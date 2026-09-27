/**
 * Phase 24 (UI): server context shared by all routes.
 */
import type { Express } from 'express';
import type { Orchestrator } from '../ai/orchestrator.js';
import type { SseHub } from './sse.js';

export type RunStateKind =
  | 'planning'
  | 'awaiting-clarification'
  | 'awaiting-confirmation'
  | 'running'
  | 'done'
  | 'error';

export interface RunState {
  runId: string;
  sessionId?: string;
  state: RunStateKind;
  planId?: string;
  planText?: string;
  report?: string;
  outcome?: string;
  error?: string;
  createdAt: number;
  /** Resolves the interactive confirmation for this run (UI decision). */
  confirmResolver?: (decision: { confirmed: boolean; feedback?: string }) => void;
  /**
   * U5: the planner's pending questions while `state === 'awaiting-clarification'`.
   * Exposed over `GET /api/runs/:runId` so a client that missed the SSE
   * event can still render the form.
   */
  clarificationQuestions?: string[];
  /** U5: which clarification round is open (1-based). */
  clarificationRound?: number;
  /**
   * U5: resolves the open clarification; `null` = the user declined to
   * answer (the orchestrator records that as a cancelled run).
   */
  clarificationResolver?: (answers: Record<string, string> | null) => void;
  /** A-04: abort in-flight planning (LLM calls honour this signal). */
  abortController?: AbortController;
  /** A-08: bearer token that created this run (undefined when auth is off). */
  ownerToken?: string;
  /** A-05: idle TTL while awaiting clarification/confirmation. */
  ttlTimer?: ReturnType<typeof setTimeout>;
}

export interface ServerContext {
  app: Express;
  orchestrator: Orchestrator;
  hub: SseHub;
  runs: Map<string, RunState>;
  projectRoot: string;
  runtimeDir: string;
  logFilePath: string;
  /** One-time orchestrator initialization (lazy — first request triggers it). */
  ready: Promise<void>;
  /** A-01: configured bearer tokens. Empty = auth middleware is off. */
  authTokens: string[];
  /** A-05: idle TTL for clarification/confirmation; 0 disables. */
  runTtlMs: number;
}
