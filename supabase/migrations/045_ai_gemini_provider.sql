-- ============================================================
-- Add "gemini" (Google Gemini) as a third supported AI provider
-- alongside "openai" and "anthropic".
--
-- Both `ai_configs.provider` and `ai_usage_log.provider` were created
-- (029_ai_reply.sql, 033_ai_reply_polish.sql) with an inline, unnamed
-- CHECK constraint, so Postgres gave each the default
-- `<table>_<column>_check` name. Drop + recreate with the wider list.
-- ============================================================

ALTER TABLE ai_configs
  DROP CONSTRAINT IF EXISTS ai_configs_provider_check;
ALTER TABLE ai_configs
  ADD CONSTRAINT ai_configs_provider_check
  CHECK (provider IN ('openai', 'anthropic', 'gemini'));

ALTER TABLE ai_usage_log
  DROP CONSTRAINT IF EXISTS ai_usage_log_provider_check;
ALTER TABLE ai_usage_log
  ADD CONSTRAINT ai_usage_log_provider_check
  CHECK (provider IN ('openai', 'anthropic', 'gemini'));