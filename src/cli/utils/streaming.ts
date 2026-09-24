/**
 * Phase 23 (CLI, step 3): ProgressEvent → terminal renderer.
 *
 * Claude-Code-style line output:
 *   - one line per event, colored by status (done green, failed red,
 *     running yellow — per the plan)
 *   - a running "step x/y" counter for the whole plan
 *   - `--verbose` additionally prints tool calls
 */
import type { ProgressEvent } from '../../ai/runtime/streaming-manager.js';
import { color, out } from './output.js';

export interface ProgressRendererOptions {
  /** Print tool-call lines (default: hidden) */
  verbose?: boolean;
}

export type ProgressRenderer = (event: ProgressEvent) => void;

/** Build a stateful terminal renderer for one plan run. */
export function createProgressRenderer(options: ProgressRendererOptions = {}): ProgressRenderer {
  const verbose = options.verbose ?? false;
  let totalSteps = 0;
  let finishedSteps = 0;
  let started = false;

  return (event: ProgressEvent): void => {
    const stamp = color.dim(new Date(event.timestamp).toISOString().slice(11, 19));

    switch (event.type) {
      case 'plan:started': {
        // The message is "Plan running." — total steps come from the plan
        // snapshot carried in the payload (see StreamingManager).
        totalSteps =
          typeof event.payload?.totalSteps === 'number'
            ? (event.payload?.totalSteps as number)
            : 0;
        started = true;
        out(`${color.info('⏵')} ${color.bold('Plan started')}${totalSteps > 0 ? color.dim(` (${totalSteps} steps)`) : ''}`);
        break;
      }
      case 'plan:step-started': {
        if (event.payload?.agentLevel === true) {
          if (verbose) out(`   ${color.dim('·')} ${color.running('▶')} ${event.message}`);
          break;
        }
        if (!started) {
          // agent events can arrive before the plan:started hook fires
          started = true;
        }
        const count =
          totalSteps > 0 ? color.dim(` [${finishedSteps + 1}/${totalSteps}]`) : '';
        out(`${color.running('▶')}${count} ${event.message}`);
        break;
      }
      case 'plan:step-completed': {
        // Phase 29: `plan:step-completed` is produced twice per step —
        // once by the plan lifecycle (`step:<id>:done`, which carries a
        // stepId) and once by the agent lifecycle (`agent:completed`).
        // Counting both made the counter overshoot (`[4/2]`).  Only the
        // step-lifecycle event drives the counter; the agent-level line
        // is a detail and stays behind --verbose.
        if (event.payload?.agentLevel === true) {
          if (verbose) {
            out(`   ${color.dim('·')} ${color.done('✔')} ${event.message}`);
          }
          break;
        }
        finishedSteps += 1;
        const count =
          totalSteps > 0 ? color.dim(` [${finishedSteps}/${totalSteps}]`) : '';
        out(`${color.done('✔')}${count} ${event.message}`);
        break;
      }
      case 'plan:step-failed': {
        if (event.payload?.agentLevel === true) {
          if (verbose) out(`   ${color.dim('·')} ${color.failed('✖')} ${event.message}`);
          break;
        }
        out(`${color.failed('✖')} ${event.message}`);
        break;
      }
      case 'plan:replanning': {
        out(`${color.warn('↻')} ${event.message}`);
        break;
      }
      case 'plan:replanned': {
        out(`${color.warn('↻')} ${event.message}`);
        break;
      }
      case 'task:tool-call': {
        // Compact events only (Law 14) — the tool NAME is all we have,
        // and it is only shown with --verbose.
        if (verbose) {
          const tool = event.payload?.toolName;
          out(
            `   ${color.dim('·')} ${color.dim('tool call')}: ${String(tool ?? 'unknown')}` +
              (event.taskId ? color.dim(` (${event.taskId})`) : ''),
          );
        }
        break;
      }
      case 'task:tool-error': {
        // Phase 30 (P3): ALWAYS shown (unlike tool calls, which need
        // --verbose).  A tool that refused to act is why the step the
        // user just watched may be reported as failed.
        const tool = event.payload?.toolName;
        out(
          `   ${color.failed('✖')} ${color.failed('tool failed')}: ${String(tool ?? 'unknown')} — ${event.message.replace(/^Tool "[^"]+" failed: /, '')}`,
        );
        break;
      }
      case 'task:status': {
        if (verbose) out(`   ${color.dim('·')} ${event.message}`);
        break;
      }
      case 'plan:completed': {
        out(`${color.done('✅')} ${color.bold(event.message)}`);
        break;
      }
      case 'plan:failed': {
        out(`${color.failed('❌')} ${color.bold(event.message)}`);
        break;
      }
      case 'plan:cancelled': {
        out(`${color.warn('🛑')} ${color.bold(event.message)}`);
        break;
      }
      default:
        break;
    }
  };
}
