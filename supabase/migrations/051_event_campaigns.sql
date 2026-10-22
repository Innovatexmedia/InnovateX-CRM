-- ============================================================
-- 051_event_campaigns.sql — "Event Campaign": WhatsApp reminders
-- scheduled relative to ONE event date/time (webinar, workshop, …).
--
-- Model
--   event_campaigns   the event (name, date/time, optional location and
--                     join link) + who gets the reminders (tags, resolved
--                     fresh at every send) + quiet hours + state.
--   event_reminders   one row per reminder: an offset from the event
--                     (negative = before, 0 = when it starts, positive =
--                     after) + a template + variable mapping. `send_at`
--                     is derived (event time + offset, then quiet-hours
--                     adjusted) and recomputed when the event moves.
--
-- Sending reuses the existing scheduled-broadcast pipeline: when a
-- reminder falls due, api/events/cron resolves the audience, creates an
-- ordinary `broadcasts` row (status 'scheduled') plus its recipients,
-- and api/broadcasts/scheduled-cron sends it. `broadcast_id` links the
-- reminder to that row, so each reminder gets the normal per-campaign
-- delivery report for free.
--
-- RLS mirrors broadcasts: any member can read; agent+ can write.
-- The cron uses the service-role client.
--
-- Idempotent — safe to run multiple times.
-- ============================================================

CREATE TABLE IF NOT EXISTS event_campaigns (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id      uuid NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  user_id         uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  name            text NOT NULL,                 -- the event's name, also used as {{event name}}
  event_at        timestamptz NOT NULL,          -- when the event starts (stored UTC, entered in IST)
  location        text,
  join_link       text,
  -- Audience: contacts carrying ANY of audience_tag_ids, minus anyone
  -- carrying ANY of exclude_tag_ids. Resolved at each reminder's send time.
  audience_tag_ids uuid[] NOT NULL DEFAULT '{}',
  exclude_tag_ids  uuid[] NOT NULL DEFAULT '{}',
  -- Quiet hours, wall-clock IST "HH:mm". Window may cross midnight.
  quiet_enabled   boolean NOT NULL DEFAULT true,
  quiet_from      text NOT NULL DEFAULT '22:00',
  quiet_to        text NOT NULL DEFAULT '08:00',
  status          text NOT NULL DEFAULT 'active'
                  CHECK (status IN ('active', 'paused', 'cancelled', 'completed')),
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS event_campaigns_account_idx
  ON event_campaigns (account_id, created_at DESC);

CREATE TABLE IF NOT EXISTS event_reminders (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  event_campaign_id uuid NOT NULL REFERENCES event_campaigns(id) ON DELETE CASCADE,
  account_id        uuid NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  -- Minutes relative to event_at. -1440 = 1 day before, 0 = when it
  -- starts, 120 = 2 hours after.
  offset_minutes    integer NOT NULL,
  template_name     text NOT NULL,
  template_language text NOT NULL DEFAULT 'en_US',
  -- { "1": {type:'static'|'field'|'custom_field'|'event', value, fallback?}, … }
  variables         jsonb NOT NULL DEFAULT '{}'::jsonb,
  header_media_url  text,
  -- When this reminder will go out (after quiet-hours shifting). NULL
  -- when it will never send (see status/skip_reason).
  send_at           timestamptz,
  status            text NOT NULL DEFAULT 'scheduled'
                    CHECK (status IN ('scheduled', 'processing', 'queued', 'skipped', 'failed')),
  -- 'queued' = a broadcasts row now exists and scheduled-cron owns it.
  skip_reason       text,
  moved_by_quiet_hours boolean NOT NULL DEFAULT false,
  broadcast_id      uuid REFERENCES broadcasts(id) ON DELETE SET NULL,
  error_message     text,
  created_at        timestamptz NOT NULL DEFAULT now(),
  updated_at        timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS event_reminders_campaign_idx
  ON event_reminders (event_campaign_id, offset_minutes);

-- The cron's hot query: due, still-scheduled reminders.
CREATE INDEX IF NOT EXISTS event_reminders_due_idx
  ON event_reminders (send_at)
  WHERE status = 'scheduled';

ALTER TABLE event_campaigns ENABLE ROW LEVEL SECURITY;
ALTER TABLE event_reminders ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS event_campaigns_select ON event_campaigns;
CREATE POLICY event_campaigns_select ON event_campaigns FOR SELECT
  USING (is_account_member(account_id));
DROP POLICY IF EXISTS event_campaigns_insert ON event_campaigns;
CREATE POLICY event_campaigns_insert ON event_campaigns FOR INSERT
  WITH CHECK (is_account_member(account_id, 'agent'));
DROP POLICY IF EXISTS event_campaigns_update ON event_campaigns;
CREATE POLICY event_campaigns_update ON event_campaigns FOR UPDATE
  USING (is_account_member(account_id, 'agent'));
DROP POLICY IF EXISTS event_campaigns_delete ON event_campaigns;
CREATE POLICY event_campaigns_delete ON event_campaigns FOR DELETE
  USING (is_account_member(account_id, 'agent'));

DROP POLICY IF EXISTS event_reminders_select ON event_reminders;
CREATE POLICY event_reminders_select ON event_reminders FOR SELECT
  USING (is_account_member(account_id));
DROP POLICY IF EXISTS event_reminders_insert ON event_reminders;
CREATE POLICY event_reminders_insert ON event_reminders FOR INSERT
  WITH CHECK (
    is_account_member(account_id, 'agent')
    -- The reminder must belong to a campaign of the SAME account, so one
    -- account can never attach reminders to another account's event.
    AND EXISTS (
      SELECT 1 FROM event_campaigns c
      WHERE c.id = event_campaign_id AND c.account_id = event_reminders.account_id
    )
  );
DROP POLICY IF EXISTS event_reminders_update ON event_reminders;
CREATE POLICY event_reminders_update ON event_reminders FOR UPDATE
  USING (is_account_member(account_id, 'agent'))
  WITH CHECK (
    is_account_member(account_id, 'agent')
    AND EXISTS (
      SELECT 1 FROM event_campaigns c
      WHERE c.id = event_campaign_id AND c.account_id = event_reminders.account_id
    )
  );
DROP POLICY IF EXISTS event_reminders_delete ON event_reminders;
CREATE POLICY event_reminders_delete ON event_reminders FOR DELETE
  USING (is_account_member(account_id, 'agent'));

DROP TRIGGER IF EXISTS set_updated_at ON event_campaigns;
CREATE TRIGGER set_updated_at BEFORE UPDATE ON event_campaigns
  FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();
DROP TRIGGER IF EXISTS set_updated_at ON event_reminders;
CREATE TRIGGER set_updated_at BEFORE UPDATE ON event_reminders
  FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

-- Broadcasts created by an event reminder carry kind 'standard' like any
-- other, so they show up in the normal list with their delivery counts.
-- This column lets the broadcasts list/detail tell them apart if wanted.
ALTER TABLE broadcasts
  ADD COLUMN IF NOT EXISTS event_reminder_id uuid REFERENCES event_reminders(id) ON DELETE SET NULL;

-- Columns the broadcast send path (scheduled-cron, wizard) already reads
-- and writes. Added defensively and idempotently: they were never in a
-- numbered migration, so a database that lacks them would make every
-- event reminder fail to build its broadcast.
ALTER TABLE broadcasts
  ADD COLUMN IF NOT EXISTS header_media_url text;
ALTER TABLE broadcast_recipients
  ADD COLUMN IF NOT EXISTS button_params jsonb;