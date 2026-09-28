import { describe, expect, it } from 'vitest';
import * as prompts from './index.js';
import { buildAssessmentPrompt, buildPlanPrompt } from '../planning/planner.js';
import { buildEnvironmentContext } from '../environment-context.js';
import { languageSection } from '../language.js';
import { buildCatalogBlock } from '../planning/catalog-prompt.js';
import { buildStepPrompt } from '../runtime/step-prompt.js';

describe('central prompt module', () => {
  it('exports each prompt builder from the canonical import surface', () => {
    for (const name of [
      'buildEnvironmentContext',
      'languageSection',
      'buildSystemPrompt',
      'buildProjectContext',
      'buildCatalogBlock',
      'buildAssessmentPrompt',
      'buildPlanPrompt',
      'buildAnswerPrompt',
      'buildStructuredPlanPrompt',
      'buildStepPrompt',
      'buildStepExecutionPrompt',
      'buildAcceptancePrompt',
      'buildFinalReviewPrompt',
      'formatPlanExample',
    ] as const) {
      expect(typeof prompts[name], `${name} should be exported`).toBe('function');
    }
  });

  it('keeps legacy import paths wired to the centralized implementations', () => {
    expect(buildAssessmentPrompt).toBe(prompts.buildAssessmentPrompt);
    expect(buildPlanPrompt).toBe(prompts.buildPlanPrompt);
    expect(buildEnvironmentContext).toBe(prompts.buildEnvironmentContext);
    expect(languageSection).toBe(prompts.languageSection);
    expect(buildCatalogBlock).toBe(prompts.buildCatalogBlock);
    expect(buildStepPrompt).toBe(prompts.buildStepPrompt);
  });

  it("preserves the planner's mode-specific prompt behavior", () => {
    expect(prompts.buildAssessmentPrompt('hello', undefined, 'chat')).toContain('CONVERSATION');
    expect(prompts.buildAssessmentPrompt('change a file', undefined, 'plan')).toContain('PLAN');
    expect(prompts.buildPlanPrompt('request')).toContain('USER REQUEST:');
    expect(prompts.buildAnswerPrompt('hello')).toContain('[[NEEDS_PLAN: false]]');
    expect(prompts.buildStructuredPlanPrompt('request', 'catalog')).toContain('catalog');
  });
});
