/**
 * Event Campaign server-side helpers shared by the API routes and the
 * cron. Everything here takes the Supabase client as an argument so the
 * same code runs under RLS (user routes) and the service role (cron).
 */

import type { SupabaseClient } from '@supabase/supabase-js';

import { resolveTemplateRow } from '@/lib/whatsapp/template-body';
import type { Contact } from '@/types';
import { eventContextOf, quietOf } from './context';
import { planReminder, validateOffset, type SendPlan } from './schedule';
import type {
  EventCampaignRow,
  EventReminderRow,
  EventSkipReason,
  ReminderInput,
} from './types';
import {
  isKnownMapping,
  validateEventVariables,
  type EventContext,
  type EventVariableMapping,
} from './variables';

// ── plan ⇄ row ─────────────────────────────────────────────────

export { quietOf, eventContextOf };

/** Column values to store for a plan. */
export function planToColumns(plan: SendPlan): {
  send_at: string | null;
  status: 'scheduled' | 'skipped';
  skip_reason: EventSkipReason | null;
  moved_by_quiet_hours: boolean;
} {
  return {
    send_at: plan.sendAt ? plan.sendAt.toISOString() : null,
    status: plan.sendAt ? 'scheduled' : 'skipped',
    skip_reason: plan.skipReason,
    moved_by_quiet_hours: plan.movedByQuietHours,
  };
}

/**
 * Recompute send times for every reminder that has not gone out yet.
 * Called after the event moves, quiet hours change, or a paused campaign
 * resumes. Reminders that already left (queued/processing/failed) and
 * ones skipped on purpose (cancelled, no recipients) are never touched.
 */
export async function replanReminders(
  db: SupabaseClient,
  campaign: EventCampaignRow,
  now: Date = new Date(),
): Promise<void> {
  const { data, error } = await db
    .from('event_reminders')
    .select('id, offset_minutes, status, skip_reason')
    .eq('event_campaign_id', campaign.id)
    .in('status', ['scheduled', 'skipped']);
  if (error) throw new Error(`Failed to load reminders: ${error.message}`);

  const eventAt = new Date(campaign.event_at);
  const quiet = quietOf(campaign);
  const revivable: (EventSkipReason | null)[] = ['quiet_hours_after_event', 'already_past', 'campaign_paused'];

  for (const r of (data ?? []) as Pick<EventReminderRow, 'id' | 'offset_minutes' | 'status' | 'skip_reason'>[]) {
    if (r.status === 'skipped' && !revivable.includes(r.skip_reason)) continue;
    const plan = planReminder(eventAt, r.offset_minutes, quiet, now);
    // A reminder that has just come due (cron hasn't picked it up yet) must
    // not be skipped by an unrelated edit — leave it for the cron.
    if (r.status === 'scheduled' && plan.skipReason === 'already_past' && eventAt.getTime() > now.getTime()) {
      const due = planReminder(eventAt, r.offset_minutes, quiet, new Date(0));
      if (due.sendAt && now.getTime() - due.sendAt.getTime() < 5 * 60_000) continue;
    }
    const cols = planToColumns(plan);
    const { error: upErr } = await db.from('event_reminders').update(cols).eq('id', r.id);
    if (upErr) throw new Error(`Failed to update reminder: ${upErr.message}`);
  }
}

// ── input validation ───────────────────────────────────────────

export interface ValidatedReminder {
  offset_minutes: number;
  template_name: string;
  template_language: string;
  variables: Record<string, EventVariableMapping>;
  header_media_url: string | null;
}

/**
 * Check one reminder against the account's real templates and the event.
 * Returns the normalized row values, or a human-readable error.
 */
export async function validateReminderInput(
  db: SupabaseClient,
  accountId: string,
  input: ReminderInput,
  ev: EventContext,
): Promise<{ ok: true; value: ValidatedReminder } | { ok: false; error: string }> {
  const offsetErr = validateOffset(input.offset_minutes);
  if (offsetErr) return { ok: false, error: offsetErr };

  if (!input.template_name?.trim()) return { ok: false, error: 'Pick a template for every reminder.' };

  const resolved = await resolveTemplateRow(db, accountId, input.template_name, input.template_language);
  if (resolved.malformed) return { ok: false, error: `Template "${input.template_name}" is malformed.` };
  const tpl = resolved.row;
  if (!tpl) return { ok: false, error: `Template "${input.template_name}" was not found.` };
  if (tpl.status && tpl.status !== 'APPROVED') {
    return { ok: false, error: `Template "${tpl.name}" is not approved by WhatsApp yet.` };
  }

  // A URL button with a {{1}} needs a per-recipient value the event
  // reminder flow has no way to supply, so every send would fail.
  const dynamicButton = (tpl.buttons ?? []).some((b) => b.type === 'URL' && b.url.includes('{{'));
  if (dynamicButton) {
    return {
      ok: false,
      error: `Template "${tpl.name}" has a button link with a variable, which event reminders do not support yet.`,
    };
  }

  const vars = input.variables ?? {};
  for (const [key, m] of Object.entries(vars)) {
    if (!isKnownMapping(m)) return { ok: false, error: `{{${key}}} has an unknown source.` };
  }

  const placeholders = [...new Set((tpl.body_text.match(/\{\{(\d+)\}\}/g) ?? []).map((p) => p.replace(/[{}]/g, '')))];
  const unmapped = placeholders.filter((k) => !vars[k]);
  if (unmapped.length > 0) {
    return { ok: false, error: `Template "${tpl.name}" needs a value for ${unmapped.map((k) => `{{${k}}}`).join(', ')}.` };
  }
  // Only keep mappings the template actually uses.
  const used: Record<string, EventVariableMapping> = {};
  for (const k of placeholders) used[k] = vars[k];

  const problems = validateEventVariables(used, ev);
  if (problems.length > 0) return { ok: false, error: problems[0] };

  const isMedia = tpl.header_type === 'image' || tpl.header_type === 'video' || tpl.header_type === 'document';
  const headerUrl = (input.header_media_url ?? tpl.header_media_url ?? '').trim();
  if (isMedia && !/^https?:\/\//i.test(headerUrl)) {
    return { ok: false, error: `Template "${tpl.name}" has a media header and needs a media URL.` };
  }

  return {
    ok: true,
    value: {
      offset_minutes: input.offset_minutes,
      template_name: tpl.name,
      template_language: resolved.language,
      variables: used,
      header_media_url: isMedia ? headerUrl : null,
    },
  };
}

// ── audience ───────────────────────────────────────────────────

const PAGE = 1000;
const IN_CHUNK = 200;

async function contactIdsWithAnyTag(db: SupabaseClient, tagIds: string[]): Promise<Set<string>> {
  const ids = new Set<string>();
  if (tagIds.length === 0) return ids;
  // PostgREST caps a response at ~1000 rows, so page through.
  for (let from = 0; ; from += PAGE) {
    const { data, error } = await db
      .from('contact_tags')
      .select('contact_id')
      .in('tag_id', tagIds)
      .order('contact_id', { ascending: true })
      .range(from, from + PAGE - 1);
    if (error) throw new Error(`Failed to load tagged contacts: ${error.message}`);
    for (const row of data ?? []) ids.add(row.contact_id as string);
    if (!data || data.length < PAGE) break;
  }
  return ids;
}

/**
 * Who should get a reminder right now: contacts carrying ANY of the
 * campaign's audience tags, minus anyone with an exclude tag, minus
 * contacts who opted out, minus contacts with no phone number. Resolved
 * fresh each time so someone who registers after the event was created
 * still gets the remaining reminders.
 */
export async function resolveEventAudience(db: SupabaseClient, campaign: EventCampaignRow): Promise<Contact[]> {
  const included = await contactIdsWithAnyTag(db, campaign.audience_tag_ids);
  if (included.size === 0) return [];
  const excluded = await contactIdsWithAnyTag(db, campaign.exclude_tag_ids);
  const wanted = [...included].filter((id) => !excluded.has(id));

  const contacts: Contact[] = [];
  for (let i = 0; i < wanted.length; i += IN_CHUNK) {
    const { data, error } = await db
      .from('contacts')
      .select('*')
      .eq('account_id', campaign.account_id)
      .in('id', wanted.slice(i, i + IN_CHUNK));
    if (error) throw new Error(`Failed to load contacts: ${error.message}`);
    contacts.push(...((data ?? []) as Contact[]));
  }
  return contacts.filter((c) => c.subscription_status !== 'opted_out' && (c.phone ?? '').trim() !== '');
}

/** contactId → (customFieldId → value), for the custom fields a template actually uses. */
export async function fetchCustomValues(
  db: SupabaseClient,
  contactIds: string[],
  fieldIds: string[],
): Promise<Map<string, Map<string, string>>> {
  const index = new Map<string, Map<string, string>>();
  if (contactIds.length === 0 || fieldIds.length === 0) return index;
  for (let i = 0; i < contactIds.length; i += IN_CHUNK) {
    const { data, error } = await db
      .from('contact_custom_values')
      .select('contact_id, custom_field_id, value')
      .in('contact_id', contactIds.slice(i, i + IN_CHUNK))
      .in('custom_field_id', fieldIds);
    if (error) throw new Error(`Failed to load custom values: ${error.message}`);
    for (const row of data ?? []) {
      const bucket = index.get(row.contact_id as string) ?? new Map<string, string>();
      bucket.set(row.custom_field_id as string, (row.value as string | null) ?? '');
      index.set(row.contact_id as string, bucket);
    }
  }
  return index;
}