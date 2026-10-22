import { NextResponse } from 'next/server';
import { requireRole, toErrorResponse } from '@/lib/auth/account';
import {
  parseHHmm,
  planReminder,
  validateOffset,
} from '@/lib/events/schedule';
import {
  planToColumns,
  validateReminderInput,
  type ValidatedReminder,
} from '@/lib/events/service';
import type { ReminderInput } from '@/lib/events/types';

/**
 * POST /api/events — create an Event Campaign: the event, who gets
 * reminders (by tag), quiet hours, and the list of reminders.
 *
 * Body:
 *   {
 *     name: string,
 *     event_at: ISO timestamp (the client converts the IST date/time the
 *               user typed),
 *     location?: string, join_link?: string,
 *     audience_tag_ids: string[], exclude_tag_ids?: string[],
 *     quiet?: { enabled: boolean, from: "HH:mm", to: "HH:mm" },
 *     reminders: { offset_minutes, template_name, template_language?,
 *                  variables?, header_media_url? }[]
 *   }
 *
 * Nothing is created unless every reminder validates, and at least one
 * of them is actually going to send.
 */
export async function POST(request: Request) {
  try {
    const { supabase, accountId, userId } = await requireRole('agent');
    const body = await request.json().catch(() => null);
    if (!body || typeof body !== 'object') {
      return NextResponse.json({ error: 'Invalid request body.' }, { status: 400 });
    }

    const name = String(body.name ?? '').trim();
    if (!name) return NextResponse.json({ error: 'Event name is required.' }, { status: 400 });
    if (name.length > 120) {
      return NextResponse.json({ error: 'Event name is too long (max 120 characters).' }, { status: 400 });
    }

    const eventAt = new Date(String(body.event_at ?? ''));
    if (Number.isNaN(eventAt.getTime())) {
      return NextResponse.json({ error: 'Event date and time are required.' }, { status: 400 });
    }
    if (eventAt.getTime() <= Date.now()) {
      return NextResponse.json({ error: 'The event must be in the future.' }, { status: 400 });
    }

    const location = cleanText(body.location);
    const joinLink = cleanText(body.join_link);
    if (joinLink && !/^https?:\/\/\S+$/i.test(joinLink)) {
      return NextResponse.json({ error: 'Join link must start with http:// or https://' }, { status: 400 });
    }

    const audienceTagIds = stringArray(body.audience_tag_ids);
    const excludeTagIds = stringArray(body.exclude_tag_ids);
    if (audienceTagIds.length === 0) {
      return NextResponse.json({ error: 'Pick at least one tag for the audience.' }, { status: 400 });
    }
    const tagCheck = await checkTagsBelongToAccount(supabase, accountId, [...audienceTagIds, ...excludeTagIds]);
    if (tagCheck) return NextResponse.json({ error: tagCheck }, { status: 400 });

    const quiet = {
      enabled: body.quiet?.enabled !== false,
      from: String(body.quiet?.from ?? '22:00'),
      to: String(body.quiet?.to ?? '08:00'),
    };
    if (parseHHmm(quiet.from) === null || parseHHmm(quiet.to) === null) {
      return NextResponse.json({ error: 'Quiet hours must be times like 22:00.' }, { status: 400 });
    }

    const remindersIn: ReminderInput[] = Array.isArray(body.reminders) ? body.reminders : [];
    if (remindersIn.length === 0) {
      return NextResponse.json({ error: 'Add at least one reminder.' }, { status: 400 });
    }
    const seen = new Set<number>();
    for (const r of remindersIn) {
      const offsetErr = validateOffset(r.offset_minutes);
      if (offsetErr) return NextResponse.json({ error: offsetErr }, { status: 400 });
      if (seen.has(r.offset_minutes)) {
        return NextResponse.json({ error: 'Two reminders are set for the same time.' }, { status: 400 });
      }
      seen.add(r.offset_minutes);
    }

    const ev = { name, eventAt, joinLink, location };
    const validated: ValidatedReminder[] = [];
    for (const r of remindersIn) {
      const v = await validateReminderInput(supabase, accountId, r, ev);
      if (!v.ok) return NextResponse.json({ error: v.error }, { status: 400 });
      validated.push(v.value);
    }

    const plans = validated.map((v) => planReminder(eventAt, v.offset_minutes, quiet));
    if (plans.every((p) => p.sendAt === null)) {
      return NextResponse.json(
        { error: 'None of these reminders can be sent: their times have passed or fall inside quiet hours.' },
        { status: 400 },
      );
    }

    const { data: campaign, error: cErr } = await supabase
      .from('event_campaigns')
      .insert({
        account_id: accountId,
        user_id: userId,
        name,
        event_at: eventAt.toISOString(),
        location,
        join_link: joinLink,
        audience_tag_ids: audienceTagIds,
        exclude_tag_ids: excludeTagIds,
        quiet_enabled: quiet.enabled,
        quiet_from: quiet.from,
        quiet_to: quiet.to,
      })
      .select('*')
      .single();
    if (cErr || !campaign) {
      return NextResponse.json({ error: cErr?.message ?? 'Failed to create the event.' }, { status: 500 });
    }

    const rows = validated.map((v, i) => ({
      event_campaign_id: campaign.id,
      account_id: accountId,
      offset_minutes: v.offset_minutes,
      template_name: v.template_name,
      template_language: v.template_language,
      variables: v.variables,
      header_media_url: v.header_media_url,
      ...planToColumns(plans[i]),
    }));
    const { error: rErr } = await supabase.from('event_reminders').insert(rows);
    if (rErr) {
      // Don't leave an event with no reminders behind.
      await supabase.from('event_campaigns').delete().eq('id', campaign.id);
      return NextResponse.json({ error: `Failed to save reminders: ${rErr.message}` }, { status: 500 });
    }

    // Echo how many will actually go out so the UI can say so.
    const willSend = plans.filter((p) => p.sendAt).length;
    return NextResponse.json({ id: campaign.id, reminders: rows.length, will_send: willSend, skipped: rows.length - willSend });
  } catch (error) {
    return toErrorResponse(error);
  }
}

function cleanText(v: unknown): string | null {
  const s = typeof v === 'string' ? v.trim() : '';
  return s ? s : null;
}

function stringArray(v: unknown): string[] {
  return Array.isArray(v) ? [...new Set(v.filter((x): x is string => typeof x === 'string'))] : [];
}

async function checkTagsBelongToAccount(
  supabase: Awaited<ReturnType<typeof requireRole>>['supabase'],
  accountId: string,
  ids: string[],
): Promise<string | null> {
  const unique = [...new Set(ids)];
  if (unique.length === 0) return null;
  const { data, error } = await supabase.from('tags').select('id').eq('account_id', accountId).in('id', unique);
  if (error) return error.message;
  return (data ?? []).length === unique.length ? null : 'One of the selected tags was not found.';
}