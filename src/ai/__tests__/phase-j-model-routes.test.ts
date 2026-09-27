/**
 * J-06 — cheap classify/judge/review vs plan/code; usage broken down by model.
 */
import { describe, it, expect } from 'vitest';
import { resolveModelForRole, roleForPersona } from '../models/model-routes.js';
import { UsageAggregator } from '../runtime/usage-aggregator.js';
import { AcceptanceChecker } from '../runtime/acceptance-checker.js';
import { PersonaRegistry } from '../registries/persona-registry.js';
import { SkillRegistry } from '../registries/skill-registry.js';
import { ToolRegistry } from '../registries/tool-registry.js';
import { ModelRegistry } from '../registries/model-registry.js';

describe('J-06 — model routes', () => {
  it('maps personas to roles and honours per-role overrides', () => {
    expect(roleForPersona('coder')).toBe('code');
    expect(roleForPersona('planner')).toBe('plan');
    expect(roleForPersona('judge')).toBe('judge');
    expect(roleForPersona('reviewer')).toBe('review');
    expect(roleForPersona('chat')).toBe('classify');
    const routes = { judge: 'cheap-judge', code: 'strong-code', plan: 'strong-plan' };
    expect(resolveModelForRole('judge', routes, 'gpt-4o')).toBe('cheap-judge');
    expect(resolveModelForRole('code', routes, 'gpt-4o')).toBe('strong-code');
    expect(resolveModelForRole('classify', routes, 'gpt-4o')).toBe('gpt-4o');
  });

  it('the acceptance checker is constructed on the routed judge model', () => {
    const checker = new AcceptanceChecker({
      personaRegistry: new PersonaRegistry(),
      skillRegistry: new SkillRegistry({ toolRegistry: new ToolRegistry() }),
      toolRegistry: new ToolRegistry(),
      modelRegistry: new ModelRegistry(),
      modelId: resolveModelForRole('judge', { judge: 'cheap-judge' }, 'gpt-4o'),
    });
    expect((checker as unknown as { modelId: string }).modelId).toBe('cheap-judge');
  });

  it('usage summary buckets tokens by model id', () => {
    const agg = new UsageAggregator();
    agg.recordDirect({
      taskId: 't1',
      agentId: 'a',
      usage: { promptTokens: 10, completionTokens: 5, totalTokens: 15 },
      timestamp: Date.now(),
      llmCall: true,
      modelId: 'cheap-judge',
    });
    agg.recordDirect({
      taskId: 't2',
      agentId: 'b',
      usage: { promptTokens: 40, completionTokens: 20, totalTokens: 60 },
      timestamp: Date.now(),
      llmCall: true,
      modelId: 'gpt-4o',
    });
    const summary = agg.getSummary();
    expect(summary.byModel['cheap-judge']?.totalTokens).toBe(15);
    expect(summary.byModel['gpt-4o']?.totalTokens).toBe(60);
    expect(summary.totalTokens).toBe(75);
  });
});
