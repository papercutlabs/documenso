import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

// Validate the bind before loading application modules with startup side effects.
const hostname = process.env.HIVE_DOCUMENSO_HOST;
const portText = process.env.PORT;
if (!['127.0.0.1', '0.0.0.0', '::'].includes(hostname)) {
  throw new Error('Documenso bind refused: unsupported host; set HIVE_DOCUMENSO_HOST to the qualified 127.0.0.1, 0.0.0.0 or :: bind.');
}
if (!/^[1-9][0-9]{0,4}$/.test(portText ?? '') || Number(portText) > 65535) {
  throw new Error('Documenso bind refused: invalid port; set PORT to an integer from 1 through 65535.');
}

// These are the observed ESM exports in the existing installed app, not vendored code.
const load = (path) => import(pathToFileURL(resolve(process.cwd(), path)).href);
const [nodeServer, staticServer, adapter, router, build] = await Promise.all([
  load('../../node_modules/@hono/node-server/dist/index.mjs'),
  load('../../node_modules/@hono/node-server/dist/serve-static.mjs'),
  load('../../node_modules/hono-react-router-adapter/dist/handlers/node/index.js'),
  load('build/server/hono/server/router.js'),
  load('build/server/index.js'),
]);

const server = router.default;
server.use(
  staticServer.serveStatic({
    root: 'build/client',
    onFound: (path, c) => {
      if (path.startsWith('./build/client/assets')) {
        c.header('Cache-Control', 'public, immutable, max-age=31536000');
      } else {
        c.header('Cache-Control', 'public, max-age=0, stale-while-revalidate=86400');
      }
    },
  }),
);

const handler = adapter.default(build, server);
nodeServer.serve({ fetch: handler.fetch, port: Number(portText), hostname });
