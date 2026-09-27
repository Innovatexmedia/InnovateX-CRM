/**
 * Zero-dependency IANA timezone helpers built entirely on `Intl`, so
 * scheduling a campaign in a timezone other than the browser's own
 * still lands on the correct UTC instant. No `date-fns-tz`/`luxon` —
 * this project can't `npm install` new packages in some environments,
 * and `Intl` alone is enough for this.
 */

/** A hand-picked, common set of IANA zones — used as a fallback when
 *  `Intl.supportedValuesOf` isn't available (older runtimes). Modern
 *  Node (>=20, which this project already requires) and modern
 *  browsers both support it, so this list is rarely actually used. */
const FALLBACK_ZONES = [
  'UTC',
  'America/Los_Angeles',
  'America/Denver',
  'America/Chicago',
  'America/New_York',
  'America/Sao_Paulo',
  'Europe/London',
  'Europe/Paris',
  'Europe/Berlin',
  'Europe/Moscow',
  'Africa/Lagos',
  'Africa/Johannesburg',
  'Asia/Dubai',
  'Asia/Karachi',
  'Asia/Kolkata',
  'Asia/Dhaka',
  'Asia/Bangkok',
  'Asia/Jakarta',
  'Asia/Shanghai',
  'Asia/Singapore',
  'Asia/Tokyo',
  'Asia/Seoul',
  'Australia/Sydney',
  'Pacific/Auckland',
];

/** The browser/server's own IANA timezone, e.g. "Asia/Kolkata". */
export function getLocalTimeZone(): string {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';
  } catch {
    return 'UTC';
  }
}

/** Every IANA zone the runtime knows about, sorted alphabetically. */
export function listTimeZones(): string[] {
  try {
    const supported = (
      Intl as unknown as { supportedValuesOf?: (key: string) => string[] }
    ).supportedValuesOf?.('timeZone');
    if (supported && supported.length > 0) return supported;
  } catch {
    // fall through to the fallback list
  }
  return FALLBACK_ZONES;
}

/**
 * The UTC offset (in minutes, UTC minus local — i.e. what you'd add to
 * a UTC instant to get that zone's wall-clock time) that `timeZone`
 * observes at `instant`. Handles DST because it reads the offset at
 * the specific instant, not a fixed value.
 */
export function getTimeZoneOffsetMinutes(instant: Date, timeZone: string): number {
  const dtf = new Intl.DateTimeFormat('en-US', {
    timeZone,
    hourCycle: 'h23',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  });
  const parts = dtf.formatToParts(instant).reduce<Record<string, string>>((acc, p) => {
    acc[p.type] = p.value;
    return acc;
  }, {});
  // "24:00" from hourCycle h23 for midnight rolled to the next day —
  // Intl sometimes emits hour "24"; normalize it to "00".
  const hour = parts.hour === '24' ? '00' : parts.hour;
  const asUtc = Date.UTC(
    Number(parts.year),
    Number(parts.month) - 1,
    Number(parts.day),
    Number(hour),
    Number(parts.minute),
    Number(parts.second),
  );
  return (asUtc - instant.getTime()) / 60000;
}

/**
 * The short abbreviation/offset a timezone shows for `instant`, e.g.
 * "GMT+5:30" or "PST" — whatever the runtime's locale data has.
 */
export function getTimeZoneAbbreviation(timeZone: string, instant: Date = new Date()): string {
  try {
    const parts = new Intl.DateTimeFormat('en-US', {
      timeZone,
      timeZoneName: 'shortOffset',
    }).formatToParts(instant);
    const tzPart = parts.find((p) => p.type === 'timeZoneName');
    return tzPart?.value ?? timeZone;
  } catch {
    return timeZone;
  }
}

/** "Asia/Kolkata (GMT+5:30)" — the label shown in the timezone picker. */
export function formatTimeZoneLabel(timeZone: string, instant: Date = new Date()): string {
  return `${timeZone.replace(/_/g, ' ')} (${getTimeZoneAbbreviation(timeZone, instant)})`;
}

/**
 * Converts a wall-clock date + time as observed in `timeZone` into the
 * actual UTC instant it refers to. `dateStr` is "YYYY-MM-DD" (an
 * <input type="date"> value), `timeStr` is "HH:mm" (an
 * <input type="time"> value).
 *
 * Two-pass: guess the instant assuming UTC, read that zone's offset at
 * the guess, correct, then re-read the offset at the corrected instant
 * (covers the rare case where the first guess landed on the wrong
 * side of a DST transition).
 */
export function zonedTimeToUtc(dateStr: string, timeStr: string, timeZone: string): Date {
  const [year, month, day] = dateStr.split('-').map(Number);
  const [hour, minute] = timeStr.split(':').map(Number);
  const guessUtcMs = Date.UTC(year, (month ?? 1) - 1, day ?? 1, hour ?? 0, minute ?? 0);

  const offset1 = getTimeZoneOffsetMinutes(new Date(guessUtcMs), timeZone);
  const correctedMs = guessUtcMs - offset1 * 60000;

  const offset2 = getTimeZoneOffsetMinutes(new Date(correctedMs), timeZone);
  const finalMs = guessUtcMs - offset2 * 60000;

  return new Date(finalMs);
}

/** The inverse — given a UTC instant, the "YYYY-MM-DD" and "HH:mm"
 *  wall-clock strings that `timeZone` would show for it. */
export function utcToZonedParts(
  instant: Date,
  timeZone: string,
): { date: string; time: string } {
  const dtf = new Intl.DateTimeFormat('en-CA', {
    timeZone,
    hourCycle: 'h23',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
  });
  const parts = dtf.formatToParts(instant).reduce<Record<string, string>>((acc, p) => {
    acc[p.type] = p.value;
    return acc;
  }, {});
  const hour = parts.hour === '24' ? '00' : parts.hour;
  return {
    date: `${parts.year}-${parts.month}-${parts.day}`,
    time: `${hour}:${parts.minute}`,
  };
}