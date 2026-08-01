import type { TimedWord } from './align.js';

/**
 * Rhythm-aware cue segmentation.
 *
 * Greedy left-to-right flushing cannot see the consequences of a break: it will happily
 * strand a two-word tail or split a phrase because the character budget ran out one word
 * early. This finds the globally cheapest segmentation with dynamic programming, scoring
 * candidate breaks against evidence from three places:
 *
 * PROSODY — the pause before the next word. Research on prosodic phrasing finds that the
 * boundaries that reliably coincide with syntactic ones are sentence ends, marked by
 * longer pauses; so pause length is the strongest single cue we have, and it is the one
 * signal that comes from the speaker rather than from the text.
 *
 * SYNTAX — punctuation and function words. Audiovisual translation guidance is that
 * linguistic phrases should not be split, and eye-tracking work shows non-syntactic
 * segmentation raises cognitive load even when comprehension survives. Breaking after
 * "the" or "of" strands a word that binds forward, so those breaks are penalised.
 *
 * PERCEPTION — reading rate and on-screen dwell time, plus regularity. Cues of wildly
 * varying length read as arrhythmic against speech even when each one is individually
 * legal, so deviation from a target duration is penalised directly.
 */

export interface SegmentOptions {
  maxWordsPerCue: number;
  maxLines: number;
  maxCharsPerLine: number;
  maxCps: number;
  minDuration: number;
  maxDuration: number;
  /** A pause at least this long is treated as a hard boundary. */
  breakOnGap: number;
  /** Preferred on-screen time. Cues are nudged toward this for an even cadence. */
  targetDuration?: number;
  /** Fixed cost of locating a new caption before reading starts, in seconds. */
  acquisitionSeconds?: number;
  /**
   * Extra screen time a cue can expect beyond its own speech, from lead-in and hold.
   * In continuous narration this is small, which is precisely why cues must be short.
   */
  spareScreenTime?: number;
}

const SENTENCE_END = /[.!?|।॥]["')\]]?$/;
const CLAUSE_END = /[,;:—–]["')\]]?$/;

/**
 * Words that bind to what FOLLOWS them, so a break immediately after reads as broken.
 * Includes the English function words common in Tanglish/Hinglish speech plus the Indic
 * particles and postpositions that behave the same way in code-mixed sentences.
 */
const BINDS_FORWARD = new Set([
  // English determiners, prepositions, conjunctions, auxiliaries
  'a', 'an', 'the', 'my', 'your', 'his', 'her', 'its', 'our', 'their', 'this', 'that',
  'these', 'those', 'of', 'to', 'in', 'on', 'at', 'for', 'with', 'from', 'by', 'into',
  'over', 'under', 'and', 'or', 'but', 'so', 'if', 'as', 'than', 'is', 'are', 'was',
  'were', 'be', 'been', 'will', 'would', 'can', 'could', 'should', 'has', 'have', 'had',
  'no', 'not', 'very', 'more', 'most',
  // Hinglish / Tanglish connectives and quantifiers
  'oru', 'indha', 'andha', 'inda', 'ithu', 'adhu', 'naan', 'neenga', 'namma', 'unga',
  'ek', 'ye', 'wo', 'yeh', 'aur', 'ya', 'par', 'ki', 'ka', 'ke', 'kya', 'bahut',
  'konjam', 'romba', 'ellaam', 'apdi', 'ipdi',
]);

/** Words that bind to what PRECEDES them, so a break just before them reads as broken. */
const BINDS_BACKWARD = new Set([
  // Tamil/Hindi postpositions and clitics attach to the previous noun.
  'la', 'le', 'ku', 'kku', 'ah', 'aa', 'um', 'dhaan', 'thaan', 'nu', 'nnu',
  'me', 'mein', 'se', 'ko', 'ne', 'hai', 'hain', 'tha', 'thi',
]);

const core = (w: string) => w.toLowerCase().replace(/[^\p{L}\p{N}]/gu, '');

export interface Segment {
  words: TimedWord[];
  start: number;
  end: number;
}

/**
 * Quality of breaking immediately after word index `i`.
 * Lower is better; the value is a penalty added to the segmentation cost.
 */
function breakPenalty(words: TimedWord[], i: number, o: SegmentOptions): number {
  const word = words[i];
  const next = words[i + 1];
  if (!word || !next) return 0;

  const gap = next.start - word.end;
  let penalty = 0;

  // Prosody: a real pause is the best possible place to break. Scale the reward so a
  // full breakOnGap pause effectively cancels most other objections.
  penalty -= Math.min(gap / o.breakOnGap, 1) * 6;

  // Syntax: punctuation marks an intended boundary.
  if (SENTENCE_END.test(word.w)) penalty -= 8;
  else if (CLAUSE_END.test(word.w)) penalty -= 3;

  // Splitting a bound phrase is the thing readers actually notice.
  if (BINDS_FORWARD.has(core(word.w))) penalty += 5;
  if (BINDS_BACKWARD.has(core(next.w))) penalty += 5;

  // A break with no evidence at all is mildly discouraged, so cues do not fragment.
  if (gap < 0.05 && !SENTENCE_END.test(word.w) && !CLAUSE_END.test(word.w)) penalty += 1.5;

  return penalty;
}

/** Cost of showing words[from..to] as a single cue. Infinity means illegal. */
function cueCost(words: TimedWord[], from: number, to: number, o: SegmentOptions): number {
  const slice = words.slice(from, to + 1);
  if (slice.length === 0 || slice.length > o.maxWordsPerCue) return Infinity;

  const chars = slice.reduce((a, w) => a + w.w.length, 0) + slice.length - 1;
  if (chars > o.maxCharsPerLine * o.maxLines) return Infinity;

  const start = slice[0]!.start;
  const end = slice[slice.length - 1]!.end;
  const duration = Math.max(end - start, 0.01);
  if (duration > o.maxDuration) return Infinity;

  /*
   * READABILITY IS A HARD CONSTRAINT, not a penalty.
   *
   * A caption is on screen for roughly as long as its own words are spoken — in
   * continuous narration the next cue's speech begins immediately, so there is no spare
   * time to hold it. That means the only way to make a cue readable is to put fewer
   * characters on it. Treating this as a soft cost produced captions that cleared before
   * they could be read (measured comfort 0.74 across an entire clip), so a cue that
   * cannot be read in the time it owns is rejected outright.
   */
  const acquisition = o.acquisitionSeconds ?? 0.15;
  const spare = o.spareScreenTime ?? 0.12;
  const lines = Math.min(o.maxLines, Math.max(1, Math.ceil(chars / o.maxCharsPerLine)));
  const readable = (duration + spare - acquisition * lines * 0.6) * o.maxCps;
  if (chars > readable) return Infinity;

  const target = o.targetDuration ?? Math.min(2.2, (o.minDuration + o.maxDuration) / 3);
  let cost = 0;

  // Rhythm: even cadence. Squared so one wildly-off cue is worse than several slightly off.
  cost += ((duration - target) / target) ** 2 * 4;

  // Prefer comfortable margin over scraping the readability limit.
  cost += (chars / Math.max(readable, 1)) ** 2 * 2;

  if (duration < o.minDuration) cost += (o.minDuration - duration) * 8;

  // A cue that never splits an internal pause is preferable; penalise swallowing one.
  for (let i = from; i < to; i++) {
    const gap = words[i + 1]!.start - words[i]!.end;
    if (gap >= o.breakOnGap) cost += 10;
  }

  return cost;
}

/**
 * Optimal segmentation by dynamic programming.
 *
 * best[j] is the cheapest way to cover words[0..j-1]. Because a cue is capped at
 * maxWordsPerCue the inner loop is bounded, so this is O(n · maxWordsPerCue) rather than
 * O(n²) — trivial for the few hundred words in a reel.
 */
export function segmentWords(words: TimedWord[], o: SegmentOptions): Segment[] {
  /*
   * Readability is a hard constraint, so a very fast speaker can make every
   * segmentation illegal. Rather than collapse to fixed-size chunks, relax the reading
   * rate in steps and take the first setting that admits a solution — a slightly rushed
   * caption is far better than an arbitrarily chopped one.
   */
  for (const relax of [1, 1.15, 1.35, 1.6, 2]) {
    const result = solve(words, { ...o, maxCps: o.maxCps * relax });
    if (result) return result;
  }
  return chunkFallback(words, o);
}

function chunkFallback(words: TimedWord[], o: SegmentOptions): Segment[] {
  const out: Segment[] = [];
  for (let i = 0; i < words.length; i += o.maxWordsPerCue) {
    const slice = words.slice(i, i + o.maxWordsPerCue);
    if (slice.length) {
      out.push({ words: slice, start: slice[0]!.start, end: slice[slice.length - 1]!.end });
    }
  }
  return out;
}

function solve(words: TimedWord[], o: SegmentOptions): Segment[] | null {
  const n = words.length;
  if (n === 0) return [];

  const best = new Array<number>(n + 1).fill(Infinity);
  const prev = new Array<number>(n + 1).fill(-1);
  best[0] = 0;

  for (let j = 1; j <= n; j++) {
    const lowest = Math.max(0, j - o.maxWordsPerCue);
    for (let i = lowest; i < j; i++) {
      if (best[i] === Infinity) continue;
      const cue = cueCost(words, i, j - 1, o);
      if (cue === Infinity) continue;
      // No break penalty after the final word; nothing follows it.
      const brk = j === n ? 0 : breakPenalty(words, j - 1, o);
      const total = best[i]! + cue + brk;
      if (total < best[j]!) {
        best[j] = total;
        prev[j] = i;
      }
    }
  }

  // No legal segmentation at this reading rate; the caller retries with a relaxed one.
  if (best[n] === Infinity) return null;

  const segments: Segment[] = [];
  let j = n;
  while (j > 0) {
    const i = prev[j]!;
    const slice = words.slice(i, j);
    segments.unshift({ words: slice, start: slice[0]!.start, end: slice[slice.length - 1]!.end });
    j = i;
  }
  return segments;
}
