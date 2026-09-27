import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { createGetCurrentTimeTool } from '../tools/implementations/get-current-time.js';
import { createConvertTimeTool } from '../tools/implementations/convert-time.js';
import {
  MAX_THOUGHTS_PER_SESSION,
  createSequentialThinkingTool,
} from '../tools/implementations/sequential-thinking.js';
import {
  formatHourDifference,
  formatOffset,
  instantFromWallClock,
  isDaylightSaving,
  isValidTimeZone,
  localTimeZone,
  suggestTimeZones,
  timeInZone,
} from '../tools/time/tz.js';
import { collectEnvironmentFacts, environmentBullets } from '../environment-context.js';

type ToolExecute = (args: unknown) => Promise<Record<string, unknown>>;
function executeOf(toolObj: unknown): ToolExecute {
  return (toolObj as unknown as { execute: ToolExecute }).execute;
}

// ─── time-zone maths (fixed instants, so DST is deterministic) ────

describe('Phase 38 — time-zone maths', () => {
  it('renders a zone offset and wall clock for a fixed instant', () => {
    const tehran = timeInZone('Asia/Tehran', new Date('2026-07-01T12:00:00Z'));
    expect(tehran.datetime).toBe('2026-07-01T15:30:00+03:30');
    expect(tehran.utcOffset).toBe('GMT+03:30');
    expect(tehran.utcOffsetMinutes).toBe(210);
    expect(tehran.dayOfWeek).toBe('Wednesday');
    expect(tehran.isDST).toBe(false); // Iran abolished DST in 2022
  });

  it("uses the zone's own day, not UTC's, at the edges", () => {
    // 2026-09-25T21:30Z is already the 26th in Tehran (+03:30).
    const tehran = timeInZone('Asia/Tehran', new Date('2026-09-25T21:30:00Z'));
    expect(tehran.datetime.startsWith('2026-09-26T01:00:00')).toBe(true);
  });

  it('detects daylight saving in both hemispheres', () => {
    expect(isDaylightSaving('Europe/Berlin', new Date('2026-07-01T12:00:00Z'))).toBe(true);
    expect(isDaylightSaving('Europe/Berlin', new Date('2026-01-15T12:00:00Z'))).toBe(false);

    // Southern hemisphere: DST in January, standard in July.
    expect(isDaylightSaving('Australia/Sydney', new Date('2026-01-15T12:00:00Z'))).toBe(true);
    expect(isDaylightSaving('Australia/Sydney', new Date('2026-07-15T12:00:00Z'))).toBe(false);

    // No DST at all.
    expect(isDaylightSaving('Asia/Tehran', new Date('2026-07-01T12:00:00Z'))).toBe(false);
    expect(isDaylightSaving('UTC', new Date('2026-07-01T12:00:00Z'))).toBe(false);
  });

  it('formats fractional offsets the way ISO and the reference do', () => {
    expect(formatOffset(210)).toBe('+03:30');
    expect(formatOffset(-300)).toBe('-05:00');
    expect(formatOffset(345)).toBe('+05:45'); // Kathmandu
    expect(formatOffset(0)).toBe('+00:00');

    expect(formatHourDifference(210)).toBe('+3.5h');
    expect(formatHourDifference(-300)).toBe('-5.0h');
    expect(formatHourDifference(345)).toBe('+5.75h');
    expect(formatHourDifference(0)).toBe('0.0h');
  });

  it('solves the wall clock → instant conversion across a DST switch', () => {
    // Berlin is +02:00 in July (DST) and +01:00 in January.
    expect(instantFromWallClock('Europe/Berlin', '12:00', '2026-07-01')?.toISOString()).toBe(
      '2026-07-01T10:00:00.000Z'
    );
    expect(instantFromWallClock('Europe/Berlin', '12:00', '2026-01-15')?.toISOString()).toBe(
      '2026-01-15T11:00:00.000Z'
    );
    // Tehran has no DST: the same offset all year.
    expect(instantFromWallClock('Asia/Tehran', '09:30', '2026-07-01')?.toISOString()).toBe(
      '2026-07-01T06:00:00.000Z'
    );
  });

  it('rejects malformed times and dates', () => {
    expect(instantFromWallClock('UTC', '9:30')).toBeDefined(); // one-digit hour is fine
    expect(instantFromWallClock('UTC', '25:00')).toBeUndefined();
    expect(instantFromWallClock('UTC', '09:70')).toBeUndefined();
    expect(instantFromWallClock('UTC', 'half past nine')).toBeUndefined();
    expect(instantFromWallClock('UTC', '12:00', '01-01-2026')).toBeUndefined();
  });

  it('validates zones and suggests close matches', () => {
    expect(isValidTimeZone('Asia/Tehran')).toBe(true);
    expect(isValidTimeZone('Europe/Berlin')).toBe(true);
    expect(isValidTimeZone('Tehran')).toBe(false);
    expect(isValidTimeZone('')).toBe(false);

    const suggestions = suggestTimeZones('Asia/Tehrn');
    expect(suggestions).toContain('Asia/Tehran');
    expect(suggestTimeZones('tehran')).toContain('Asia/Tehran');
    expect(suggestTimeZones('xy')).toEqual([]);
  });

  it('reports a local zone that Intl accepts', () => {
    expect(isValidTimeZone(localTimeZone())).toBe(true);
  });
});

// ─── get_current_time ────────────────────────────────────────────

describe('Phase 38 — get_current_time', () => {
  let root: string;
  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'p38-time-'));
  });
  afterEach(() => {
    fs.rmSync(root, { recursive: true, force: true });
  });

  it('returns the reference fields plus the machine zone, for now', async () => {
    const execute = executeOf(createGetCurrentTimeTool(root));
    const result = (await execute({})) as Record<string, never> & {
      success: boolean;
      timezone: string;
      localTimeZone: string;
      datetime: string;
      dayOfWeek: string;
      isDST: boolean;
      utcOffset: string;
    };

    expect(result.success).toBe(true);
    expect(result.timezone).toBe(result.localTimeZone);
    expect(isValidTimeZone(result.timezone)).toBe(true);
    // ISO 8601 with an offset, seconds precision.
    expect(result.datetime).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}[+-]\d{2}:\d{2}$/);
    expect(result.dayOfWeek).toMatch(/^[A-Z][a-z]+$/);
    expect(typeof result.isDST).toBe('boolean');
  });

  it('answers for a requested zone, and for a requested day', async () => {
    const execute = executeOf(createGetCurrentTimeTool(root));
    const july = (await execute({ timezone: 'Europe/Berlin', date: '2026-07-01' })) as {
      success: boolean;
      datetime: string;
      isDST: boolean;
      utcOffset: string;
    };
    expect(july.success).toBe(true);
    expect(july.datetime).toBe('2026-07-01T14:00:00+02:00');
    expect(july.isDST).toBe(true);

    const january = (await execute({ timezone: 'Europe/Berlin', date: '2026-01-15' })) as {
      datetime: string;
      isDST: boolean;
      utcOffset: string;
    };
    expect(january.datetime).toBe('2026-01-15T13:00:00+01:00');
    expect(january.isDST).toBe(false);
    expect(january.utcOffset).toBe('GMT+01:00');
  });

  it('refuses an unknown zone with suggestions instead of pretending', async () => {
    const execute = executeOf(createGetCurrentTimeTool(root));
    const result = (await execute({ timezone: 'Asia/Tehrn' })) as {
      success: boolean;
      code: string;
      error: string;
    };
    expect(result.success).toBe(false);
    expect(result.code).toBe('INVALID_TIMEZONE');
    expect(result.error).toContain('Asia/Tehran');
  });

  it('refuses a malformed date', async () => {
    const execute = executeOf(createGetCurrentTimeTool(root));
    const result = (await execute({ date: '25/09/2026' })) as { success: boolean; code: string };
    expect(result.success).toBe(false);
    expect(result.code).toBe('INVALID_DATE');
  });
});

// ─── convert_time ────────────────────────────────────────────────

describe('Phase 38 — convert_time', () => {
  let root: string;
  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'p38-convert-'));
  });
  afterEach(() => {
    fs.rmSync(root, { recursive: true, force: true });
  });

  it('converts one zone to another and reports the difference', async () => {
    const execute = executeOf(createConvertTimeTool(root));
    const result = (await execute({
      sourceTimeZone: 'Asia/Tehran',
      time: '09:30',
      targetTimeZone: 'UTC',
      date: '2026-07-01',
    })) as {
      success: boolean;
      source: { datetime: string; utcOffset: string };
      target: { datetime: string; utcOffset: string };
      timeDifference: string;
    };

    expect(result.success).toBe(true);
    expect(result.source.datetime).toBe('2026-07-01T09:30:00+03:30');
    expect(result.source.utcOffset).toBe('GMT+03:30');
    expect(result.target.datetime).toBe('2026-07-01T06:00:00+00:00');
    expect(result.timeDifference).toBe('-3.5h');
  });

  it('crosses midnight and the day boundary correctly', async () => {
    const execute = executeOf(createConvertTimeTool(root));
    const result = (await execute({
      sourceTimeZone: 'Asia/Tehran',
      time: '23:00',
      targetTimeZone: 'America/New_York',
      date: '2026-01-15',
    })) as {
      source: { datetime: string; dayOfWeek: string };
      target: { datetime: string; dayOfWeek: string; isDST: boolean };
      timeDifference: string;
    };

    // 23:00 Tehran (+03:30) = 19:30 UTC = 14:30 EST (-05:00), same day.
    expect(result.source.datetime).toBe('2026-01-15T23:00:00+03:30');
    expect(result.target.datetime).toBe('2026-01-15T14:30:00-05:00');
    expect(result.target.isDST).toBe(false);
    expect(result.timeDifference).toBe('-8.5h');

    // And the other way round: a morning in New York is evening in Tehran.
    const back = (await execute({
      sourceTimeZone: 'America/New_York',
      time: '08:00',
      targetTimeZone: 'Asia/Tehran',
      date: '2026-01-15',
    })) as { target: { datetime: string; dayOfWeek: string } };
    expect(back.target.datetime).toBe('2026-01-15T16:30:00+03:30');
  });

  it('handles daylight saving on both sides of the conversion', async () => {
    const execute = executeOf(createConvertTimeTool(root));
    const summer = (await execute({
      sourceTimeZone: 'Europe/Berlin',
      time: '12:00',
      targetTimeZone: 'America/New_York',
      date: '2026-07-01',
    })) as { target: { datetime: string; isDST: boolean } };
    expect(summer.target.datetime).toBe('2026-07-01T06:00:00-04:00');
    expect(summer.target.isDST).toBe(true);

    // In January both are on standard time and the gap is an hour larger.
    const winter = (await execute({
      sourceTimeZone: 'Europe/Berlin',
      time: '12:00',
      targetTimeZone: 'America/New_York',
      date: '2026-01-15',
    })) as { target: { datetime: string; isDST: boolean } };
    expect(winter.target.datetime).toBe('2026-01-15T06:00:00-05:00');
    expect(winter.target.isDST).toBe(false);
  });

  it('converts to several zones in one call, with a per-zone difference', async () => {
    const execute = executeOf(createConvertTimeTool(root));
    const result = (await execute({
      sourceTimeZone: 'Asia/Tehran',
      time: '10:00',
      targetTimeZones: ['Europe/Berlin', 'Asia/Tokyo'],
      date: '2026-07-01',
    })) as {
      success: boolean;
      targets: Array<{ timezone: string; datetime: string; timeDifference: string }>;
      target?: unknown;
    };

    expect(result.targets.map((entry) => entry.timezone)).toEqual(['Europe/Berlin', 'Asia/Tokyo']);
    // 10:00 Tehran (+03:30) = 06:30 UTC = 08:30 Berlin (+02:00) = 15:30 Tokyo (+09:00).
    expect(result.targets[0]!.datetime).toBe('2026-07-01T08:30:00+02:00');
    expect(result.targets[0]!.timeDifference).toBe('-1.5h');
    expect(result.targets[1]!.datetime).toBe('2026-07-01T15:30:00+09:00');
    expect(result.targets[1]!.timeDifference).toBe('+5.5h');
    // The single-target convenience fields are absent for a multi-zone call.
    expect(result.target).toBeUndefined();
  });

  it('defaults the target to the machine zone and refuses bad input', async () => {
    const execute = executeOf(createConvertTimeTool(root));

    const local = (await execute({ sourceTimeZone: 'UTC', time: '12:00' })) as {
      success: boolean;
      targets: Array<{ timezone: string }>;
    };
    expect(local.targets[0]!.timezone).toBe(localTimeZone());

    const badZone = (await execute({
      sourceTimeZone: 'Mars/Olympus',
      time: '12:00',
      targetTimeZone: 'UTC',
    })) as { success: boolean; code: string };
    expect(badZone.code).toBe('INVALID_TIMEZONE');

    const badTime = (await execute({
      sourceTimeZone: 'UTC',
      time: '25:99',
      targetTimeZone: 'UTC',
    })) as { success: boolean; code: string };
    expect(badTime.code).toBe('INVALID_TIME');

    const badDate = (await execute({
      sourceTimeZone: 'UTC',
      time: '12:00',
      targetTimeZone: 'UTC',
      date: '01.01.2026',
    })) as { success: boolean; code: string };
    expect(badDate.code).toBe('INVALID_DATE');
  });

  it('deduplicates a target zone that is also given in the list', async () => {
    const execute = executeOf(createConvertTimeTool(root));
    const result = (await execute({
      sourceTimeZone: 'UTC',
      time: '12:00',
      targetTimeZone: 'Asia/Tokyo',
      targetTimeZones: ['Asia/Tokyo'],
    })) as { targets: Array<{ timezone: string }> };
    expect(result.targets).toHaveLength(1);
  });
});

// ─── sequentialthinking ──────────────────────────────────────────

describe('Phase 38 — sequentialthinking', () => {
  let root: string;
  const sessionFile = (id = 'default'): string =>
    path.join(root, '.ai-runtime', 'thinking', `${id}.json`);

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'p38-think-'));
  });
  afterEach(() => {
    fs.rmSync(root, { recursive: true, force: true });
  });

  it('records a step and reports the reference fields', async () => {
    const execute = executeOf(createSequentialThinkingTool(root));
    const result = (await execute({
      thought: 'First, understand what the bug report actually claims.',
      thoughtNumber: 1,
      totalThoughts: 3,
      nextThoughtNeeded: true,
    })) as {
      success: boolean;
      thoughtNumber: number;
      totalThoughts: number;
      nextThoughtNeeded: boolean;
      thoughtHistoryLength: number;
      branches: string[];
      remaining: number;
      formatted: string;
    };

    expect(result.success).toBe(true);
    expect(result.thoughtNumber).toBe(1);
    expect(result.totalThoughts).toBe(3);
    expect(result.thoughtHistoryLength).toBe(1);
    expect(result.branches).toEqual([]);
    expect(result.remaining).toBe(2);
    expect(result.formatted).toContain('1/3');
    expect(result.formatted).toContain('💭 Thought');

    // Persisted, atomically, where the plan said.
    const saved = JSON.parse(fs.readFileSync(sessionFile(), 'utf-8'));
    expect(saved.thoughts).toHaveLength(1);
    expect(saved.thoughts[0].thought).toContain('bug report');
  });

  it('raises the estimate when a step goes beyond it (reference behaviour)', async () => {
    const execute = executeOf(createSequentialThinkingTool(root));
    const result = (await execute({
      thought: 'A sixth step appeared.',
      thoughtNumber: 6,
      totalThoughts: 5,
      nextThoughtNeeded: true,
    })) as { totalThoughts: number; remaining: number };
    expect(result.totalThoughts).toBe(6);
    expect(result.remaining).toBe(0);
  });

  it('tracks branches and revisions, warning about a dangling revision', async () => {
    const execute = executeOf(createSequentialThinkingTool(root));
    await execute({ thought: 'base', thoughtNumber: 1, totalThoughts: 3, nextThoughtNeeded: true });
    const branch = (await execute({
      thought: 'explore option B',
      thoughtNumber: 2,
      totalThoughts: 3,
      nextThoughtNeeded: true,
      branchFromThought: 1,
      branchId: 'option-b',
    })) as { branches: string[]; branchLengths: Record<string, number>; formatted: string };
    expect(branch.branches).toEqual(['option-b']);
    expect(branch.branchLengths).toEqual({ 'option-b': 1 });
    expect(branch.formatted).toContain('🌿 Branch');

    const revision = (await execute({
      thought: 'actually the base claim is wrong',
      thoughtNumber: 3,
      totalThoughts: 3,
      nextThoughtNeeded: false,
      isRevision: true,
      revisesThought: 1,
    })) as { success: boolean; formatted: string; warnings?: string[] };
    expect(revision.success).toBe(true);
    expect(revision.formatted).toContain('🔄 Revision');
    expect(revision.warnings).toBeUndefined();

    const dangling = (await execute({
      thought: 'revising something that does not exist',
      thoughtNumber: 4,
      totalThoughts: 4,
      nextThoughtNeeded: false,
      isRevision: true,
      revisesThought: 99,
    })) as { warnings?: string[] };
    expect(dangling.warnings?.join(' ')).toContain('revisesThought 99');
  });

  it('persists across tool instances — a resumed run continues the chain', async () => {
    const first = executeOf(createSequentialThinkingTool(root));
    await first({
      thought: 'step one',
      thoughtNumber: 1,
      totalThoughts: 4,
      nextThoughtNeeded: true,
    });

    // A brand-new instance is what a new process/run looks like.
    const second = executeOf(createSequentialThinkingTool(root));
    const result = (await second({
      thought: 'step two, continuing',
      thoughtNumber: 2,
      totalThoughts: 4,
      nextThoughtNeeded: true,
    })) as { thoughtHistoryLength: number; remaining: number };

    expect(result.thoughtHistoryLength).toBe(2);
    expect(result.remaining).toBe(2);
  });

  it('keeps separate sessions apart', async () => {
    const execute = executeOf(createSequentialThinkingTool(root));
    await execute({
      thought: 'a',
      thoughtNumber: 1,
      totalThoughts: 2,
      nextThoughtNeeded: true,
      sessionId: 'alpha',
    });
    const beta = (await execute({
      thought: 'b',
      thoughtNumber: 1,
      totalThoughts: 2,
      nextThoughtNeeded: true,
      sessionId: 'beta',
    })) as { thoughtHistoryLength: number; sessionId: string };

    expect(beta.thoughtHistoryLength).toBe(1);
    expect(fs.existsSync(sessionFile('alpha'))).toBe(true);
    expect(fs.existsSync(sessionFile('beta'))).toBe(true);
  });

  it('refuses a session that hit the step ceiling', async () => {
    const file = sessionFile('full');
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(
      file,
      JSON.stringify({
        sessionId: 'full',
        updatedAt: new Date().toISOString(),
        thoughts: Array.from({ length: MAX_THOUGHTS_PER_SESSION }, (_, index) => ({
          thought: `step ${index + 1}`,
          thoughtNumber: index + 1,
          totalThoughts: MAX_THOUGHTS_PER_SESSION,
          nextThoughtNeeded: true,
          recordedAt: new Date().toISOString(),
        })),
      })
    );

    const execute = executeOf(createSequentialThinkingTool(root));
    const result = (await execute({
      thought: 'one more',
      thoughtNumber: MAX_THOUGHTS_PER_SESSION + 1,
      totalThoughts: MAX_THOUGHTS_PER_SESSION + 1,
      nextThoughtNeeded: false,
      sessionId: 'full',
    })) as { success: boolean; code: string; error: string };

    expect(result.success).toBe(false);
    expect(result.code).toBe('THINKING_LIMIT');
    expect(result.error).toContain('new session id');
  });

  it('starts a fresh chain when the session file is corrupt instead of failing the step', async () => {
    const file = sessionFile('broken');
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, '{ this is not json');

    const execute = executeOf(createSequentialThinkingTool(root));
    const result = (await execute({
      thought: 'recovering',
      thoughtNumber: 1,
      totalThoughts: 1,
      nextThoughtNeeded: false,
      sessionId: 'broken',
    })) as { success: boolean; thoughtHistoryLength: number };

    expect(result.success).toBe(true);
    expect(result.thoughtHistoryLength).toBe(1);
    // The broken file was replaced with a valid one.
    expect(() => JSON.parse(fs.readFileSync(file, 'utf-8'))).not.toThrow();
  });

  it('sanitises a session id so it can never escape the thinking directory', async () => {
    const execute = executeOf(createSequentialThinkingTool(root));
    await execute({
      thought: 'evil id',
      thoughtNumber: 1,
      totalThoughts: 1,
      nextThoughtNeeded: false,
      sessionId: '../../etc/passwd',
    });
    const dir = path.join(root, '.ai-runtime', 'thinking');
    const files = fs.readdirSync(dir);
    expect(files).toHaveLength(1);
    expect(files[0]).not.toContain('/');
    expect(files[0]).not.toContain('..');
  });
});

// ─── the clock in the environment block ─────────────────────────

describe('Phase 38 — the environment block carries the clock', () => {
  it('names the current time, its zone and its offset', () => {
    const facts = collectEnvironmentFacts();
    expect(isValidTimeZone(facts.now.timeZone)).toBe(true);
    expect(facts.now.formatted).toMatch(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/);
    expect(facts.now.utcOffset).toMatch(/^GMT[+-]\d{2}:\d{2}$/);
    expect(facts.now.dayOfWeek).toMatch(/^[A-Z][a-z]+$/);

    const bullets = environmentBullets(facts).join('\n');
    expect(bullets).toContain(`current time: ${facts.now.formatted.slice(0, 10)} (${facts.now.timeZone}`);
  });

  it('reports the clock for an injected platform too (deterministic parts)', () => {
    const facts = collectEnvironmentFacts({ SHELL: '/bin/bash' }, 'linux');
    const bullets = environmentBullets(facts).join('\n');
    expect(bullets).toContain('current time:');
    // The zone comes from the host, not the injected platform — documented behaviour.
    expect(isValidTimeZone(facts.now.timeZone)).toBe(true);
  });
});
