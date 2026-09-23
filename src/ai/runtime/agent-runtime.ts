import { generateText, stepCountIs } from 'ai';
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
}

// ─── Constants ────────────────────────────────────────────────────

const DEFAULT_MAX_STEPS = 20;
const DEFAULT_TIMEOUT_MS = 120_000; // 2 minutes

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
    } = options;

    const agentId = agent.agentId;
    const toolsUsed: string[] = [];
    const errors: string[] = [];

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
        planContext,
      });

      const timeoutPromise = new Promise<never>((_, reject) => {
        timeoutTimer = setTimeout(
          () => reject(new TimeoutError(`Agent run timed out after ${timeoutMs}ms`)),
          timeoutMs
        );
      });

      const sdkResult = await Promise.race([executionPromise, timeoutPromise]);

      // ── Build compact summary ─────────────────────────────
      const summary = this.buildSummary(sdkResult.text, toolsUsed);

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
        errors: [],
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
    planContext: { planId?: string; planStepId?: string };
  }): Promise<{ text: string; usage?: TokenUsage }> {
    const { agent, prompt, maxSteps, eventBus, taskId, agentId, toolsUsed, planContext } = params;

    const hasTools = Object.keys(agent.tools).length > 0;

    const generateOptions: Parameters<typeof generateText>[0] = {
      model: agent.model,
      system: agent.systemPrompt,
      prompt,
      stopWhen: stepCountIs(maxSteps),
      ...(hasTools ? { tools: agent.tools } : {}),
    };

    const result = await generateText(generateOptions);

    // ✅ FIXED: Safely extract tool calls regardless of AI SDK version
    if (result.steps && Array.isArray(result.steps)) {
      for (const step of result.steps) {
        // AI SDK v4+: step.toolCalls is ToolCallPart[]
        const toolCalls = (step as any).toolCalls;
        if (Array.isArray(toolCalls)) {
          for (const call of toolCalls) {
            const toolName = call.toolName ?? call.tool?.name ?? 'unknown';
            toolsUsed.push(toolName);

            eventBus.emit({
              type: 'agent:tool_call',
              taskId,
              agentId,
              timestamp: Date.now(),
              status: 'running',
              toolName,
              callId: call.toolCallId ?? call.id ?? `call-${Date.now()}`,
              ...planContext,
            });
          }
        }
      }
    }

    // ✅ FIXED: Safely extract usage
    const rawUsage = result.usage as any;
    const usage: TokenUsage | undefined = rawUsage
      ? {
          promptTokens: rawUsage.promptTokens ?? rawUsage.inputTokens ?? rawUsage.inputTokenDetails?.total ?? 0,
          completionTokens: rawUsage.completionTokens ?? rawUsage.outputTokens ?? rawUsage.outputTokenDetails?.total ?? 0,
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
  private buildSummary(fullText: string, toolsUsed: string[]): string {
    const uniqueTools = [...new Set(toolsUsed)];
    const toolInfo =
      uniqueTools.length > 0
        ? ` Used tools: ${uniqueTools.join(', ')}.`
        : ' No tools used.';

    const textPreview =
      fullText.length > 400
        ? fullText.slice(0, 400) + '…'
        : fullText;

    return `${textPreview}${toolInfo}`;
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
