-- ============================================================
-- 047_account_approval.sql — Platform-level account approval +
-- suspension
--
-- Why this exists:
--   A new signup currently gets full access the moment they verify
--   their email (handle_new_user creates their account + logs them
--   straight into the dashboard). For a SaaS being opened up to
--   outside clients, InnovateX wants a manual gate: a new account
--   sits in `pending` until an operator approves it in /admin, and
--   any account can later be `suspended` to cut off access without
--   deleting data.
--
-- What this adds
--   - `account_approval_status_enum` ('pending' | 'approved' | 'suspended')
--   - `accounts.approval_status` — defaults to 'approved' for this
--     migration's own ALTER (so every account that already exists
--     today, including InnovateX's own, is backfilled approved and
--     nobody currently using the product gets locked out). The
--     column default is then flipped to 'pending' in a second step,
--     so only accounts created AFTER this migration start out
--     gated. handle_new_user() itself needs no change — it doesn't
--     set approval_status, so new rows simply pick up the column
--     default.
--   - `accounts.approved_at` / `approved_by` — set when an admin
--     approves a pending account (approved_by is a platform admin's
--     auth.users id, not an account member).
--   - `accounts.suspended_at` / `suspended_reason` — set when an
--     admin suspends an account; cleared on re-approval.
--
-- Enforcement is NOT in RLS here — the approval gate is enforced in
-- application code (src/middleware.ts, reading this column via the
-- caller's own RLS-scoped session, which the existing "members can
-- read their own account" policy from 017 already allows) rather
-- than as a new RLS policy, since every authenticated member must
-- be able to see their own account's status to render the
-- pending/suspended screens. The /admin surface that lists and
-- mutates OTHER accounts' status runs on the service-role client
-- (src/lib/admin/admin-client.ts) gated by a fixed
-- PLATFORM_ADMIN_EMAILS allowlist in application code, not RLS —
-- there is no per-account membership relation that would let RLS
-- express "any account, if you're a platform admin" without a new
-- global-role table, which is more machinery than this needs.
--
-- Idempotent — safe to re-run.
-- ============================================================

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'account_approval_status_enum') THEN
    CREATE TYPE account_approval_status_enum AS ENUM ('pending', 'approved', 'suspended');
  END IF;
END $$;

ALTER TABLE accounts
  ADD COLUMN IF NOT EXISTS approval_status account_approval_status_enum NOT NULL DEFAULT 'approved';

-- Explicit, idempotent backfill for any row inserted between the
-- ADD COLUMN above (which already defaults new/existing rows to
-- 'approved') and this statement — belt-and-suspenders, matches the
-- style of other migrations in this repo.
UPDATE accounts SET approval_status = 'approved' WHERE approval_status IS NULL;

ALTER TABLE accounts
  ADD COLUMN IF NOT EXISTS approved_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS approved_by UUID REFERENCES auth.users(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS suspended_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS suspended_reason TEXT;

-- Backfill: every account that exists as of this migration was
-- already "approved" the moment it started using the product, so
-- stamp approved_at for a clean audit trail (approved_by stays
-- NULL — nobody actually clicked approve for these).
UPDATE accounts SET approved_at = created_at WHERE approval_status = 'approved' AND approved_at IS NULL;

-- Only NOW flip the default, so every future signup (via
-- handle_new_user, which does not set approval_status explicitly)
-- lands in 'pending' and is gated until an admin approves it.
ALTER TABLE accounts ALTER COLUMN approval_status SET DEFAULT 'pending';

CREATE INDEX IF NOT EXISTS idx_accounts_approval_status ON accounts(approval_status);