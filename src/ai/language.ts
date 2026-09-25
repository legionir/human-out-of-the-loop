/**
 * The language the user wrote in, and the words that keep the model in it.
 *
 * Nothing here needs a model call: a script detector is enough to name the
 * language of a request in the vast majority of cases, and naming it is what
 * makes a model answer in it.  Everything the model *produces* for the user —
 * plan steps, clarification questions, chat answers, review summaries — goes
 * through one of the directive builders below, so "answer in my language" is a
 * property of the runtime, not of a lucky prompt.
 *
 * A detected language is a hint, never a filter: the request itself is always
 * in the prompt, so a miss (Romanian, Turkish, a third script we do not map)
 * still leaves the fallback sentence telling the model to match the request.
 */

export interface DetectedLanguage {
  /** BCP-47-ish code used by the runtime (`fa`, `ar`, `ru`, …). */
  code: string;
  /** English name, used inside the instruction sent to the model. */
  name: string;
  /** The language's own name — a Persian speaker sees «فارسی». */
  native: string;
}

interface ScriptRule {
  language: DetectedLanguage;
  ranges: ReadonlyArray<readonly [number, number]>;
}

/** Persian-only letters: without one of these, Arabic-script text is Arabic. */
const PERSIAN_MARKER = /[\u067e\u0686\u0698\u06a9\u06af\u06cc\u06c0]/;

const PERSIAN = { code: 'fa', name: 'Persian', native: 'فارسی' };
const ARABIC = { code: 'ar', name: 'Arabic', native: 'العربية' };
/**
 * Arabic-script text without a Persian-only letter.  "خواندن README" is Persian
 * and "مرحبا" is Arabic, and no amount of character counting can tell them
 * apart — so the instruction names the script and lets the model (which can
 * read the request in front of it) pick the language.  Guessing "Arabic" here
 * was wrong for exactly the user this feature exists for.
 */
const ARABIC_SCRIPT = {
  code: 'arabic-script',
  name: 'the Arabic script (Persian, Arabic, Urdu …)',
  native: 'خط عربی',
};

// Order matters: the Arabic-script rules come first because they are the ones
// that need the marker to be told apart.
const SCRIPT_RULES: ReadonlyArray<ScriptRule> = [
  // Arabic and Persian share a block: the marker (پ چ ژ گ ی ک, which Arabic
  // does not have) decides.  This rule must stay first, because it is the one
  // with two possible answers.
  {
    language: ARABIC,
    ranges: [
      [0x0600, 0x06ff],
      [0xfb50, 0xfdff],
      [0xfe70, 0xfeff],
    ],
  },
  { language: { code: 'he', name: 'Hebrew', native: 'עברית' }, ranges: [[0x0590, 0x05ff]] },
  { language: { code: 'ru', name: 'Russian', native: 'Русский' }, ranges: [[0x0400, 0x04ff]] },
  { language: { code: 'el', name: 'Greek', native: 'Ελληνικά' }, ranges: [[0x0370, 0x03ff]] },
  { language: { code: 'hi', name: 'Hindi', native: 'हिन्दी' }, ranges: [[0x0900, 0x097f]] },
  { language: { code: 'bn', name: 'Bengali', native: 'বাংলা' }, ranges: [[0x0980, 0x09ff]] },
  { language: { code: 'th', name: 'Thai', native: 'ไทย' }, ranges: [[0x0e00, 0x0e7f]] },
  { language: { code: 'ja', name: 'Japanese', native: '日本語' }, ranges: [[0x3040, 0x30ff]] },
  {
    language: { code: 'ko', name: 'Korean', native: '한국어' },
    ranges: [
      [0xac00, 0xd7af],
      [0x1100, 0x11ff],
    ],
  },
  { language: { code: 'zh', name: 'Chinese', native: '中文' }, ranges: [[0x4e00, 0x9fff]] },
];
/** How many characters of a script make a detection trustworthy. */
const MIN_SCRIPT_CHARS = 2;

function countInRanges(text: string, ranges: ScriptRule['ranges']): number {
  let count = 0;
  for (const char of text) {
    const code = char.codePointAt(0) ?? 0;
    if (ranges.some(([lo, hi]) => code >= lo && code <= hi)) count++;
  }
  return count;
}

/**
 * Name the language of `text` from its script, or `undefined` when the text is
 * Latin (or too short) — the caller then keeps the generic "same language as
 * the user's request" instruction.
 */
export function detectLanguage(text: string): DetectedLanguage | undefined {
  if (typeof text !== 'string' || text.trim() === '') return undefined;
  for (const rule of SCRIPT_RULES) {
    const count = countInRanges(text, rule.ranges);
    if (count < MIN_SCRIPT_CHARS) continue;
    // Persian and Arabic share a block: without a Persian-only letter the text
    // is Arabic here (Dari/Urdu are closer to Persian and will still be
    // answered in their own words — this only picks the instruction).
    if (rule.language.code === 'ar') {
      return PERSIAN_MARKER.test(text) ? PERSIAN : ARABIC_SCRIPT;
    }
    return rule.language;
  }
  return undefined;
}

/**
 * The instruction that keeps everything user-facing in the user's language.
 *
 * `detected` comes from the request; when it is missing the model still gets the
 * generic rule ("the same language the user wrote in"), which is what a Latin
 * request needs anyway (English, Spanish, Turkish … are all written with the
 * same letters).
 */
export function languageInstruction(text: string, detected?: DetectedLanguage): string {
  const keep =
    'Keep code, file paths, commands, tool names and identifiers exactly as they are; never translate them.';
  const language = detected ?? detectLanguage(text);
  if (!language) {
    return `Answer in the same language the user wrote their request in. ${keep}`;
  }
  if (language.code === 'arabic-script') {
    // Persian/Arabic/Urdu share the script; the request itself is the evidence.
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
    `Write everything the user reads — the answer, plan steps, clarification questions, ` +
    `summaries and reports — in ${language.name}. ` +
    keep
  );
}

/** A ready-to-append prompt section (no leading newline). */
export function languageSection(text: string, detected?: DetectedLanguage): string {
  return `## Language\n${languageInstruction(text, detected)}`;
}

/** The generic rule, for prompts that do not carry one user request. */
export function genericLanguageInstruction(): string {
  return languageInstruction('');
}
