-- ============================================================
-- 044_opt_in_opt_out.sql — WhatsApp opt-in / opt-out compliance
--
-- Adds subscription tracking to contacts plus the account-level
-- configuration (keywords + auto-responses) that drives it, matching
-- AiSensy's opt-in/opt-out management feature.
--
--   1. contacts.subscription_status (+ opted_in_at / opted_out_at /
--      opt_source) — per-contact consent state.
--   2. opt_keywords — inbound keywords ("STOP", "START", …) that flip
--      subscription_status when matched. Account-scoped, same tenancy
--      model as `quick_replies` / `webhook_endpoints`.
--   3. opt_responses — the auto-reply (template or plain message) sent
--      back when an opt-in/opt-out keyword (or quick-reply trigger)
--      matches. One row per (account_id, direction).
--   4. quick_replies.triggers_opt_in — lets a quick-reply button double
--      as an opt-in trigger when a customer taps it (see the webhook's
--      interactive-reply handling).
--   5. automations.skip_opted_out — per-automation toggle (default on)
--      so the engine can skip contacts who opted out of WhatsApp
--      messaging before running a step against them.
--
-- Design notes
--   - `subscription_status` defaults to 'unknown' rather than
--     'opted_in' — WhatsApp's own compliance model (and AiSensy's) is
--     opt-out based for utility conversations but we don't want to
--     assume consent for marketing-style automation/broadcast sends
--     just because a contact exists; broadcasts already have their own
--     opt-in gates (templates, 24h window) so 'unknown' contacts are
--     NOT excluded from broadcasts, only 'opted_out' ones are (see the
--     broadcast send route).
--   - Only `opted_out` contacts are hard-excluded from broadcast sends
--     and (when the toggle is on) automation execution — 'unknown' is
--     treated as sendable, matching existing behaviour for every
--     contact created before this migration.
--   - Max 5 ENABLED opt-out keywords per account is enforced at the
--     APPLICATION layer (src/app/api/settings/opt-management/keywords/
--     route.ts), not with a DB CHECK/trigger — a CHECK constraint can't
--     see sibling rows, and a per-INSERT counting trigger would need to
--     re-scan the table on every toggle. The cost of an app-layer race
--     (two concurrent inserts both passing the count check) is a
--     transient 6th enabled keyword, acceptable for a per-workspace
--     settings screen with no concurrent editors in practice.
--
-- RLS
--   Both new tables mirror `webhook_endpoints` (026/028): any member
--   can read, only admin+ can write — this is workspace-compliance
--   configuration, not agent-day-to-day data.
--
-- Idempotent — safe to run multiple times.
-- ============================================================

-- 1. Contact subscription state -------------------------------
ALTER TABLE contacts
  ADD COLUMN IF NOT EXISTS subscription_status text NOT NULL DEFAULT 'unknown'
    CHECK (subscription_status IN ('opted_in', 'opted_out', 'unknown')),
  ADD COLUMN IF NOT EXISTS opted_in_at timestamptz,
  ADD COLUMN IF NOT EXISTS opted_out_at timestamptz,
  ADD COLUMN IF NOT EXISTS opt_source text
    CHECK (opt_source IS NULL OR opt_source IN ('keyword', 'quick_reply', 'manual', 'api', 'import'));

-- Broadcast/automation exclusion queries filter on this directly.
CREATE INDEX IF NOT EXISTS idx_contacts_subscription_status
  ON contacts (account_id, subscription_status);

-- 2. Opt keywords -----------------------------------------------
CREATE TABLE IF NOT EXISTS opt_keywords (
  id          UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  account_id  UUID NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  direction   TEXT NOT NULL CHECK (direction IN ('in', 'out')),
  keyword     TEXT NOT NULL,
  match_type  TEXT NOT NULL DEFAULT 'contains' CHECK (match_type IN ('exact', 'contains')),
  enabled     BOOLEAN NOT NULL DEFAULT true,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_opt_keywords_account ON opt_keywords(account_id);
-- Hot path: the webhook loads only enabled keywords for the account +
-- direction on every inbound text message.
CREATE INDEX IF NOT EXISTS idx_opt_keywords_account_direction_enabled
  ON opt_keywords(account_id, direction) WHERE enabled = true;

ALTER TABLE opt_keywords ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS opt_keywords_select ON opt_keywords;
DROP POLICY IF EXISTS opt_keywords_insert ON opt_keywords;
DROP POLICY IF EXISTS opt_keywords_update ON opt_keywords;
DROP POLICY IF EXISTS opt_keywords_delete ON opt_keywords;
CREATE POLICY opt_keywords_select ON opt_keywords FOR SELECT
  USING (is_account_member(account_id));
CREATE POLICY opt_keywords_insert ON opt_keywords FOR INSERT
  WITH CHECK (is_account_member(account_id, 'admin'));
CREATE POLICY opt_keywords_update ON opt_keywords FOR UPDATE
  USING (is_account_member(account_id, 'admin'));
CREATE POLICY opt_keywords_delete ON opt_keywords FOR DELETE
  USING (is_account_member(account_id, 'admin'));

DROP TRIGGER IF EXISTS set_updated_at ON opt_keywords;
CREATE TRIGGER set_updated_at BEFORE UPDATE ON opt_keywords
  FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

-- 3. Opt responses ------------------------------------------------
CREATE TABLE IF NOT EXISTS opt_responses (
  id            UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  account_id    UUID NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  direction     TEXT NOT NULL CHECK (direction IN ('in', 'out')),
  enabled       BOOLEAN NOT NULL DEFAULT true,
  response_type TEXT NOT NULL DEFAULT 'message' CHECK (response_type IN ('template', 'message')),
  template_id   UUID REFERENCES message_templates(id) ON DELETE SET NULL,
  message_text  TEXT,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (account_id, direction)
);

CREATE INDEX IF NOT EXISTS idx_opt_responses_account ON opt_responses(account_id);

ALTER TABLE opt_responses ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS opt_responses_select ON opt_responses;
DROP POLICY IF EXISTS opt_responses_insert ON opt_responses;
DROP POLICY IF EXISTS opt_responses_update ON opt_responses;
DROP POLICY IF EXISTS opt_responses_delete ON opt_responses;
CREATE POLICY opt_responses_select ON opt_responses FOR SELECT
  USING (is_account_member(account_id));
CREATE POLICY opt_responses_insert ON opt_responses FOR INSERT
  WITH CHECK (is_account_member(account_id, 'admin'));
CREATE POLICY opt_responses_update ON opt_responses FOR UPDATE
  USING (is_account_member(account_id, 'admin'));
CREATE POLICY opt_responses_delete ON opt_responses FOR DELETE
  USING (is_account_member(account_id, 'admin'));

DROP TRIGGER IF EXISTS set_updated_at ON opt_responses;
CREATE TRIGGER set_updated_at BEFORE UPDATE ON opt_responses
  FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

-- 4. Quick-reply opt-in trigger flag -------------------------------
ALTER TABLE quick_replies
  ADD COLUMN IF NOT EXISTS triggers_opt_in boolean NOT NULL DEFAULT false;

-- 5. Automation "skip opted-out contacts" toggle -------------------
-- Defaults to true: existing automations start compliant without any
-- action from the account owner.
ALTER TABLE automations
  ADD COLUMN IF NOT EXISTS skip_opted_out boolean NOT NULL DEFAULT true;