import { NextResponse } from 'next/server';
import { requireRole, toErrorResponse } from '@/lib/auth/account';
import { offsetLabel, planReminder } from '@/lib/events/schedule';
import {
  eventContextOf,
  planToColumns,
  quietOf,
  validateReminderInput,
} from '@/lib/events/service';
import type { EventCampaignRow, ReminderInput } from '@/lib/events/types';

/**
 * POST /api/events/[id]/reminders — add one reminder to an existing,
 * unfinished event. Body: { offset_minutes, template_name,
 * template_language?, variables?, header_media_url? }.
 *
 * A reminder that could never send (its time has passed, or quiet hours
 * would push it past the event) is refused here rather than saved as a
 * silently-skipped row.
 */
export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const { supabase, accountId } = await requireRole('agent');
    const { id } = await params;
    const input = (await request.json().catch(() => null)) as ReminderInput | null;
    if (!input || typeof input !== 'object') {
      return NextResponse.json({ error: 'Invalid request body.' }, { status: 400 });
    }

    const { data } = await supabase
      .from('event_campaigns')
      .select('*')
      .eq('id', id)
      .eq('account_id', accountId)
      .maybeSingle();
    const campaign = data as EventCampaignRow | null;
    if (!campaign) return NextResponse.json({ error: 'Event not found.' }, { status: 404 });
    if (campaign.status === 'cancelled' || campaign.status === 'completed') {
      return NextResponse.json({ error: 'A finished event cannot take new reminders.' }, { status: 409 });
    }

    const { data: clash } = await supabase
      .from('event_reminders')
      .select('id')
      .eq('event_campaign_id', id)
      .eq('offset_minutes', input.offset_minutes)
      .limit(1);
    if ((clash ?? []).length > 0) {
      return NextResponse.json({ error: 'A reminder is already set for that time.' }, { status: 409 });
    }

    const v = await validateReminderInput(supabase, accountId, input, eventContextOf(campaign));
    if (!v.ok) return NextResponse.json({ error: v.error }, { status: 400 });

    const plan = planReminder(new Date(campaign.event_at), v.value.offset_minutes, quietOf(campaign));
    if (!plan.sendAt) {
      const label = offsetLabel(v.value.offset_minutes);
      return NextResponse.json(
        {
          error:
            plan.skipReason === 'already_past'
              ? `"${label}" has already passed, so it would never send.`
              : `"${label}" falls inside quiet hours and would land after the event starts, so it would never send.`,
        },
        { status: 400 },
      );
    }

    const { data: row, error } = await supabase
      .from('event_reminders')
      .insert({
        event_campaign_id: id,
        account_id: accountId,
        ...v.value,
        ...planToColumns(plan),
      })
      .select('id')
      .single();
    if (error || !row) {
      return NextResponse.json({ error: error?.message ?? 'Failed to add the reminder.' }, { status: 500 });
    }

    // A paused campaign stays paused; a completed one was rejected above.
    return NextResponse.json({ id: row.id, send_at: plan.sendAt.toISOString(), moved: plan.movedByQuietHours });
  } catch (error) {
    return toErrorResponse(error);
  }
}