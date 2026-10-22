import { NextResponse } from 'next/server';
import { requireRole, toErrorResponse } from '@/lib/auth/account';
import { parseHHmm } from '@/lib/events/schedule';
import { eventContextOf, replanReminders } from '@/lib/events/service';
import type { EventCampaignRow, EventReminderRow } from '@/lib/events/types';
import { validateEventVariables } from '@/lib/events/variables';

type Ctx = Awaited<ReturnType<typeof requireRole>>;

/**
 * PATCH /api/events/[id]
 *
 *   { action: 'pause' }    stop sending; reminders stay in place
 *   { action: 'resume' }   start again; reminders whose time passed while
 *                          paused are skipped, not sent late
 *   { action: 'cancel' }   stop for good; unsent reminders are skipped
 *   { action: 'update', name?, event_at?, location?, join_link?,
 *     audience_tag_ids?, exclude_tag_ids?, quiet? }
 *                          edit the event; moving event_at (or changing
 *                          quiet hours) re-times every unsent reminder
 *
 * Nothing here calls Meta. Sending only ever happens in api/events/cron
 * → api/broadcasts/scheduled-cron.
 */
export async function PATCH(request: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const ctx = await requireRole('agent');
    const { id } = await params;
    const body = await request.json().catch(() => null);

    const campaign = await loadCampaign(ctx, id);
    if (!campaign) return NextResponse.json({ error: 'Event not found.' }, { status: 404 });

    switch (body?.action) {
      case 'pause': {
        if (campaign.status !== 'active') return conflict('Only an active event can be paused.');
        await setStatus(ctx, id, 'paused');
        return NextResponse.json({ ok: true });
      }
      case 'resume': {
        if (campaign.status !== 'paused') return conflict('Only a paused event can be resumed.');
        if (new Date(campaign.event_at).getTime() <= Date.now() && !(await hasFutureAfterReminder(ctx, campaign))) {
          return conflict('The event has already happened, so there is nothing left to resume.');
        }
        // Re-time first, THEN activate: otherwise a cron run in between
        // could send a reminder that fell due while paused.
        await replanReminders(ctx.supabase, { ...campaign, status: 'active' });
        await setStatus(ctx, id, 'active');
        return NextResponse.json({ ok: true });
      }
      case 'cancel': {
        if (campaign.status === 'cancelled' || campaign.status === 'completed') {
          return conflict('This event is already finished.');
        }
        await cancelUnsent(ctx, campaign);
        await setStatus(ctx, id, 'cancelled');
        return NextResponse.json({ ok: true });
      }
      case 'update':
        return await updateEvent(ctx, campaign, body);
      default:
        return NextResponse.json(
          { error: 'action must be "pause", "resume", "cancel" or "update"' },
          { status: 400 },
        );
    }
  } catch (error) {
    return toErrorResponse(error);
  }
}

/** DELETE /api/events/[id] — remove the event. Reminders already sent stay in Broadcasts. */
export async function DELETE(_request: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const ctx = await requireRole('agent');
    const { id } = await params;
    const campaign = await loadCampaign(ctx, id);
    if (!campaign) return NextResponse.json({ error: 'Event not found.' }, { status: 404 });

    await cancelUnsent(ctx, campaign);
    const { error } = await ctx.supabase
      .from('event_campaigns')
      .delete()
      .eq('id', id)
      .eq('account_id', ctx.accountId);
    if (error) return NextResponse.json({ error: error.message }, { status: 500 });
    return NextResponse.json({ ok: true });
  } catch (error) {
    return toErrorResponse(error);
  }
}

// ── helpers ────────────────────────────────────────────────────

function conflict(message: string) {
  return NextResponse.json({ error: message }, { status: 409 });
}

async function loadCampaign(ctx: Ctx, id: string): Promise<EventCampaignRow | null> {
  const { data } = await ctx.supabase
    .from('event_campaigns')
    .select('*')
    .eq('id', id)
    .eq('account_id', ctx.accountId)
    .maybeSingle();
  return (data as EventCampaignRow | null) ?? null;
}

async function setStatus(ctx: Ctx, id: string, status: EventCampaignRow['status']) {
  const { error } = await ctx.supabase
    .from('event_campaigns')
    .update({ status })
    .eq('id', id)
    .eq('account_id', ctx.accountId);
  if (error) throw new Error(error.message);
}

/** True when a paused post-event campaign still has an "after" reminder due in the future. */
async function hasFutureAfterReminder(ctx: Ctx, campaign: EventCampaignRow): Promise<boolean> {
  const { count } = await ctx.supabase
    .from('event_reminders')
    .select('id', { count: 'exact', head: true })
    .eq('event_campaign_id', campaign.id)
    .eq('status', 'scheduled')
    .gt('offset_minutes', 0);
  return (count ?? 0) > 0;
}

/**
 * Stop everything that has not gone out: unsent reminders become
 * skipped('cancelled'), and a reminder already turned into a scheduled
 * broadcast that scheduled-cron has not claimed yet is cancelled too.
 */
async function cancelUnsent(ctx: Ctx, campaign: EventCampaignRow) {
  const { data: reminders } = await ctx.supabase
    .from('event_reminders')
    .select('id, broadcast_id, status')
    .eq('event_campaign_id', campaign.id);
  const rows = (reminders ?? []) as Pick<EventReminderRow, 'id' | 'broadcast_id' | 'status'>[];

  await ctx.supabase
    .from('event_reminders')
    .update({ status: 'skipped', skip_reason: 'cancelled', send_at: null })
    .eq('event_campaign_id', campaign.id)
    .in('status', ['scheduled', 'processing']);

  const broadcastIds = rows.filter((r) => r.status === 'queued' && r.broadcast_id).map((r) => r.broadcast_id as string);
  if (broadcastIds.length > 0) {
    // Same convention as the schedule route: 'failed' stands in for
    // "cancelled", and only a still-'scheduled' row can be stopped.
    await ctx.supabase
      .from('broadcasts')
      .update({ status: 'failed' })
      .in('id', broadcastIds)
      .eq('status', 'scheduled');
  }
}

async function updateEvent(ctx: Ctx, campaign: EventCampaignRow, body: Record<string, unknown>) {
  if (campaign.status === 'cancelled' || campaign.status === 'completed') {
    return conflict('A finished event cannot be edited.');
  }

  const patch: Partial<EventCampaignRow> = {};

  if (body.name !== undefined) {
    const name = String(body.name).trim();
    if (!name || name.length > 120) {
      return NextResponse.json({ error: 'Event name must be 1–120 characters.' }, { status: 400 });
    }
    patch.name = name;
  }

  if (body.event_at !== undefined) {
    const at = new Date(String(body.event_at));
    if (Number.isNaN(at.getTime())) {
      return NextResponse.json({ error: 'Event date and time are not valid.' }, { status: 400 });
    }
    if (at.getTime() <= Date.now()) {
      return NextResponse.json({ error: 'The event must be in the future.' }, { status: 400 });
    }
    patch.event_at = at.toISOString();
  }

  for (const key of ['location', 'join_link'] as const) {
    if (body[key] !== undefined) {
      const v = typeof body[key] === 'string' ? (body[key] as string).trim() : '';
      if (key === 'join_link' && v && !/^https?:\/\/\S+$/i.test(v)) {
        return NextResponse.json({ error: 'Join link must start with http:// or https://' }, { status: 400 });
      }
      patch[key] = v || null;
    }
  }

  for (const key of ['audience_tag_ids', 'exclude_tag_ids'] as const) {
    if (body[key] !== undefined) {
      const ids = Array.isArray(body[key]) ? [...new Set((body[key] as unknown[]).filter((x): x is string => typeof x === 'string'))] : [];
      if (ids.length > 0) {
        const { data } = await ctx.supabase.from('tags').select('id').eq('account_id', ctx.accountId).in('id', ids);
        if ((data ?? []).length !== ids.length) {
          return NextResponse.json({ error: 'One of the selected tags was not found.' }, { status: 400 });
        }
      }
      patch[key] = ids;
    }
  }
  if (patch.audience_tag_ids && patch.audience_tag_ids.length === 0) {
    return NextResponse.json({ error: 'Pick at least one tag for the audience.' }, { status: 400 });
  }

  const q = body.quiet as { enabled?: boolean; from?: string; to?: string } | undefined;
  if (q) {
    if (q.enabled !== undefined) patch.quiet_enabled = q.enabled !== false;
    if (q.from !== undefined) {
      if (parseHHmm(String(q.from)) === null) return NextResponse.json({ error: 'Quiet hours must be times like 22:00.' }, { status: 400 });
      patch.quiet_from = String(q.from);
    }
    if (q.to !== undefined) {
      if (parseHHmm(String(q.to)) === null) return NextResponse.json({ error: 'Quiet hours must be times like 22:00.' }, { status: 400 });
      patch.quiet_to = String(q.to);
    }
  }

  if (Object.keys(patch).length === 0) {
    return NextResponse.json({ error: 'Nothing to update.' }, { status: 400 });
  }

  const merged: EventCampaignRow = { ...campaign, ...patch };

  // Changing the link/location/name must not break an unsent reminder that
  // reads it (e.g. clearing the join link while a reminder sends {{link}}).
  const { data: pending } = await ctx.supabase
    .from('event_reminders')
    .select('variables, template_name')
    .eq('event_campaign_id', campaign.id)
    .eq('status', 'scheduled');
  for (const r of (pending ?? []) as Pick<EventReminderRow, 'variables' | 'template_name'>[]) {
    const problems = validateEventVariables(r.variables ?? {}, eventContextOf(merged));
    if (problems.length > 0) {
      return NextResponse.json(
        { error: `A reminder using "${r.template_name}" would break: ${problems[0]}` },
        { status: 400 },
      );
    }
  }

  const { error } = await ctx.supabase
    .from('event_campaigns')
    .update(patch)
    .eq('id', campaign.id)
    .eq('account_id', ctx.accountId);
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });

  const retime =
    patch.event_at !== undefined ||
    patch.quiet_enabled !== undefined ||
    patch.quiet_from !== undefined ||
    patch.quiet_to !== undefined;
  if (retime) await replanReminders(ctx.supabase, merged);

  return NextResponse.json({ ok: true, retimed: retime });
}