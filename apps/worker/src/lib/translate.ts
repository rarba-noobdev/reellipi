import { env } from './env.js';
import { distributeWords } from './align.js';
import type { Cue } from './subtitles.js';

/**
 * Caption translation.
 *
 * Cue boundaries and their start/end times are preserved: a translated caption must
 * appear when the corresponding speech happens, so translation replaces the TEXT inside
 * an existing cue rather than resegmenting. Word timings are then redistributed across
 * the cue's own span, because the translated wording rarely has the same number of words
 * as the original and the karaoke highlight needs something to follow.
 */

const BASE = 'https://api.sarvam.ai';

export interface TranslateTarget {
  code: string;
  label: string;
  /** Native name, shown alongside so speakers recognise their own language. */
  native: string;
  /** Mayura translates well but covers fewer languages; see MAYURA_CODES. */
  model: 'mayura:v1' | 'sarvam-translate:v1';
  /** Render in Latin script — how Hinglish and similar romanised output is produced. */
  romanised?: boolean;
}

/**
 * Languages Mayura supports. Verified against the live API: on code-mixed Tanglish input
 * Mayura produced clean output while sarvam-translate:v1 left source words untranslated
 * ("పన్నుంగా"), so Mayura is preferred wherever it covers the pair.
 */
const MAYURA_CODES = new Set([
  'en-IN', 'hi-IN', 'bn-IN', 'gu-IN', 'kn-IN', 'ml-IN', 'mr-IN', 'od-IN', 'pa-IN', 'ta-IN', 'te-IN',
]);

export const TRANSLATE_TARGETS: TranslateTarget[] = [
  { code: 'en-IN', label: 'English', native: 'English', model: 'mayura:v1' },
  { code: 'hi-IN', label: 'Hindi', native: 'हिन्दी', model: 'mayura:v1' },
  { code: 'hi-IN-roman', label: 'Hinglish', native: 'Hindi in Latin script', model: 'mayura:v1', romanised: true },
  { code: 'ta-IN', label: 'Tamil', native: 'தமிழ்', model: 'mayura:v1' },
  { code: 'te-IN', label: 'Telugu', native: 'తెలుగు', model: 'mayura:v1' },
  { code: 'kn-IN', label: 'Kannada', native: 'ಕನ್ನಡ', model: 'mayura:v1' },
  { code: 'ml-IN', label: 'Malayalam', native: 'മലയാളം', model: 'mayura:v1' },
  { code: 'mr-IN', label: 'Marathi', native: 'मराठी', model: 'mayura:v1' },
  { code: 'bn-IN', label: 'Bengali', native: 'বাংলা', model: 'mayura:v1' },
  { code: 'gu-IN', label: 'Gujarati', native: 'ગુજરાતી', model: 'mayura:v1' },
  { code: 'pa-IN', label: 'Punjabi', native: 'ਪੰਜਾਬੀ', model: 'mayura:v1' },
  { code: 'od-IN', label: 'Odia', native: 'ଓଡ଼ିଆ', model: 'mayura:v1' },
];

export function findTarget(code: string): TranslateTarget | undefined {
  return TRANSLATE_TARGETS.find((t) => t.code === code);
}

/** Strip the pseudo-suffix used to distinguish romanised variants from native script. */
const baseCode = (code: string) => code.replace(/-roman$/, '');

async function translateText(
  input: string,
  target: TranslateTarget,
  sourceLanguageCode: string,
): Promise<string> {
  const body: Record<string, unknown> = {
    input,
    source_language_code: sourceLanguageCode,
    target_language_code: baseCode(target.code),
    model: MAYURA_CODES.has(baseCode(target.code)) ? 'mayura:v1' : 'sarvam-translate:v1',
  };
  if (target.romanised) body.output_script = 'roman';

  const res = await fetch(`${BASE}/translate`, {
    method: 'POST',
    headers: { 'api-subscription-key': env.sarvamKey, 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`Sarvam translate ${res.status}: ${text.slice(0, 300)}`);
  return (JSON.parse(text) as { translated_text?: string }).translated_text ?? '';
}

export interface TranslateResult {
  cues: Cue[];
  translated: number;
  failed: number;
}

/**
 * Translate a cue list, keeping every cue's timing.
 *
 * Cues are sent in batches separated by a delimiter rather than one request each: a 40-
 * cue reel would otherwise be 40 round trips, and the model also translates better with
 * surrounding context than it does a three-word fragment in isolation.
 */
export async function translateCues(
  cues: Cue[],
  targetCode: string,
  sourceLanguageCode = 'auto',
  onProgress?: (done: number, total: number) => void,
): Promise<TranslateResult> {
  const target = findTarget(targetCode);
  if (!target) throw new Error(`Unsupported target language: ${targetCode}`);

  // Mayura caps input at 1000 characters, so batch conservatively.
  const BATCH_CHARS = 700;
  const SEP = '\n';

  const out: Cue[] = cues.map((c) => ({ ...c }));
  let translated = 0;
  let failed = 0;
  let i = 0;

  while (i < out.length) {
    const batch: number[] = [];
    let chars = 0;
    while (i < out.length && chars < BATCH_CHARS) {
      const line = out[i]!.lines.join(' ');
      if (batch.length && chars + line.length > BATCH_CHARS) break;
      batch.push(i);
      chars += line.length + 1;
      i++;
    }

    const source = batch.map((idx) => out[idx]!.lines.join(' ')).join(SEP);
    try {
      const result = await translateText(source, target, sourceLanguageCode);
      const parts = result.split(/\r?\n/).map((s) => s.trim()).filter(Boolean);

      /*
       * The model does not always return the same number of lines it was given. When the
       * counts disagree the mapping is unsafe, so fall back to per-cue requests for that
       * batch rather than silently pairing the wrong caption with the wrong timing.
       */
      if (parts.length === batch.length) {
        batch.forEach((idx, n) => applyTranslation(out[idx]!, parts[n]!));
        translated += batch.length;
      } else {
        for (const idx of batch) {
          try {
            const one = await translateText(out[idx]!.lines.join(' '), target, sourceLanguageCode);
            applyTranslation(out[idx]!, one);
            translated++;
          } catch {
            failed++;
          }
        }
      }
    } catch (e) {
      console.warn(`[translate] batch failed: ${(e as Error).message}`);
      failed += batch.length;
    }
    onProgress?.(Math.min(i, out.length), out.length);
  }

  return { cues: out, translated, failed };
}

/**
 * Put translated text into a cue and rebuild its word timings.
 *
 * The cue keeps its start and end; the new words are spread across that span in
 * proportion to speaking time, exactly as the original word timings were derived. Line
 * wrapping is left to the caller, which knows the current style's line limits.
 */
function applyTranslation(cue: Cue, text: string): void {
  const clean = text.trim();
  if (!clean) return;
  cue.lines = [clean];
  cue.words = distributeWords(clean, cue.start, cue.end);
  // Keyword marks referred to the original wording and no longer match anything.
  cue.highlight = undefined;
}
