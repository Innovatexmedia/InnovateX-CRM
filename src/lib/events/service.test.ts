import { describe, expect, it } from 'vitest';
import type { SupabaseClient } from '@supabase/supabase-js';

import { istToDate } from './schedule';
import { replanReminders, validateReminderInput } from './service';
import type { EventCampaignRow } from './types';
import type { EventContext } from './variables';

// ── fakes ──────────────────────────────────────────────────────

type Row = Record<string, unknown>;

/** Just enough of the query builder for resolveTemplateRow: select().eq().eq() then await. */
function templatesDb(rows: Row[]): SupabaseClient {
  return {
    from() {
      let result = rows;
      const b = {
        select: () => b,
        eq: (col: string, val: unknown) => {
          result = result.filter((r) => r[col] === val);
          return b;
        },
        then: (resolve: (v: { data: Row[] }) => void) => resolve({ data: result }),
      };
      return b;
    },
  } as unknown as SupabaseClient;
}

const tpl = (over: Row = {}): Row => ({
  id: 't1',
  user_id: 'u1',
  account_id: 'acc',
  name: 'event_reminder_1day',
  language: 'en',
  status: 'APPROVED',
  body_text: 'Hi {{1}}, {{2}} is on {{3}} IST.',
  header_type: null,
  buttons: [],
  ...over,
});

const ev: EventContext = {
  name: 'Free Wealth Webinar',
  eventAt: istToDate('2026-11-01', '19:00')!,
  joinLink: 'https://zoom.us/j/1',
  location: null,
};

const goodVars = {
  '1': { type: 'field', value: 'first_name', fallback: 'there' },
  '2': { type: 'event', value: 'event_name' },
  '3': { type: 'event', value: 'event_datetime' },
} as const;

const input = (over: Row = {}) => ({
  offset_minutes: -1440,
  template_name: 'event_reminder_1day',
  template_language: 'en',
  variables: { ...goodVars },
  ...over,
});

// ── validateReminderInput ──────────────────────────────────────

describe('validateReminderInput', () => {
  it('accepts an approved template with every placeholder mapped', async () => {
    const r = await validateReminderInput(templatesDb([tpl()]), 'acc', input(), ev);
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.value.template_name).toBe('event_reminder_1day');
      expect(r.value.template_language).toBe('en');
      expect(Object.keys(r.value.variables)).toEqual(['1', '2', '3']);
    }
  });

  it('drops mappings the template does not use', async () => {
    const r = await validateReminderInput(
      templatesDb([tpl()]),
      'acc',
      input({ variables: { ...goodVars, '9': { type: 'static', value: 'x' } } }),
      ev,
    );
    expect(r.ok && Object.keys(r.value.variables)).toEqual(['1', '2', '3']);
  });

  it('rejects an unknown template', async () => {
    const r = await validateReminderInput(templatesDb([]), 'acc', input(), ev);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toMatch(/not found/);
  });

  it('rejects a template that is not approved', async () => {
    const r = await validateReminderInput(templatesDb([tpl({ status: 'PENDING' })]), 'acc', input(), ev);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toMatch(/not approved/);
  });

  it("does not see another account's template", async () => {
    const r = await validateReminderInput(templatesDb([tpl({ account_id: 'other' })]), 'acc', input(), ev);
    expect(r.ok).toBe(false);
  });

  it('rejects a placeholder with no mapping', async () => {
    const r = await validateReminderInput(
      templatesDb([tpl()]),
      'acc',
      input({ variables: { '1': goodVars['1'], '2': goodVars['2'] } }),
      ev,
    );
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toMatch(/\{\{3\}\}/);
  });

  it('rejects a join-link variable when the event has no link', async () => {
    const t = tpl({ body_text: 'Join: {{1}}. Bye.' });
    const r = await validateReminderInput(
      templatesDb([t]),
      'acc',
      input({ variables: { '1': { type: 'event', value: 'join_link' } } }),
      { ...ev, joinLink: '' },
    );
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toMatch(/join link/);
  });

  it('rejects a template whose button link carries a variable', async () => {
    const t = tpl({ buttons: [{ type: 'URL', text: 'Open', url: 'https://x.com/{{1}}' }] });
    const r = await validateReminderInput(templatesDb([t]), 'acc', input(), ev);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toMatch(/button link/);
  });

  it('requires a media URL for a media header', async () => {
    const t = tpl({ header_type: 'image' });
    const bad = await validateReminderInput(templatesDb([t]), 'acc', input(), ev);
    expect(bad.ok).toBe(false);
    const good = await validateReminderInput(
      templatesDb([t]),
      'acc',
      input({ header_media_url: 'https://cdn.example.com/a.png' }),
      ev,
    );
    expect(good.ok && good.value.header_media_url).toBe('https://cdn.example.com/a.png');
  });

  it('rejects an offset too far from the event', async () => {
    const r = await validateReminderInput(templatesDb([tpl()]), 'acc', input({ offset_minutes: -40 * 1440 }), ev);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toMatch(/30 days/);
  });
});

// ── replanReminders ────────────────────────────────────────────

interface ReminderRow {
  id: string;
  offset_minutes: number;
  status: string;
  skip_reason: string | null;
}

/** Fake for replanReminders: select().eq().in() → rows; update().eq('id') → recorded. */
function remindersDb(rows: ReminderRow[], updates: Record<string, Row>): SupabaseClient {
  return {
    from() {
      let pendingUpdate: Row | null = null;
      const b = {
        select: () => b,
        update: (cols: Row) => {
          pendingUpdate = cols;
          return b;
        },
        eq: (col: string, val: unknown) => {
          if (pendingUpdate && col === 'id') {
            updates[val as string] = pendingUpdate;
            return Promise.resolve({ error: null });
          }
          return b;
        },
        in: () => Promise.resolve({ data: rows, error: null }),
      };
      return b;
    },
  } as unknown as SupabaseClient;
}

const campaign = (eventAt: Date): EventCampaignRow => ({
  id: 'c1',
  account_id: 'acc',
  user_id: 'u1',
  name: 'Webinar',
  event_at: eventAt.toISOString(),
  location: null,
  join_link: null,
  audience_tag_ids: ['tag'],
  exclude_tag_ids: [],
  quiet_enabled: true,
  quiet_from: '22:00',
  quiet_to: '08:00',
  status: 'active',
  created_at: '',
  updated_at: '',
});

describe('replanReminders', () => {
  const NOW = new Date('2026-10-01T00:00:00Z');

  it('re-times unsent reminders when the event moves', async () => {
    const updates: Record<string, Row> = {};
    const db = remindersDb(
      [
        { id: 'r1', offset_minutes: -60, status: 'scheduled', skip_reason: null },
        { id: 'r2', offset_minutes: -1440, status: 'scheduled', skip_reason: null },
      ],
      updates,
    );
    await replanReminders(db, campaign(istToDate('2026-11-01', '20:00')!), NOW);
    // 1 hour before 20:00 IST = 19:00 IST = 13:30 UTC
    expect(updates.r1.send_at).toBe('2026-11-01T13:30:00.000Z');
    expect(updates.r1.status).toBe('scheduled');
    expect(updates.r2.send_at).toBe('2026-10-31T14:30:00.000Z');
  });

  it('revives a reminder that was skipped for quiet hours / past time', async () => {
    const updates: Record<string, Row> = {};
    const db = remindersDb(
      [{ id: 'r1', offset_minutes: -60, status: 'skipped', skip_reason: 'already_past' }],
      updates,
    );
    await replanReminders(db, campaign(istToDate('2026-11-01', '20:00')!), NOW);
    expect(updates.r1.status).toBe('scheduled');
    expect(updates.r1.skip_reason).toBeNull();
  });

  it('leaves a deliberately skipped reminder (cancelled / no recipients) alone', async () => {
    const updates: Record<string, Row> = {};
    const db = remindersDb(
      [
        { id: 'r1', offset_minutes: -60, status: 'skipped', skip_reason: 'cancelled' },
        { id: 'r2', offset_minutes: -30, status: 'skipped', skip_reason: 'no_recipients' },
      ],
      updates,
    );
    await replanReminders(db, campaign(istToDate('2026-11-01', '20:00')!), NOW);
    expect(Object.keys(updates)).toEqual([]);
  });

  it('skips a reminder when the event moves so close that its time has passed', async () => {
    const updates: Record<string, Row> = {};
    const db = remindersDb([{ id: 'r1', offset_minutes: -1440, status: 'scheduled', skip_reason: null }], updates);
    const soon = new Date(NOW.getTime() + 3 * 3600_000); // event in 3h → "1 day before" already passed
    await replanReminders(db, campaign(soon), NOW);
    expect(updates.r1.status).toBe('skipped');
    expect(updates.r1.skip_reason).toBe('already_past');
    expect(updates.r1.send_at).toBeNull();
  });
});