/**
 * Readability report for a clip's captions.
 *
 *   npx tsx src/scripts/check-rhythm.ts <video>
 *
 * Reports the things a viewer actually feels: whether a caption is on screen long enough
 * to read, whether the screen blanks during short pauses, and whether the cadence is even.
 */
import { transcribeMedia } from '../jobs/transcribe.js';
import { buildCues } from '../lib/subtitles.js';
import { requiredReadingTime } from '../lib/readingTiming.js';

const input = process.argv[2];
if (!input) throw new Error('Usage: check-rhythm.ts <video>');

const t = await transcribeMedia(input, { mode: 'translit', languageCode: 'unknown' });
const cues = buildCues(t.words, { mediaDuration: t.durationSeconds });

const o = {
  cps: 20,
  acquisitionSeconds: 0.15,
  leadInSeconds: 0.12,
  maxLagOutSeconds: 1.2,
  bridgeGapSeconds: 1.5,
  interCueGap: 0.042,
  minDuration: 0.7,
  maxDuration: 7,
  mediaDuration: t.durationSeconds,
};

const SENTENCE_END = /[.!?|।॥]["')\]]?$/;

const rows = cues.map((c, i) => {
  const next = cues[i + 1];
  const speechStart = c.words[0]!.start;
  const speechEnd = c.words[c.words.length - 1]!.end;
  const dwell = c.end - c.start;
  const need = requiredReadingTime(c, o);
  return {
    i,
    dwell,
    need,
    comfort: dwell / need,
    lead: speechStart - c.start,
    hold: c.end - speechEnd,
    blankAfter: next ? next.start - c.end : 0,
    text: c.lines.join(' '),
  };
});

const mean = (xs: number[]) => xs.reduce((a, b) => a + b, 0) / (xs.length || 1);
const sd = (xs: number[]) => {
  const m = mean(xs);
  return Math.sqrt(mean(xs.map((x) => (x - m) ** 2)));
};

// 10% tolerance: the reading-time model is an estimate, so treating a 30ms shortfall as
// a failure would be false precision. Anything below 0.9 is a real problem.
const rushed = rows.filter((r) => r.comfort < 0.9);
const runOn = cues.filter((c) => c.words.slice(0, -1).some((w) => SENTENCE_END.test(w.w)));
const blanks = rows.filter((r) => r.blankAfter > 0.2);
const totalBlank = rows.reduce((a, r) => a + Math.max(0, r.blankAfter), 0);

console.log(`${cues.length} cues over ${t.durationSeconds.toFixed(1)}s\n`);
console.log('READABILITY');
// Same 10% tolerance as the per-cue check: the reading-time model is an estimate, so
// demanding a mean of exactly 1.00 would be false precision.
const meanComfort = mean(rows.map((r) => r.comfort));
console.log(`  mean comfort (dwell / reading time) : ${meanComfort.toFixed(2)}  ${meanComfort >= 0.95 ? 'PASS' : 'FAIL'}`);
console.log(`  cues too short to read              : ${rushed.length}  ${rushed.length === 0 ? 'PASS' : 'FAIL'}`);
console.log(`  mean dwell                          : ${mean(rows.map((r) => r.dwell)).toFixed(2)}s`);
console.log(`  mean lead-in                        : ${(mean(rows.map((r) => r.lead)) * 1000).toFixed(0)}ms`);
console.log(`  mean hold after last word           : ${(mean(rows.map((r) => r.hold)) * 1000).toFixed(0)}ms`);

console.log('\nRHYTHM');
console.log(`  cues spanning a sentence end        : ${runOn.length}  ${runOn.length === 0 ? 'PASS' : 'FAIL'}`);
console.log(`  dwell sd (lower = steadier)         : ${sd(rows.map((r) => r.dwell)).toFixed(2)}s`);
console.log(`  blank gaps > 200ms                  : ${blanks.length}  (${totalBlank.toFixed(1)}s of blank screen)`);

if (rushed.length) {
  console.log('\n  rushed cues:');
  for (const r of rushed.slice(0, 5)) {
    console.log(`    need ${r.need.toFixed(2)}s got ${r.dwell.toFixed(2)}s  "${r.text}"`);
  }
}

console.log('\n--- first 10 cues ---');
for (const r of rows.slice(0, 10)) {
  console.log(
    `  ${cues[r.i]!.start.toFixed(2)}-${cues[r.i]!.end.toFixed(2)}  dwell ${r.dwell.toFixed(2)}s ` +
      `comfort ${r.comfort.toFixed(2)}  hold ${(r.hold * 1000).toFixed(0)}ms  ${r.text}`,
  );
}
