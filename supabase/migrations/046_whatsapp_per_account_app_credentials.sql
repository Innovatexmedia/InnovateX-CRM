-- ============================================================
-- Per-account Meta App ID / App Secret on whatsapp_config
--
-- Why this exists:
--   docs/multi-waba.md "Setup B" (a client's WABA lives under its own
--   Meta App, not InnovateX's) previously required adding that app's
--   secret to the deployment-wide META_APP_SECRET env var and
--   redeploying — one code change per client, which doesn't scale
--   for a multi-tenant SaaS onboarding new accounts on their own.
--
--   These two columns let each account supply its own Meta App
--   credentials from Settings → WhatsApp connection instead:
--
--     app_id     — plain text. Only consumer is the Resumable Upload
--                  call for image/video/document template headers
--                  (Meta requires an app-scoped upload). Falls back to
--                  the deployment-wide META_APP_ID when unset.
--     app_secret — encrypted at rest (same GCM scheme as
--                  access_token/verify_token, see
--                  src/lib/whatsapp/encryption.ts). Checked, in
--                  addition to every secret listed in META_APP_SECRET,
--                  when verifying an inbound webhook's
--                  X-Hub-Signature-256. A request is accepted when it
--                  matches ANY configured secret.
--
--   Neither column is required — most accounts share InnovateX's one
--   Meta App and leave both blank, exactly as before this migration.
--
-- Idempotent — safe to re-run.
-- ============================================================

ALTER TABLE whatsapp_config
  ADD COLUMN IF NOT EXISTS app_id TEXT,
  ADD COLUMN IF NOT EXISTS app_secret TEXT;