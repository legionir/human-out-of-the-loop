import { randomUUID } from 'node:crypto';
import { generateText, streamText, stepCountIs, type Tool } from 'ai';
import { withGenerationSettings } from '../models/generation-settings.js';
import { withJournal, type JournalWriter } from './journal.js';
import { withToolCallLog, type ToolCallLogOptions, type ToolCallSink } from './tool-call-log.js';
import { addTokenUsage, toTokenUsage } from './llm-usage.js';
import { capToolResult } from './tool-result-cap.js';
import {
  DEFAULT_CONTEXT_BUDGET_CHARS,
  trimConversationMessages,
} from './conversation-budget.js';
import type { ResolvedAgent } from '../agents/agent-factory.js';
import { EventBus, type TokenUsage } from './event-bus.js';
import { runWithAgentContext } from './agent-run-context.js';
import { wrapModelForRetry } from './model-call-retry.js';
import type { RateLimiter } from './rate-limiter.js';
import {
  emitThought,
  reasoningFromRawChunk,
  responsesReasoningFromRawChunk,
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
  finishReason?: string;
  /**
   * v27.17.2: the streamed turn came back empty, so the same prompt was asked
   * again without streaming.  The run's summary says so.
   */
  reaskedWithoutStreaming?: boolean;
}

export class ProviderStreamError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ProviderStreamError';
  }
}

/** Did any step call a tool?  A turn with tool calls is not "empty". */
function stepsHaveToolCalls(steps: ReadonlyArray<SdkStepLike> | undefined): boolean {
  if (!Array.isArray(steps)) return false;
  return steps.some((step) => Array.isArray(step.toolCalls) && step.toolCalls.length > 0);
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
  /**
   * v27.17.3: one record per tool call with type, name, input and status
   * (see `tool-call-log.ts`).  The CLI renders a line per call; a UI can feed
   * the same records into its own event stream.
   */
  onToolCall?: ToolCallSink;
  /**
   * v27.17.3: how the records above resolve a tool's category and which
   * credential values to scrub out of the shown input.  Supplied by the
   * Orchestrator (it owns the registries and the secrets); a bare runtime
   * falls back to name-based inference.
   */
  toolCallOptions?: ToolCallLogOptions;
  /** F-04: conversation history is trimmed to this many characters. */
  contextBudgetChars?: number;
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

function withRuntimeToolHooks<T extends Record<string, unknown>>(
  tools: T,
  ctx: {
    signal?: AbortSignal;
    eventBus: EventBus;
    taskId: string;
    agentId: string;
    planContext: { planId?: string; planStepId?: string };
    toolsUsed: string[];
    emittedCallIds: Set<string>;
  }
): T {
  const wrapped: Record<string, unknown> = {};
  for (const [name, value] of Object.entries(tools)) {
    const tool = value as Tool;
    if (typeof tool.execute !== 'function') {
      wrapped[name] = value;
      continue;
    }
    const originalExecute = tool.execute.bind(tool);
    wrapped[name] = {
      ...tool,
      execute: async (input: unknown, options?: { abortSignal?: AbortSignal; toolCallId?: string }) => {
        const signal = options?.abortSignal ?? ctx.signal;
        if (signal?.aborted) {
          const reason = signal.reason;
          throw reason instanceof Error ? reason : new Error('Aborted');
        }
        ctx.toolsUsed.push(name);
        const callId = options?.toolCallId ?? `call-${randomUUID()}`;
        ctx.emittedCallIds.add(callId);
        ctx.eventBus.emit({
          type: 'agent:tool_call',
          taskId: ctx.taskId,
          agentId: ctx.agentId,
          timestamp: Date.now(),
          status: 'running',
          toolName: name,
          callId,
          ...ctx.planContext,
        });
        const output = await originalExecute(input, { ...options, abortSignal: signal } as never);
        return capToolResult(output);
      },
    };
  }
  return wrapped as T;
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
  private readonly rateLimiter?: RateLimiter;

  constructor(options: { rateLimiter?: RateLimiter } = {}) {
    this.rateLimiter = options.rateLimiter;
  }

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
      onToolCall,
      toolCallOptions,
      contextBudgetChars = DEFAULT_CONTEXT_BUDGET_CHARS,
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
    const usageAcc: { value?: TokenUsage } = {};
    const runController = new AbortController();
    const abortSignal =
      signal && typeof AbortSignal.any === 'function'
        ? AbortSignal.any([signal, runController.signal])
        : runController.signal;

    const invoke = async (): Promise<AgentRunResult> => {
      // ── Race execution against timeout ────────────────────
      // Phase 30 (P5): the run's own deadline.  When it fires the in-flight
      // request must be aborted — an abandoned request keeps the Node event
      // loop (and therefore the CLI process) alive until the provider
      // eventually answers, which is exactly the "hang after the report"
      // that the P5 e2e caught.

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
        usageAcc,
        signal: abortSignal,
        ...(onThought ? { onThought } : {}),
        ...(onToolCall ? { onToolCall } : {}),
        ...(toolCallOptions ? { toolCallOptions } : {}),
        contextBudgetChars,
      });

      const timeoutPromise = new Promise<never>((_, reject) => {
        timeoutTimer = setTimeout(() => {
          const error = new TimeoutError(`Agent run timed out after ${timeoutMs}ms`);
          runController.abort(error);
          reject(error);
        }, timeoutMs);
      });

      let sdkResult: SdkRunOutcome;
      try {
        sdkResult = await Promise.race([executionPromise, timeoutPromise]);
      } catch (err) {
        // C-01: hold the caller (and therefore resource locks) until the
        // in-flight generateText/tool work actually settles.
        await executionPromise.then(
          () => undefined,
          () => undefined
        );
        throw err;
      }

      // A turn with no text and no tool call did nothing; counting it as a
      // completed task let an empty answer pass as a finished step.
      if (!sdkResult.text.trim() && toolsUsed.length === 0) {
        throw new EmptyResponseError(
          'The model returned an empty response (no text and no tool calls).'
        );
      }

      // ── Build compact summary ─────────────────────────────
      const summary = this.buildSummary(
        sdkResult.text,
        toolsUsed,
        toolErrors,
        sdkResult.reaskedWithoutStreaming === true
      );
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
        usage: sdkResult.usage as TokenUsage | undefined,
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
        usage: sdkResult.usage as TokenUsage | undefined,
        failureType: null,
      };
    };

    try {
      return await runWithAgentContext(
        {
          taskId,
          agentId,
          personaId: agent.persona?.id ?? agent.agentId,
          delegationDepth: agent.delegationDepth ?? 0,
          abortSignal,
          ...planContext,
        },
        invoke
      );
    } catch (err) {
      // ── Handle all error types uniformly ──────────────────
      const { message, code } = this.classifyError(err);
      errors.push(message);

      // Emit error event (C-06: include partial usage so aggregators see it)
      eventBus.emit({
        type: 'agent:error',
        taskId,
        agentId,
        timestamp: Date.now(),
        status: 'error',
        error: message,
        code,
        ...(usageAcc.value ? { usage: usageAcc.value } : {}),
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
        usage: usageAcc.value,
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
    usageAcc: { value?: TokenUsage };
    /** Phase 22: cancellation signal, forwarded to generateText */
    signal?: AbortSignal;
    /** Phase 32: live thinking text (switches the turn to `streamText`) */
    onThought?: ThoughtSink;
    /** v27.17.3: structured tool-call records */
    onToolCall?: ToolCallSink;
    /** v27.17.3: how those records resolve a tool's type, and what to redact */
    toolCallOptions?: ToolCallLogOptions;
    contextBudgetChars?: number;
  }): Promise<{ text: string; usage?: TokenUsage; reaskedWithoutStreaming?: boolean }> {
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
      usageAcc,
      signal,
      onThought,
      onToolCall,
      toolCallOptions,
      contextBudgetChars = DEFAULT_CONTEXT_BUDGET_CHARS,
    } = params;

    const hasTools = Object.keys(agent.tools).length > 0;

    // Phase 37: journal every tool execution from ONE place — the tools the
    // runtime is about to hand to the model.  Both branches below use this
    // wrapped set, so `streamText` (the thinking path) is covered by the same
    // wiring as `generateText`; a new tool needs no journal code of its own.
    const journalled = hasTools
      ? withToolCallLog(
          withJournal(agent.tools, { taskId, agentId, ...planContext }, this.journal),
          { taskId, agentId, ...planContext },
          onToolCall,
          toolCallOptions ?? {}
        )
      : undefined;
    const emittedCallIds = new Set<string>();
    const tools = journalled
      ? withRuntimeToolHooks(journalled, {
          signal,
          eventBus,
          taskId,
          agentId,
          planContext,
          toolsUsed,
          emittedCallIds,
        })
      : undefined;

    const model = wrapModelForRetry(
      agent.model,
      this.rateLimiter,
      agent.providerId ?? 'default'
    );

    const onStepFinish = (event: { usage?: unknown; finishReason?: string }): void => {
      const stepUsage = toTokenUsage(event.usage);
      if (stepUsage) usageAcc.value = addTokenUsage(usageAcc.value, stepUsage);
      if (event.finishReason === 'error') {
        throw new ProviderStreamError('Provider finished the step with finishReason=error');
      }
    };

    const prepareStep = (({ messages }: { messages: unknown[] }) => ({
      messages: trimConversationMessages(messages, contextBudgetChars),
    })) as never;

    const generateOptions: Parameters<typeof generateText>[0] = withGenerationSettings(
      {
        model,
        system: agent.systemPrompt,
        prompt,
        stopWhen: stepCountIs(maxSteps),
        ...(tools ? { tools } : {}),
        // Phase 22: real cancellation — aborting rejects generateText
        ...(signal ? { abortSignal: signal } : {}),
        onStepFinish,
        prepareStep,
      },
      agent.generationSettings
    );

    // Phase 32: with a thinking sink the same turn is executed by
    // `streamText`, so reasoning deltas can be forwarded while the model
    // is still answering.  Without one the call — and therefore the
    // token stream, the retries and the result — is exactly what it was.
    //
    // v27.17.2: providers that cannot stream.  A gateway may answer a
    // `stream: true` Responses request with a non-streamed Chat Completions
    // body — the reporter's returned `{"choices":[{"message":{"role":
    // "assistant","content":""}}]}`, which the SDK turns into an empty turn (and
    // which the official provider refuses with "Received a Chat Completions
    // stream while using the OpenAI Responses API" for other gateways).  When
    // the streaming attempt gives nothing to show, the same prompt is asked
    // once more WITHOUT streaming: that is the difference between the real
    // answer and the assessment's draft.  Cancellation and timeouts are never
    // re-asked — the run is over by then.
    let reaskedWithoutStreaming = false;
    const stillWanted = (): boolean => signal?.aborted !== true;

    let result: SdkRunOutcome;
    if (!onThought) {
      result = await generateText(generateOptions);
    } else {
      try {
        result = await this.streamWithThoughts({
          model,
          system: agent.systemPrompt,
          prompt,
          maxSteps,
          tools,
          signal,
          onThought,
          context: { taskId, agentId, ...planContext },
          generationSettings: agent.generationSettings,
          contextBudgetChars,
        });
      } catch (err) {
        if (!stillWanted()) throw err;
        if (err instanceof ProviderStreamError) throw err;
        reaskedWithoutStreaming = true;
        result = await generateText(generateOptions);
      }

      if (!reaskedWithoutStreaming && result.text.trim() === '' && !stepsHaveToolCalls(result.steps)) {
        if (!stillWanted()) {
          throw new EmptyResponseError(
            'The model returned an empty response (no text and no tool calls).'
          );
        }
        reaskedWithoutStreaming = true;
        result = await generateText(generateOptions);
      }
    }

    if (result.finishReason === 'error') {
      throw new ProviderStreamError('Provider stream finished with finishReason=error');
    }

    // Phase 22: `step.toolCalls` is fully typed (Array<TypedToolCall>)
    // in AI SDK v7 — no unsafe cast needed.  The Array.isArray guard
    // stays as a runtime safety net for partial test mocks.
    // C-12: `agent:tool_call` is emitted when the tool *starts* (see
    // withRuntimeToolHooks).  Here we only backfill toolsUsed for mocks
    // that never invoke execute, and collect tool-level failures.
    if (result.steps && Array.isArray(result.steps)) {
      for (const step of result.steps) {
        const toolCalls = step.toolCalls;
        if (Array.isArray(toolCalls)) {
          for (const call of toolCalls) {
            const toolName = call.toolName ?? 'unknown';
            if (!toolsUsed.includes(toolName)) toolsUsed.push(toolName);
            const callId = call.toolCallId ?? `call-${randomUUID()}`;
            if (!emittedCallIds.has(callId)) {
              emittedCallIds.add(callId);
              eventBus.emit({
                type: 'agent:tool_call',
                taskId,
                agentId,
                timestamp: Date.now(),
                status: 'running',
                toolName,
                callId,
                ...planContext,
              });
            }
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
    if (usage) usageAcc.value = usage;

    return {
      text: result.text ?? '',
      usage: usageAcc.value ?? usage,
      ...(reaskedWithoutStreaming ? { reaskedWithoutStreaming: true } : {}),
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
    generationSettings?: ResolvedAgent['generationSettings'];
    tools?: ResolvedAgent['tools'];
    signal?: AbortSignal;
    onThought: ThoughtSink;
    context: { taskId?: string; agentId?: string; planId?: string; planStepId?: string };
    contextBudgetChars?: number;
  }): Promise<SdkRunOutcome> {
    const { model, system, prompt, maxSteps, tools, signal, onThought, context, generationSettings } =
      params;
    const budgetChars = params.contextBudgetChars ?? DEFAULT_CONTEXT_BUDGET_CHARS;

    // `await` on purpose: the SDK returns the result object synchronously, and
    // awaiting a non-promise is a no-op — but a provider shim (a test double,
    // a gateway adapter) may hand back a promise, and then every field below
    // would read `undefined`.
    const streamed = await streamText(
      withGenerationSettings(
        {
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
          prepareStep: (({ messages }: { messages: unknown[] }) => ({
            messages: trimConversationMessages(messages, budgetChars),
          })) as never,
        },
        generationSettings
      )
    );

    const emittedChars = await this.pipeThoughts(streamed.fullStream, onThought, context);

    const [text, steps, usage, reasoningText, finishReason] = await Promise.all([
      streamed.text,
      streamed.steps,
      streamed.usage,
      streamed.reasoningText,
      streamed.finishReason ?? Promise.resolve(undefined),
    ]);

    if (finishReason === 'error') {
      throw new ProviderStreamError('Provider stream finished with finishReason=error');
    }

    // v27.17.2 — the reporter's gateway put the thinking in an item the SDK
    // only parses at the END of the stream (and mapped none of it to a
    // reasoning delta), so the CLI opened a `💭` block and never filled it.
    // Showing the collected text late is worse than streaming it, and far
    // better than losing it.
    if (reasoningText && emittedChars === 0) {
      emitThought(onThought, { kind: 'start', source: 'provider-field', ...context });
      emitThought(onThought, {
        kind: 'delta',
        text: reasoningText,
        source: 'provider-field',
        ...context,
      });
      emitThought(onThought, { kind: 'end', ...context });
    }

    return {
      text,
      steps: steps as ReadonlyArray<SdkStepLike>,
      usage,
      ...(typeof finishReason === 'string' ? { finishReason } : {}),
    };
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
  ): Promise<number> {
    let blockOpen = false;
    // The SDK relayed reasoning of its own (a `reasoning-start`/`-delta` part).
    let nativeReasoning = false;
    // …and that reasoning carried text (so raw chunks would only duplicate it).
    let nativeText = false;
    // Everything shown this turn, whatever the source — used to show only the
    // part of a late full item that was not streamed already.
    let emitted = '';

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
    const show = (text: string, source: 'reasoning' | 'provider-field'): void => {
      openBlock(source);
      emitted += text;
      emitThought(onThought, { kind: 'delta', text, source, ...context });
    };

    for await (const chunk of stream) {
      const part = (chunk ?? {}) as {
        type?: unknown;
        text?: unknown;
        delta?: unknown;
        rawValue?: unknown;
        error?: unknown;
      };
      switch (part.type) {
        case 'error': {
          const message =
            typeof part.error === 'string'
              ? part.error
              : part.error instanceof Error
                ? part.error.message
                : typeof part.text === 'string'
                  ? part.text
                  : 'Provider stream error';
          throw new ProviderStreamError(message);
        }
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
          nativeText = true;
          show(text, 'reasoning');
          break;
        }
        case 'reasoning-end':
          nativeReasoning = true;
          closeBlock();
          break;
        case 'raw': {
          // Responses API shapes the SDK drops (v27.17.2) — see
          // `responsesReasoningFromRawChunk`.  A delta is skipped when the SDK
          // is already relaying text; a full item is shown minus what was
          // streamed, so the block is filled instead of left empty.
          const responses = responsesReasoningFromRawChunk(part.rawValue);
          if (responses) {
            if (responses.full) {
              if (emitted.includes(responses.text)) break;
              const rest = emitted.length > 0 && responses.text.startsWith(emitted)
                ? responses.text.slice(emitted.length)
                : responses.text;
              if (rest.length > 0) show(rest, 'provider-field');
              break;
            }
            if (nativeText) break;
            show(responses.text, 'provider-field');
            break;
          }

          if (nativeReasoning) break;
          const text = reasoningFromRawChunk(part.rawValue);
          if (!text) break;
          show(text, 'provider-field');
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
    return emitted.length;
  }

  // ── Private: helpers ────────────────────────────────────────

  /**
   * Build a compact summary from the agent's output.
   * Truncates to ~500 chars to keep events lightweight.
   */
  private buildSummary(
    fullText: string,
    toolsUsed: string[],
    toolErrors: ToolFailure[] = [],
    reaskedWithoutStreaming = false
  ): string {
    // v27.17.2: the streamed turn was empty and the same prompt was asked
    // again without streaming — say so, so a "why did it answer twice?" is
    // answerable from the log instead of being a mystery.
    const streamInfo = reaskedWithoutStreaming
      ? ' The provider streamed no answer; the turn was repeated without streaming.'
      : '';
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

    return `${textPreview}${toolInfo}${errorInfo}${streamInfo}`;
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
      if (err instanceof ProviderStreamError || err.name === 'ProviderStreamError') {
        return { message: msg, code: 'PROVIDER_ERROR' };
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
