/**
 * Phase 38 — time-zone maths for the `get_current_time` / `convert_time` tools,
 * ported from the reference `time` server (Python `zoneinfo` → `Intl`).
 *
 * Node has no `zoneinfo` module, but `Intl.DateTimeFormat` carries the full IANA
 * database, so the same questions are answered without a dependency:
 *
 *   - what is the offset of zone X at instant T (`longOffset` → "GMT+03:30"),
 *   - is that offset the *standard* one for X (January vs July comparison — the
 *     trick that works in both hemispheres without a tzdata table),
 *   - what does the clock read in X at instant T (wall-clock formatting),
 *   - and, for a rejected zone, what did the caller probably mean
 *     (`suggestTimeZones('tehran')` → `Asia/Tehran`).
 *
 * Every helper takes the instant explicitly, which is what makes the DST
 * behaviour testable from any host and on any date.
 */

/** One zone's view of an instant — the reference's `TimeResult` shape. */
export interface ZonedTime {
  timezone: string;
  /** ISO 8601 with the zone's offset, seconds precision (reference: `isoformat`). */
  datetime: string;
  /** `Monday` … `Sunday` in English. */
  dayOfWeek: string;
  isDST: boolean;
  /** `GMT+03:30` — how `Intl` describes the offset. */
  utcOffset: string;
  /** The same offset in minutes (195 for Tehran, for example). */
  utcOffsetMinutes: number;
  /** `2026-09-25 04:12:33` — the wall clock, for direct use in prose. */
  formatted: string;
  epochMs: number;
}

const ZONE_CACHE = new Map<string, Intl.DateTimeFormat>();

function formatterFor(timezone: string): Intl.DateTimeFormat {
  const cached = ZONE_CACHE.get(timezone);
  if (cached) return cached;
  const formatter = new Intl.DateTimeFormat('en-US', {
    timeZone: timezone,
    hour12: false,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    weekday: 'long',
  });
  ZONE_CACHE.set(timezone, formatter);
  return formatter;
}

/** True when `Intl` accepts the zone — the only reliable IANA validation. */
export function isValidTimeZone(timezone: string): boolean {
  if (typeof timezone !== 'string' || timezone.trim() === '') return false;
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: timezone }).format(new Date(0));
    return true;
  } catch {
    return false;
  }
}

/** The system zone, when Node can report one (falls back to UTC). */
export function localTimeZone(): string {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';
  } catch {
    return 'UTC';
  }
}

/**
 * Zones whose name looks like what the caller typed — the difference between
 * "Invalid timezone: Asia/Tehrn" and "did you mean Asia/Tehran?".
 */
/** Bounded Levenshtein distance — enough to catch a typo in a city name. */
function editDistance(a: string, b: string, max = 3): number {
  if (Math.abs(a.length - b.length) > max) return max + 1;
  let previous = Array.from({ length: b.length + 1 }, (_, index) => index);
  for (let i = 1; i <= a.length; i++) {
    const current = [i];
    for (let j = 1; j <= b.length; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      current[j] = Math.min(current[j - 1]! + 1, previous[j]! + 1, previous[j - 1]! + cost);
    }
    previous = current;
  }
  return previous[b.length]!;
}

export function suggestTimeZones(input: string, limit = 3): string[] {
  const needle = input.trim().toLowerCase().replace(/[\s_]/g, '/');
  if (needle.length < 3) return [];
  // The city half is what people mistype most: `Asia/Tehrn` → `tehran`.
  const needleCity = needle.split('/').pop() ?? needle;
  const zones: string[] =
    typeof (Intl as { supportedValuesOf?: (key: string) => string[] }).supportedValuesOf ===
    'function'
      ? (Intl as { supportedValuesOf: (key: string) => string[] }).supportedValuesOf('timeZone')
      : [];
  const scored = zones
    .map((zone) => {
      const lower = zone.toLowerCase();
      const city = lower.split('/').pop() ?? lower;
      let score = 0;
      if (lower === needle) score = 100;
      else if (city === needle) score = 90;
      else if (city.startsWith(needle)) score = 70;
      else if (lower.includes(needle)) score = 50;
      else if (needle.length >= 4 && city.includes(needle)) score = 30;
      else {
        // A typo, not a substring: compare the city halves (`Asia/Tehrn` vs
        // `Asia/Tehran`) and the whole names, allowing one or two edits.
        const cityDistance = editDistance(needleCity, city.replace(/[^a-z]/g, ''));
        const wholeDistance = editDistance(needle, lower);
        if (cityDistance <= 1 || wholeDistance <= 1) score = 80;
        else if (needleCity.length >= 5 && cityDistance <= 2) score = 60;
        else if (needle.length >= 6 && wholeDistance <= 2) score = 55;
      }
      return { zone, score };
    })
    .filter((entry) => entry.score > 0)
    .sort((a, b) => b.score - a.score || a.zone.localeCompare(b.zone));
  return scored.slice(0, limit).map((entry) => entry.zone);
}

/** `GMT+03:30` → 210 minutes; `GMT` → 0; `UTC` → 0. */
function offsetMinutes(timezone: string, instant: Date): number {
  const part = new Intl.DateTimeFormat('en-US', {
    timeZone: timezone,
    timeZoneName: 'longOffset',
  })
    .formatToParts(instant)
    .find((piece) => piece.type === 'timeZoneName')?.value;
  if (!part || part === 'GMT' || part === 'UTC') return 0;
  const match = /GMT([+-])(\d{1,2})(?::(\d{2}))?/.exec(part);
  if (!match) return 0;
  const sign = match[1] === '-' ? -1 : 1;
  return sign * (Number(match[2]) * 60 + Number(match[3] ?? 0));
}

/** `210` → `+03:30` (sign always present, the way ISO 8601 wants it). */
export function formatOffset(minutes: number): string {
  const sign = minutes < 0 ? '-' : '+';
  const absolute = Math.abs(minutes);
  const hours = String(Math.floor(absolute / 60)).padStart(2, '0');
  const mins = String(absolute % 60).padStart(2, '0');
  return `${sign}${hours}:${mins}`;
}

/**
 * Is the zone observing DST at this instant?
 *
 * Comparing the offset with the *standard* offset, taken as the smaller of the
 * January and July offsets: in the northern hemisphere July is DST (so January
 * is standard), in the southern hemisphere it is the other way round, and a
 * zone without DST has the same offset in both months.  That is a heuristic —
 * it matches every zone in the IANA database today — and it is documented as
 * one rather than pretending to be `timezone.dst()`.
 */
export function isDaylightSaving(timezone: string, instant: Date): boolean {
  const year = instant.getUTCFullYear();
  const january = offsetMinutes(timezone, new Date(Date.UTC(year, 0, 15, 12)));
  const july = offsetMinutes(timezone, new Date(Date.UTC(year, 6, 15, 12)));
  const standard = Math.min(january, july);
  return offsetMinutes(timezone, instant) !== standard;
}

/** Everything the model needs to know about one zone at one instant. */
export function timeInZone(timezone: string, instant: Date): ZonedTime {
  const parts = formatterFor(timezone).formatToParts(instant);
  const pick = (type: Intl.DateTimeFormatPartTypes): string =>
    parts.find((piece) => piece.type === type)?.value ?? '';

  const year = pick('year');
  const month = pick('month');
  const day = pick('day');
  const hour = pick('hour') === '24' ? '00' : pick('hour');
  const minute = pick('minute');
  const second = pick('second');
  const offset = offsetMinutes(timezone, instant);

  return {
    timezone,
    datetime: `${year}-${month}-${day}T${hour}:${minute}:${second}${formatOffset(offset)}`,
    dayOfWeek: pick('weekday'),
    isDST: isDaylightSaving(timezone, instant),
    utcOffset: `GMT${formatOffset(offset)}`,
    utcOffsetMinutes: offset,
    formatted: `${year}-${month}-${day} ${hour}:${minute}:${second}`,
    epochMs: instant.getTime(),
  };
}

/**
 * The wall-clock time `HH:MM` on `date` (or today) in `sourceTimeZone`, as an
 * instant.  Used by `convert_time`: the reference builds the same thing with
 * `datetime(...)` before calling `astimezone`.
 *
 * The UTC offset of a zone depends on the date, so the offset is resolved for
 * the target day — not for "now".
 */
export function instantFromWallClock(
  sourceTimeZone: string,
  time: string,
  date?: string
): Date | undefined {
  const match = /^(\d{1,2}):(\d{2})$/.exec(time.trim());
  if (!match) return undefined;
  const hour = Number(match[1]);
  const minute = Number(match[2]);
  if (hour > 23 || minute > 59) return undefined;

  let year: number;
  let month: number;
  let day: number;
  if (date) {
    const dateMatch = /^(\d{4})-(\d{2})-(\d{2})$/.exec(date.trim());
    if (!dateMatch) return undefined;
    year = Number(dateMatch[1]);
    month = Number(dateMatch[2]);
    day = Number(dateMatch[3]);
  } else {
    const now = timeInZone(sourceTimeZone, new Date());
    year = Number(now.datetime.slice(0, 4));
    month = Number(now.datetime.slice(5, 7));
    day = Number(now.datetime.slice(8, 10));
  }

  // Guess using the offset at that UTC instant, then correct once: the first
  // guess can land on the other side of a DST switch, which the second pass
  // fixes (a two-step solve, enough for every real zone).
  const guess = new Date(Date.UTC(year, month - 1, day, hour, minute));
  const firstOffset = offsetMinutes(sourceTimeZone, guess);
  let candidate = new Date(guess.getTime() - firstOffset * 60_000);
  const secondOffset = offsetMinutes(sourceTimeZone, candidate);
  if (secondOffset !== firstOffset) {
    candidate = new Date(guess.getTime() - secondOffset * 60_000);
  }
  return candidate;
}

/** `+3.5h` / `-5h` / `+5.75h` — the reference's `time_difference` string. */
export function formatHourDifference(minutes: number): string {
  const hours = minutes / 60;
  if (Number.isInteger(hours)) return `${hours > 0 ? '+' : ''}${hours.toFixed(1)}h`;
  const fixed = hours.toFixed(2).replace(/0+$/, '').replace(/\.$/, '');
  return `${hours > 0 ? '+' : ''}${fixed}h`;
}
