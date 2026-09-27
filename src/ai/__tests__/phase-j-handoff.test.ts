/**
 * J-04 — structured step handoff: dependents see {changedFiles,keyResult,notes},
 * not the predecessor's full resultSummary.
 */
import { describe, it, expect } from 'vitest';
import { extractHandoff, formatHandoff } from '../runtime/handoff.js';
import { buildStepPrompt } from '../runtime/step-prompt.js';
import type { Plan } from '../schemas/plan.js';

function planWithDep(summary: string, handoff?: Plan['steps'][number]['handoff']): Plan {
  return {
    id: 'plan_h',
    goal: 'Ship login',
    clarifications: [],
    status: 'running',
    steps: [
      {
        id: 's1',
        description: 'scaffold',
        dependsOn: [],
        assignedPersona: 'coder',
        assignedSkills: [],
        assignedTools: ['write_file'],
        claimedResources: [],
        acceptanceCriteria: 'file exists',
        status: 'done',
        resultSummary: summary,
        ...(handoff ? { handoff } : {}),
      },
      {
        id: 's2',
        description: 'wire the form',
        dependsOn: ['s1'],
        assignedPersona: 'coder',
        assignedSkills: [],
        assignedTools: ['edit_file'],
        claimedResources: [],
        acceptanceCriteria: 'form submits',
        status: 'ready',
      },
    ],
  };
}

describe('J-04 — step handoff', () => {
  it('parses an explicit HANDOFF JSON block', () => {
    const handoff = extractHandoff(
      'long transcript of tools\nHANDOFF: {"changedFiles":["src/a.ts"],"keyResult":"wrote a.ts","notes":"watch the types"}',
    );
    expect(handoff.changedFiles).toEqual(['src/a.ts']);
    expect(handoff.keyResult).toBe('wrote a.ts');
    expect(handoff.notes).toBe('watch the types');
  });

  it('falls back to the first line as keyResult', () => {
    const handoff = extractHandoff('Created src/login.ts\nthen a huge dump');
    expect(handoff.keyResult).toBe('Created src/login.ts');
    expect(handoff.changedFiles).toEqual([]);
  });

  it('puts DEPENDENCY HANDOFF in the dependent prompt and omits the full transcript', () => {
    const dump = `Created src/login.ts\n${'TOOL OUTPUT '.repeat(80)}`;
    const prompt = buildStepPrompt(
      planWithDep(dump, {
        changedFiles: ['src/login.ts'],
        keyResult: 'Created src/login.ts',
        notes: 'use the helper',
      }),
      planWithDep(dump).steps[1]!,
    );
    expect(prompt).toContain('DEPENDENCY HANDOFF');
    expect(prompt).not.toContain('DEPENDENCY RESULTS');
    expect(prompt).toContain('keyResult: Created src/login.ts');
    expect(prompt).toContain('src/login.ts');
    expect(prompt).not.toContain('TOOL OUTPUT');
    expect(formatHandoff(extractHandoff(dump))).toContain('Created src/login.ts');
  });
});
