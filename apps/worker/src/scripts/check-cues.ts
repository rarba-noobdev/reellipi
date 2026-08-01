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

for (const c of [...short, ...long]) {
  const next = cues[c.idx + 1];
  console.log(
    `  [${c.idx}] ${c.start.toFixed(2)}-${c.end.toFixed(2)} (${((c.end - c.start) * 1000).toFixed(0)}ms) ` +
      `"${c.lines.join(' / ')}"  chars=${c.lines.join(' ').length}` +
      (next ? `  gapToNext=${((next.start - c.end) * 1000).toFixed(0)}ms` : '  [last]'),
  );
}
