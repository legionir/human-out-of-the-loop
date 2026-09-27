/**
 * G-09: the REPL used to construct a fresh Orchestrator (and reconnect every
 * MCP server) on every goal.  Cache one instance per (cwd, model, persistent).
 */
import { Orchestrator, type OrchestratorConfig } from '../../ai/orchestrator.js';
import type { ProgressEvent } from '../../ai/runtime/streaming-manager.js';
import type { ThoughtSink } from '../../ai/runtime/thought-stream.js';
import type { ToolCallSink } from '../../ai/runtime/tool-call-log.js';

export interface OrchestratorCacheKey {
  cwd: string;
  model?: string;
  persistent: boolean;
}

function keyOf(k: OrchestratorCacheKey): string {
  return `${k.persistent ? '1' : '0'}|${k.model ?? ''}|${k.cwd}`;
}

export interface CachedOrchestratorHooks {
  onProgress?: (event: ProgressEvent) => void;
  onThought?: ThoughtSink;
  onToolCall?: ToolCallSink;
}

export interface CachedOrchestrator {
  orchestrator: Orchestrator;
  hooks: CachedOrchestratorHooks;
}

export class OrchestratorCache {
  private readonly entries = new Map<string, CachedOrchestrator>();
  /** How many Orchestrator instances this cache has constructed. */
  constructCount = 0;
  /** How many `initialize()` calls actually bootstrapped (not no-ops). */
  initializeCount = 0;

  acquire(
    key: OrchestratorCacheKey,
    rest: Omit<
      OrchestratorConfig,
      'projectRoot' | 'persistent' | 'defaultModelId' | 'onProgress' | 'onThought' | 'onToolCall'
    > = {},
  ): CachedOrchestrator {
    const id = keyOf(key);
    const existing = this.entries.get(id);
    if (existing) return existing;
    const hooks: CachedOrchestratorHooks = {};
    const orchestrator = new Orchestrator({
      ...rest,
      projectRoot: key.cwd,
      persistent: key.persistent,
      ...(key.model ? { defaultModelId: key.model } : {}),
      onProgress: (event) => hooks.onProgress?.(event),
      onThought: (chunk) => hooks.onThought?.(chunk),
      onToolCall: (record) => hooks.onToolCall?.(record),
    });
    this.constructCount += 1;
    const original = orchestrator.initialize.bind(orchestrator);
    orchestrator.initialize = async () => {
      const already = (orchestrator as unknown as { initialized?: boolean }).initialized === true;
      await original();
      if (!already) this.initializeCount += 1;
    };
    const entry: CachedOrchestrator = { orchestrator, hooks };
    this.entries.set(id, entry);
    return entry;
  }

  async invalidate(): Promise<void> {
    const pending = [...this.entries.values()].map((e) => e.orchestrator.shutdown().catch(() => undefined));
    this.entries.clear();
    await Promise.all(pending);
  }
}
