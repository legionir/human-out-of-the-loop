import { randomUUID } from 'node:crypto';
import { generateText, stepCountIs, type LanguageModelUsage } from 'ai';
import type { ResolvedAgent } from '../agents/agent-factory.js';
import { EventBus, type TokenUsage } from './event-bus.js';

// ─── Types ────────────────────────────────────────────────────────

export interface AgentRunResult {
  taskId: string;
  agentId: string;
  success: boolean;
  /** Compact summary of what the agent did */
  summary: string;
  /** The agent's final text output (compact, not raw transcript) */
  result: string;
  /** List of tool names that were invoked during execution */
  toolsUsed: string[];
  /** Errors encountered (if any) */
  errors: string[];
  /** Token usage from the AI SDK response */
  usage?: TokenUsage;
  /** Failure classification (Phase 11 uses this) */
  failureType?: 'technical' | 'quality' | null;
}

export interface AgentRunOptions {
  /** The fully-resolved agent from AgentFactory (Phase 5/6) */
  agent: ResolvedAgent;
  /** Task identifier for event correlation */
  taskId: string;
  /** The prompt to execute */
  prompt: string;
  /**
   * EventBus instance.
   * Phase 19 (SING-01): now REQUIRED — there is no global fallback,
   * so events never leak between Orchestrator instances.
   */
  eventBus: EventBus;
  /** Maximum number of tool-call iterations (safety limit) */
  maxSteps?: number;
  /** Timeout in milliseconds for the entire run */
  timeoutMs?: number;
  /** Phase 20 (CORR-03/05): plan context, attached to emitted events */
  planId?: string;
  /** Phase 20 (CORR-05): step context, attached to emitted events */
  planStepId?: string;
  /**
   * Phase 22: cancellation signal.  Forwarded to `generateText` as
   * `abortSignal` — aborting it rejects the run with an AbortError,
   * which is surfaced as a structured failure (code "ABORTED").
   */
  signal?: AbortSignal;
}

// ─── Constants ────────────────────────────────────────────────────

const DEFAULT_MAX_STEPS = 20;
const DEFAULT_TIMEOUT_MS = 120_000; // 2 minutes

/** Phase 30 (P3): compact error budget so events/summaries stay small. */
const TOOL_ERROR_MAX_CHARS = 200;
const TOOL_ERROR_MAX_ENTRIES = 5;

/** One tool-level failure observed during an agent run. */
export interface ToolFailure {
  toolName: string;
  callId: string;
  /** Compact one-line message (truncated to TOOL_ERROR_MAX_CHARS) */
  error: string;
}

/**
 * Phase 30 (P3): recognise a failed tool call from a raw AI SDK step
 * content part.  Returns `null` for anything that is not a failure.
 *
 * AI SDK v7 emits `tool-result` parts for tools that returned (including
 * the project's `{ success: false, … }` refusals) and `tool-error` parts
 * for tools that threw.  `execution-denied` covers approval refusals.
 */
function describeToolFailure(part: unknown): ToolFailure | null {
  if (!part || typeof part !== 'object') return null;
  const raw = part as {
    type?: unknown;
    toolName?: unknown;
    toolCallId?: unknown;
    output?: unknown;
    error?: unknown;
  };

  const toolName = typeof raw.toolName === 'string' ? raw.toolName : 'unknown';
  const callId = typeof raw.toolCallId === 'string' ? raw.toolCallId : `call-${randomUUID()}`;

  // (1) The tool threw.
  if (raw.type === 'tool-error') {
    return { toolName, callId, error: compactToolError(errorMessage(raw.error)) };
  }

  if (raw.type !== 'tool-result') return null;
  const output = raw.output;

  // (2) SDK-level error outputs.
  if (output && typeof output === 'object') {
    const out = output as { type?: unknown; value?: unknown; reason?: unknown };
    if (out.type === 'error-text' || out.type === 'error-json') {
      return { toolName, callId, error: compactToolError(errorMessage(out.value)) };
    }
    if (out.type === 'execution-denied') {
      const reason = typeof out.reason === 'string' ? out.reason : 'execution denied';
      return { toolName, callId, error: compactToolError(reason) };
    }
  }

  // (3) The project's own failure contract: `{ success: false, error, code }`.
  if (output && typeof output === 'object') {
    const out = output as { success?: unknown; error?: unknown; code?: unknown };
    if (out.success === false) {
      const message = typeof out.error === 'string' ? out.error : 'tool reported failure';
      const code = typeof out.code === 'string' ? ` [${out.code}]` : '';
      return { toolName, callId, error: compactToolError(`${message}${code}`) };
    }
  }

  return null;
}

function errorMessage(value: unknown): string {
  if (value instanceof Error) return value.message;
  if (typeof value === 'string') return value;
  if (value === undefined || value === null) return 'unknown error';
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

function compactToolError(message: string): string {
  const oneLine = message.replace(/\s+/g, ' ').trim();
  return oneLine.length > TOOL_ERROR_MAX_CHARS
    ? oneLine.slice(0, TOOL_ERROR_MAX_CHARS) + '…'
    : oneLine;
}

// ─── AgentRuntime ────────────────────────────────────────────────

/**
 * Executes a resolved agent against a prompt using the AI SDK's
 * `generateText` function.
 *
 * Key design decisions:
 *   1. **Compact events only** (Law 14): the EventBus receives
 *      tool *names* but NOT full arguments or results.  The raw
 *      transcript stays inside this function and is never exposed.
 *   2. **Structured error results**: provider errors, timeouts,
 *      and unrecoverable tool errors produce a structured
 *      `AgentRunResult` with `success: false` — never a thrown
 *      exception that could crash the caller.
 *   3. **Usage tracking**: token usage from the AI SDK response
 *      is captured and included in the result for Phase 13
 *      aggregation.
 */
export class AgentRuntime {
  /**
   * Run a single agent execution.
   *
   * This method NEVER throws.  All errors are captured and
   * returned as part of the `AgentRunResult`.
   */
  async run(options: AgentRunOptions): Promise<AgentRunResult> {
    const {
      agent,
      taskId,
      prompt,
      eventBus,
      maxSteps = DEFAULT_MAX_STEPS,
      timeoutMs = DEFAULT_TIMEOUT_MS,
      planId,
      planStepId,
      signal,
    } = options;

    const agentId = agent.agentId;
    const toolsUsed: string[] = [];
    const errors: string[] = [];
    // Phase 30 (P3): tool-level failures (see `executeWithSdk`) — these do
    // NOT make the run itself fail (a model may recover by calling another
    // tool), but they must never be silently dropped either.
    const toolErrors: ToolFailure[] = [];

    // Phase 20 (CORR-03/05): plan context attached to every event
    const planContext = {
      ...(planId !== undefined ? { planId } : {}),
      ...(planStepId !== undefined ? { planStepId } : {}),
    };

    // ── Emit running event ──────────────────────────────────
    eventBus.emit({
      type: 'agent:running',
      taskId,
      agentId,
      timestamp: Date.now(),
      status: 'running',
      prompt: prompt.slice(0, 200), // Truncate for compact event
      ...planContext,
    });

    // Phase 20 (LEAK-02): the timeout timer MUST be cleared when the
    // race settles, or it keeps the event loop alive after every run.
    let timeoutTimer: ReturnType<typeof setTimeout> | undefined;

    try {
      // ── Race execution against timeout ────────────────────
      const executionPromise = this.executeWithSdk({
        agent,
        prompt,
        maxSteps,
        eventBus,
        taskId,
        agentId,
        toolsUsed,
        toolErrors,
        planContext,
        signal,
      });

      const timeoutPromise = new Promise<never>((_, reject) => {
        timeoutTimer = setTimeout(
          () => reject(new TimeoutError(`Agent run timed out after ${timeoutMs}ms`)),
          timeoutMs
        );
      });

      const sdkResult = await Promise.race([executionPromise, timeoutPromise]);

      // ── Build compact summary ─────────────────────────────
      const summary = this.buildSummary(sdkResult.text, toolsUsed, toolErrors);
      const toolErrorMessages = toolErrors.map(
        (failure) => `${failure.toolName}: ${failure.error}`
      );

      // ── Emit completed event ──────────────────────────────
      eventBus.emit({
        type: 'agent:completed',
        taskId,
        agentId,
        timestamp: Date.now(),
        status: 'completed',
        summary,
        toolsUsed: [...new Set(toolsUsed)],
        usage: sdkResult.usage,
        ...planContext,
      });

      return {
        taskId,
        agentId,
        success: true,
        summary,
        result: sdkResult.text,
        toolsUsed: [...new Set(toolsUsed)],
        // Phase 30 (P3): failures the tools reported are carried on the
        // result (and therefore into the acceptance check) even though
        // the agent run as a whole completed.
        errors: toolErrorMessages,
        usage: sdkResult.usage,
        failureType: null,
      };
    } catch (err) {
      // ── Handle all error types uniformly ──────────────────
      const { message, code } = this.classifyError(err);
      errors.push(message);

      // Emit error event
      eventBus.emit({
        type: 'agent:error',
        taskId,
        agentId,
        timestamp: Date.now(),
        status: 'error',
        error: message,
        code,
        ...planContext,
      });

      return {
        taskId,
        agentId,
        success: false,
        summary: `Agent execution failed: ${message}`,
        result: '',
        toolsUsed: [...new Set(toolsUsed)],
        errors,
        usage: undefined,
        failureType: 'technical',
      };
    } finally {
      if (timeoutTimer) clearTimeout(timeoutTimer);
    }
  }

  // ── Private: AI SDK execution ───────────────────────────────

  private async executeWithSdk(params: {
    agent: ResolvedAgent;
    prompt: string;
    maxSteps: number;
    eventBus: EventBus;
    taskId: string;
    agentId: string;
    toolsUsed: string[];
    /** Phase 30 (P3): filled with every tool-level failure observed */
    toolErrors: ToolFailure[];
    planContext: { planId?: string; planStepId?: string };
    /** Phase 22: cancellation signal, forwarded to generateText */
    signal?: AbortSignal;
  }): Promise<{ text: string; usage?: TokenUsage }> {
    const {
      agent,
      prompt,
      maxSteps,
      eventBus,
      taskId,
      agentId,
      toolsUsed,
      toolErrors,
      planContext,
      signal,
    } = params;

    const hasTools = Object.keys(agent.tools).length > 0;

    const generateOptions: Parameters<typeof generateText>[0] = {
      model: agent.model,
      system: agent.systemPrompt,
      prompt,
      stopWhen: stepCountIs(maxSteps),
      ...(hasTools ? { tools: agent.tools } : {}),
      // Phase 22: real cancellation — aborting rejects generateText
      ...(signal ? { abortSignal: signal } : {}),
    };

    const result = await generateText(generateOptions);

    // Phase 22: `step.toolCalls` is fully typed (Array<TypedToolCall>)
    // in AI SDK v7 — no unsafe cast needed.  The Array.isArray guard
    // stays as a runtime safety net for partial test mocks.
    if (result.steps && Array.isArray(result.steps)) {
      for (const step of result.steps) {
        const toolCalls = step.toolCalls;
        if (Array.isArray(toolCalls)) {
          for (const call of toolCalls) {
            const toolName = call.toolName ?? 'unknown';
            toolsUsed.push(toolName);

            eventBus.emit({
              type: 'agent:tool_call',
              taskId,
              agentId,
              timestamp: Date.now(),
              status: 'running',
              toolName,
              callId: call.toolCallId ?? `call-${randomUUID()}`,
              ...planContext,
            });
          }
        }

        // ── Phase 30 (P3): collect tool-level failures ────────
        // Every tool in `src/ai/tools/implementations/*` that refuses to
        // act returns `{ success: false, error, code }` as a NORMAL tool
        // result — the AI SDK has no idea anything went wrong, so the
        // refusal used to vanish.  A throwing tool is reported by the SDK
        // as a `tool-error` content part instead.  Both end up here.
        const content = (step as { content?: unknown }).content;
        if (!Array.isArray(content)) continue;
        for (const part of content) {
          const failure = describeToolFailure(part);
          if (!failure) continue;

          toolErrors.push(failure);
          eventBus.emit({
            type: 'agent:tool_error',
            taskId,
            agentId,
            timestamp: Date.now(),
            status: 'error',
            toolName: failure.toolName,
            callId: failure.callId,
            error: failure.error,
            ...planContext,
          });
        }
      }
    }

    // Phase 22: typed usage extraction.  `LanguageModelUsage` is the
    // AI SDK v7 shape (inputTokens/outputTokens/totalTokens); the
    // promptTokens/completionTokens fallback keeps compatibility with
    // test mocks built against the older SDK shape.
    type LegacyUsageShape = { promptTokens?: number; completionTokens?: number };
    const rawUsage = result.usage as (LanguageModelUsage & LegacyUsageShape) | undefined;
    const usage: TokenUsage | undefined = rawUsage
      ? {
          promptTokens: rawUsage.promptTokens ?? rawUsage.inputTokens ?? 0,
          completionTokens: rawUsage.completionTokens ?? rawUsage.outputTokens ?? 0,
          totalTokens: rawUsage.totalTokens ?? 0,
        }
      : undefined;

    return {
      text: result.text ?? '',
      usage,
    };
  }

  // ── Private: helpers ────────────────────────────────────────

  /**
   * Build a compact summary from the agent's output.
   * Truncates to ~500 chars to keep events lightweight.
   */
  private buildSummary(
    fullText: string,
    toolsUsed: string[],
    toolErrors: ToolFailure[] = []
  ): string {
    const uniqueTools = [...new Set(toolsUsed)];
    const toolInfo =
      uniqueTools.length > 0
        ? ` Used tools: ${uniqueTools.join(', ')}.`
        : ' No tools used.';

    // Phase 30 (P3): a refused/failed tool call is part of what the
    // human — and the acceptance judge, which reads this summary — must
    // see.  Without it, "the step is complete" was reported for steps
    // whose only tool call had been rejected.
    const errorInfo =
      toolErrors.length === 0
        ? ''
        : ` Tool errors: ${toolErrors
            .slice(0, TOOL_ERROR_MAX_ENTRIES)
            .map((failure) => `${failure.toolName} — ${failure.error}`)
            .join('; ')}${toolErrors.length > TOOL_ERROR_MAX_ENTRIES ? ' (…)' : ''}`;

    const textPreview =
      fullText.length > 400
        ? fullText.slice(0, 400) + '…'
        : fullText;

    return `${textPreview}${toolInfo}${errorInfo}`;
  }

  /**
   * Classify an error into a message and code.
   * Handles TimeoutError, AI SDK errors, and generic errors.
   */
  private classifyError(err: unknown): { message: string; code: string } {
    if (err instanceof TimeoutError) {
      return { message: err.message, code: 'TIMEOUT' };
    }

    if (err instanceof Error) {
      // Phase 22: cancellation — an aborted run is a controlled failure,
      // not a provider error.
      if (err.name === 'AbortError' || /abort/i.test(err.message)) {
        return { message: err.message, code: 'ABORTED' };
      }

      // AI SDK provider errors often have a `cause` or specific message patterns
      const msg = err.message;
      if (msg.includes('rate limit') || msg.includes('429')) {
        return { message: msg, code: 'RATE_LIMIT' };
      }
      if (msg.includes('API key') || msg.includes('authentication') || msg.includes('401')) {
        return { message: 'Provider authentication failed', code: 'AUTH_ERROR' };
      }
      if (msg.includes('timeout') || msg.includes('ETIMEDOUT')) {
        return { message: msg, code: 'TIMEOUT' };
      }
      return { message: msg, code: 'PROVIDER_ERROR' };
    }

    return { message: String(err), code: 'UNKNOWN' };
  }
}

// ─── Custom error class ──────────────────────────────────────────

class TimeoutError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'TimeoutError';
  }
}

/**
 * @deprecated Phase 19 (SING-02): a shared AgentRuntime breaks
 * isolation between Orchestrator instances.  Each Orchestrator creates
 * its own `new AgentRuntime()`; TaskRuntime also creates a fresh
 * instance when none is configured.  Kept only for source
 * compatibility — do not use in new code.
 */
export const agentRuntime = new AgentRuntime();
