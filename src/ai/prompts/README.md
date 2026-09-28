# Prompt construction

`src/ai/prompts/` is the canonical home for text sent to models. Import builders from a focused module internally, or from `./index.js` for consumers that need the public prompt API.

- `system.ts` — persona + skill system-prompt assembly and context-budget trimming.
- `environment.ts`, `language.ts`, `project-context.ts` — shared prompt sections.
- `catalog.ts`, `examples.ts` — planner catalog and example formatting.
- `planner.ts` — assessment, plan, chat-answer, and structured-plan user prompts.
- `steps.ts` — execution-step prompts and dependency summaries.
- `reviews.ts` — acceptance and final-review prompts.

Persona and Skill instructions remain registry data. Runtime modules own model calls and should delegate prompt text construction here. Legacy module paths re-export the moved builders for compatibility.
