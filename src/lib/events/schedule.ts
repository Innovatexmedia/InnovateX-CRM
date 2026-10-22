/**
 * Event Campaign scheduling — pure functions, no I/O.
 *
 * Everything the user types is wall-clock India Standard Time (UTC+05:30,
 * no daylight saving), so IST maths is plain fixed-offset arithmetic and
 * does not depend on the server's timezone or ICU data.
 */

export const IST_OFFSET_MIN = 330;
const MIN = 60_000;
const DAY_MIN = 1440;

/** Longest allowed gap from the event, either side. Guards typos like "400 days". */
export const MAX_OFFSET_DAYS = 30;
export const MAX_OFFSET_MINUTES = MAX_OFFSET_DAYS * DAY_MIN;

export type OffsetUnit = 'minutes' | 'hours' | 'days';
export type OffsetDirection = 'before' | 'start' | 'after';

export interface QuietHours {
  enabled: boolean;
  /** "HH:mm" IST. */
  from: string;
  /** "HH:mm" IST. May be earlier than `from` (window crosses midnight). */
  to: string;
}

// ── offset helpers ─────────────────────────────────────────────

const UNIT_MIN: Record<OffsetUnit, number> = { minutes: 1, hours: 60, days: DAY_MIN };

/** (amount, unit, direction) → signed minutes from the event. */
export function toOffsetMinutes(
  amount: number,
  unit: OffsetUnit,
  direction: OffsetDirection,
): number {
  if (direction === 'start') return 0;
  const m = Math.round(amount) * UNIT_MIN[unit];
  return direction === 'before' ? -m : m;
}

/** Inverse of toOffsetMinutes, picking the largest unit that divides evenly. */
export function fromOffsetMinutes(offset: number): {
  amount: number;
  unit: OffsetUnit;
  direction: OffsetDirection;
} {
  if (offset === 0) return { amount: 0, unit: 'hours', direction: 'start' };
  const direction: OffsetDirection = offset < 0 ? 'before' : 'after';
  const abs = Math.abs(offset);
  if (abs % DAY_MIN === 0) return { amount: abs / DAY_MIN, unit: 'days', direction };
  if (abs % 60 === 0) return { amount: abs / 60, unit: 'hours', direction };
  return { amount: abs, unit: 'minutes', direction };
}

/** "1 day before", "2 hours after", "When it starts". */
export function offsetLabel(offset: number): string {
  const { amount, unit, direction } = fromOffsetMinutes(offset);
  if (direction === 'start') return 'When it starts';
  const noun = amount === 1 ? unit.slice(0, -1) : unit;
  return `${amount} ${noun} ${direction}`;
}

/** Returns an error message, or null when the offset is acceptable. */
export function validateOffset(offset: number): string | null {
  if (!Number.isInteger(offset)) return 'Reminder time must be a whole number of minutes.';
  if (Math.abs(offset) > MAX_OFFSET_MINUTES) {
    return `A reminder can be at most ${MAX_OFFSET_DAYS} days before or after the event.`;
  }
  return null;
}

// ── IST wall-clock helpers ─────────────────────────────────────

/** "HH:mm" → minutes since midnight, or null when malformed. */
export function parseHHmm(s: string): number | null {
  const m = /^([01]?\d|2[0-3]):([0-5]\d)$/.exec(s.trim());
  if (!m) return null;
  return Number(m[1]) * 60 + Number(m[2]);
}

function istParts(d: Date) {
  const shifted = new Date(d.getTime() + IST_OFFSET_MIN * MIN);
  return {
    year: shifted.getUTCFullYear(),
    month: shifted.getUTCMonth(),
    day: shifted.getUTCDate(),
    hour: shifted.getUTCHours(),
    minute: shifted.getUTCMinutes(),
  };
}

function istMinuteOfDay(d: Date): number {
  const p = istParts(d);
  return p.hour * 60 + p.minute;
}

/** "2026-11-01" + "19:00" (IST) → the instant. Returns null on bad input. */
export function istToDate(dateStr: string, timeStr: string): Date | null {
  const dm = /^(\d{4})-(\d{2})-(\d{2})$/.exec(dateStr.trim());
  const tm = parseHHmm(timeStr);
  if (!dm || tm === null) return null;
  const ms =
    Date.UTC(Number(dm[1]), Number(dm[2]) - 1, Number(dm[3]), 0, 0, 0) +
    tm * MIN -
    IST_OFFSET_MIN * MIN;
  const d = new Date(ms);
  return Number.isNaN(d.getTime()) ? null : d;
}

/** The instant → { date: "2026-11-01", time: "19:00" } in IST (for form inputs). */
export function dateToIstInputs(d: Date): { date: string; time: string } {
  const p = istParts(d);
  const pad = (n: number) => String(n).padStart(2, '0');
  return {
    date: `${p.year}-${pad(p.month + 1)}-${pad(p.day)}`,
    time: `${pad(p.hour)}:${pad(p.minute)}`,
  };
}

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

/** "1 Nov 2026" */
export function formatEventDate(d: Date): string {
  const p = istParts(d);
  return `${p.day} ${MONTHS[p.month]} ${p.year}`;
}

/** "7:00 PM" */
export function formatEventTime(d: Date): string {
  const p = istParts(d);
  const h12 = p.hour % 12 === 0 ? 12 : p.hour % 12;
  return `${h12}:${String(p.minute).padStart(2, '0')} ${p.hour < 12 ? 'AM' : 'PM'}`;
}

/** "1 Nov 2026, 7:00 PM" */
export function formatEventDateTime(d: Date): string {
  return `${formatEventDate(d)}, ${formatEventTime(d)}`;
}

// ── send-time computation ──────────────────────────────────────

export type SkipReason = 'quiet_hours_after_event' | 'already_past';

export interface SendPlan {
  /** When it will go out; null when it never will. */
  sendAt: Date | null;
  /** True when quiet hours pushed it later than event + offset. */
  movedByQuietHours: boolean;
  skipReason: SkipReason | null;
}

function inQuietWindow(minuteOfDay: number, from: number, to: number): boolean {
  if (from === to) return false;
  return from < to
    ? minuteOfDay >= from && minuteOfDay < to
    : minuteOfDay >= from || minuteOfDay < to;
}

/**
 * Event time + offset, then quiet hours.
 *
 *  - A reminder that lands inside the quiet window is moved to the END
 *    of the window (e.g. 02:00 → 08:00).
 *  - If that move would push a "before" or "when it starts" reminder past
 *    the event itself, it is skipped: "1 hour before" is useless once
 *    the event has begun.
 *  - "After" reminders may be moved freely.
 *  - Anything already in the past (relative to `now`) is skipped.
 */
export function planReminder(
  eventAt: Date,
  offsetMinutes: number,
  quiet: QuietHours,
  now: Date = new Date(),
): SendPlan {
  const rawMs = eventAt.getTime() + offsetMinutes * MIN;
  // Work on whole minutes: the cron runs once a minute, and window
  // boundaries are minute-aligned.
  let sendMs = Math.floor(rawMs / MIN) * MIN;
  let moved = false;

  const from = parseHHmm(quiet.from);
  const to = parseHHmm(quiet.to);
  if (quiet.enabled && from !== null && to !== null && from !== to) {
    const m = istMinuteOfDay(new Date(sendMs));
    if (inQuietWindow(m, from, to)) {
      const untilEnd = (to - m + DAY_MIN) % DAY_MIN;
      sendMs += untilEnd * MIN;
      moved = true;
    }
  }

  if (moved && offsetMinutes <= 0 && sendMs > eventAt.getTime()) {
    return { sendAt: null, movedByQuietHours: true, skipReason: 'quiet_hours_after_event' };
  }
  if (sendMs < now.getTime()) {
    return { sendAt: null, movedByQuietHours: moved, skipReason: 'already_past' };
  }
  return { sendAt: new Date(sendMs), movedByQuietHours: moved, skipReason: null };
}