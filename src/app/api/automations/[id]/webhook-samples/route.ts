// ============================================================
// /api/automations/[id]/webhook-samples — the "capture test data" step
// of the Incoming Webhook builder UI.
//
// GET: read-only, returns the rolling window of raw bodies that
// automation's URL has actually received (see `POST /api/hooks/[token]`),
// newest first, so the user can watch test hits arrive while they set
// up the integration and then pick real field names for the mapping
// step.
//
// DELETE: clears that history (sets it back to `[]`). This is purely
// cosmetic/privacy housekeeping for the builder — captured samples are
// never read by the automation engine, only by this GET for the
// mapping UI's field picker — so clearing them has no effect on
// whether the automation runs; it just lets a user wipe out whatever
// test phone numbers/emails/etc. ended up in there before going live
// (or before sharing a screenshot) without waiting for the rolling
// 20-sample window to push old entries out on its own.
// ============================================================

import { NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { requireRole, toErrorResponse } from '@/lib/auth/account'
import { supabaseAdmin } from '@/lib/automations/admin-client'
import type { WebhookSample } from '@/types'

async function loadOwnedIncomingWebhookAutomation(id: string, userId: string) {
  const admin = supabaseAdmin()
  const { data: automation, error } = await admin
    .from('automations')
    .select('id, user_id, trigger_type, webhook_samples')
    .eq('id', id)
    .eq('user_id', userId)
    .maybeSingle()
  return { admin, automation, error }
}

export async function GET(
  _request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params

  // Read-only — any authenticated member of the account can watch
  // captures come in while a teammate wires up the integration, same
  // bar as the automation GET route (no `requireRole('agent')` gate,
  // unlike the write routes).
  const supabase = await createClient()
  const {
    data: { user },
  } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const { automation, error } = await loadOwnedIncomingWebhookAutomation(id, user.id)

  if (error) return NextResponse.json({ error: error.message }, { status: 500 })
  if (!automation) return NextResponse.json({ error: 'Not found' }, { status: 404 })
  if (automation.trigger_type !== 'incoming_webhook') {
    return NextResponse.json({ error: 'Not an incoming_webhook automation' }, { status: 400 })
  }

  const samples = (automation.webhook_samples ?? []) as WebhookSample[]
  return NextResponse.json({ samples })
}

export async function DELETE(
  _request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params

  // Clearing is a write — enforce `agent`, matching every other
  // mutating automations route (the service-role client below
  // bypasses RLS).
  try {
    await requireRole('agent')
  } catch (err) {
    return toErrorResponse(err)
  }

  const supabase = await createClient()
  const {
    data: { user },
  } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const { admin, automation, error } = await loadOwnedIncomingWebhookAutomation(id, user.id)

  if (error) return NextResponse.json({ error: error.message }, { status: 500 })
  if (!automation) return NextResponse.json({ error: 'Not found' }, { status: 404 })
  if (automation.trigger_type !== 'incoming_webhook') {
    return NextResponse.json({ error: 'Not an incoming_webhook automation' }, { status: 400 })
  }

  const { error: updErr } = await admin
    .from('automations')
    .update({ webhook_samples: [] })
    .eq('id', id)
  if (updErr) return NextResponse.json({ error: updErr.message }, { status: 500 })

  return NextResponse.json({ ok: true })
}