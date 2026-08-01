import type { Cue } from './subtitles.js';

/**
 * Display timing: how long a caption is ON SCREEN, as opposed to when its words are
 * spoken.
 *
 * These are different problems and conflating them is what makes auto-captions feel
 * wrong. Word timings drive the karaoke highlight and must stay locked to the audio.
 * Display timing serves the reader, and the reader needs three things the speech clock
 * does not provide:
 *
 * 1. LEAD-IN. A caption that appears exactly as the word is spoken is already late —
 *    the eye needs time to land on it. Professional practice is to cut in slightly
 *    early, into the preceding silence.
 *
 * 2. READING TIME. A cue must persist long enough to actually be read: roughly a fixed
 *    acquisition cost to find the line, plus characters divided by reading rate. A fast
 *    talker produces cues that are legal on speech timing yet unreadable, so the card is
 *    held past the last word when there is room.
 *
 * 3. PAUSE HANDLING. Clearing the screen for every short gap produces what the BBC
 *    guidelines call a jerky effect. Below a threshold the caption is held through the
 *    pause instead; only a genuinely long silence clears the screen.
 *
 * Word timings are never modified here — only the cue's own start and end.
 */

export interface ReadingTimingOptions {
  /** Reading rate in characters per second. 17 is comfortable; Netflix caps adults at 20. */
  cps?: number;
  /** Fixed cost of locating and fixating a new caption, in seconds. */
  acquisitionSeconds?: number;
  /** How far a caption may cut in ahead of its first word. */
  leadInSeconds?: number;
  /** How far a caption may linger past its last word when the screen is free. */
  maxLagOutSeconds?: number;
  /**
   * Gaps shorter than this are bridged rather than cleared. BBC guidance puts the point
   * where clearing starts to look jerky at around a second and a half.
   */
  bridgeGapSeconds?: number;
  /** Minimum blank between two cues so they do not appear to flash into each other. */
  interCueGap?: number;
  minDuration?: number;
  maxDuration?: number;
  mediaDuration?: number;
}

/*
 * Reading parameters for BURNED-IN SAME-LANGUAGE captions, which is a different problem
 * from the one Netflix's 17 CPS figure solves.
 *
 * That figure governs foreign-language subtitles, where the text is the viewer's only
 * route to the meaning and must be read in full. Here the viewer also hears the words, in
 * their own language mix, so the caption reinforces rather than carries — the eye can
 * sample it instead of reading every character. Netflix itself allows 20 CPS for adult
 * content, and that is the appropriate end of the range.
 *
 * Acquisition is likewise cheaper than in prose subtitling: the card is always in the
 * same place on screen, so there is no visual search, only a fixation.
 */
const DEFAULTS: Required<ReadingTimingOptions> = {
  cps: 20,
  acquisitionSeconds: 0.15,
  leadInSeconds: 0.12,
  maxLagOutSeconds: 1.2,
  bridgeGapSeconds: 1.5,
  /*
   * One frame at 24fps rather than Netflix's two.
   *
   * That two-frame rule guards against broadcast subtitles blurring together. Here the
   * captions are burned in and change appearance completely between cues (colour sweep,
   * word count, position), so the boundary is already unmistakable. At this speech rate
   * the larger gap was costing ~3s of screen time across a 58s clip — time the reader
   * needs more than the separation.
   */
  interCueGap: 0.042,
  minDuration: 0.7,
  maxDuration: 7,
  mediaDuration: Infinity,
};

export interface TimingReport {
  cues: Cue[];
  /** Cues that could not be held long enough to read comfortably. */
  rushed: number;
  /** Cues extended through a pause rather than clearing the screen. */
  bridged: number;
  meanDwell: number;
  /** Mean of (dwell / required reading time). Above 1 means comfortable. */
  meanComfort: number;
}

/** Time needed to read this cue, ignoring how fast it was spoken. */
export function requiredReadingTime(cue: Cue, o: Required<ReadingTimingOptions>): number {
  const chars = cue.lines.join(' ').length;
  // Each extra line costs another fixation to find its start.
  const lineCost = o.acquisitionSeconds * Math.max(1, cue.lines.length) * 0.6;
  return lineCost + chars / o.cps;
}

export function applyReadingTiming(cues: Cue[], options: ReadingTimingOptions = {}): TimingReport {
  const o = { ...DEFAULTS, ...options };
  if (cues.length === 0) {
    return { cues, rushed: 0, bridged: 0, meanDwell: 0, meanComfort: 0 };
  }

  const out = cues.map((c) => ({ ...c }));
  let rushed = 0;
  let bridged = 0;

  for (let i = 0; i < out.length; i++) {
    const cue = out[i]!;
    const next = out[i + 1];
    const prev = out[i - 1];

    // Speech anchors. The cue may be displayed around these but the words do not move.
    const speechStart = cue.words[0]?.start ?? cue.start;
    const speechEnd = cue.words[cue.words.length - 1]?.end ?? cue.end;

    // --- lead-in: cut in early, but never over the previous caption -----------------
    const earliest = prev ? prev.end + o.interCueGap : 0;
    cue.start = Math.max(earliest, speechStart - o.leadInSeconds);
    // Guard against a lead-in that would overrun the speech it belongs to.
    if (cue.start > speechStart) cue.start = speechStart;

    // --- how long the screen is free ------------------------------------------------
    // The next caption's own speech decides the ceiling; it may itself lead in, so
    // reserve that much plus the mandatory blank.
    const nextSpeechStart = next?.words[0]?.start ?? next?.start ?? o.mediaDuration;
    const ceiling = Math.min(
      nextSpeechStart - o.leadInSeconds - o.interCueGap,
      o.mediaDuration,
    );

    const gapAfter = nextSpeechStart - speechEnd;
    const needed = requiredReadingTime(cue, o);

    /*
     * Target end time. Hold at least until the cue has been readable for `needed`
     * seconds. Bridge a short pause outright; on a long pause take a bounded lag-out and
     * then clear, because leaving a stale caption over silence reads as a mistake.
     */
    let target: number;
    if (Number.isFinite(gapAfter) && gapAfter <= o.bridgeGapSeconds && next) {
      target = ceiling;
      if (gapAfter > o.interCueGap * 2) bridged++;
    } else {
      target = Math.min(speechEnd + o.maxLagOutSeconds, ceiling);
    }

    cue.end = Math.max(speechEnd, target, cue.start + Math.min(needed, o.maxDuration));

    // --- clamp to the legal window ---------------------------------------------------
    if (cue.end > cue.start + o.maxDuration) cue.end = cue.start + o.maxDuration;
    if (Number.isFinite(ceiling) && cue.end > ceiling) cue.end = Math.max(speechEnd, ceiling);
    if (cue.end > o.mediaDuration) cue.end = o.mediaDuration;
    // A cue must never outlive the start of the next one.
    if (next && cue.end > nextSpeechStart - o.interCueGap) {
      cue.end = Math.max(cue.start + 0.1, nextSpeechStart - o.interCueGap);
    }
    if (cue.end - cue.start < o.minDuration) {
      cue.end = Math.min(
        cue.start + o.minDuration,
        next ? nextSpeechStart - o.interCueGap : o.mediaDuration,
      );
    }
    if (cue.end <= cue.start) cue.end = cue.start + 0.1;

    if (cue.end - cue.start < needed - 0.05) rushed++;
  }

  const dwells = out.map((c) => c.end - c.start);
  const comforts = out.map((c, i) => dwells[i]! / Math.max(requiredReadingTime(c, o), 0.01));

  return {
    cues: out,
    rushed,
    bridged,
    meanDwell: mean(dwells),
    meanComfort: mean(comforts),
  };
}

const mean = (xs: number[]) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0);
