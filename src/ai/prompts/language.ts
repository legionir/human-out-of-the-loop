import { detectLanguage, type DetectedLanguage } from '../language.js';
export type { DetectedLanguage } from '../language.js';

export function languageInstruction(text: string, detected?: DetectedLanguage): string {
  const keep = 'Keep code, file paths, commands, tool names and identifiers exactly as they are; never translate them.';
  const language = detected ?? detectLanguage(text);
  if (!language) return `Answer in the same language the user wrote their request in. ${keep}`;
  if (language.code === 'arabic-script') {
    return (
      'The user wrote their request in a language written in the Arabic script ' +
      '(Persian, Arabic, Urdu and others). ' +
      'Write everything the user reads — the answer, plan steps, clarification questions, ' +
      'summaries and reports — in the SAME language as the request; never switch to English. ' +
      keep
    );
  }
  return (
    `The user wrote in ${language.name} (${language.native}). ` +
    'Write everything the user reads — the answer, plan steps, clarification questions, ' +
    `summaries and reports — in ${language.name}. ` +
    keep
  );
}

export function languageSection(text: string, detected?: DetectedLanguage): string {
  return `## Language\n${languageInstruction(text, detected)}`;
}

export function genericLanguageInstruction(): string {
  return languageInstruction('');
}
