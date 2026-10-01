-- "Capture test data" for the Incoming Webhook automation trigger.
--
-- AiSensy/Intercom/Zendesk-style webhook triggers never assume a fixed
-- payload shape, because the same product wires into a different
-- external system (Shopify, a custom landing page, Zapier/Make, a
-- client's own backend) for every customer. Instead they let you fire
-- a real test request first, show you exactly what arrived, and then
-- map its fields onto the CRM's own (Phone, Name, tags, custom vars).
-- This column is the storage for that middle step — a rolling window
-- of raw bodies POST /api/hooks/[token] has actually received.
--
-- Only ever populated/read for trigger_type = 'incoming_webhook' rows,
-- but kept as a plain column (not restricted at the DB level) since
-- every other automation row simply leaves it at its default.
ALTER TABLE automations
  ADD COLUMN IF NOT EXISTS webhook_samples jsonb NOT NULL DEFAULT '[]'::jsonb;

COMMENT ON COLUMN automations.webhook_samples IS
  'Rolling window (see MAX_WEBHOOK_SAMPLES in src/app/api/hooks/[token]/route.ts) of raw request bodies received on this automation''s incoming_webhook URL, newest first. Builder-only (the "capture test data" step); never read by the automation engine.';