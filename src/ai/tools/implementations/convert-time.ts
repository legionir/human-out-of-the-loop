import { tool, type Tool } from 'ai';
import {
  formatHourDifference,
  instantFromWallClock,
  isValidTimeZone,
  localTimeZone,
  suggestTimeZones,
  timeInZone,
  type ZonedTime,
} from '../time/tz.js';
import { z } from 'zod';

const inputSchema = z.object({
  sourceTimeZone: z.string().describe("IANA zone the given time is in, e.g. 'Asia/Tehran'"),
  time: z.string().describe('Wall-clock time in that zone, 24-hour HH:MM (e.g. "09:30")'),
  targetTimeZone: z
    .string()
    .optional()
    .describe("IANA zone to convert to, e.g. 'Europe/Berlin'. Defaults to this machine's zone."),
  targetTimeZones: z
    .array(z.string())
    .optional()
    .describe('Several zones at once — one call for "what time is that for everyone?"'),
  date: z
    .string()
    .optional()
    .describe('Convert within a specific day, YYYY-MM-DD (default: today in the source zone)'),
});

export interface ConvertTimeOutcome {
  success: boolean;
  source?: ZonedTime;
  target?: ZonedTime;
  targets?: Array<ZonedTime & { timeDifference: string }>;
  timeDifference?: string;
  error?: string;
  code?: string;
}

type ConvertTimeInput = {
  sourceTimeZone: string;
  time: string;
  targetTimeZone?: string;
  targetTimeZones?: string[];
  date?: string;
};

/**
 * Phase 38: `convert_time`, ported from the reference `time` server.
 *
 * "Standup is 09:30 my time — what is that for the reviewer in Berlin, and does
 * it cross midnight?" is the question this answers. The reference takes a list
 * of target zones and returns a `source`/`target` pair per zone plus a
 * `time_difference` string; that shape is kept (`targets`, each with its own
 * `timeDifference`) and a single-target call additionally fills `target` +
 * `timeDifference` so the common case stays easy to read.
 *
 * The wall-clock → instant conversion resolves the zone offset **for the target
 * day**, so it is right across a DST switch, and `date` makes that day
 * explicit (otherwise it is "today in the source zone" — the reference uses
 * today too, but silently).
 */
export function createConvertTimeTool(projectRoot: string) {
  void projectRoot; // the factory signature is shared with the workspace tools
  const localZone = localTimeZone();

  const convertTimeTool: Tool<ConvertTimeInput, ConvertTimeOutcome> & {
    execute: (input: ConvertTimeInput) => Promise<ConvertTimeOutcome>;
  } = {
    description:
      'Converts a wall-clock time (HH:MM) from one IANA time zone to one or more others, reporting ' +
      'each offset, whether daylight saving applies, and the hour difference between the zones.',
    inputSchema,
    execute: async ({ sourceTimeZone, time, targetTimeZone, targetTimeZones, date }) => {
      const source = sourceTimeZone?.trim();
      const requested = [...(targetTimeZone ? [targetTimeZone] : []), ...(targetTimeZones ?? [])]
        .map((zone) => zone.trim())
        .filter((zone) => zone !== '');
      const targets = requested.length > 0 ? [...new Set(requested)] : [localZone];

      const invalid: Array<{ zone: string; suggestions: string[] }> = [];
      for (const zone of [source, ...targets]) {
        if (!isValidTimeZone(zone)) invalid.push({ zone, suggestions: suggestTimeZones(zone) });
      }
      if (invalid.length > 0) {
        const [first] = invalid;
        return {
          success: false,
          error:
            `Unknown time zone "${first!.zone}"` +
            (first!.suggestions.length > 0
              ? `. Did you mean ${first!.suggestions.join(', ')}?`
              : '.'),
          code: 'INVALID_TIMEZONE',
        };
      }

      if (date && !/^\d{4}-\d{2}-\d{2}$/.test(date.trim())) {
        return {
          success: false,
          error: `Invalid date "${date}" — expected YYYY-MM-DD.`,
          code: 'INVALID_DATE',
        };
      }

      const instant = instantFromWallClock(source, time, date);
      if (!instant || Number.isNaN(instant.getTime())) {
        return {
          success: false,
          error: `Invalid time "${time}" — expected 24-hour HH:MM (e.g. "09:30").`,
          code: 'INVALID_TIME',
        };
      }

      const sourceTime = timeInZone(source, instant);
      const converted = targets.map((zone) => {
        const target = timeInZone(zone, instant);
        return {
          ...target,
          timeDifference: formatHourDifference(
            target.utcOffsetMinutes - sourceTime.utcOffsetMinutes
          ),
        };
      });

      return {
        success: true,
        source: sourceTime,
        targets: converted,
        ...(converted.length === 1
          ? { target: converted[0]!, timeDifference: converted[0]!.timeDifference }
          : {}),
      };
    },
  };

  return tool(convertTimeTool);
}
