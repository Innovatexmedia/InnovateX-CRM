import { NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { requireRole, toErrorResponse } from '@/lib/auth/account'
import { supabaseAdmin } from '@/lib/automations/admin-client'
import {
  loadStepsTree,
  replaceSteps,
  type BuilderStepInput,
} from '@/lib/automations/steps-tree'
import {
  validateStepsForActivation,
  validateTriggerForActivation,
} from '@/lib/automations/validate'
import { generateWebhookToken } from '@/lib/automations/webhook-token'

async function requireUser() {
  const supabase = await createClient()
  const {
    data: { user },
  } = await supabase.auth.getUser()
  return user
}

export async function GET(
  _request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params
  const user = await requireUser()
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const admin = supabaseAdmin()
  const { data: automation, error } = await admin
    .from('automations')
    .select('*')
    .eq('id', id)
    .eq('user_id', user.id)
    .maybeSingle()

  if (error) return NextResponse.json({ error: error.message }, { status: 500 })
  if (!automation) return NextResponse.json({ error: 'Not found' }, { status: 404 })

  const steps = await loadStepsTree(id)
  return NextResponse.json({ automation, steps })
}

export async function PATCH(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params

  // Editing an automation is a write — the RLS automations_update policy
  // requires `agent`, but this route mutates via the service-role client
  // which bypasses RLS, so enforce the role here.
  try {
    await requireRole('agent')
  } catch (err) {
    return toErrorResponse(err)
  }

  const user = await requireUser()
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const body = await request.json().catch(() => null)
  if (!body) return NextResponse.json({ error: 'Invalid JSON' }, { status: 400 })

  const admin = supabaseAdmin()

  // Ownership check before we touch anything. Load the fields we need
  // to compute the post-patch "effective" state for validation.
  const { data: existing } = await admin
    .from('automations')
    .select('id, user_id, is_active, trigger_type, trigger_config')
    .eq('id', id)
    .maybeSingle()
  if (!existing || existing.user_id !== user.id) {
    return NextResponse.json({ error: 'Not found' }, { status: 404 })
  }

  const update: Record<string, unknown> = {}
  for (const k of [
    'name',
    'description',
    'trigger_type',
    'trigger_config',
    'is_active',
    'skip_opted_out',
  ] as const) {
    if (k in body) update[k] = body[k]
  }

  // Webhook token handling — mirrors the POST route's rule: this field
  // is never client-settable. Three cases land here:
  //   1. `regenerate_webhook_token: true` — rotate it (the "Regenerate"
  //      action in the builder). Invalidates the old URL immediately.
  //   2. The trigger is (already, or now becoming) `incoming_webhook`
  //      and there's no token yet (a fresh automation, or one whose
  //      trigger_type this same PATCH is switching to it) — generate
  //      one so the automation is never left in a state where its own
  //      trigger type has nothing to receive on.
  //   3. Anything else — strip a client-supplied `token` from whatever
  //      trigger_config it sent, same as the POST route.
  const mergedTriggerTypeForToken = (update.trigger_type ?? existing.trigger_type) as string
  const incomingConfig = (update.trigger_config ?? {}) as Record<string, unknown>
  const existingConfig = (existing.trigger_config ?? {}) as Record<string, unknown>
  if (body.regenerate_webhook_token === true) {
    if (mergedTriggerTypeForToken !== 'incoming_webhook') {
      return NextResponse.json(
        { error: 'regenerate_webhook_token only applies to the incoming_webhook trigger' },
        { status: 400 },
      )
    }
    update.trigger_config = { ...existingConfig, ...incomingConfig, token: generateWebhookToken() }
  } else if (mergedTriggerTypeForToken === 'incoming_webhook') {
    const alreadyHasToken = typeof existingConfig.token === 'string' && existingConfig.token
    // Only actually touch trigger_config when there's something to do —
    // the client sent one (merge it in, token still wins), or there's no
    // token yet to generate one for. A plain `{ is_active: true }` PATCH
    // on an already-configured webhook trigger should not rewrite
    // trigger_config at all.
    if ('trigger_config' in update || !alreadyHasToken) {
      update.trigger_config = {
        ...existingConfig,
        ...incomingConfig,
        token: alreadyHasToken ? existingConfig.token : generateWebhookToken(),
      }
    }
  } else if ('trigger_config' in update) {
    const { token: _drop, ...rest } = incomingConfig
    void _drop
    update.trigger_config = rest
  }

  // If this PATCH leaves the automation active (either explicitly
  // activating it OR editing an already-active one), validate the
  // merged configuration first. Activation is the natural gate — drafts
  // are still allowed to be incomplete.
  const willBeActive =
    typeof update.is_active === 'boolean' ? update.is_active : existing.is_active
  if (willBeActive) {
    const mergedTriggerType = (update.trigger_type ?? existing.trigger_type) as string
    const mergedTriggerConfig = update.trigger_config ?? existing.trigger_config
    const mergedSteps = Array.isArray(body.steps)
      ? (body.steps as { step_type: string; step_config: Record<string, unknown> }[])
      : await loadStepsTree(id)
    const issues = [
      ...validateTriggerForActivation(mergedTriggerType, mergedTriggerConfig),
      ...validateStepsForActivation(mergedSteps),
    ]
    if (issues.length > 0) {
      return NextResponse.json(
        {
          error: 'Cannot keep automation active with invalid configuration',
          issues,
        },
        { status: 400 },
      )
    }
  }

  if (Object.keys(update).length > 0) {
    const { error: updErr } = await admin
      .from('automations')
      .update(update)
      .eq('id', id)
    if (updErr) return NextResponse.json({ error: updErr.message }, { status: 500 })
  }

  if (Array.isArray(body.steps)) {
    const err = await replaceSteps(id, body.steps as BuilderStepInput[])
    if (err) return NextResponse.json({ error: err }, { status: 500 })
  }

  // Echo the (possibly server-generated/rotated) trigger_config back —
  // the builder's "Regenerate" action needs the new token without a
  // second round trip, and there's no other response on a PATCH for it
  // to learn the value from.
  return NextResponse.json({
    ok: true,
    trigger_config: (update.trigger_config ?? existing.trigger_config) as unknown,
  })
}

export async function DELETE(
  _request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params

  // Deleting an automation is a write — enforce `agent` (the service-role
  // client below bypasses the agent-gated automations_delete RLS).
  try {
    await requireRole('agent')
  } catch (err) {
    return toErrorResponse(err)
  }

  const user = await requireUser()
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const { error } = await supabaseAdmin()
    .from('automations')
    .delete()
    .eq('id', id)
    .eq('user_id', user.id)
  if (error) return NextResponse.json({ error: error.message }, { status: 500 })
  return NextResponse.json({ ok: true })
}