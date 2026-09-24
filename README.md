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

## CLI

A full command-line front-end (Claude Code–style): plan, confirm once, then go out of the loop. After `npm run build`, the binary is `human-out-of-the-loop`; in development use `npx tsx src/cli.ts …` (same commands).

```bash
# Plan + confirm + execute, persisting state in .ai-runtime
human-out-of-the-loop run "Build a login page" --persistent --model gpt-4o

# CI / Human-Out-Of-Loop: never prompt, confirm automatically
human-out-of-the-loop run "Build a login page" --yes --max-replans 2

# Preview the plan without executing anything
human-out-of-the-loop run "Build a login page" --dry-run
```

### Command reference

| Command | Purpose | Key options |
|---|---|---|
| `run <goal>` | Plan, confirm (once), execute to completion | `--project-root`, `--persistent`, `--model <id>`, `--session <id>`, `--yes`, `--verbose`, `--dry-run`, `--timeout-ms <ms>`, `--max-steps <n>`, `--max-replans <0-10>`, `--max-delegation-depth <0-5>`, `--label <text>` |
| `sessions list` | List persisted sessions | `--project-root` |
| `sessions show <id>` | Session detail (interactions, plan ids, summaries) | `--project-root` |
| `sessions label <id> <label>` | Rename a session (empty string clears the label) | `--project-root` |
| `sessions delete <id>` | Delete a session | `--project-root` |
| `plans list` | List persisted plans (status, step progress) | `--project-root` |
| `plans show <id>` | Plan detail (goal, steps, dependencies) | `--project-root` |
| `plans cancel <id>` | Mark a plan cancelled (no execution state touched) | `--project-root` |
| `plans resume <id>` | Re-execute a plan that is not in a terminal state | `--project-root`, `--model`, `--timeout-ms` |
| `mcp list` | MCP servers from `registry/mcp-servers` | `--json` |
| `mcp test <serverId>` | Connect to one MCP server, list its tools | `--json` |
| `models` / `personas` / `skills` / `tools` | List registry entries | `--json` |
| `usage` | Token usage per plan (prompt/completion/total + task count) | `--plan <planId>`, `--json` |
| `tasks list` | Tasks from the observability log (derived status, tokens) | `--plan <planId>`, `--json` |
| `tasks show <taskId>` | Every log entry for one task (incl. payloads) | `--project-root` |
| `logs` | Read the observability log (`.ai-runtime/observability.jsonl`) | `--plan <planId>`, `--tail <n>`, `--follow` |

`run` exits **0** on success/partial-success, **1** on failure (plan rejected,
clarification unanswered, agent failure), **2** on usage errors (unknown model,
bad flag values). With `--yes` or in a non-TTY environment the CLI never
prompts: an unclear request fails with the planner's questions instead of
hanging. In an interactive terminal the CLI asks clarification questions
before planning and shows the plan summary before executing.

### Examples

```bash
# Inspect one plan and its spend
human-out-of-the-loop plans show plan_8f3a… --project-root ./app
human-out-of-the-loop usage --plan plan_8f3a… --project-root ./app --json

# Watch the observability log while a run is in flight
human-out-of-the-loop logs --follow --project-root ./app

# Rename a session for easier reference
human-out-of-the-loop sessions label session_5c1d… "Login page v2"
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

**488 tests green, 0 tsc errors** (phases 18–26 complete — see `EXECUTION_PLAN_V2.md`; CLI + UI completion plans: `CLI_COMPLETION_PLAN.md`, `UI_COMPLETION_PLAN.md`)

## Law Compliance

- **Law 12:** Persona=behavior+policy, Skill=knowledge, Tool=action. No Agent imports Tool impl directly.
- **Law 13:** Main→Sub via `delegate_task` only.
- **Law 14:** Compact events (tool name only, no args) + `get_task_details` explicit.
- **Law 15:** Structured Output via `Output.object()` + Zod.
- **Law 16:** Data-driven registries — new components without Runtime code changes.
- **Law 17:** Human-Out-Of-Loop — confirmation is ONLY human touchpoint, auto retry/re-plan/backoff.
- **Law 18:** `allowedTools` enforced in Factory (static) + delegate_task (dynamic) + Feasibility Gate.
