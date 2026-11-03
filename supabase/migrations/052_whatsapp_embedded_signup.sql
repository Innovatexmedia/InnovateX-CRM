-- ============================================================
-- 052 — WhatsApp Embedded Signup ("Connect with Facebook")
--
-- Additive only: two nullable columns on `whatsapp_config`. Safe to run
-- against a live database — the running app never reads them until the
-- Embedded Signup code is deployed, and rows created by the manual
-- connect form keep working exactly as before (both columns stay NULL).
--
--   connected_via  — how the number was connected: 'manual' (the
--                    Settings form) or 'embedded_signup' (Facebook
--                    popup). NULL on rows that predate this migration.
--
--   two_step_pin   — the 6-digit PIN Embedded Signup generated when it
--                    registered the number with the Cloud API. Stored
--                    encrypted (same AES-256-GCM scheme as access_token)
--                    so a later re-register / reconnect can reuse it
--                    instead of asking the client for a PIN they never
--                    chose. NULL for manually connected numbers.
-- ============================================================

ALTER TABLE whatsapp_config
  ADD COLUMN IF NOT EXISTS connected_via TEXT,
  ADD COLUMN IF NOT EXISTS two_step_pin TEXT;

COMMENT ON COLUMN whatsapp_config.connected_via IS
  'manual | embedded_signup. NULL for rows created before migration 052.';
COMMENT ON COLUMN whatsapp_config.two_step_pin IS
  'Encrypted 6-digit PIN generated during Embedded Signup registration. NULL for manual connections.';