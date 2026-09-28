import { DEFAULT_RUN_MODE, type RunMode } from '../modes.js';
import { buildProjectContext } from './project-context.js';

export function buildAssessmentPrompt(
  userRequest: string,
  projectRoot?: string,
  mode: RunMode = DEFAULT_RUN_MODE,
  sessionHistory?: string,
  catalog?: string,
): string {
  const context = buildProjectContext(projectRoot);
  const note = context
    ? `${context}\n\nA request that only lacks the project, its location or its technology stack is CLEAR: the context above supplies them.\n`
    : '';
  const modeRule =
    mode === 'chat'
      ? 'The user asked for a CONVERSATION: set kind="answer" and put your reply in the "answer" field. Do not plan, and never answer a conversation with kind="clarify" — a greeting, a thank-you or a short remark is answered with kind="answer" like anything else.'
      : mode === 'plan'
        ? 'The user asked for a PLAN: real work is expected. Set kind="plan" and provide the full plan, even for a short request — use kind="clarify" only when the request cannot be planned without an answer you cannot infer.'
        : 'Decide what the request needs:\n' +
          '- a greeting ("hello", "سلام"), a thank-you, small talk, a question, an explanation, or anything you can answer yourself → kind="answer" with your reply in the "answer" field;\n' +
          '- real work in this project (files to change, commands to run, several steps) → kind="plan" and provide the full plan;\n' +
          '- too vague to do either → kind="clarify" and ask.';
  return `
You are deciding what to do with the following user request.
${note ? `\n${note}` : ''}
${modeRule}
${catalog ? `\n${catalog}\n` : ''}
USER REQUEST:
"""
${userRequest}
"""
${sessionHistory ? `\n${sessionHistory}\n` : ''}
Set kind="plan" or kind="answer" or kind="clarify" and fill the matching field:
- "plan": the complete execution plan (goal + steps with personas, skills, tools and acceptance criteria);
- "answer": your reply to the user, written for them (not a summary of this decision);
- "clarify": put 1-5 specific, answerable questions in the "needsClarification" array — never an empty list.

A request that is a question about the project, its files, or the runtime is kind="answer"; when it can only be answered by reading the project, say what you need in the answer — do not invent file contents.
Assign only persona, skill and tool ids from the catalog above — never invent ids.
`.trim();
}

export function buildPlanPrompt(
  userRequest: string,
  clarifications?: Record<string, string>,
  projectRoot?: string,
  sessionHistory?: string,
  catalog?: string,
  example?: string,
): string {
  const context = buildProjectContext(projectRoot);
  let prompt = `
Decompose the following user request into a detailed execution plan.
${context ? `\n${context}\n` : ''}
${catalog ? `${catalog}\n` : ''}
USER REQUEST:
"""
${userRequest}
"""
`.trim();

  if (sessionHistory) prompt += `\n\n${sessionHistory}`;
  if (example) prompt += `\n\n${example}`;
  if (clarifications && Object.keys(clarifications).length > 0) {
    prompt += `\n\nCLARIFICATIONS PROVIDED BY USER:\n`;
    for (const [question, answer] of Object.entries(clarifications)) {
      prompt += `Q: ${question}\nA: ${answer}\n\n`;
    }
  }
  return prompt;
}

export function buildAnswerPrompt(userRequest: string, projectRoot?: string): string {
  const context = buildProjectContext(projectRoot);
  return `
${context ? `${context}\n` : ''}
USER REQUEST:
"""
${userRequest}
"""

Answer the request above directly, in the user's language. Use the read-only tools if you need to check something in the project — read, never guess. If the request needs files to change or several steps of work, say so in a sentence or two and point the user at \`@plan <request>\`; never pretend you did it.

End your reply with a final line, exactly as shown, with no other text on that line:
[[NEEDS_PLAN: true]]   — if THIS request needs a plan (files to change, commands to run, several steps) and you just said so
[[NEEDS_PLAN: false]]  — for every other reply, including one that merely mentions \`@plan\` as an example or explanation
`.trim();
}

export function buildStructuredPlanPrompt(
  userRequest: string,
  catalog: string,
  clarifications?: Record<string, string>,
): string {
  let prompt = `
Decompose the following user request into a detailed execution plan.

${catalog}

USER REQUEST:
"""
${userRequest}
"""
`.trim();
  if (clarifications && Object.keys(clarifications).length > 0) {
    prompt += `\n\nCLARIFICATIONS:\n`;
    for (const [question, answer] of Object.entries(clarifications)) {
      prompt += `Q: ${question}\nA: ${answer}\n\n`;
    }
  }
  return prompt;
}
