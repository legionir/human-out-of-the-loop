import { tool, type Tool } from 'ai';
import { z } from 'zod';
import {
  isValidTimeZone,
  localTimeZone,
  suggestTimeZones,
  timeInZone,
  type ZonedTime,
} from '../time/tz.js';

const inputSchema = z.object({
  timezone: z
    .string()
    .optional()
    .describe(
      "IANA time zone name, e.g. 'Asia/Tehran' or 'America/New_York'. Defaults to this machine's zone."
    ),
  date: z
    .string()
    .optional()
    .describe(
      "Ask for a specific day instead of now, as YYYY-MM-DD (the zone's offset that day is used)."
    ),
});

export interface GetCurrentTimeOutcome {
  success: boolean;
  timezone?: string;
  /** The machine's own zone, so the model knows what "local" meant. */
  localTimeZone?: string;
  datetime?: string;
  dayOfWeek?: string;
  isDST?: boolean;
  utcOffset?: string;
  utcOffsetMinutes?: number;
  formatted?: string;
  epochMs?: number;
  error?: string;
  code?: string;
}

type GetCurrentTimeInput = { timezone?: string; date?: string };

function toOutcome(time: ZonedTime, localZone: string): GetCurrentTimeOutcome {
  return {
    success: true,
    timezone: time.timezone,
    localTimeZone: localZone,
    datetime: time.datetime,
    dayOfWeek: time.dayOfWeek,
    isDST: time.isDST,
    utcOffset: time.utcOffset,
    utcOffsetMinutes: time.utcOffsetMinutes,
    formatted: time.formatted,
    epochMs: time.epochMs,
  };
}

/**
 * Phase 38: `get_current_time`, ported from the reference `time` server.
 *
 * A model without a clock invents dates — and a run whose plan says "check the
 * release from last week" is only as good as the model's idea of *now*. The
 * tool answers with the reference's four fields (timezone, datetime,
 * day_of_week, is_dst) plus the parts a prompt actually uses: the wall clock,
 * the UTC offset and the epoch. It also reports the **machine's** zone, so the
 * model can tell "the user's time" from "UTC".
 *
 * Two additions over the reference:
 *   - `date` asks about another day (offsets are date-dependent — a January
 *     question about Berlin is not the same as a July one);
 *   - an unknown zone is refused with the closest matches
 *     (`INVALID_TIMEZONE`: "did you mean Asia/Tehran?"), because a model that
 *     typed `Asia/Tehrn` would otherwise silently get UTC.
 */
export function createGetCurrentTimeTool(projectRoot: string) {
  void projectRoot; // time is not workspace-scoped; the factory signature is shared
  const localZone = localTimeZone();

  const getCurrentTimeTool: Tool<GetCurrentTimeInput, GetCurrentTimeOutcome> & {
    execute: (input: GetCurrentTimeInput) => Promise<GetCurrentTimeOutcome>;
  } = {
    description:
      'Returns the current date and time, optionally in a specific IANA time zone, with the day of ' +
      'the week, the UTC offset and whether daylight saving is in effect. Use it before writing ' +
      "anything that depends on today's date, instead of guessing.",
    inputSchema,
    execute: async ({ timezone, date }) => {
      const zone = timezone?.trim() || localZone;

      if (!isValidTimeZone(zone)) {
        const suggestions = suggestTimeZones(zone);
        return {
          success: false,
          error:
            `Unknown time zone "${zone}"` +
            (suggestions.length > 0 ? `. Did you mean ${suggestions.join(', ')}?` : '.'),
          code: 'INVALID_TIMEZONE',
        };
      }

      let instant: Date;
      if (date) {
        if (!/^\d{4}-\d{2}-\d{2}$/.test(date.trim())) {
          return {
            success: false,
            error: `Invalid date "${date}" — expected YYYY-MM-DD.`,
            code: 'INVALID_DATE',
          };
        }
        // Noon UTC of that day: the zone's offset at that moment is what the
        // caller is asking about, without the risk of a midnight edge case.
        instant = new Date(`${date.trim()}T12:00:00Z`);
        if (Number.isNaN(instant.getTime())) {
          return {
            success: false,
            error: `Invalid date "${date}" — expected YYYY-MM-DD.`,
            code: 'INVALID_DATE',
          };
        }
      } else {
        instant = new Date();
      }

      try {
        return toOutcome(timeInZone(zone, instant), localZone);
      } catch (err) {
        return {
          success: false,
          error: err instanceof Error ? err.message : String(err),
          code: 'INVALID_TIMEZONE',
        };
      }
    },
  };

  return tool(getCurrentTimeTool);
}
