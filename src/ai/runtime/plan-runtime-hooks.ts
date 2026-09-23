import type { AcceptanceChecker } from './acceptance-checker.js';
import type { Plan } from '../schemas/plan.js';

/**
 * Wire the AcceptanceChecker into a PlanRuntime execution.
 *
 * This function:
 *   1. Registers the plan with the AcceptanceChecker.
 *   2. Starts the checker's event listener.
 *   3. Returns a cleanup function to call when the plan finishes.
 *
 * Usage in PlanRuntime.execute():
 *   const cleanup = wireAcceptanceChecker(plan, checker);
 *   try { ... } finally { cleanup(); }
 */
export function wireAcceptanceChecker(
  plan: Plan,
  checker: AcceptanceChecker
): () => void {
  checker.registerPlan(plan);
  checker.start();

  return () => {
    checker.stop();
    checker.unregisterPlan(plan.id ?? 'unknown');
  };
}
