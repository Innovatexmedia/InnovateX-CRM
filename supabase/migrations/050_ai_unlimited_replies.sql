-- ============================================================
-- 050_ai_unlimited_replies.sql — lift the 20-reply cap on AI auto-reply
--
-- `ai_configs.auto_reply_max_per_conversation` was CHECKed to 1..20.
-- Businesses with long support threads need more, so the range is now
-- 0..1000 where 0 means UNLIMITED (no per-thread reply cap).
--
-- Safety nets that stay in place regardless of the cap:
--   - the model hands off to a human when it can't confidently help
--   - the per-account throttle (RATE_LIMITS.aiAutoReplyAccount)
--   - a human assigned to the thread silences the bot on that thread
--
-- `claim_ai_reply_slot` is updated so max_replies = 0 always claims, and
-- so the slot claim itself is refused once the thread has been handed
-- off (bot paused) or a human owns it. That makes "AI is about to reply"
-- and "handoff just happened" atomic with each other: a reply can no
-- longer slip out after a concurrent handoff/assignment was written.
-- Idempotent — safe to run multiple times.
-- ============================================================

-- Drop whatever CHECK currently guards the column (its auto-generated
-- name differs between installs), then add the widened one.
DO $$
DECLARE
  c record;
BEGIN
  FOR c IN
    SELECT con.conname
    FROM pg_constraint con
    JOIN pg_class rel ON rel.oid = con.conrelid
    JOIN pg_attribute att
      ON att.attrelid = rel.oid AND att.attnum = ANY (con.conkey)
    WHERE rel.relname = 'ai_configs'
      AND con.contype = 'c'
      AND att.attname = 'auto_reply_max_per_conversation'
  LOOP
    EXECUTE format('ALTER TABLE ai_configs DROP CONSTRAINT %I', c.conname);
  END LOOP;
END $$;

ALTER TABLE ai_configs
  ADD CONSTRAINT ai_configs_auto_reply_max_per_conversation_check
  CHECK (auto_reply_max_per_conversation BETWEEN 0 AND 1000);

CREATE OR REPLACE FUNCTION public.claim_ai_reply_slot(
  conversation_id uuid,
  max_replies integer
)
RETURNS boolean AS $$
  WITH claimed AS (
    UPDATE conversations
    SET ai_reply_count = ai_reply_count + 1
    WHERE id = conversation_id
      AND ai_autoreply_disabled = false
      AND assigned_agent_id IS NULL
      AND (max_replies = 0 OR ai_reply_count < max_replies)
    RETURNING 1
  )
  SELECT EXISTS (SELECT 1 FROM claimed);
$$ LANGUAGE sql SECURITY DEFINER SET search_path = public;

GRANT EXECUTE ON FUNCTION public.claim_ai_reply_slot(uuid, integer) TO service_role;