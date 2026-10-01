-- ============================================================
-- 048_incoming_webhook_trigger.sql — "Incoming Webhook" automation
-- trigger: an external system (landing page, Shopify, payment
-- gateway, Zapier/Make/n8n, …) can POST to an automation's own
-- unique URL to fire it, without a WhatsApp message ever arriving
-- first. The inbound mirror of the existing `send_webhook` step.
--
-- No new column: the token lives in the existing `trigger_config`
-- JSONB (same place `keyword_match` keeps its keywords, `tag_added`
-- its tag_id, etc.), keyed `token`. This index is what makes
-- `POST /api/hooks/[token]` a fast, unique reverse lookup from token
-- back to the one automation it belongs to — and what guarantees two
-- automations (in the same account or different ones) can never
-- collide on the same token.
--
-- Idempotent — safe to run multiple times.
-- ============================================================

CREATE UNIQUE INDEX IF NOT EXISTS idx_automations_webhook_token
  ON automations ((trigger_config ->> 'token'))
  WHERE trigger_type = 'incoming_webhook';