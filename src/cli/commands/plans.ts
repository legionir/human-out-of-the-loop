/**
 * Phase 23 (CLI, step 2): plan management.
 *
 *   human-out-of-the-loop plans list [--project-root DIR]
 *   human-out-of-the-loop plans show <planId> [--project-root DIR]
 *   human-out-of-the-loop plans cancel <planId> [--project-root DIR]
 *   human-out-of-the-loop plans resume <planId> [--project-root DIR]
 *
 * Plans live in `<projectRoot>/.ai-runtime/plans/` (persistent mode).
 */
import path from 'node:path';
import { Orchestrator } from '../../ai/orchestrator.js';
import { CancellationManager } from '../../ai/runtime/cancellation-manager.js';
import { FilePlanStore } from '../../ai/runtime/plan-store.js';
import { EventBus } from '../../ai/runtime/event-bus.js';
import { TaskRuntime } from '../../ai/runtime/task-runtime.js';
import { prepareCliEnvironment } from '../utils/config.js';
import { color, err, out, renderTable } from '../utils/output.js';

export interface PlansCommandOptions {
  projectRoot?: string;
  /** Print the raw plan JSON instead of the formatted view */
  json?: boolean;
  /** Pass through model/timeout for resume (model resolution needs it) */
  model?: string;
  timeoutMs?: number;
}

function planStoreFor(opts: PlansCommandOptions): FilePlanStore {
  const projectRoot = path.resolve(opts.projectRoot ?? process.cwd());
  prepareCliEnvironment(projectRoot);
  return new FilePlanStore(path.join(projectRoot, '.ai-runtime', 'plans'));
}

function projectRootFor(opts: PlansCommandOptions): string {
  return path.resolve(opts.projectRoot ?? process.cwd());
}

export async function plansListCommand(opts: PlansCommandOptions): Promise<number> {
  const store = planStoreFor(opts);
  const ids = store.list();

  if (ids.length === 0) {
    out(color.dim('No plans found (persistent mode stores plans in .ai-runtime/plans).'));
    return 0;
  }

  const rows = ids.map((id) => {
    const plan = store.load(id);
    const done = plan?.steps.filter((s) => s.status === 'done').length ?? 0;
    return [
      id,
      plan?.status ?? 'unknown',
      `${done}/${plan?.steps.length ?? 0}`,
      (plan?.goal ?? '').slice(0, 60),
    ];
  });

  out(renderTable(['PLAN ID', 'STATUS', 'STEPS', 'GOAL'], rows));
  return 0;
}

/**
 * C3/Phase 29: `plans show <planId>` renders the plan for a human — the
 * same shape the run preview uses (steps, personas, tools, dependencies)
 * plus the execution status of every step.  `--json` keeps the previous
 * machine-readable dump.
 */
export async function plansShowCommand(planId: string, opts: PlansCommandOptions): Promise<number> {
  const store = planStoreFor(opts);
  const plan = store.load(planId);
  if (!plan) {
    err(color.failed(`Plan "${planId}" not found.`));
    return 1;
  }

  if (opts.json) {
    out(JSON.stringify(plan, null, 2));
    return 0;
  }

  const personasUsed = Array.from(new Set(plan.steps.map((s) => s.assignedPersona)));
  const resources = Array.from(new Set(plan.steps.flatMap((s) => s.claimedResources)));

  out(color.bold(`Plan ${plan.id ?? planId}`));
  out(`Goal:      ${plan.goal}`);
  out(`Status:    ${plan.status}`);
  out(`Steps:     ${plan.steps.length}`);
  out(`Personas:  ${personasUsed.join(', ') || 'none'}`);
  out(`Resources: ${resources.join(', ') || 'none'}`);
  out(color.dim(`Created:   ${plan.createdAt ? new Date(plan.createdAt).toISOString() : 'unknown'}`));

  for (const step of plan.steps) {
    const icon =
      step.status === 'done'
        ? color.done('✔')
        : step.status === 'failed'
          ? color.failed('✖')
          : step.status === 'running'
            ? color.running('▶')
            : color.dim('·');

    out('');
    out(`${icon} [${step.id}] ${step.description} ${color.dim(`(${step.status})`)}`);
    out(`    Persona:  ${step.assignedPersona}`);
    out(`    Skills:   ${step.assignedSkills.join(', ') || 'none'}`);
    out(`    Tools:    ${step.assignedTools.join(', ') || 'none'}`);
    if (step.dependsOn.length > 0) out(`    Depends:  ${step.dependsOn.join(', ')}`);
    if (step.claimedResources.length > 0) out(`    Resources: ${step.claimedResources.join(', ')}`);
    out(`    Accept:   ${step.acceptanceCriteria}`);
    if (step.taskId) out(color.dim(`    Task:     ${step.taskId}`));
    if (step.failureType) out(color.failed(`    Failure:  ${step.failureType}`));
    if (step.resultSummary) {
      out(color.dim(`    Result:   ${step.resultSummary.replace(/\s+/g, ' ').slice(0, 160)}`));
    }
  }

  return 0;
}

/**
 * Cancel a plan.  Works directly against the store + CancellationManager
 * (no full Orchestrator needed): a plan that is running INSIDE THIS
 * process would get its runtime signalled; a plan owned by another
 * process gets the "cancelling" marker persisted, which the phase-22
 * isPlanTerminal change makes authoritative (resume will not restart it,
 * and the other process's loop honours the persisted status on reload).
 */
export async function plansCancelCommand(planId: string, opts: PlansCommandOptions): Promise<number> {
  const projectRoot = projectRootFor(opts);
  prepareCliEnvironment(projectRoot);
  const planStore = planStoreFor(opts);
  const taskRuntime = new TaskRuntime({
    maxConcurrentTasks: 1,
    eventBus: new EventBus(),
  });
  const cancellationManager = new CancellationManager(planStore, taskRuntime);
  const result = await cancellationManager.cancelPlan(planId);
  taskRuntime.destroy();

  if (!result.success) {
    err(color.failed(result.message));
    return 1;
  }
  out(color.warn(`Cancellation initiated: ${result.message}`));
  out(color.dim(`Previous status: ${result.previousStatus} → new status: ${result.newStatus}`));
  return 0;
}

/** Resume a previously interrupted plan (needs the full orchestrator). */
export async function plansResumeCommand(planId: string, opts: PlansCommandOptions): Promise<number> {
  const projectRoot = projectRootFor(opts);
  prepareCliEnvironment(projectRoot);
  const globalConfig = prepareCliEnvironment(projectRoot);

  const orchestrator = new Orchestrator({
    projectRoot,
    persistent: true,
    ...(opts.model ?? globalConfig.defaultModel
      ? { defaultModelId: opts.model ?? globalConfig.defaultModel }
      : {}),
    ...(opts.timeoutMs !== undefined ? { agentTimeoutMs: opts.timeoutMs } : {}),
  });

  try {
    await orchestrator.initialize();
    const result = await orchestrator.resumePlan(planId);
    if (!result) {
      err(color.failed(`Plan "${planId}" not found (or not resumable).`));
      return 1;
    }
    out(result.report);
    const usage = orchestrator.getUsageSummary();
    out(color.dim(`\nUsage: ${usage.totalTokens} tokens (resumed run)`));
    return result.review.outcome === 'success' || result.review.outcome === 'partial-success'
      ? 0
      : 1;
  } catch (e) {
    err(color.failed(`Error: ${e instanceof Error ? e.message : String(e)}`));
    return 1;
  } finally {
    await orchestrator.shutdown();
  }
}
