// ============================================================
// Platform-admin gate.
//
// This is deliberately NOT the same thing as an account's
// `account_role` (owner/admin/agent/viewer, src/lib/auth/roles.ts)
// — that hierarchy is scoped to a single tenant's own team.
// "Platform admin" means an InnovateX operator who can see and
// approve/suspend EVERY account on the deployment, which no
// account-scoped role should ever imply.
//
// Kept intentionally simple: a fixed, comma-separated allowlist of
// email addresses in an env var, checked in application code (never
// in RLS — see the note in migration 047). No new role/table, no
// promote-another-admin UI. Adding or removing an admin is an env
// var edit + redeploy, which is the right amount of ceremony for a
// capability this powerful on a small operator team.
// ============================================================

import { createClient } from '@/lib/supabase/server'

/**
 * Parse `PLATFORM_ADMIN_EMAILS` (comma-separated, case-insensitive,
 * whitespace-trimmed). Empty/unset means no one — never treat that
 * as "check disabled", since a misconfigured env var closing the
 * door is the safe failure, not opening it to everyone.
 */
function platformAdminEmails(): Set<string> {
  const raw = process.env.PLATFORM_ADMIN_EMAILS ?? ''
  return new Set(
    raw
      .split(',')
      .map((s) => s.trim().toLowerCase())
      .filter((s) => s.length > 0),
  )
}

export function isPlatformAdminEmail(email: string | null | undefined): boolean {
  if (!email) return false
  return platformAdminEmails().has(email.trim().toLowerCase())
}

export interface PlatformAdminContext {
  userId: string
  email: string
}

export class NotPlatformAdminError extends Error {
  readonly status = 403 as const
  constructor(message = 'Not a platform admin') {
    super(message)
    this.name = 'NotPlatformAdminError'
  }
}

/**
 * Resolve the caller's Supabase session and verify their email is
 * on the PLATFORM_ADMIN_EMAILS allowlist. Throws on anything short
 * of that — no session, or a session whose email isn't listed.
 *
 * Uses the RLS-scoped SSR client only to identify *who* is asking
 * (auth.getUser() reads the session cookie); it never queries
 * account data with it. Callers that need to read/write other
 * accounts do so with supabaseAdmin() from ./admin-client after
 * this resolves.
 */
export async function requirePlatformAdmin(): Promise<PlatformAdminContext> {
  const supabase = await createClient()
  const {
    data: { user },
    error,
  } = await supabase.auth.getUser()

  if (error || !user || !user.email) {
    throw new NotPlatformAdminError('Not signed in')
  }
  if (!isPlatformAdminEmail(user.email)) {
    throw new NotPlatformAdminError()
  }
  return { userId: user.id, email: user.email }
}