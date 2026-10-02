-- PcL branding configuration for self-hosted Documenso instance
-- Run manually against the Documenso database

-- Enable custom branding for the org
UPDATE "OrganisationGlobalSettings"
SET "brandingEnabled" = true,
    "brandingCompanyDetails" = 'Papercut Labs Pte Ltd\nSingapore\nUEN: 202528031D'
WHERE "organisationId" = (SELECT id FROM "Organisation" LIMIT 1);

-- Hide "Powered by Documenso" flag
UPDATE "OrganisationClaim"
SET flags = COALESCE(flags, '{}'::jsonb) || '{"hidePoweredBy": true}'::jsonb
WHERE "organisationId" = (SELECT id FROM "Organisation" LIMIT 1);
