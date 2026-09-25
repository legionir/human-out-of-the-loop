import { randomUUID } from 'node:crypto';
import { generateText, streamText, stepCountIs } from 'ai';
import { withJournal, type JournalWriter } from './journal.js';
import { toTokenUsage } from './llm-usage.js';
import type { ResolvedAgent } from '../agents/agent-factory.js';
import { EventBus, type TokenUsage } from './event-bus.js';
import {
  emitThought,
  reasoningFromRawChunk,
  type ThoughtSink,
} from './thought-stream.js';

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

/**
 * Phase 32: the slice of an AI SDK result this runtime consumes.  Typing
 * it structurally keeps the `generateText` and `streamText` branches
 * interchangeable — both produce text, steps (tool calls, content) and
 * usage — without leaking the SDK's generic parameters into this file.
 */
interface SdkStepLike {
  toolCalls?: ReadonlyArray<{ toolName?: string; toolCallId?: string }>;
  content?: unknown;
}

interface SdkRunOutcome {
  text: string;
  steps?: ReadonlyArray<SdkStepLike>;
  /** Raw SDK usage — normalized with `toTokenUsage` by the caller. */
  usage?: unknown;
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
  /**
   * Phase 32: live model thinking (reasoning) text.
   *
   * When set, the turn is executed with `streamText` instead of
   * `generateText` so reasoning deltas can be forwarded as they are
   * produced; the returned result is the same (text, tool calls, usage).
   * Left undefined, the runtime stays on the non-streaming call.
   */
  onThought?: ThoughtSink;
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

  // (4) MCP servers report failures as a RESULT with `isError: true`
  // (@ai-sdk/mcp returns it verbatim instead of throwing).  Without this
  // case a failing MCP tool looked like a success to the runtime:
  // `task.errors` stayed empty and acceptance could not see it.
  if (output && typeof output === 'object') {
    const out = output as { isError?: unknown; content?: unknown };
    if (out.isError === true) {
      const message = mcpErrorText(out.content);
      return { toolName, callId, error: compactToolError(message ?? 'MCP tool reported an error') };
    }
  }

  return null;
}

/** Flatten an MCP `content` array into a one-line message. */
function mcpErrorText(content: unknown): string | null {
  if (!Array.isArray(content)) return null;
  const texts = content
    .map((item) => {
      if (!item || typeof item !== 'object') return null;
      const entry = item as { type?: unknown; text?: unknown };
      return entry.type === 'text' && typeof entry.text === 'string' ? entry.text : null;
    })
    .filter((t): t is string => t !== null);
  return texts.length > 0 ? texts.join(' ') : null;
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
   * Phase 37 — the Journal, when the process has one.
   *
   * Set through {@link setJournal} by the Orchestrator (which owns
   * `runtimeDir`); left unset in unit tests that construct a bare runtime, in
   * which case the tool set is passed through untouched.
   */
  private journal: JournalWriter | null = null;

  /** Phase 37: wire (or clear) the journal this runtime writes tool actions to. */
  setJournal(journal: JournalWriter | null): void {
    this.journal = journal;
  }

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
      onThought,
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
      // Phase 30 (P5): the run's own deadline.  When it fires the in-flight
      // request must be aborted — an abandoned request keeps the Node event
      // loop (and therefore the CLI process) alive until the provider
      // eventually answers, which is exactly the "hang after the report"
      // that the P5 e2e caught.
      const runController = new AbortController();
      const abortSignal =
        signal && typeof AbortSignal.any === 'function'
          ? AbortSignal.any([signal, runController.signal])
          : runController.signal;

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
        signal: abortSignal,
        ...(onThought ? { onThought } : {}),
      });
      // The loser of the race must not surface as an unhandled rejection
      // when the aborted request settles.
      executionPromise.catch(() => {});

      const timeoutPromise = new Promise<never>((_, reject) => {
        timeoutTimer = setTimeout(() => {
          const error = new TimeoutError(`Agent run timed out after ${timeoutMs}ms`);
          runController.abort(error);
          reject(error);
        }, timeoutMs);
      });

      const sdkResult = await Promise.race([executionPromise, timeoutPromise]);

      // A turn with no text and no tool call did nothing; counting it as a
      // completed task let an empty answer pass as a finished step.
      if (!sdkResult.text.trim() && toolsUsed.length === 0) {
        throw new EmptyResponseError(
          'The model returned an empty response (no text and no tool calls).'
        );
      }

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
    /** Phase 32: live thinking text (switches the turn to `streamText`) */
    onThought?: ThoughtSink;
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
      onThought,
    } = params;

    const hasTools = Object.keys(agent.tools).length > 0;

    // Phase 37: journal every tool execution from ONE place — the tools the
    // runtime is about to hand to the model.  Both branches below use this
    // wrapped set, so `streamText` (the thinking path) is covered by the same
    // wiring as `generateText`; a new tool needs no journal code of its own.
    const tools = hasTools
      ? withJournal(agent.tools, { taskId, agentId, ...planContext }, this.journal)
      : undefined;

    const generateOptions: Parameters<typeof generateText>[0] = {
      model: agent.model,
      system: agent.systemPrompt,
      prompt,
      stopWhen: stepCountIs(maxSteps),
      ...(tools ? { tools } : {}),
      // Phase 22: real cancellation — aborting rejects generateText
      ...(signal ? { abortSignal: signal } : {}),
    };

    // Phase 32: with a thinking sink the same turn is executed by
    // `streamText`, so reasoning deltas can be forwarded while the model
    // is still answering.  Without one the call — and therefore the
    // token stream, the retries and the result — is exactly what it was.
    const result: SdkRunOutcome = onThought
      ? await this.streamWithThoughts({
          model: agent.model,
          system: agent.systemPrompt,
          prompt,
          maxSteps,
          tools,
          signal,
          onThought,
          context: { taskId, agentId, ...planContext },
        })
      : await generateText(generateOptions);

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

    // Phase 22: typed usage extraction (SDK v7 shape, legacy-mock fallback).
    const usage: TokenUsage | undefined = toTokenUsage(result.usage);

    return {
      text: result.text ?? '',
      usage,
    };
  }

  // ── Private: streaming (Phase 32) ───────────────────────────

  /**
   * Execute one turn with `streamText` and forward the model's thinking
   * text as it arrives.
   *
   * Returns the same information the `generateText` branch produces, so
   * the rest of the runtime (tool-call events, usage, summaries) is
   * untouched by the choice.  Tool calls and their failures are still
   * collected from `steps` afterwards — the event order of a run does not
   * change because a terminal is watching.
   */
  private async streamWithThoughts(params: {
    model: ResolvedAgent['model'];
    system: string;
    prompt: string;
    maxSteps: number;
    tools?: ResolvedAgent['tools'];
    signal?: AbortSignal;
    onThought: ThoughtSink;
    context: { taskId?: string; agentId?: string; planId?: string; planStepId?: string };
  }): Promise<SdkRunOutcome> {
    const { model, system, prompt, maxSteps, tools, signal, onThought, context } = params;

    const streamed = streamText({
      model,
      system,
      prompt,
      stopWhen: stepCountIs(maxSteps),
      ...(tools ? { tools } : {}),
      ...(signal ? { abortSignal: signal } : {}),
      // OpenAI-compatible gateways answer reasoning in
      // `delta.reasoning_content`, which the SDK's chat chunk schema
      // drops; the raw chunk still carries it.
      includeRawChunks: true,
    });

    await this.pipeThoughts(streamed.fullStream, onThought, context);

    const [text, steps, usage] = await Promise.all([
      streamed.text,
      streamed.steps,
      streamed.usage,
    ]);

    return { text, steps: steps as ReadonlyArray<SdkStepLike>, usage };
  }

  /**
   * Read the SDK stream, forwarding reasoning to the sink.
   *
   * Two sources, in priority order:
   *   1. real reasoning parts (`reasoning-start/-delta/-end`) — OpenAI
   *      reasoning summaries, Anthropic extended thinking, …;
   *   2. the raw provider chunk, for gateways whose reasoning lives in a
   *      field the SDK does not model (`delta.reasoning_content`).
   *
   * Only one of the two is used per turn: a provider that emits reasoning
   * parts also ships the same text in its raw chunks, and printing both
   * would duplicate every thought.
   */
  private async pipeThoughts(
    stream: AsyncIterable<unknown>,
    onThought: ThoughtSink,
    context: { taskId?: string; agentId?: string; planId?: string; planStepId?: string },
  ): Promise<void> {
    let blockOpen = false;
    let nativeReasoning = false;

    const openBlock = (source: 'reasoning' | 'provider-field'): void => {
      if (blockOpen) return;
      blockOpen = true;
      emitThought(onThought, { kind: 'start', source, ...context });
    };
    const closeBlock = (): void => {
      if (!blockOpen) return;
      blockOpen = false;
      emitThought(onThought, { kind: 'end', ...context });
    };

    for await (const chunk of stream) {
      const part = (chunk ?? {}) as {
        type?: unknown;
        text?: unknown;
        delta?: unknown;
        rawValue?: unknown;
      };
      switch (part.type) {
        case 'reasoning-start':
          nativeReasoning = true;
          openBlock('reasoning');
          break;
        case 'reasoning-delta': {
          // The public stream uses `text`; the language-model part uses
          // `delta` — accept both so a shape change cannot silence it.
          const text =
            typeof part.text === 'string'
              ? part.text
              : typeof part.delta === 'string'
                ? part.delta
                : '';
          if (text.length === 0) break;
          nativeReasoning = true;
          openBlock('reasoning');
          emitThought(onThought, { kind: 'delta', text, source: 'reasoning', ...context });
          break;
        }
        case 'reasoning-end':
          nativeReasoning = true;
          closeBlock();
          break;
        case 'raw': {
          if (nativeReasoning) break;
          const text = reasoningFromRawChunk(part.rawValue);
          if (!text) break;
          openBlock('provider-field');
          emitThought(onThought, { kind: 'delta', text, source: 'provider-field', ...context });
          break;
        }
        case 'text-start':
        case 'tool-call':
        case 'start-step':
        case 'finish-step':
          // The thinking block is over; the answer (or the next turn) begins.
          closeBlock();
          break;
        default:
          break;
      }
    }

    closeBlock();
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
    if (err instanceof EmptyResponseError) {
      return { message: err.message, code: 'EMPTY_RESPONSE' };
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

/** The model answered, but with nothing: no text and no tool call. */
export class EmptyResponseError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'EmptyResponseError';
  }
}
