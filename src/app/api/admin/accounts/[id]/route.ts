// ============================================================
// PATCH /api/admin/accounts/[id] — approve / suspend / reinstate
//
// One endpoint, three actions via `{ action: 'approve' | 'suspend' |
// 'reinstate' }` in the body, rather than three routes — they're the
// same resource transition (accounts.approval_status) with
// different audit fields, and a single handler keeps that logic in
// one place instead of drifting across files.
//
//   approve   — pending|suspended -> approved. Stamps approved_at /
//               approved_by (the calling admin). Clears any prior
//               suspension fields, so re-approving after a suspend
//               doesn't leave a stale suspended_reason visible.
//   suspend   — approved|pending -> suspended. Stamps suspended_at
//               and, optionally, suspended_reason from the body.
//               This is what actually cuts off login — see the
//               middleware.ts gate.
//   reinstate — alias for approve, kept as a separate action name in
//               the request so the /admin UI's button label
//               ("Reinstate" on a suspended row vs "Approve" on a
//               pending row) can stay honest about which state it's
//               leaving, even though the resulting write is
//               identical.
// ============================================================

import { NextResponse } from 'next/server'

import { requirePlatformAdmin, NotPlatformAdminError } from '@/lib/admin/auth'
import { supabaseAdmin } from '@/lib/admin/admin-client'

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

type Action = 'approve' | 'suspend' | 'reinstate'

function isAction(v: unknown): v is Action {
  return v === 'approve' || v === 'suspend' || v === 'reinstate'
}

export async function PATCH(
  request: Request,
  context: { params: Promise<{ id: string }> },
) {
  let admin
  try {
    admin = await requirePlatformAdmin()
  } catch (err) {
    if (err instanceof NotPlatformAdminError) {
      return NextResponse.json({ error: err.message }, { status: err.status })
    }
    throw err
  }

  const { id } = await context.params
  if (!UUID_RE.test(id)) {
    return NextResponse.json({ error: 'Invalid account id.' }, { status: 400 })
  }

  const body = (await request.json().catch(() => null)) as
    | { action?: unknown; reason?: unknown }
    | null
  if (!body || !isAction(body.action)) {
    return NextResponse.json(
      { error: "'action' must be one of: approve, suspend, reinstate" },
      { status: 400 },
    )
  }
  const reason =
    typeof body.reason === 'string' && body.reason.trim() ? body.reason.trim() : null

  const db = supabaseAdmin()
  const now = new Date().toISOString()

  const update =
    body.action === 'suspend'
      ? {
          approval_status: 'suspended' as const,
          suspended_at: now,
          suspended_reason: reason,
        }
      : {
          // approve + reinstate both land here.
          approval_status: 'approved' as const,
          approved_at: now,
          approved_by: admin.userId,
          suspended_at: null,
          suspended_reason: null,
        }

  const { data, error } = await db
    .from('accounts')
    .update(update)
    .eq('id', id)
    .select('id, name, approval_status, approved_at, suspended_at, suspended_reason')
    .maybeSingle()

  if (error) {
    console.error('[api/admin/accounts/[id]] update error:', error)
    return NextResponse.json({ error: 'Failed to update account' }, { status: 500 })
  }
  if (!data) {
    return NextResponse.json({ error: 'Account not found' }, { status: 404 })
  }

  return NextResponse.json({ account: data })
}