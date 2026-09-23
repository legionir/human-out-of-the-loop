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

  const { choice } = await inquirer.prompt<{ choice: 'yes' | 'no' }>([
    {
      type: 'list',
      name: 'choice',
      message: 'Execute this plan?',
      choices: [
        { name: 'Yes, execute (Human-Out-Of-Loop — no further questions)', value: 'yes' },
        { name: 'No, reject', value: 'no' },
      ],
      default: 'yes',
    },
  ]);

  if (choice === 'yes') {
    return { confirmed: true };
  }

  const { feedback } = await inquirer.prompt<{ feedback: string }>([
    {
      type: 'input',
      name: 'feedback',
      message: 'Feedback for the planner (optional, enter to skip):',
    },
  ]);
  const trimmed = feedback.trim();
  return {
    confirmed: false,
    feedback: trimmed === '' ? 'User rejected the plan.' : trimmed,
  };
}
