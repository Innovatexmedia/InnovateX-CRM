import { timingSafeEqual } from 'node:crypto';
import { NextResponse } from 'next/server';
import { supabaseAdmin } from '@/lib/automations/admin-client';
import {
  eventContextOf,
  fetchCustomValues,
  resolveEventAudience,
} from '@/lib/events/service';
import { offsetLabel } from '@/lib/events/schedule';
import type { EventCampaignRow, EventReminderRow, EventSkipReason } from '@/lib/events/types';
import { resolveEventVariables } from '@/lib/events/variables';

/**
 * Turns due Event Campaign reminders into ordinary scheduled broadcasts.
 * Meant to be hit every minute by the same external pinger as the other
 * cron routes (shared secret in `x-cron-secret` = AUTOMATION_CRON_SECRET).
 *
 * For each due reminder it:
 *   1. claims it (scheduled → processing) so overlapping runs never
 *      double-handle one;
 *   2. re-checks it is still worth sending (campaign active, event not
 *      already over for a "before" reminder, not stale);
 *   3. resolves the audience NOW (tags are live, so late registrants are
 *      included) and each recipient's template params;
 *   4. creates a `broadcasts` row plus its `broadcast_recipients` (as a
 *      draft, flipped to 'scheduled' only once complete) and marks the
 *      reminder 'queued'.
 *
 * It never calls Meta itself. api/broadcasts/scheduled-cron — already
 * pinged every minute — picks the new broadcast up and sends it, which
 * means rate limiting, retries, phone-variant handling, delivery counts
 * and the per-campaign report are the existing, battle-tested ones.
 */

const BATCH_SIZE = 20; // reminders handled per run
const INSERT_BATCH_SIZE = 200;
/** A reminder this long overdue (cron outage) is dropped rather than sent stale. */
const STALE_AFTER_MS = 6 * 60 * 60 * 1000;
/** A "when it starts" reminder is still useful shortly after start, not long after. */
const START_GRACE_MS = 30 * 60 * 1000;
/** A reminder 'processing' for longer than this is assumed dead and retried. */
const STUCK_AFTER_MS = 10 * 60 * 1000;

type Admin = ReturnType<typeof supabaseAdmin>;
type DueReminder = EventReminderRow & { event_campaigns: EventCampaignRow };

export async function GET(request: Request) {
  const expected = process.env.AUTOMATION_CRON_SECRET;
  if (!expected) {
    return NextResponse.json({ error: 'cron not configured' }, { status: 503 });
  }
  const supplied = request.headers.get('x-cron-secret') ?? '';
  const suppliedBuf = Buffer.from(supplied);
  const expectedBuf = Buffer.from(expected);
  if (
    suppliedBuf.length !== expectedBuf.length ||
    !timingSafeEqual(suppliedBuf, expectedBuf)
  ) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const admin = supabaseAdmin();
  const nowIso = new Date().toISOString();

  // A run that died mid-reminder (serverless timeout) leaves it in
  // 'processing'. Put those back so a later run retries them —
  // handleReminder is idempotent (see the existing-broadcast check).
  await admin
    .from('event_reminders')
    .update({ status: 'scheduled' })
    .eq('status', 'processing')
    .lt('updated_at', new Date(Date.now() - STUCK_AFTER_MS).toISOString());

  // Only reminders of ACTIVE campaigns: a paused or cancelled event's
  // reminders are simply not selected.
  const { data: due, error } = await admin
    .from('event_reminders')
    .select('*, event_campaigns!inner(*)')
    .eq('status', 'scheduled')
    .eq('event_campaigns.status', 'active')
    .lte('send_at', nowIso)
    .order('send_at', { ascending: true })
    .limit(BATCH_SIZE);

  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  if (!due || due.length === 0) return NextResponse.json({ processed: 0 });

  const result = { processed: 0, queued: 0, skipped: 0, failed: 0 };

  for (const row of due as unknown as DueReminder[]) {
    // Claim. No row back = another invocation got it first.
    const { data: claimed } = await admin
      .from('event_reminders')
      .update({ status: 'processing' })
      .eq('id', row.id)
      .eq('status', 'scheduled')
      .select('id')
      .maybeSingle();
    if (!claimed) continue;

    result.processed++;
    const campaign = row.event_campaigns;
    try {
      const outcome = await handleReminder(admin, row, campaign);
      result[outcome]++;
    } catch (err) {
      console.error(`[event-cron] reminder ${row.id} failed:`, err);
      await admin
        .from('event_reminders')
        .update({
          status: 'failed',
          error_message: err instanceof Error ? err.message : 'Unknown error',
        })
        .eq('id', row.id);
      result.failed++;
    }
    await completeIfFinished(admin, campaign.id);
  }

  return NextResponse.json(result);
}

async function skip(admin: Admin, id: string, reason: EventSkipReason) {
  await admin
    .from('event_reminders')
    .update({ status: 'skipped', skip_reason: reason, send_at: null })
    .eq('id', id);
}

async function handleReminder(
  admin: Admin,
  reminder: EventReminderRow,
  campaign: EventCampaignRow,
): Promise<'queued' | 'skipped'> {
  // The campaign was read at the start of the run; the user may have
  // paused or cancelled since. Re-check, and hand the reminder back
  // (still 'scheduled', so Resume re-times it) rather than send.
  const { data: fresh } = await admin
    .from('event_campaigns')
    .select('status')
    .eq('id', campaign.id)
    .maybeSingle();
  if (!fresh || fresh.status !== 'active') {
    await admin
      .from('event_reminders')
      .update({ status: 'scheduled' })
      .eq('id', reminder.id)
      .eq('status', 'processing');
    return 'skipped';
  }

  const now = Date.now();
  const eventMs = new Date(campaign.event_at).getTime();
  const sendMs = reminder.send_at ? new Date(reminder.send_at).getTime() : now;

  // Stale or no-longer-meaningful: never send "1 hour before" after the
  // event has started, and never send something hours overdue.
  if (now - sendMs > STALE_AFTER_MS) {
    await skip(admin, reminder.id, 'too_late');
    return 'skipped';
  }
  if (reminder.offset_minutes < 0 && now >= eventMs) {
    await skip(admin, reminder.id, 'already_past');
    return 'skipped';
  }
  if (reminder.offset_minutes === 0 && now > eventMs + START_GRACE_MS) {
    await skip(admin, reminder.id, 'already_past');
    return 'skipped';
  }

  // Idempotency: a previous run may have created this reminder's
  // broadcast and then died before recording it. A finished broadcast
  // (anything but 'draft') is adopted as-is; a half-built draft is
  // thrown away and rebuilt, so recipients are never duplicated or
  // sent partially.
  const { data: existing } = await admin
    .from('broadcasts')
    .select('id, status')
    .eq('event_reminder_id', reminder.id)
    .limit(1)
    .maybeSingle();
  if (existing) {
    if (existing.status === 'failed') {
      throw new Error('A previous attempt to build this reminder\'s broadcast failed.');
    }
    if (existing.status !== 'draft') {
      await admin
        .from('event_reminders')
        .update({ status: 'queued', broadcast_id: existing.id, error_message: null })
        .eq('id', reminder.id);
      return 'queued';
    }
    await admin.from('broadcasts').delete().eq('id', existing.id);
  }

  const contacts = await resolveEventAudience(admin, campaign);
  if (contacts.length === 0) {
    await skip(admin, reminder.id, 'no_recipients');
    return 'skipped';
  }

  const customFieldIds = [
    ...new Set(
      Object.values(reminder.variables)
        .filter((m) => m.type === 'custom_field')
        .map((m) => m.value),
    ),
  ];
  const customIndex = await fetchCustomValues(
    admin,
    contacts.map((c) => c.id),
    customFieldIds,
  );
  const ev = eventContextOf(campaign);

  const { data: broadcast, error: bErr } = await admin
    .from('broadcasts')
    .insert({
      user_id: campaign.user_id,
      account_id: campaign.account_id,
      name: `${campaign.name} — ${offsetLabel(reminder.offset_minutes)}`,
      template_name: reminder.template_name,
      template_language: reminder.template_language,
      template_variables: reminder.variables,
      audience_filter: {
        type: 'tags',
        tagIds: campaign.audience_tag_ids,
        excludeTagIds: campaign.exclude_tag_ids,
        eventCampaignId: campaign.id,
      },
      // Built as a draft and only flipped to 'scheduled' once every
      // recipient row exists, so scheduled-cron can never pick up (and
      // send to) a half-populated audience.
      status: 'draft',
      scheduled_at: new Date().toISOString(),
      header_media_url: reminder.header_media_url,
      event_reminder_id: reminder.id,
      total_recipients: contacts.length,
      sent_count: 0,
      delivered_count: 0,
      read_count: 0,
      replied_count: 0,
      failed_count: 0,
    })
    .select('id')
    .single();
  if (bErr || !broadcast) {
    throw new Error(`Failed to create broadcast: ${bErr?.message ?? 'unknown error'}`);
  }

  const rows = contacts.map((c) => ({
    broadcast_id: broadcast.id,
    contact_id: c.id,
    status: 'pending' as const,
    template_params: resolveEventVariables(reminder.variables, c, customIndex.get(c.id), ev),
    button_params: null,
  }));

  for (let i = 0; i < rows.length; i += INSERT_BATCH_SIZE) {
    const { error: rErr } = await admin
      .from('broadcast_recipients')
      .insert(rows.slice(i, i + INSERT_BATCH_SIZE));
    if (rErr) {
      // Don't leave a half-populated broadcast that scheduled-cron
      // would send to only some of the audience.
      await admin
        .from('broadcasts')
        .update({ status: 'failed', failed_count: contacts.length })
        .eq('id', broadcast.id);
      throw new Error(`Failed to add recipients: ${rErr.message}`);
    }
  }

  // Cancelled / deleted while the recipients were being built? Then this
  // reminder is no longer ours: discard the draft instead of sending it.
  const { data: stillMine } = await admin
    .from('event_reminders')
    .select('id')
    .eq('id', reminder.id)
    .eq('status', 'processing')
    .maybeSingle();
  if (!stillMine) {
    await admin.from('broadcasts').delete().eq('id', broadcast.id);
    return 'skipped';
  }

  // Due immediately: api/broadcasts/scheduled-cron sends it on its next
  // run (within a minute).
  const { error: sErr } = await admin
    .from('broadcasts')
    .update({ status: 'scheduled' })
    .eq('id', broadcast.id)
    .eq('status', 'draft');
  if (sErr) throw new Error(`Failed to schedule broadcast: ${sErr.message}`);

  const { data: marked } = await admin
    .from('event_reminders')
    .update({ status: 'queued', broadcast_id: broadcast.id, error_message: null })
    .eq('id', reminder.id)
    .eq('status', 'processing')
    .select('id')
    .maybeSingle();
  if (!marked) {
    // Lost the race to a cancel in the last instant: stop the broadcast.
    await admin.from('broadcasts').update({ status: 'failed' }).eq('id', broadcast.id).eq('status', 'scheduled');
    return 'skipped';
  }
  return 'queued';
}

/** Flip the campaign to 'completed' once nothing is left to send. */
async function completeIfFinished(admin: Admin, campaignId: string) {
  const { count } = await admin
    .from('event_reminders')
    .select('id', { count: 'exact', head: true })
    .eq('event_campaign_id', campaignId)
    .in('status', ['scheduled', 'processing']);
  if (count === 0) {
    await admin
      .from('event_campaigns')
      .update({ status: 'completed' })
      .eq('id', campaignId)
      .eq('status', 'active');
  }
}