import { describe, expect, it } from 'vitest';

import {
  dateToIstInputs,
  formatEventDate,
  formatEventDateTime,
  formatEventTime,
  fromOffsetMinutes,
  istToDate,
  offsetLabel,
  parseHHmm,
  planReminder,
  toOffsetMinutes,
  validateOffset,
  type QuietHours,
} from './schedule';

const QUIET: QuietHours = { enabled: true, from: '22:00', to: '08:00' };
const OFF: QuietHours = { enabled: false, from: '22:00', to: '08:00' };
// Long before every event used below, so "already past" never interferes.
const NOW = new Date('2026-10-01T00:00:00Z');

const ev = (date: string, time: string) => istToDate(date, time)!;
const ist = (d: Date | null) => (d ? `${dateToIstInputs(d).date} ${dateToIstInputs(d).time}` : null);

describe('IST helpers', () => {
  it('converts IST wall-clock to the right instant', () => {
    expect(istToDate('2026-11-01', '19:00')!.toISOString()).toBe('2026-11-01T13:30:00.000Z');
    // IST midnight is the previous day in UTC.
    expect(istToDate('2026-11-01', '00:00')!.toISOString()).toBe('2026-10-31T18:30:00.000Z');
  });

  it('rejects malformed input', () => {
    expect(istToDate('01-11-2026', '19:00')).toBeNull();
    expect(istToDate('2026-11-01', '25:00')).toBeNull();
    expect(parseHHmm('7pm')).toBeNull();
    expect(parseHHmm('07:05')).toBe(425);
  });

  it('round-trips through the form inputs', () => {
    const d = ev('2026-11-01', '19:30');
    expect(dateToIstInputs(d)).toEqual({ date: '2026-11-01', time: '19:30' });
  });

  it('formats date and time the way templates will show them', () => {
    const d = ev('2026-11-01', '19:00');
    expect(formatEventDate(d)).toBe('1 Nov 2026');
    expect(formatEventTime(d)).toBe('7:00 PM');
    expect(formatEventDateTime(d)).toBe('1 Nov 2026, 7:00 PM');
    expect(formatEventTime(ev('2026-11-01', '00:05'))).toBe('12:05 AM');
    expect(formatEventTime(ev('2026-11-01', '12:00'))).toBe('12:00 PM');
  });
});

describe('offsets', () => {
  it('turns amount/unit/direction into signed minutes and back', () => {
    expect(toOffsetMinutes(1, 'days', 'before')).toBe(-1440);
    expect(toOffsetMinutes(2, 'hours', 'after')).toBe(120);
    expect(toOffsetMinutes(99, 'minutes', 'start')).toBe(0);
    expect(fromOffsetMinutes(-1440)).toEqual({ amount: 1, unit: 'days', direction: 'before' });
    expect(fromOffsetMinutes(-90)).toEqual({ amount: 90, unit: 'minutes', direction: 'before' });
    expect(fromOffsetMinutes(0).direction).toBe('start');
  });

  it('labels with correct singular/plural', () => {
    expect(offsetLabel(-1440)).toBe('1 day before');
    expect(offsetLabel(-2880)).toBe('2 days before');
    expect(offsetLabel(-60)).toBe('1 hour before');
    expect(offsetLabel(-15)).toBe('15 minutes before');
    expect(offsetLabel(0)).toBe('When it starts');
    expect(offsetLabel(120)).toBe('2 hours after');
  });

  it('caps how far from the event a reminder can be', () => {
    expect(validateOffset(-30 * 1440)).toBeNull();
    expect(validateOffset(-31 * 1440)).toMatch(/at most 30 days/);
    expect(validateOffset(1.5)).toMatch(/whole number/);
  });
});

describe('planReminder', () => {
  const event = ev('2026-11-01', '19:00');

  it('sends at event time + offset when quiet hours do not apply', () => {
    const p = planReminder(event, -1440, QUIET, NOW);
    expect(ist(p.sendAt)).toBe('2026-10-31 19:00');
    expect(p.movedByQuietHours).toBe(false);
    expect(p.skipReason).toBeNull();
  });

  it('does not move a reminder when quiet hours are off', () => {
    const night = ev('2026-11-01', '03:00');
    const p = planReminder(night, -60, OFF, NOW);
    expect(ist(p.sendAt)).toBe('2026-11-01 02:00');
    expect(p.movedByQuietHours).toBe(false);
  });

  it('moves a night-time reminder to the end of the window', () => {
    // Event 11:00, 9 hours before = 02:00 → inside 22:00–08:00 → 08:00.
    const p = planReminder(ev('2026-11-01', '11:00'), -540, QUIET, NOW);
    expect(ist(p.sendAt)).toBe('2026-11-01 08:00');
    expect(p.movedByQuietHours).toBe(true);
  });

  it('treats the window start as quiet and the window end as open', () => {
    // 22:00 exactly is quiet → moved to 08:00 next day (an after-reminder, so allowed).
    const late = planReminder(ev('2026-11-02', '21:00'), 60, QUIET, NOW);
    expect(ist(late.sendAt)).toBe('2026-11-03 08:00');
    expect(late.movedByQuietHours).toBe(true);
    // 21:59 is fine.
    const fine = planReminder(ev('2026-11-02', '22:59'), -60, QUIET, NOW);
    expect(ist(fine.sendAt)).toBe('2026-11-02 21:59');
    expect(fine.movedByQuietHours).toBe(false);
    // 08:00 exactly is open.
    const open = planReminder(ev('2026-11-02', '09:00'), -60, QUIET, NOW);
    expect(ist(open.sendAt)).toBe('2026-11-02 08:00');
    expect(open.movedByQuietHours).toBe(false);
  });

  it('skips a before-reminder whose shift would land after the event starts', () => {
    // Event 07:00, 3 hours before = 04:00 → moved to 08:00 > 07:00 → skipped.
    const p = planReminder(ev('2026-11-01', '07:00'), -180, QUIET, NOW);
    expect(p.sendAt).toBeNull();
    expect(p.skipReason).toBe('quiet_hours_after_event');
  });

  it('skips a "when it starts" reminder that falls in quiet hours', () => {
    const p = planReminder(ev('2026-11-01', '06:00'), 0, QUIET, NOW);
    expect(p.skipReason).toBe('quiet_hours_after_event');
  });

  it('moves an after-reminder instead of skipping it', () => {
    // Event 21:00 + 2h = 23:00 → 08:00 next day.
    const p = planReminder(ev('2026-11-01', '21:00'), 120, QUIET, NOW);
    expect(ist(p.sendAt)).toBe('2026-11-02 08:00');
    expect(p.movedByQuietHours).toBe(true);
    expect(p.skipReason).toBeNull();
  });

  it('handles a window that does not cross midnight', () => {
    const lunch: QuietHours = { enabled: true, from: '13:00', to: '15:00' };
    const p = planReminder(ev('2026-11-01', '14:30'), 0, lunch, NOW);
    // "when it starts" inside the window → pushed past the event → skipped.
    expect(p.skipReason).toBe('quiet_hours_after_event');
    const after = planReminder(ev('2026-11-01', '12:30'), 60, lunch, NOW);
    expect(ist(after.sendAt)).toBe('2026-11-01 15:00');
  });

  it('ignores a degenerate window (from === to) and bad times', () => {
    const same: QuietHours = { enabled: true, from: '22:00', to: '22:00' };
    expect(planReminder(ev('2026-11-01', '03:00'), -60, same, NOW).movedByQuietHours).toBe(false);
    const bad: QuietHours = { enabled: true, from: 'x', to: 'y' };
    expect(planReminder(ev('2026-11-01', '03:00'), -60, bad, NOW).movedByQuietHours).toBe(false);
  });

  it('skips anything already in the past', () => {
    const now = ev('2026-11-01', '18:30');
    const p = planReminder(event, -60, OFF, now); // wanted 18:00
    expect(p.sendAt).toBeNull();
    expect(p.skipReason).toBe('already_past');
  });

  it('keeps a reminder due exactly now', () => {
    const now = ev('2026-11-01', '18:00');
    const p = planReminder(event, -60, OFF, now);
    expect(ist(p.sendAt)).toBe('2026-11-01 18:00');
  });

  it('follows the event when it is rescheduled', () => {
    const before = planReminder(ev('2026-11-01', '19:00'), -60, QUIET, NOW);
    const after = planReminder(ev('2026-11-01', '20:00'), -60, QUIET, NOW);
    expect(ist(before.sendAt)).toBe('2026-11-01 18:00');
    expect(ist(after.sendAt)).toBe('2026-11-01 19:00');
  });
});