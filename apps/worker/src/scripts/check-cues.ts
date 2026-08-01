/** Report cues that violate the duration rules, without paying for a render. */
import { transcribeMedia } from '../jobs/transcribe.js';
import { styleCues } from '../jobs/style.js';

const input = process.argv[2];
if (!input) throw new Error('Usage: check-cues.ts <video> [--no-llm]');

const t = await transcribeMedia(input, { mode: 'translit', languageCode: 'unknown' });
// Check the same path render-sample uses, or LLM-grouped cues go unverified.
const styled = await styleCues(t.words, {
  languageCode: t.languageCode,
  mediaDuration: t.durationSeconds,
  skipLlm: process.argv.includes('--no-llm'),
});
const cues = styled.cues;
console.log(`LLM styling: ${styled.llmApplied ? 'applied' : `skipped (${styled.warning ?? 'disabled'})`}`);

const short = cues.filter((c) => c.end - c.start < 0.7);
const long = cues.filter((c) => c.end - c.start > 7);

console.log(`${cues.length} cues over ${t.durationSeconds.toFixed(2)}s`);
console.log(`under 833ms: ${short.length}   over 7s: ${long.length}\n`);

// Rhythm report: do cues respect sentence ends, and is the cadence even?
const SENTENCE_END = /[.!?|।॥]["')\]]?$/;
const runOn = cues.filter((c) => {
  const inner = c.words.slice(0, -1);
  return inner.some((w) => SENTENCE_END.test(w.w));
});
const durations = cues.map((c) => c.end - c.start);
const mean = durations.reduce((a, b) => a + b, 0) / durations.length;
const sd = Math.sqrt(durations.reduce((a, d) => a + (d - mean) ** 2, 0) / durations.length);

console.log(`cues spanning a sentence end : ${runOn.length}  ${runOn.length === 0 ? 'PASS' : 'FAIL'}`);
for (const c of runOn.slice(0, 5)) console.log(`    RUN-ON: "${c.lines.join(' ')}"`);
console.log(`cue duration mean ${mean.toFixed(2)}s  sd ${sd.toFixed(2)}s  (lower sd = steadier rhythm)`);

console.log('\n--- first 12 cues ---');
for (const c of cues.slice(0, 12)) {
  console.log(`  ${c.start.toFixed(2)}-${c.end.toFixed(2)} (${(c.end - c.start).toFixed(2)}s)  ${c.lines.join(' / ')}`);
}
console.log('');

for (const c of [...short, ...long]) {
  const next = cues[c.idx + 1];
  console.log(
    `  [${c.idx}] ${c.start.toFixed(2)}-${c.end.toFixed(2)} (${((c.end - c.start) * 1000).toFixed(0)}ms) ` +
      `"${c.lines.join(' / ')}"  chars=${c.lines.join(' ').length}` +
      (next ? `  gapToNext=${((next.start - c.end) * 1000).toFixed(0)}ms` : '  [last]'),
  );
}
