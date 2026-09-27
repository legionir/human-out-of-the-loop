/**
 * Phase 23 (CLI, step 3): interactive plan confirmation.
 *
 * Replaces the old readline-based `createCliConfirmCallback` with
 * inquirer: the plan summary is displayed, then the user picks
 * confirm / reject-with-feedback.
 *
 * NOTE: this is the ONE place the CLI may ask the user a question.
 * `--yes` (CI / Human-Out-Of-Loop) bypasses it entirely, and in a
 * non-TTY environment without `--yes` we fail fast with a hint
 * instead of hanging.
 */
import inquirer from 'inquirer';
import { color, out } from './output.js';

export interface ConfirmationResult {
  confirmed: boolean;
  feedback?: string;
  /** The prompt was aborted (Ctrl-C / Escape): stop, never re-plan. */
  cancelled?: boolean;
}

/** Thrown when interactive confirmation is impossible (no TTY). */
export class InteractivePromptUnavailableError extends Error {
  constructor() {
    super(
      'Interactive confirmation requires a TTY. Re-run with --yes to auto-confirm (CI / Human-Out-Of-Loop mode), or from an interactive terminal.',
    );
    this.name = 'InteractivePromptUnavailableError';
  }
}

/**
 * Ask the user to confirm a plan (inquirer).
 *
 * @param planText the formatted plan (from formatPlanForUser)
 */
export async function confirmPlanInteractively(planText: string): Promise<ConfirmationResult> {
  if (!process.stdout.isTTY || !process.stdin.isTTY) {
    throw new InteractivePromptUnavailableError();
  }

  out(color.bold('\n── Plan to execute ────────────────────────────'));
  out(planText);
  out(color.bold('───────────────────────────────────────────────\n'));

  let choice: 'yes' | 'no';
  try {
    const answered = await inquirer.prompt<{ choice: 'yes' | 'no' }>([
      {
        // Phase 29: inquirer v14 renamed the arrow-key list prompt from
        // `list` to `select`; `list` is no longer registered and made every
        // interactive confirmation fail with
        // 'Prompt type "list" is not registered'.
        type: 'select',
        name: 'choice',
        message: 'Execute this plan?',
        choices: [
          { name: 'Yes, execute (Human-Out-Of-Loop — no further questions)', value: 'yes' },
          { name: 'No, reject', value: 'no' },
        ],
        default: 'yes',
      },
    ]);
    choice = answered.choice;
  } catch (e) {
    // G-07: Ctrl-C / Escape must reject the plan (close the interaction),
    // not print a stack and leave it pending.
    if (isExitPromptError(e)) {
      out(color.warn('cancelled'));
      return { confirmed: false, cancelled: true, feedback: 'User cancelled the confirmation prompt.' };
    }
    throw e;
  }

  if (choice === 'yes') {
    return { confirmed: true };
  }

  let feedback: string;
  try {
    ({ feedback } = await inquirer.prompt<{ feedback: string }>([
      {
        type: 'input',
        name: 'feedback',
        message: 'Feedback for the planner (optional, enter to skip):',
      },
    ]));
  } catch (e) {
    // Ctrl-C at the feedback question is still a rejection, not a crash.
    if (isExitPromptError(e)) {
      out(color.warn('cancelled'));
      return { confirmed: false, cancelled: true, feedback: 'User cancelled the confirmation prompt.' };
    }
    throw e;
  }
  const trimmed = feedback.trim();
  return {
    confirmed: false,
    feedback: trimmed === '' ? 'User rejected the plan.' : trimmed,
  };
}

/**
 * C4: interactive clarification questions (inquirer).
 *
 * Mirrors the confirm flow: TTY required, one prompt per question,
 * Ctrl+C/Escape (or answering ALL questions empty) → `null`, which the
 * orchestrator treats as a clean run cancellation.
 */
export async function promptClarifications(
  questions: string[],
  round: number,
): Promise<Record<string, string> | null> {
  if (!process.stdout.isTTY || !process.stdin.isTTY) {
    throw new InteractivePromptUnavailableError();
  }

  out(color.bold(`\n── Clarification needed (round ${round}) ──────────`));
  for (const q of questions) {
    out(color.warn(`? ${q}`));
  }
  out(color.bold('───────────────────────────────────────────────\n'));

  const answers: Record<string, string> = {};
  for (const question of questions) {
    try {
      const { value } = await inquirer.prompt<{ value: string }>([
        {
          type: 'input',
          name: 'value',
          message: question,
          default: '',
        },
      ]);
      answers[question] = value.trim();
    } catch {
      // Ctrl+C / Escape — treat as "I don't want to answer"
      return null;
    }
  }
  // All answers empty → decline (clean cancellation, not a silent plan)
  if (Object.values(answers).every((a) => a === '')) {
    return null;
  }
  return answers;
}

function isExitPromptError(error: unknown): boolean {
  if (!error || typeof error !== 'object') return false;
  const name = (error as { name?: string }).name;
  return name === 'ExitPromptError' || name === 'AbortPromptError';
}
