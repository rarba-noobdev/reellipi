/**
 * Phase 1 acceptance harness.
 *
 * Runs the real pipeline over a clip and, when tmp/sample/truth.json exists, reports
 * how far detected speech-run boundaries drift from the known phrase boundaries.
 *
 *   npx tsx src/scripts/probe-pipeline.ts [path/to/video.mp4] [--mode translit] [--lang unknown]
 */
import fs from 'node:fs/promises';
import path from 'node:path';
import { transcribeMedia } from '../jobs/transcribe.js';
import type { LangMode } from '../lib/sarvam.js';

interface Truth {
  duration: number;
  phrases: Array<{ text: string; start: number; end: number }>;
}

function arg(flag: string, fallback: string): string {
  const i = process.argv.indexOf(flag);
  return i >= 0 ? (process.argv[i + 1] ?? fallback) : fallback;
}

async function main() {
  const positional = process.argv.slice(2).find((a) => !a.startsWith('--') && /\.(mp4|mov|m4a|wav|mp3|webm)$/i.test(a));
  const input = path.resolve(positional ?? 'tmp/sample/sample.mp4');
  const mode = arg('--mode', 'translit') as LangMode;
  const lang = arg('--lang', 'unknown');

  await fs.access(input).catch(() => {
    throw new Error(`Input not found: ${input}\nRun: npx tsx src/scripts/make-sample.ts`);
  });

  console.log(`input : ${input}`);
  console.log(`mode  : ${mode}   language_code: ${lang}\n`);

  const t0 = Date.now();
  const result = await transcribeMedia(input, {
    mode,
    languageCode: lang,
    onProgress: (done, total) => process.stdout.write(`\r  transcribing ${done}/${total} runs`),
  });
  process.stdout.write('\r'.padEnd(40) + '\r');

  console.log(`duration        : ${result.durationSeconds.toFixed(2)}s (${result.width}x${result.height})`);
  console.log(`detected lang   : ${result.languageCode}`);
  console.log(`speech runs     : ${result.stats.runCount}  covering ${result.stats.speechSeconds}s`);
  console.log(`billed          : ${result.stats.billedSeconds}s  ~= Rs ${result.stats.estimatedCostInr.toFixed(4)}`);
  console.log(`API timestamps  : ${result.stats.apiProvidedTimestamps ? 'MULTI-ENTRY (revisit align.ts!)' : 'single whole-file entry -> using distribution'}`);
  console.log(`wall clock      : ${((Date.now() - t0) / 1000).toFixed(1)}s\n`);

  console.log('--- speech runs ---');
  for (const r of result.runs) {
    console.log(`  [${r.index}] ${r.start.toFixed(2)}-${r.end.toFixed(2)}s  ${r.transcript || '(empty)'}`);
  }

  console.log('\n--- word timeline (first 25) ---');
  for (const w of result.words.slice(0, 25)) {
    console.log(`  ${w.start.toFixed(2).padStart(6)} -> ${w.end.toFixed(2).padStart(6)}  ${w.w}`);
  }

  const monotonic = result.words.every((w, i, a) => i === 0 || w.start >= a[i - 1]!.end - 1e-6);
  console.log(`\nmonotonic timeline : ${monotonic ? 'PASS' : 'FAIL'}`);

  const truthPath = path.join(path.dirname(input), 'truth.json');
  const truth = await fs.readFile(truthPath, 'utf8').then((t) => JSON.parse(t) as Truth).catch(() => null);
  if (!truth) {
    console.log('(no truth.json alongside input — skipping drift measurement)');
    return;
  }

  console.log('\n--- boundary drift vs ground truth ---');
  const errors: number[] = [];
  for (const p of truth.phrases) {
    // Pair each known phrase with the detected run that overlaps it most.
    const best = result.runs
      .map((r) => ({ r, ov: Math.min(r.end, p.end) - Math.max(r.start, p.start) }))
      .sort((a, b) => b.ov - a.ov)[0];
    if (!best || best.ov <= 0) {
      console.log(`  MISSED  ${p.start.toFixed(2)}-${p.end.toFixed(2)}  "${p.text.slice(0, 40)}"`);
      continue;
    }
    const dStart = best.r.start - p.start;
    const dEnd = best.r.end - p.end;
    errors.push(Math.abs(dStart), Math.abs(dEnd));
    console.log(
      `  truth ${p.start.toFixed(2)}-${p.end.toFixed(2)} | run ${best.r.start.toFixed(2)}-${best.r.end.toFixed(2)}` +
        ` | dstart ${fmtMs(dStart)} dend ${fmtMs(dEnd)}`,
    );
  }
  if (errors.length) {
    const mean = errors.reduce((a, b) => a + b, 0) / errors.length;
    const max = Math.max(...errors);
    console.log(`\nboundary error: mean ${(mean * 1000).toFixed(0)}ms  max ${(max * 1000).toFixed(0)}ms`);
    console.log(max <= 0.35 ? 'PHASE 1 ACCEPT: within the +-350ms budget for silence-split timing.' : 'OVER BUDGET: tune silencedetect noise/duration in lib/ffmpeg.ts.');
  }

  const outPath = path.join(path.dirname(input), 'pipeline-result.json');
  await fs.writeFile(outPath, JSON.stringify(result, null, 2));
  console.log(`\nfull result -> ${outPath}`);
}

const fmtMs = (s: number) => `${s >= 0 ? '+' : ''}${(s * 1000).toFixed(0)}ms`;

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
