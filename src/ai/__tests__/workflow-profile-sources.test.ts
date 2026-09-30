import { describe, expect, it } from 'vitest';
import { componentProjection, dependencyDigest } from '../workflow-profiles/profile-digest.js';
import { createWorkflowProfileComponentSources } from '../workflow-profiles/profile-sources.js';

const planner = { id: 'planner', name: 'Task Planner', system: 'Plan.', allowedTools: ['create_task'] };
const personas = new Map<string, unknown>([['planner', planner]]);
const skills = new Map<string, unknown>([['notes', { id: 'notes', version: '1.0.0', resolvedInstructions: 'Be terse.' }]]);

const registries = {
  personas: { get: (id: string) => personas.get(id), list: () => [...personas.values()] as Array<{ id: string }> },
  skills: { get: (id: string) => skills.get(id), list: () => [...skills.values()] as Array<{ id: string }> },
  models: { getConfig: (id: string) => (id === 'default' ? { id: 'default', provider: 'test', model: 'test' } : undefined) },
};

describe('workflow profile component sources', () => {
  it('resolves registry content and enumerates ids when the registry can', () => {
    const sources = createWorkflowProfileComponentSources({ registries });
    expect(sources.personas.get('planner')).toEqual(planner);
    expect(sources.personas.listIds?.()).toEqual(['planner']);
    expect(sources.skills.get('notes')).toMatchObject({ resolvedInstructions: 'Be terse.' });
    expect(sources.models.get('default')).toMatchObject({ provider: 'test' });
  });

  it('returns undefined for unknown ids instead of substituting content', () => {
    const sources = createWorkflowProfileComponentSources({ registries });
    expect(sources.personas.get('missing')).toBeUndefined();
    expect(sources.toolsets.get('missing')).toBeUndefined();
    // No toolset registry is wired (none ships in the repository), so nothing resolves.
    expect(sources.toolsets.listIds).toBeUndefined();
  });

  it('hands out defensive copies so registry state cannot be changed through the profile layer', () => {
    const sources = createWorkflowProfileComponentSources({ registries });
    const record = sources.personas.get('planner') as Record<string, unknown>;
    record.allowedTools = ['everything'];
    expect(personas.get('planner')).toEqual(planner);
  });

  it('pins stably: the same content digests identically across reads', () => {
    const sources = createWorkflowProfileComponentSources({ registries });
    const first = sources.personas.get('planner') as Record<string, unknown>;
    const second = sources.personas.get('planner') as Record<string, unknown>;
    expect(dependencyDigest('persona', 'planner', componentProjection(second)))
      .toBe(dependencyDigest('persona', 'planner', componentProjection(first)));
  });

  it('exposes the code-owned built-in rubrics by default', () => {
    const sources = createWorkflowProfileComponentSources({ registries });
    expect(sources.rubrics.get('hootl.default-review')).toMatchObject({ id: 'hootl.default-review', decisions: ['pass', 'revise', 'reject'] });
  });
});
