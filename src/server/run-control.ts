/**
 * A-04 / A-05 / A-08 — cancel, idle TTL, and ownership for in-flight runs.
 */
import type { Request, Response } from 'express';
import { getAuthToken, isOwnerForbidden } from './auth.js';
import type { RunState, ServerContext } from './types.js';

export function clearRunTtl(run: RunState): void {
  if (run.ttlTimer) {
    clearTimeout(run.ttlTimer);
    run.ttlTimer = undefined;
  }
}

export function armRunTtl(ctx: ServerContext, run: RunState): void {
  clearRunTtl(run);
  if (!ctx.runTtlMs || ctx.runTtlMs <= 0) return;
  run.ttlTimer = setTimeout(() => {
    run.ttlTimer = undefined;
    cancelInFlightRun(ctx, run);
  }, ctx.runTtlMs);
}

/**
 * Abort planning, resolve any waiting human prompt as "no", and cancel a
 * running plan. Returns false when the run is already terminal.
 */
export function cancelInFlightRun(ctx: ServerContext, run: RunState): boolean {
  if (run.state === 'done' || run.state === 'error') return false;
  clearRunTtl(run);
  run.abortController?.abort();
  const clarify = run.clarificationResolver;
  if (clarify) {
    run.clarificationResolver = undefined;
    run.clarificationQuestions = undefined;
    clarify(null);
  }
  const confirm = run.confirmResolver;
  if (confirm) {
    run.confirmResolver = undefined;
    confirm({ confirmed: false, cancelled: true });
  }
  if (run.planId && (run.state === 'running' || run.state === 'planning')) {
    void ctx.orchestrator.cancelPlan(run.planId).catch(() => undefined);
  }
  return true;
}

/** 403 when auth is on and this client does not own the run. */
export function sendOwnerForbidden(
  ctx: ServerContext,
  req: Request,
  res: Response,
  ownerToken: string | undefined,
): boolean {
  if (!isOwnerForbidden(ctx.authTokens.length > 0, getAuthToken(req), ownerToken)) {
    return false;
  }
  res.status(403).json({ error: 'Forbidden: this resource belongs to another client.' });
  return true;
}

export function findRunByPlanId(ctx: ServerContext, planId: string): RunState | undefined {
  for (const run of ctx.runs.values()) {
    if (run.planId === planId) return run;
  }
  return undefined;
}
