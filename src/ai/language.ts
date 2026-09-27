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
/** Urdu-only letters (ٹ ڈ ڑ ں ے ھ) that Persian/Arabic do not use this way. */
const URDU_MARKER = /[\u0679\u0688\u0691\u06ba\u06d2\u06be]/;

const PERSIAN = { code: 'fa', name: 'Persian', native: 'فارسی' };
const ARABIC = { code: 'ar', name: 'Arabic', native: 'العربية' };
const URDU = { code: 'ur', name: 'Urdu', native: 'اردو' };
const JAPANESE = { code: 'ja', name: 'Japanese', native: '日本語' };
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

const KANA_RANGES: ReadonlyArray<readonly [number, number]> = [[0x3040, 0x30ff]];
const CJK_RANGES: ReadonlyArray<readonly [number, number]> = [[0x4e00, 0x9fff]];

// Order matters: the Arabic-script rules come first because they are the ones
// that need the marker to be told apart.
const SCRIPT_RULES: ReadonlyArray<ScriptRule> = [
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
  { language: JAPANESE, ranges: KANA_RANGES },
  {
    language: { code: 'ko', name: 'Korean', native: '한국어' },
    ranges: [
      [0xac00, 0xd7af],
      [0x1100, 0x11ff],
    ],
  },
  { language: { code: 'zh', name: 'Chinese', native: '中文' }, ranges: CJK_RANGES },
];
/** How many characters of a script make a detection trustworthy. */
const MIN_SCRIPT_CHARS = 2;

function isDigitCodePoint(code: number): boolean {
  if (code >= 0x30 && code <= 0x39) return true;
  if (code >= 0x0660 && code <= 0x0669) return true; // Arabic-Indic
  if (code >= 0x06f0 && code <= 0x06f9) return true; // Extended Arabic-Indic
  if (code >= 0xff10 && code <= 0xff19) return true;
  return false;
}

function countInRanges(text: string, ranges: ScriptRule['ranges']): number {
  let count = 0;
  for (const char of text) {
    const code = char.codePointAt(0) ?? 0;
    if (isDigitCodePoint(code)) continue;
    if (ranges.some(([lo, hi]) => code >= lo && code <= hi)) count++;
  }
  return count;
}

function latinLetterCount(text: string): number {
  let count = 0;
  for (const char of text) {
    const code = char.codePointAt(0) ?? 0;
    if ((code >= 0x41 && code <= 0x5a) || (code >= 0x61 && code <= 0x7a)) count++;
  }
  return count;
}

/**
 * Name the language of `text` from its script, or `undefined` when the text is
 * Latin (or too short) — the caller then keeps the generic "same language as
 * the user's request" instruction.
 *
 * A non-Latin script must *dominate* the Latin letters in the string, so a
 * quoted foreign word inside an English sentence does not flip the language.
 * Digits (including Arabic-Indic) are ignored.
 */
export function detectLanguage(text: string): DetectedLanguage | undefined {
  if (typeof text !== 'string' || text.trim() === '') return undefined;
  const latin = latinLetterCount(text);

  const kana = countInRanges(text, KANA_RANGES);
  const cjk = countInRanges(text, CJK_RANGES);
  if (kana >= 1 && kana + cjk >= latin) return JAPANESE;

  for (const rule of SCRIPT_RULES) {
    if (rule.language.code === 'ja') continue; // handled above (any kana)
    const count = countInRanges(text, rule.ranges);
    const min = rule.language.code === 'ja' ? 1 : MIN_SCRIPT_CHARS;
    if (count < min) continue;
    if (latin > count) continue;
    if (rule.language.code === 'ar') {
      if (URDU_MARKER.test(text)) return URDU;
      return PERSIAN_MARKER.test(text) ? PERSIAN : ARABIC_SCRIPT;
    }
    if (rule.language.code === 'zh' && kana >= 1) return JAPANESE;
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
