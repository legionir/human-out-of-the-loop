// Compatibility re-export; prompt builders live under src/ai/prompts.
export {
  STEP_CONTEXT_CHAR_CAP,
  buildStepPrompt,
  buildStepExecutionPrompt,
  formatDoneStepSummaries,
} from '../prompts/steps.js';
