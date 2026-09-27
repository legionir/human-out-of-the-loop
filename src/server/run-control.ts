/**
 * A-04 / A-05 / A-08 — cancel, idle TTL, and ownership for in-flight runs.
 */
import { createHash } from 'node:crypto';
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

// ─── A-08: ownership of sessions and plans ───────────────────────────
//
// A run is bound to the token that started it (above).  Sessions — and
// through `plan.sessionId`, their plans — are bound too: the session a run
// creates records a hash of the creating token (never the token itself).
// A session without an owner (created by the CLI, or before auth was on)
// is visible to every authenticated client.

const OWNER_KEY = 'ownerTokenHash';

export function tokenOwnerHash(token: string): string {
  return createHash('sha256').update(token).digest('hex').slice(0, 32);
}

/** Record the caller as the owner of a session (no-op when auth is off). */
export function claimSession(ctx: ServerContext, req: Request, sessionId: string): void {
  const token = getAuthToken(req);
  if (ctx.authTokens.length === 0 || !token) return;
  const session = ctx.orchestrator.sessionStore.getSession(sessionId);
  if (!session || session.metadata?.[OWNER_KEY]) return;
  session.metadata = { ...(session.metadata ?? {}), [OWNER_KEY]: tokenOwnerHash(token) };
  ctx.orchestrator.sessionStore.saveSession(session);
}

/** May the caller see / change this session? */
export function canAccessSession(ctx: ServerContext, req: Request, sessionId: string | undefined): boolean {
  if (ctx.authTokens.length === 0 || !sessionId) return true;
  const owner = ctx.orchestrator.sessionStore.getSession(sessionId)?.metadata?.[OWNER_KEY];
  if (typeof owner !== 'string') return true;
  const token = getAuthToken(req);
  return token !== undefined && tokenOwnerHash(token) === owner;
}

/** May the caller see / drive this plan (via its run, else its session)? */
export function canAccessPlan(ctx: ServerContext, req: Request, planId: string): boolean {
  if (ctx.authTokens.length === 0) return true;
  const run = findRunByPlanId(ctx, planId);
  if (run) return !isOwnerForbidden(true, getAuthToken(req), run.ownerToken);
  const plan = ctx.orchestrator.planStore.load(planId);
  return canAccessSession(ctx, req, plan?.sessionId);
}

export function sendSessionForbidden(
  ctx: ServerContext,
  req: Request,
  res: Response,
  sessionId: string | undefined,
): boolean {
  if (canAccessSession(ctx, req, sessionId)) return false;
  res.status(403).json({ error: 'Forbidden: this resource belongs to another client.' });
  return true;
}

export function sendPlanForbidden(ctx: ServerContext, req: Request, res: Response, planId: string): boolean {
  if (canAccessPlan(ctx, req, planId)) return false;
  res.status(403).json({ error: 'Forbidden: this resource belongs to another client.' });
  return true;
}

/**
 * The stream id is a runId (planning events) or a planId.  With several
 * tokens, observability output must be scoped to a plan the caller owns.
 */
export function canAccessStream(ctx: ServerContext, req: Request, id: string): boolean {
  if (ctx.authTokens.length === 0) return true;
  const run = ctx.runs.get(id);
  if (run) return !isOwnerForbidden(true, getAuthToken(req), run.ownerToken);
  return canAccessPlan(ctx, req, id);
}

/**
 * The observability log holds every run's events.  With one token there is
 * one client; with several, a caller may only read a plan it owns.
 */
export function sendObservabilityForbidden(
  ctx: ServerContext,
  req: Request,
  res: Response,
  planId: string | undefined,
): boolean {
  if (ctx.authTokens.length <= 1) return false;
  if (planId && canAccessPlan(ctx, req, planId)) return false;
  res.status(403).json({
    error: planId
      ? 'Forbidden: this resource belongs to another client.'
      : 'With several tokens configured, pass ?planId= for a plan you own.',
  });
  return true;
}
