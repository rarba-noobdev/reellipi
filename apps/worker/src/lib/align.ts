/**
 * Word timing derivation.
 *
 * Sarvam returns no word-level timestamps (see lib/sarvam.ts), so a word's time is
 * inferred from the speech run it belongs to. The run's start/end are exact — we cut
 * the audio there ourselves — and words are spread across that window in proportion
 * to how long they take to say. Expect roughly +-150-300ms of drift inside a run,
 * which is why runs are kept short (2-5s) by silence detection.
 */

export interface TimedWord {
  w: string;
  start: number;
  end: number;
}

/** Per-word constant, in "character equivalents", covering onset + release time. */
const WORD_OVERHEAD = 2.0;
/** No word renders for less than this, or karaoke highlights flicker. */
const MIN_WORD_SECONDS = 0.08;

const graphemeSplitter =
  typeof Intl !== 'undefined' && 'Segmenter' in Intl
    ? new Intl.Segmenter(undefined, { granularity: 'grapheme' })
    : null;

/**
 * Grapheme clusters, not UTF-16 code units. In Tamil and Devanagari a syllable is one
 * base char plus combining marks, so `String.length` overcounts them badly and would
 * starve Latin words of time in a code-mixed line.
 */
function speechWeight(word: string): number {
  const core = word.replace(/[^\p{L}\p{N}]/gu, '');
  if (!core) return 0.5;
  const count = graphemeSplitter ? [...graphemeSplitter.segment(core)].length : core.length;
  return count + WORD_OVERHEAD;
}

export function tokenize(transcript: string): string[] {
  return transcript.split(/\s+/).map((w) => w.trim()).filter(Boolean);
}

/**
 * Spread one chunk's transcript across the chunk's real time window.
 * `start`/`end` are absolute (already offset by the run's position in the full audio).
 */
export function distributeWords(transcript: string, start: number, end: number): TimedWord[] {
  const words = tokenize(transcript);
  if (words.length === 0) return [];

  const span = Math.max(end - start, MIN_WORD_SECONDS * words.length);
  const weights = words.map(speechWeight);
  const total = weights.reduce((a, b) => a + b, 0) || words.length;

  const out: TimedWord[] = [];
  let cursor = start;
  for (let i = 0; i < words.length; i++) {
    const share = (weights[i]! / total) * span;
    const wordEnd = i === words.length - 1 ? start + span : cursor + share;
    out.push({
      w: words[i]!,
      start: round3(cursor),
      end: round3(Math.max(wordEnd, cursor + MIN_WORD_SECONDS)),
    });
    cursor = out[i]!.end;
  }
  return out;
}

/**
 * Stitch per-run word lists into one timeline, forcing monotonicity. Runs are already
 * non-overlapping, but rounding and the MIN_WORD_SECONDS floor can push a word past
 * the next run's start.
 */
export function mergeTimelines(perRun: TimedWord[][]): TimedWord[] {
  const all = perRun.flat().sort((a, b) => a.start - b.start);
  let prevEnd = 0;
  for (const w of all) {
    if (w.start < prevEnd) w.start = prevEnd;
    if (w.end <= w.start) w.end = w.start + MIN_WORD_SECONDS;
    w.start = round3(w.start);
    w.end = round3(w.end);
    prevEnd = w.end;
  }
  return all;
}

function round3(n: number): number {
  return Math.round(n * 1000) / 1000;
}
