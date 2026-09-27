/**
 * Per-plan token / USD budget (J-03).
 *
 * `--budget 10000` is tokens; `--budget $1.50` is US dollars.  Crossing
 * the cap cancels the plan with reason `budget exceeded` and blocks
 * further model calls.
 */
import type { TokenUsage } from './event-bus.js';

export type BudgetKind = 'tokens' | 'usd';

export interface Budget {
  kind: BudgetKind;
  limit: number;
  raw: string;
}

export interface ModelPrice {
  inputUsdPerMTok: number;
  outputUsdPerMTok: number;
}

export const DEFAULT_MODEL_PRICE: ModelPrice = { inputUsdPerMTok: 2.5, outputUsdPerMTok: 10 };

export function priceFromModelConfig(config?: { pricing?: ModelPrice } | null): ModelPrice {
  const pricing = config?.pricing;
  if (
    pricing &&
    Number.isFinite(pricing.inputUsdPerMTok) &&
    Number.isFinite(pricing.outputUsdPerMTok)
  ) {
    return pricing;
  }
  return DEFAULT_MODEL_PRICE;
}

export class BudgetExceededError extends Error {
  readonly reason = 'budget exceeded';
  constructor(public readonly budget: Budget, public readonly used: { tokens: number; usd: number }) {
    super(`budget exceeded (${budget.kind} limit ${budget.limit})`);
    this.name = 'BudgetExceededError';
  }
}

export function parseBudget(raw: string): Budget | { error: string } {
  const text = raw.trim();
  if (!text) return { error: 'budget must not be empty' };
  const usd = /^\$?\s*([0-9]+(?:\.[0-9]+)?)\s*\$?$/.exec(text);
  if (text.includes('$') && usd) {
    const limit = Number(usd[1]);
    if (!Number.isFinite(limit) || limit <= 0) return { error: 'budget USD must be a positive number' };
    return { kind: 'usd', limit, raw: text };
  }
  const tokens = /^([0-9]+(?:\.[0-9]+)?)[kK]?$/.exec(text.replace(/\s*tokens?\s*$/i, '').trim());
  if (!tokens) return { error: 'budget must be a token count (e.g. 10000) or a dollar amount (e.g. $1.50)' };
  let limit = Number(tokens[1]);
  if (/k$/i.test(text.replace(/\s*tokens?\s*$/i, '').trim())) limit *= 1000;
  if (!Number.isFinite(limit) || limit <= 0) return { error: 'budget tokens must be a positive number' };
  return { kind: 'tokens', limit, raw: text };
}

export function costUsd(usage: TokenUsage, price: ModelPrice = DEFAULT_MODEL_PRICE): number {
  return (usage.promptTokens / 1_000_000) * price.inputUsdPerMTok + (usage.completionTokens / 1_000_000) * price.outputUsdPerMTok;
}

export class BudgetTracker {
  tokens = 0;
  usd = 0;
  blocked = false;

  constructor(public readonly budget?: Budget) {}

  record(usage: TokenUsage, price: ModelPrice = DEFAULT_MODEL_PRICE): void {
    this.tokens += usage.totalTokens;
    this.usd += costUsd(usage, price);
  }

  exceeded(): boolean {
    if (!this.budget) return false;
    return this.budget.kind === 'tokens' ? this.tokens > this.budget.limit : this.usd > this.budget.limit;
  }

  /** Throw if a *next* model call is forbidden. */
  assertCanCall(): void {
    if (!this.budget) return;
    if (this.blocked || this.exceeded()) {
      this.blocked = true;
      throw new BudgetExceededError(this.budget, { tokens: this.tokens, usd: this.usd });
    }
  }

  remainingLabel(): string {
    if (!this.budget) return 'no budget';
    if (this.budget.kind === 'tokens') {
      return `${Math.max(0, this.budget.limit - this.tokens)} tokens left of ${this.budget.limit}`;
    }
    return `$${(Math.max(0, this.budget.limit - this.usd)).toFixed(4)} left of $${this.budget.limit}`;
  }
}

export function estimatePlanCost(
  stepCount: number,
  planningUsage: TokenUsage | undefined,
  price: ModelPrice = DEFAULT_MODEL_PRICE,
): { tokens: number; usd: number; steps: number } {
  const heuristicPerStep = 800;
  const tokens = (planningUsage?.totalTokens ?? 0) + stepCount * heuristicPerStep;
  const usd =
    costUsd(planningUsage ?? { promptTokens: 0, completionTokens: 0, totalTokens: 0 }, price) +
    (stepCount * heuristicPerStep * ((price.inputUsdPerMTok + price.outputUsdPerMTok) / 2)) / 1_000_000;
  return { tokens, usd, steps: stepCount };
}
