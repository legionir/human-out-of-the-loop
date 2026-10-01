/**
 * Phase 24 (UI): run routes.
 *
 *   POST /api/run          { message, sessionId?, confirm? } → 202 { runId }
 *   GET  /api/runs/:runId  → live run state (UI polls until terminal)
 *
 * The interactive flow:
 *   1. UI posts { message, sessionId?, confirm: false }
 *   2. Server starts Orchestrator.run() in the background; when the plan
 *      is ready the confirmCallback pauses and stores the plan text.
 *   3. UI polls the run → sees 'awaiting-confirmation' + planId → renders
 *      the plan modal (table from GET /api/plans/:id) and subscribes to
 *      SSE /api/stream/:planId.
 *   4. UI posts /api/plans/:id/confirm { confirmed, feedback? } → the
 *      callback resolves and execution proceeds (or the run is cancelled).
 *   5. UI watches SSE for live progress and polls until state 'done'
 *      (report + outcome).
 *
 * `confirm: true` skips the modal entirely (auto-confirm — the
 * Human-Out-Of-Loop mode from the web UI).
 */
import { randomUUID } from 'node:crypto';
import { Router } from 'express';
import type { Plan } from '../../ai/schemas/plan.js';
import type { OrchestratorWorkflowProfileOptions, RunOverrides } from '../../ai/orchestrator.js';
import { resolveProfileSelection } from '../../ai/workflow-profiles/profile-selection.js';
import { WorkflowProfileLoadError } from '../../ai/workflow-profiles/profile-registry.js';
import { parseRunMode, type RunMode } from '../../ai/modes.js';
import { parseModePrefix, resolveRunMode } from '../../cli/utils/mode-prefix.js';
import { loadGlobalConfig } from '../../cli/utils/config.js';
import { getAuthToken } from '../auth.js';
import {
  armRunTtl,
  cancelInFlightRun,
  claimSession,
  clearRunTtl,
  sendOwnerForbidden,
  sendSessionForbidden,
} from '../run-control.js';
import type { ServerContext } from '../types.js';

export function runRouter(ctx: ServerContext): Router {
  const router = Router();

  router.post('/api/run', async (req, res) => {
    const { message, sessionId, confirm, model, timeoutMs, maxSteps, maxReplans, mode, previewId, profile } =
      (req.body ?? {}) as {
        message?: unknown;
        sessionId?: unknown;
        confirm?: unknown;
        /** U3: per-run overrides */
        model?: unknown;
        timeoutMs?: unknown;
        maxSteps?: unknown;
        maxReplans?: unknown;
        /** v27.17.0: auto (default) / chat / plan */
        mode?: unknown;
        /** H-08: execute a previously previewed plan. */
        previewId?: unknown;
        /** Phase 8: run this request with the named Workflow Profile (see GET /api/profiles). */
        profile?: unknown;
      };
    // NOTE (UI security step): `projectRoot` intentionally does NOT come
    // from the request body — it is fixed server-side (config/env).
    if (previewId != null && typeof previewId !== 'string') {
      res.status(400).json({ error: '"previewId" must be a string when present.' });
      return;
    }
    const preview = previewId ? ctx.previews.get(previewId) : undefined;
    if (previewId && !preview) {
      res.status(404).json({ error: `Preview "${previewId}" not found.` });
      return;
    }
    if (typeof message !== 'string' || message.trim() === '') {
      res.status(400).json({ error: 'Body must include a non-empty "message".' });
      return;
    }
    // JSON `null` is a natural way to express "no session" — treat it
    // the same as an absent field.
    if (sessionId != null && typeof sessionId !== 'string') {
      res.status(400).json({ error: '"sessionId" must be a string when present.' });
      return;
    }
    if (sessionId) {
      await ctx.orchestrator.initialize();
      if (!ctx.orchestrator.sessionStore.getSession(sessionId)) {
        res.status(404).json({ error: `Session "${sessionId}" not found.` });
        return;
      }
      if (sendSessionForbidden(ctx, req, res, sessionId)) return;
    }

    // Phase 8: an explicit Workflow Profile for THIS run. Selection is the opt-in: the resolved
    // options carry the flag for this run only, and every problem (unknown id, untrusted project,
    // broken file, stale dependency pin) is answered here — before a run, session or plan exists.
    // `profileFile` is deliberately NOT accepted over HTTP: a client-supplied host path would be a
    // new "read any JSON file" primitive. Use the CLI (--profile-file) or an operator directory.
    if ('profileFile' in ((req.body ?? {}) as Record<string, unknown>)) {
      res.status(400).json({
        error: '"profileFile" is not accepted over the API; select by id or use the CLI --profile-file.',
      });
      return;
    }
    let profileOptions: OrchestratorWorkflowProfileOptions | undefined;
    if (profile != null) {
      if (typeof profile !== 'string' || profile.trim() === '') {
        res.status(400).json({ error: '"profile" must be a non-empty profile id when present.' });
        return;
      }
      try {
        profileOptions = resolveProfileSelection({
          projectRoot: ctx.projectRoot,
          trustedProject: ctx.trustedProject === true,
          profile: profile.trim(),
        });
      } catch (error) {
        if (error instanceof WorkflowProfileLoadError) {
          res.status(400).json({
            error: error.message,
            diagnostics: error.diagnostics.map((diagnostic) => ({
              stage: diagnostic.stage,
              code: diagnostic.code,
              message: diagnostic.message,
              ...(diagnostic.profileId ? { profileId: diagnostic.profileId } : {}),
              ...(diagnostic.file ? { file: diagnostic.file } : {}),
            })),
          });
          return;
        }
        throw error;
      }
    }
    const autoConfirm = confirm === true;

    // v27.17.0: an unknown mode is a request error, not a silent fallback.
    let runMode: RunMode | undefined;
    if (mode != null) {
      if (typeof mode !== 'string' || !parseRunMode(mode)) {
        res.status(400).json({ error: '"mode" must be one of: auto, chat, plan.' });
        return;
      }
      runMode = parseRunMode(mode);
    }

    // H-09: `@chat` / `@plan` prefixes override body `mode` (same as preview).
    const prefix = parseModePrefix(message);
    let runMessage = message;
    if (prefix.mode) {
      runMode = prefix.mode;
      runMessage = prefix.text;
    } else if (!runMode) {
      runMode = resolveRunMode({ config: loadGlobalConfig() }).resolved.mode;
    }
    if (preview?.mode && !prefix.mode && mode == null) {
      runMode = preview.mode;
    }

    // U3: per-run overrides — validate now (synchronous) so the UI gets
    // a clean 400 with the list of valid model ids, not a failed run.
    const runOverrides: RunOverrides = {};
    if (model != null) {
      if (typeof model !== 'string' || model.trim() === '') {
        res.status(400).json({ error: '"model" must be a non-empty string when present.' });
        return;
      }
      // Any spec: a registered id, `<provider>:<name>`, or a model name the
      // provider listed (GET /api/models/remote) — registered on first use.
      // The registry files must be loaded first, or a registered id would be
      // mistaken for a provider model name.
      await ctx.orchestrator.initialize();
      runOverrides.modelId = ctx.orchestrator.useModel(model);
    }
    // [key, value, lo, hi, mustBeInteger]
    for (const [key, field, lo, hi, isInt] of [
      ['timeoutMs', timeoutMs, 1, Number.MAX_SAFE_INTEGER, false],
      ['maxSteps', maxSteps, 1, 100, true],
      ['maxReplans', maxReplans, 0, 10, true],
    ] as const) {
      if (field == null) continue;
      if (
        typeof field !== 'number' ||
        !Number.isFinite(field) ||
        (isInt && !Number.isInteger(field)) ||
        field < lo ||
        field > hi
      ) {
        res.status(400).json({ error: `"${key}" must be a number between ${lo} and ${hi}.` });
        return;
      }
      if (key === 'timeoutMs') runOverrides.agentTimeoutMs = field;
      else if (key === 'maxSteps') runOverrides.maxSteps = field;
      else runOverrides.maxReplanningAttempts = field;
    }

    const runId = randomUUID();
    const abortController = new AbortController();
    // A-08: with auth on, a run that starts a new session owns it.
    let runSessionId = sessionId as string | undefined;
    if (!runSessionId && ctx.authTokens.length > 0) {
      await ctx.orchestrator.initialize();
      runSessionId = ctx.orchestrator.sessionStore.createSession();
      claimSession(ctx, req, runSessionId);
    }
    ctx.runs.set(runId, {
      runId,
      sessionId: runSessionId,
      state: 'planning',
      createdAt: Date.now(),
      abortController,
      ownerToken: getAuthToken(req),
      ...(profileOptions?.selection?.registered
        ? { profileId: profileOptions.selection.registered.profile.profile.id }
        : {}),
    });
    const run = ctx.runs.get(runId)!;

    // Detached: the HTTP response returns immediately (202); the run's
    // lifecycle is observable via GET /api/runs/:runId + SSE.
    void (async () => {
      try {
        const result = await ctx.orchestrator.run(runMessage.trim(), {
          sessionId: run.sessionId,
          abortSignal: abortController.signal,
          ...(runMode ? { mode: runMode } : {}),
          ...(preview ? { preparedPlan: preview.plan } : {}),
          // U3: per-run overrides (validated above)
          ...(Object.keys(runOverrides).length > 0 ? { runOverrides } : {}),
          // Phase 8: per-run profile selection (resolved above; the flag inside is per run).
          // Phase 10 (U-2): the profile run records itself under this run's id, so the durable
          // record and GET /api/runs/:runId name the same attempt.
          ...(profileOptions ? { workflowProfile: { ...profileOptions, runId } } : {}),
          // U5: interactive clarification.  The planner asks questions during
          // PLANNING (before any plan id exists), so the SSE channel for this
          // event is keyed by the runId — the run state also carries the
          // questions for clients that missed the event.
          clarificationCallback: async (questions: string[], round: number) => {
            run.state = 'awaiting-clarification';
            run.clarificationQuestions = [...questions];
            run.clarificationRound = round;
            ctx.hub.emit(runId, 'clarification', {
              runId,
              ...(run.planId ? { planId: run.planId } : {}),
              questions,
              attempt: round,
            });
            armRunTtl(ctx, run);
            return new Promise<Record<string, string> | null>((resolve) => {
              run.clarificationResolver = (answers) => {
                clearRunTtl(run);
                run.state = 'planning';
                run.clarificationQuestions = undefined;
                run.clarificationResolver = undefined;
                resolve(answers);
              };
            });
          },
          confirmCallback: async (planText: string, plan?: Plan) => {
            run.planId = plan?.id ?? run.planId;
            if (autoConfirm) {
              run.state = 'running';
              return { confirmed: true };
            }
            run.state = 'awaiting-confirmation';
            run.planText = planText;
            const confirmationPayload = {
              runId,
              ...(run.planId ? { planId: run.planId } : {}),
              planText,
            };
            ctx.hub.emit(runId, 'awaiting-confirmation', confirmationPayload);
            if (run.planId) {
              ctx.hub.emit(run.planId, 'awaiting-confirmation', confirmationPayload);
            }
            armRunTtl(ctx, run);
            return new Promise((resolve) => {
              run.confirmResolver = (decision) => {
                clearRunTtl(run);
                run.state = 'running';
                resolve(decision);
              };
            });
          },
        });

        clearRunTtl(run);
        run.sessionId = result.sessionId;
        run.state = 'done';
        run.outcome = result.review.outcome;
        run.report = result.report;
        const donePayload = { runId, ...(run.planId ? { planId: run.planId } : {}), outcome: result.review.outcome };
        ctx.hub.emit(runId, 'run:done', donePayload);
        if (run.planId) {
          ctx.hub.emit(run.planId, 'run:done', donePayload);
        }
      } catch (err) {
        clearRunTtl(run);
        run.state = 'error';
        run.error = err instanceof Error ? err.message : String(err);
      }
    })();

    res.status(202).json({
      runId,
      autoConfirm,
      ...(run.profileId ? { profileId: run.profileId } : {}),
    });
  });

  /**
   * U5: answer the planner's clarification questions (or decline).
   *
   *   POST /api/runs/:runId/clarification { answers: {q: a} }  → 200 { ok, answered }
   *   POST /api/runs/:runId/clarification { decline: true }    → 200 { ok, declined }
   *
   * 404 unknown run · 409 when the run is not awaiting clarification ·
   * 400 when an answer is missing/empty (every pending question must be
   * answered — a partial answer cannot be fed back to the planner).
   */
  /**
   * A-04: cancel a run during planning (no plan id yet) or while it is
   * waiting for a human. Also aborts in-flight planner LLM calls.
   */
  router.post('/api/runs/:runId/cancel', (req, res) => {
    const run = ctx.runs.get(req.params.runId);
    if (!run) {
      res.status(404).json({ error: `Run "${req.params.runId}" not found.` });
      return;
    }
    if (sendOwnerForbidden(ctx, req, res, run.ownerToken)) return;
    if (!cancelInFlightRun(ctx, run)) {
      res.status(409).json({ error: `Run "${run.runId}" is already ${run.state}.` });
      return;
    }
    res.json({ ok: true, runId: run.runId, cancelled: true });
  });

  router.post('/api/runs/:runId/clarification', (req, res) => {
    const run = ctx.runs.get(req.params.runId);
    if (!run) {
      res.status(404).json({ error: `Run "${req.params.runId}" not found.` });
      return;
    }
    if (sendOwnerForbidden(ctx, req, res, run.ownerToken)) return;
    if (run.state !== 'awaiting-clarification' || !run.clarificationResolver) {
      res.status(409).json({
        error: `Run "${run.runId}" is not awaiting clarification (state: ${run.state}).`,
      });
      return;
    }
    const body = (req.body ?? {}) as { answers?: unknown; decline?: unknown };

    // The user may decline to answer — that cancels the run (C4 semantics).
    if (body.decline === true) {
      const resolver = run.clarificationResolver;
      resolver(null);
      res.json({ ok: true, declined: true });
      return;
    }

    const rawAnswers = body.answers;
    if (typeof rawAnswers !== 'object' || rawAnswers === null || Array.isArray(rawAnswers)) {
      res.status(400).json({ error: 'Body must include an "answers" object (or "decline": true).' });
      return;
    }
    const pending = run.clarificationQuestions ?? [];
    const answers: Record<string, string> = {};
    const missing: string[] = [];
    for (const question of pending) {
      const value = (rawAnswers as Record<string, unknown>)[question];
      if (typeof value !== 'string' || value.trim() === '') {
        missing.push(question);
        continue;
      }
      answers[question] = value.trim();
    }
    if (missing.length > 0) {
      res.status(400).json({
        error: 'Every question must be answered with a non-empty string.',
        missing,
      });
      return;
    }

    const resolver = run.clarificationResolver;
    resolver(answers);
    res.json({ ok: true, answered: Object.keys(answers).length, round: run.clarificationRound });
  });

  router.get('/api/runs', (req, res) => {
    const token = getAuthToken(req);
    const runs = [...ctx.runs.values()]
      .filter((run) => !ctx.authTokens.length || run.ownerToken === token)
      .map((run) => ({
        runId: run.runId,
        sessionId: run.sessionId,
        state: run.state,
        planId: run.planId,
        outcome: run.outcome,
        createdAt: run.createdAt,
        error: run.error,
      }));
    res.json({ runs });
  });

  router.get('/api/runs/:runId', (req, res) => {
    const run = ctx.runs.get(req.params.runId);
    if (!run) {
      res.status(404).json({ error: `Run "${req.params.runId}" not found.` });
      return;
    }
    if (sendOwnerForbidden(ctx, req, res, run.ownerToken)) return;
    // Never leak the resolvers, abort controller, owner token or timer.
    const {
      confirmResolver,
      clarificationResolver,
      abortController,
      ownerToken,
      ttlTimer,
      ...publicState
    } = run;
    void confirmResolver;
    void clarificationResolver;
    void abortController;
    void ownerToken;
    void ttlTimer;
    res.json(publicState);
  });

  return router;
}
