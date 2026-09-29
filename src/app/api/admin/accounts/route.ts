// ============================================================
// GET /api/admin/accounts — platform-admin roster
//
// Lists every account on the deployment (any approval_status) plus
// the aggregate counts /admin's header stats need ("kitne users
// hai"). Gated by requirePlatformAdmin() — see src/lib/admin/auth.ts
// for why this is a fixed email allowlist rather than an
// account_role, and src/lib/admin/admin-client.ts for why this is
// the only place in the app allowed to read across every tenant.
// ============================================================

import { NextResponse } from 'next/server'

import { requirePlatformAdmin, NotPlatformAdminError } from '@/lib/admin/auth'
import { supabaseAdmin } from '@/lib/admin/admin-client'

interface AccountRow {
  id: string
  name: string
  owner_user_id: string
  approval_status: 'pending' | 'approved' | 'suspended'
  created_at: string
  approved_at: string | null
  suspended_at: string | null
  suspended_reason: string | null
}

export async function GET() {
  try {
    await requirePlatformAdmin()
  } catch (err) {
    if (err instanceof NotPlatformAdminError) {
      return NextResponse.json({ error: err.message }, { status: err.status })
    }
    throw err
  }

  const db = supabaseAdmin()

  const { data: accounts, error: accountsErr } = await db
    .from('accounts')
    .select(
      'id, name, owner_user_id, approval_status, created_at, approved_at, suspended_at, suspended_reason',
    )
    .order('created_at', { ascending: false })

  if (accountsErr) {
    console.error('[api/admin/accounts] accounts fetch error:', accountsErr)
    return NextResponse.json({ error: 'Failed to load accounts' }, { status: 500 })
  }

  const rows = (accounts ?? []) as AccountRow[]

  // Owner name/email lives on profiles (the accounts table itself
  // carries no contact info — see migration 001/017). One extra
  // query rather than N+1: fetch every owner's profile by
  // owner_user_id in a single IN(...) filter.
  const ownerIds = rows.map((a) => a.owner_user_id)
  const ownersById = new Map<string, { full_name: string | null; email: string | null }>()
  if (ownerIds.length > 0) {
    const { data: owners, error: ownersErr } = await db
      .from('profiles')
      .select('user_id, full_name, email')
      .in('user_id', ownerIds)
    if (ownersErr) {
      // Non-fatal — the account list is still useful without names.
      console.error('[api/admin/accounts] owners fetch error:', ownersErr)
    } else {
      for (const o of owners ?? []) {
        ownersById.set(o.user_id as string, {
          full_name: (o.full_name as string | null) ?? null,
          email: (o.email as string | null) ?? null,
        })
      }
    }
  }

  // "kitne users hai" — total individual people (profiles rows,
  // which includes invited teammates, not just account owners) and
  // total accounts (signups) broken down by status. Both are
  // cheap head-count queries (count: 'exact', head: true — no rows
  // transferred).
  const [{ count: totalUsers }, { count: totalAccounts }] = await Promise.all([
    db.from('profiles').select('*', { count: 'exact', head: true }),
    db.from('accounts').select('*', { count: 'exact', head: true }),
  ])

  const statusCounts = { pending: 0, approved: 0, suspended: 0 }
  for (const a of rows) {
    statusCounts[a.approval_status] += 1
  }

  return NextResponse.json({
    accounts: rows.map((a) => ({
      id: a.id,
      name: a.name,
      owner_email: ownersById.get(a.owner_user_id)?.email ?? null,
      owner_name: ownersById.get(a.owner_user_id)?.full_name ?? null,
      approval_status: a.approval_status,
      created_at: a.created_at,
      approved_at: a.approved_at,
      suspended_at: a.suspended_at,
      suspended_reason: a.suspended_reason,
    })),
    stats: {
      total_users: totalUsers ?? 0,
      total_accounts: totalAccounts ?? 0,
      ...statusCounts,
    },
  })
}