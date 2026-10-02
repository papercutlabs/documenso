import { sha256 } from '@noble/hashes/sha256';
import { BackgroundJobStatus, Prisma } from '@prisma/client';
import type { Context as HonoContext } from 'hono';

import { prisma } from '@documenso/prisma';

import { verify } from '../../server-only/crypto/verify';
import {
  type JobDefinition,
  type JobRunIO,
  type SimpleTriggerJobOptions,
  ZSimpleTriggerJobOptionsSchema,
} from './_internal/job';
import type { Json } from './_internal/json';
import { BaseJobProvider } from './base';

export class LocalJobProvider extends BaseJobProvider {
  private static _instance: LocalJobProvider;

  private _jobDefinitions: Record<string, JobDefinition> = {};

  private constructor() {
    super();
  }

  static getInstance() {
    if (!this._instance) {
      this._instance = new LocalJobProvider();
    }

    return this._instance;
  }

  public defineJob<N extends string, T>(definition: JobDefinition<N, T>) {
    this._jobDefinitions[definition.id] = {
      ...definition,
      enabled: definition.enabled ?? true,
    };
  }

  public async triggerJob(options: SimpleTriggerJobOptions) {
    const eligibleJobs = Object.values(this._jobDefinitions).filter(
      (job) => job.trigger.name === options.name,
    );

    await Promise.all(
      eligibleJobs.map(async (job) => {
        // Ideally we will change this to a createMany with returning later once we upgrade Prisma
        // @see: https://github.com/prisma/prisma/releases/tag/5.14.0
        const pendingJob = await prisma.backgroundJob.create({
          data: {
            jobId: job.id,
            name: job.name,
            version: job.version,
            // eslint-disable-next-line @typescript-eslint/consistent-type-assertions
            payload: options.payload as Prisma.InputJsonValue,
          },
        });

        // Execute the handler inline instead of making a flaky HTTP self-call.
        // Fire-and-forget: triggerJob returns immediately while the handler runs in the background.
        void this.executeJobInline({
          jobId: pendingJob.id,
          definition: job,
          data: options,
          isRetry: false,
        });
      }),
    );
  }

  private async executeJobInline(options: {
    jobId: string;
    definition: JobDefinition;
    data: SimpleTriggerJobOptions;
    isRetry: boolean;
  }) {
    const { jobId, definition, data, isRetry } = options;

    console.log(`[JOBS]: Triggering job ${data.name} with payload`, data.payload);

    let backgroundJob = await prisma.backgroundJob
      .update({
        where: {
          id: jobId,
          status: BackgroundJobStatus.PENDING,
        },
        data: {
          status: BackgroundJobStatus.PROCESSING,
          retried: {
            increment: isRetry ? 1 : 0,
          },
          lastRetriedAt: isRetry ? new Date() : undefined,
        },
      })
      .catch(() => null);

    if (!backgroundJob) {
      console.log(`[JOBS]: Could not transition job ${jobId} to PROCESSING — skipping`);
      return;
    }

    try {
      await definition.handler({
        payload: data.payload,
        io: this.createJobRunIO(jobId),
      });

      await prisma.backgroundJob.update({
        where: {
          id: jobId,
          status: BackgroundJobStatus.PROCESSING,
        },
        data: {
          status: BackgroundJobStatus.COMPLETED,
          completedAt: new Date(),
        },
      });
    } catch (error) {
      console.log(`[JOBS]: Job ${data.name} failed`, error);

      const taskHasExceededRetries = error instanceof BackgroundTaskExceededRetriesError;
      const jobHasExceededRetries =
        backgroundJob.retried >= backgroundJob.maxRetries &&
        !(error instanceof BackgroundTaskFailedError);

      if (taskHasExceededRetries || jobHasExceededRetries) {
        await prisma.backgroundJob.update({
          where: {
            id: jobId,
            status: BackgroundJobStatus.PROCESSING,
          },
          data: {
            status: BackgroundJobStatus.FAILED,
            completedAt: new Date(),
          },
        });

        return;
      }

      backgroundJob = await prisma.backgroundJob.update({
        where: {
          id: jobId,
          status: BackgroundJobStatus.PROCESSING,
        },
        data: {
          status: BackgroundJobStatus.PENDING,
        },
      });

      // Retry inline rather than via HTTP endpoint.
      void this.executeJobInline({
        jobId,
        definition,
        data,
        isRetry: true,
      });
    }
  }

  public getApiHandler(): (c: HonoContext) => Promise<Response | void> {
    return async (c: HonoContext) => {
      const req = c.req;

      if (req.method !== 'POST') {
        return c.text('Method not allowed', 405);
      }

      const jobId = req.header('x-job-id');
      const signature = req.header('x-job-signature');
      const isRetry = req.header('x-job-retry') !== undefined;

      const options = await req
        .json()
        .then(async (data) => ZSimpleTriggerJobOptionsSchema.parseAsync(data))
        // eslint-disable-next-line @typescript-eslint/consistent-type-assertions
        .then((data) => data as SimpleTriggerJobOptions)
        .catch(() => null);

      if (!options) {
        return c.text('Bad request', 400);
      }

      const definition = this._jobDefinitions[options.name];

      if (
        typeof jobId !== 'string' ||
        typeof signature !== 'string' ||
        typeof options !== 'object'
      ) {
        return c.text('Bad request', 400);
      }

      if (!definition) {
        return c.text('Job not found', 404);
      }

      if (definition && !definition.enabled) {
        console.log('Attempted to trigger a disabled job', options.name);

        return c.text('Job not found', 404);
      }

      if (!signature || !verify(options, signature)) {
        return c.text('Unauthorized', 401);
      }

      if (definition.trigger.schema) {
        const result = definition.trigger.schema.safeParse(options.payload);

        if (!result.success) {
          return c.text('Bad request', 400);
        }
      }

      console.log(`[JOBS]: Triggering job ${options.name} with payload`, options.payload);

      let backgroundJob = await prisma.backgroundJob
        .update({
          where: {
            id: jobId,
            status: BackgroundJobStatus.PENDING,
          },
          data: {
            status: BackgroundJobStatus.PROCESSING,
            retried: {
              increment: isRetry ? 1 : 0,
            },
            lastRetriedAt: isRetry ? new Date() : undefined,
          },
        })
        .catch(() => null);

      if (!backgroundJob) {
        return c.text('Job not found', 404);
      }

      try {
        await definition.handler({
          payload: options.payload,
          io: this.createJobRunIO(jobId),
        });

        backgroundJob = await prisma.backgroundJob.update({
          where: {
            id: jobId,
            status: BackgroundJobStatus.PROCESSING,
          },
          data: {
            status: BackgroundJobStatus.COMPLETED,
            completedAt: new Date(),
          },
        });
      } catch (error) {
        console.log(`[JOBS]: Job ${options.name} failed`, error);

        const taskHasExceededRetries = error instanceof BackgroundTaskExceededRetriesError;
        const jobHasExceededRetries =
          backgroundJob.retried >= backgroundJob.maxRetries &&
          !(error instanceof BackgroundTaskFailedError);

        if (taskHasExceededRetries || jobHasExceededRetries) {
          backgroundJob = await prisma.backgroundJob.update({
            where: {
              id: jobId,
              status: BackgroundJobStatus.PROCESSING,
            },
            data: {
              status: BackgroundJobStatus.FAILED,
              completedAt: new Date(),
            },
          });

          return c.text('Task exceeded retries', 500);
        }

        backgroundJob = await prisma.backgroundJob.update({
          where: {
            id: jobId,
            status: BackgroundJobStatus.PROCESSING,
          },
          data: {
            status: BackgroundJobStatus.PENDING,
          },
        });

        void this.executeJobInline({
          jobId,
          definition,
          data: options,
          isRetry: true,
        });
      }

      return c.text('OK', 200);
    };
  }

  private createJobRunIO(jobId: string): JobRunIO {
    return {
      runTask: async <T extends void | Json>(cacheKey: string, callback: () => Promise<T>) => {
        const hashedKey = Buffer.from(sha256(cacheKey)).toString('hex');

        let task = await prisma.backgroundJobTask.findFirst({
          where: {
            id: `task-${hashedKey}--${jobId}`,
            jobId,
          },
        });

        if (!task) {
          task = await prisma.backgroundJobTask.create({
            data: {
              id: `task-${hashedKey}--${jobId}`,
              name: cacheKey,
              jobId,
              status: BackgroundJobStatus.PENDING,
            },
          });
        }

        if (task.status === BackgroundJobStatus.COMPLETED) {
          // eslint-disable-next-line @typescript-eslint/consistent-type-assertions
          return task.result as T;
        }

        if (task.retried >= 3) {
          throw new BackgroundTaskExceededRetriesError('Task exceeded retries');
        }

        try {
          const result = await callback();

          task = await prisma.backgroundJobTask.update({
            where: {
              id: task.id,
              jobId,
            },
            data: {
              status: BackgroundJobStatus.COMPLETED,
              result: result === null ? Prisma.JsonNull : result,
              completedAt: new Date(),
            },
          });

          return result;
        } catch (err) {
          task = await prisma.backgroundJobTask.update({
            where: {
              id: task.id,
              jobId,
            },
            data: {
              status: BackgroundJobStatus.PENDING,
              retried: {
                increment: 1,
              },
            },
          });

          console.log(`[JOBS:${task.id}] Task failed`, err);

          throw new BackgroundTaskFailedError('Task failed');
        }
      },
      triggerJob: async (_cacheKey, payload) => await this.triggerJob(payload),
      logger: {
        debug: (...args) => console.debug(`[${jobId}]`, ...args),
        error: (...args) => console.error(`[${jobId}]`, ...args),
        info: (...args) => console.info(`[${jobId}]`, ...args),
        log: (...args) => console.log(`[${jobId}]`, ...args),
        warn: (...args) => console.warn(`[${jobId}]`, ...args),
      },
      // eslint-disable-next-line @typescript-eslint/require-await
      wait: async () => {
        throw new Error('Not implemented');
      },
    };
  }
}

class BackgroundTaskFailedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'BackgroundTaskFailedError';
  }
}

class BackgroundTaskExceededRetriesError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'BackgroundTaskExceededRetriesError';
  }
}
