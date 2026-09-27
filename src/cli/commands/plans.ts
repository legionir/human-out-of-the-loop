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
import { resolveCliDefaults } from '../utils/config.js';
import { color, err, out, renderTable } from '../utils/output.js';
import { validateRunOptions } from './run.js';
import { evaluatePlanResume } from '../../ai/runtime/resume-guard.js';
import { latestCheckpointStep, restoreCheckpoint } from '../../ai/runtime/checkpoint.js';

export interface PlansCommandOptions {
  projectRoot?: string;
  /** Print the raw plan JSON instead of the formatted view */
  json?: boolean;
  /** Pass through model/timeout for resume (model resolution needs it) */
  model?: string;
  timeoutMs?: number;
}

function planStoreFor(opts: PlansCommandOptions): FilePlanStore {
  const { projectRoot } = resolveCliDefaults({ projectRoot: opts.projectRoot });
  return new FilePlanStore(path.join(projectRoot, '.ai-runtime', 'plans'));
}

function projectRootFor(opts: PlansCommandOptions): string {
  return resolveCliDefaults({ projectRoot: opts.projectRoot }).projectRoot;
}

/** J-05: restore the working tree captured before a writable step. */
export async function plansRollbackCommand(planId: string, opts: PlansCommandOptions): Promise<number> {
  const projectRoot = projectRootFor(opts);
  const store = planStoreFor(opts);
  const plan = store.load(planId);
  if (!plan) {
    err(color.failed(`Plan "${planId}" not found.`));
    return 1;
  }
  const stepId = latestCheckpointStep(projectRoot, planId);
  if (!stepId) {
    err(color.failed(`No checkpoint for plan "${planId}".`));
    return 1;
  }
  const ok = restoreCheckpoint(projectRoot, planId, stepId);
  if (!ok) {
    err(color.failed(`Failed to restore checkpoint ${stepId}.`));
    return 1;
  }
  out(color.done(`Restored working tree from checkpoint ${stepId} of ${planId}.`));
  return 0;
}

export async function plansListCommand(opts: PlansCommandOptions): Promise<number> {
  const store = planStoreFor(opts);
  const ids = store.list();
  for (const w of store.loadWarnings) {
    err(color.warn(`Skipped corrupt plan file ${w.file}: ${w.error}`));
  }

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
  const invalid = validateRunOptions({ timeoutMs: opts.timeoutMs, model: opts.model });
  if (invalid) {
    err(color.failed(invalid));
    return 2;
  }
  const defaults = resolveCliDefaults({ projectRoot: opts.projectRoot, model: opts.model });
  const projectRoot = defaults.projectRoot;
  const model = defaults.model;

  const orchestrator = new Orchestrator({
    projectRoot,
    persistent: true,
    ...(model ? { defaultModelId: model } : {}),
    ...(opts.timeoutMs !== undefined ? { agentTimeoutMs: opts.timeoutMs } : {}),
  });

  try {
    await orchestrator.initialize();
    // Phase 30 (P10 follow-up): say WHY nothing happens.  A terminal plan is
    // not resumable — resuming it silently used to re-run finished work.
    const status = orchestrator.getPlanStatus(planId)?.status;
    const decision = evaluatePlanResume({
      found: status !== undefined,
      status,
      liveOwner: orchestrator.hasLiveOwner(planId),
    });
    if (decision.action === 'finalize-cancel' || status === 'cancelling') {
      // A cancel was requested but the process left before the runtime could
      // finish it.  Finalise it here — a plan must never stay in a state no
      // process owns.
      await orchestrator.cancelPlan(planId);
      err(color.failed(`Plan "${planId}" was being cancelled — it is now cancelled.`));
      return 1;
    }
    if (status === 'cancelled') {
      err(
        color.failed(
          `Plan "${planId}" is cancelled — cancellation is final and it will not be resumed.`,
        ),
      );
      return 1;
    }
    if (status === 'completed' || decision.action === 'noop') {
      err(color.dim(`Plan "${planId}" is already completed — nothing to resume.`));
      return 0;
    }
    if (decision.action !== 'resume') {
      err(color.failed(decision.message));
      return 1;
    }
    try {
      orchestrator.reconcileAbandonedInteractions();
    } catch {
      // best-effort
    }
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
    const message = e instanceof Error ? e.message : String(e);
    err(color.failed(`Error: ${message}`));
    if (e && typeof e === 'object' && 'status' in e && (e as { status?: number }).status === 409) {
      return 1;
    }
    return 1;
  } finally {
    await orchestrator.shutdown();
  }
}
