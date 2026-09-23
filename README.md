# human-out-of-the-loop — AI Multi-Agent Orchestration Runtime

> **Human-Out-Of-Loop (Law 17):** All configuration decisions (task decomposition, persona/skill/tool selection, ambiguity resolution) are finalized **before execution** and confirmed by the user. After confirmation, the system runs to completion **without human messages like "continue"**. Only explicit cancellation and progress streaming are allowed.

## Quick Start

```bash
npm install
export OPENAI_API_KEY="sk-..."
npm run build
npx vitest run
```

```typescript
import { Orchestrator, createCliConfirmCallback } from './src/ai/orchestrator.js';

const orchestrator = new Orchestrator({
  projectRoot: process.cwd(),
  persistent: true,
  maxConcurrentTasks: 5,
  maxReplanningAttempts: 3,
});

await orchestrator.initialize();

const result = await orchestrator.run('Build a login page with validation', {
  confirmCallback: createCliConfirmCallback(),
});

console.log(result.report);
await orchestrator.shutdown();
```

## Architecture

See [src/ai/README.md](./src/ai/README.md) for full architecture diagram, layers, data flow, Persona/Skill/Tool differences, authorization model, MCP integration, and Human-Out-Of-Loop principle.

## Adding New Components

See [src/ai/CONTRIBUTING.md](./src/ai/CONTRIBUTING.md) for step-by-step guides to add Tool / Skill / Persona / Agent / MCP Server.

## Configuration

See [src/ai/CONFIGURATION.md](./src/ai/CONFIGURATION.md) for env vars, configurable ceilings, file structures, runtime directory, and scope audit.

## Project Status

| Phase | Title | Status |
|-------|-------|--------|
| 1 | Base Registry & Schemas | 🟢 |
| 2 | Tool Registry (local + MCP) | 🟢 |
| 3 | Skill Registry | 🟢 |
| 4 | Persona (policy) + Model Registry | 🟢 |
| 5 | Agent Registry + Factory + Context Budget | 🟢 |
| 6 | Dynamic Catalog + Agent Composition | 🟢 |
| 7 | Agent Runtime + EventBus | 🟢 |
| 8 | Task Runtime + Resource Lock + Concurrency | 🟢 |
| 9 | Planning Layer | 🟢 |
| 10 | PlanRuntime (Human-Out-Of-Loop) | 🟢 |
| 11 | Per-Step Acceptance Check | 🟢 |
| 12 | Final Review + Report | 🟢 |
| 13 | Streaming/Cancellation/Rate-limit/Usage | 🟢 |
| 14 | Session + Observability | 🟢 |
| 15 | End-to-End Integration | 🟢 |
| 16 | Hardening + 15 Fixes | 🟢 |
| 17 | Documentation & Delivery | 🟢 |

**334 tests green, 0 tsc errors, 17/17 phases 🟢**

## Law Compliance

- **Law 12:** Persona=behavior+policy, Skill=knowledge, Tool=action. No Agent imports Tool impl directly.
- **Law 13:** Main→Sub via `delegate_task` only.
- **Law 14:** Compact events (tool name only, no args) + `get_task_details` explicit.
- **Law 15:** Structured Output via `Output.object()` + Zod.
- **Law 16:** Data-driven registries — new components without Runtime code changes.
- **Law 17:** Human-Out-Of-Loop — confirmation is ONLY human touchpoint, auto retry/re-plan/backoff.
- **Law 18:** `allowedTools` enforced in Factory (static) + delegate_task (dynamic) + Feasibility Gate.
