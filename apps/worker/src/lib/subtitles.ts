import type { TimedWord } from './align.js';
import { segmentWords } from './segment.js';

export interface Cue {
  idx: number;
  start: number;
  end: number;
  lines: string[];
  words: TimedWord[];
  /** Words the styling pass wants emphasised, lowercased and punctuation-stripped. */
  highlight?: string[];
}

export interface CueOptions {
  /** Netflix caps Latin lines at 42 chars; a 9:16 frame needs it tighter. */
  maxCharsPerLine?: number;
  maxLines?: number;
  /** Characters per second. Netflix allows 20 for adults; 17 reads comfortably. */
  maxCps?: number;
  /**
   * Minimum on-screen time for a cue.
   *
   * Deliberately below Netflix's 5/6s (833ms): that figure governs static, full-sentence
   * film subtitles a viewer reads as a block. These cues are 2-3 words with the spoken
   * word highlighted, so comprehension tracks the audio rather than a reading pass, and
   * rapid cycling is the intended short-form look. 700ms is still well clear of the
   * ~500ms threshold where cues start to read as flicker.
   */
  minDuration?: number;
  maxDuration?: number;
  /** A pause at least this long forces a cue break. */
  breakOnGap?: number;
  /** Netflix requires a 2-frame gap between events; 2 frames @24fps. */
  interCueGap?: number;
  /** Media duration. Cues are never extended past it. */
  mediaDuration?: number;
  /** Hard cap on words shown at once. Drives the segmentation search width. */
  maxWordsPerCue?: number;
}

const CUE_DEFAULTS: Required<CueOptions> = {
  // Short-form captions are set large, so a 1080px frame minus side margins fits far
  // less than Netflix's 42. Keep this in step with ass.ts fitFontSize().
  maxCharsPerLine: 22,
  maxLines: 2,
  maxCps: 17,
  minDuration: 0.7,
  maxDuration: 7,
  breakOnGap: 0.6,
  interCueGap: 0.084,
  mediaDuration: Infinity,
  maxWordsPerCue: 5,
};

const SENTENCE_END = /[.!?|।॥]["')\]]?$/;
/** Commas and dashes: weaker breaks, used only when a cue is already near capacity. */
const CLAUSE_END = /[,;:—–]["')\]]?$/;

/** Does this cue finish a sentence? Used to protect the boundary during merging. */
function endsSentence(cue: Cue): boolean {
  const last = cue.words[cue.words.length - 1];
  return last ? SENTENCE_END.test(last.w) : false;
}

/**
 * Group timed words into readable cues.
 *
 * Note on CPS: splitting a cue cannot lower the speaker's actual rate, since text and
 * duration shrink together. What the limit really buys is a cap on how much text is
 * on screen at once — so it is applied as a character budget of maxCps * cueDuration.
 */
export function buildCues(words: TimedWord[], options: CueOptions = {}): Cue[] {
  const o = { ...CUE_DEFAULTS, ...options };
  if (words.length === 0) return [];

  /*
   * Segmentation is a global optimisation, not a left-to-right scan. Greedy flushing
   * cannot see that breaking one word earlier would avoid stranding a two-word tail or
   * splitting a bound phrase, which is what made cues run across sentence ends.
   */
  const segments = segmentWords(words, {
    maxWordsPerCue: o.maxWordsPerCue,
    maxLines: o.maxLines,
    maxCharsPerLine: o.maxCharsPerLine,
    maxCps: o.maxCps,
    minDuration: o.minDuration,
    maxDuration: o.maxDuration,
    breakOnGap: o.breakOnGap,
  });

  const cues: Cue[] = segments.map((g, idx) => ({
    idx,
    start: g.start,
    end: g.end,
    lines: wrapLines(g.words.map((w) => w.w), o.maxCharsPerLine, o.maxLines),
    words: g.words,
  }));

  return enforceDurations(mergeShortCues(cues, o), o);
}

/**
 * Absorb cues too short to read into a neighbour.
 *
 * enforceDurations can only stretch a cue into the gap that follows it. In continuously
 * narrated speech there is no gap — the next cue starts immediately — so a sub-minimum
 * cue can never reach the floor by stretching and has to be merged instead.
 */
function mergeShortCues(cues: Cue[], o: Required<CueOptions>): Cue[] {
  if (cues.length < 2) return cues;
  const budget = o.maxCharsPerLine * o.maxLines;
  const out: Cue[] = [];

  /**
   * `a` and `b` may only combine if they belong to the same sentence and the result
   * still fits. Merging across a full stop is what produced cues like
   * "solren. And video" — two sentences sharing one card, which reads as if the caption
   * has lost the rhythm of the speech.
   */
  const fits = (a: Cue, b: Cue) => {
    if (endsSentence(a)) return false;
    const words = [...a.words, ...b.words];
    const width = words.reduce((acc, w) => acc + w.w.length, 0) + words.length - 1;
    const gap = b.words[0]!.start - a.words[a.words.length - 1]!.end;
    // A clear pause between them is also a rhythm boundary worth keeping.
    return width <= budget && b.end - a.start <= o.maxDuration && gap < o.breakOnGap;
  };
  const absorb = (target: Cue, extra: Cue, after: boolean) => {
    const words = after ? [...target.words, ...extra.words] : [...extra.words, ...target.words];
    target.words = words;
    target.start = Math.min(target.start, extra.start);
    target.end = Math.max(target.end, extra.end);
    target.lines = wrapLines(words.map((w) => w.w), o.maxCharsPerLine, o.maxLines);
    target.highlight = [...(target.highlight ?? []), ...(extra.highlight ?? [])].slice(0, 2);
  };

  for (let i = 0; i < cues.length; i++) {
    const cue = cues[i]!;
    const prev = out[out.length - 1];
    if (cue.end - cue.start >= o.minDuration) {
      out.push(cue);
      continue;
    }
    // Prefer merging backward; fall back to forward so a very short cue is never
    // stranded just because the preceding cue happens to be full.
    if (prev && fits(prev, cue)) {
      absorb(prev, cue, true);
      continue;
    }
    const next = cues[i + 1];
    if (next && fits(cue, next)) {
      absorb(next, cue, false);
      continue;
    }
    out.push(cue);
  }
  return out.map((c, i) => ({ ...c, idx: i }));
}

/**
 * Greedy wrap, then balance: a 30/2 split reads worse than 16/16, so once the words
 * fit we push the break toward the middle.
 */
export function wrapLines(words: string[], maxChars: number, maxLines: number): string[] {
  const lines: string[] = [];
  let line = '';
  for (const w of words) {
    const next = line ? `${line} ${w}` : w;
    if (next.length > maxChars && line) {
      lines.push(line);
      line = w;
    } else {
      line = next;
    }
  }
  if (line) lines.push(line);

  if (lines.length === 2) {
    const flat = words.join(' ');
    const target = flat.length / 2;
    let best: [string, string] | null = null;
    let bestDelta = Infinity;
    for (let i = 1; i < words.length; i++) {
      const a = words.slice(0, i).join(' ');
      const b = words.slice(i).join(' ');
      if (a.length > maxChars || b.length > maxChars) continue;
      const delta = Math.abs(a.length - target);
      if (delta < bestDelta) {
        bestDelta = delta;
        best = [a, b];
      }
    }
    if (best) return best;
  }

  // Over the line budget: keep the first maxLines and append the overflow to the last.
  if (lines.length > maxLines) {
    const kept = lines.slice(0, maxLines - 1);
    kept.push(lines.slice(maxLines - 1).join(' '));
    return kept;
  }
  return lines;
}

/**
 * Apply the duration floor/ceiling rules to an externally-grouped cue list (e.g. one
 * produced by the LLM styling pass), which never went through buildCues.
 */
export function finalizeCues(cues: Cue[], options: CueOptions = {}): Cue[] {
  const o = { ...CUE_DEFAULTS, ...options };
  const sorted = [...cues].sort((a, b) => a.start - b.start).map((c, i) => ({ ...c, idx: i }));
  return enforceDurations(mergeShortCues(sorted, o), o);
}

function enforceDurations(cues: Cue[], o: Required<CueOptions>): Cue[] {
  for (let i = 0; i < cues.length; i++) {
    const cue = cues[i]!;
    const next = cues[i + 1];
    if (cue.end - cue.start < o.minDuration) {
      // Grow toward the next cue, or toward the end of the media for the last one.
      const ceiling = next ? next.start - o.interCueGap : o.mediaDuration;
      cue.end = Math.max(cue.end, Math.min(cue.start + o.minDuration, ceiling));
    }
    if (next && cue.end > next.start - o.interCueGap) {
      cue.end = Math.max(cue.start + 0.1, next.start - o.interCueGap);
    }
    // A cue past the last frame is dropped entirely by some players.
    if (cue.end > o.mediaDuration) cue.end = Math.max(cue.start + 0.1, o.mediaDuration);
  }
  return cues;
}

/** Longest cue duration a viewer must read, and the worst on-screen density. */
export function cueStats(cues: Cue[]): { count: number; maxCps: number; maxChars: number } {
  let maxCps = 0;
  let maxChars = 0;
  for (const c of cues) {
    const chars = c.lines.join(' ').length;
    maxChars = Math.max(maxChars, chars);
    maxCps = Math.max(maxCps, chars / Math.max(c.end - c.start, 0.001));
  }
  return { count: cues.length, maxCps: Math.round(maxCps * 10) / 10, maxChars };
}

/**
 * Shift every cue and word by a fixed offset, clamping at zero and at the media end.
 *
 * Used for the drift correction control: timings come from silence detection, not from
 * the STT API, so a small global nudge is often needed to lock onto the audio.
 */
export function shiftCues(cues: Cue[], offsetSeconds: number, mediaDuration?: number): Cue[] {
  if (!offsetSeconds) return cues;
  const limit = mediaDuration ?? Infinity;
  const clamp = (t: number) => Math.max(0, Math.min(limit, t + offsetSeconds));

  return cues.map((c) => ({
    ...c,
    start: clamp(c.start),
    end: clamp(c.end),
    words: c.words.map((w) => ({ ...w, start: clamp(w.start), end: clamp(w.end) })),
    // A cue pushed entirely past the end would render as a zero-length event.
  })).filter((c) => c.end > c.start);
}

export function toSrt(cues: Cue[]): string {
  return (
    cues
      .map((c, i) => `${i + 1}\n${srtTime(c.start)} --> ${srtTime(c.end)}\n${c.lines.join('\n')}`)
      .join('\n\n') + '\n'
  );
}

export function toVtt(cues: Cue[]): string {
  return (
    'WEBVTT\n\n' +
    cues.map((c) => `${vttTime(c.start)} --> ${vttTime(c.end)}\n${c.lines.join('\n')}`).join('\n\n') +
    '\n'
  );
}

function clock(seconds: number): { h: number; m: number; s: number; ms: number } {
  const total = Math.max(0, seconds);
  const ms = Math.round((total % 1) * 1000);
  const whole = Math.floor(total);
  return { h: Math.floor(whole / 3600), m: Math.floor((whole % 3600) / 60), s: whole % 60, ms };
}
const p2 = (n: number) => String(n).padStart(2, '0');
const p3 = (n: number) => String(n).padStart(3, '0');

function srtTime(s: number): string {
  const t = clock(s);
  return `${p2(t.h)}:${p2(t.m)}:${p2(t.s)},${p3(t.ms)}`;
}
function vttTime(s: number): string {
  const t = clock(s);
  return `${p2(t.h)}:${p2(t.m)}:${p2(t.s)}.${p3(t.ms)}`;
}
