/**
 * Measure real word-timing drift without external ground truth.
 *
 * The pipeline's timing is validated against Sarvam itself: cut the audio into fixed
 * windows whose boundaries we know exactly, transcribe each one independently, then ask
 * where each word ACTUALLY occurred versus where distribution PREDICTED it.
 *
 *   npx tsx src/scripts/measure-drift.ts "C:\path\to\reel.mp4" [--window 5]
 */
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { extractAudio, probe, sliceAudio } from '../lib/ffmpeg.js';
import { transcribeChunk } from '../lib/sarvam.js';
import { transcribeMedia } from '../jobs/transcribe.js';

const input = process.argv[2];
if (!input) throw new Error('Usage: measure-drift.ts <video> [--window 5]');
const wi = process.argv.indexOf('--window');
const WINDOW = wi >= 0 ? Number(process.argv[wi + 1]) : 5;

const norm = (s: string) => s.toLowerCase().replace(/[^\p{L}\p{N}]/gu, '');

const workDir = await fs.mkdtemp(path.join(os.tmpdir(), 'reellipi-drift-'));
try {
  const meta = await probe(input);
  console.log(`${path.basename(input)}  ${meta.durationSeconds.toFixed(2)}s  window=${WINDOW}s\n`);

  console.log('1/2 running the normal pipeline (silence-split + distribute)...');
  const pipeline = await transcribeMedia(input, { mode: 'translit', languageCode: 'unknown' });
  console.log(`    ${pipeline.stats.runCount} runs, ${pipeline.words.length} words\n`);

  console.log(`2/2 transcribing independent ${WINDOW}s reference windows...`);
  const wav = await extractAudio(input, path.join(workDir, 'a.wav'));
  const windows: Array<{ start: number; end: number; words: string[] }> = [];
  for (let t = 0; t < meta.durationSeconds; t += WINDOW) {
    const end = Math.min(t + WINDOW, meta.durationSeconds);
    if (end - t < 0.5) break;
    const chunk = path.join(workDir, `w${windows.length}.wav`);
    await sliceAudio(wav, { start: t, end }, chunk);
    const res = await transcribeChunk(chunk, { mode: 'translit', languageCode: 'unknown' });
    windows.push({
      start: t,
      end,
      words: (res.transcript ?? '').split(/\s+/).map(norm).filter(Boolean),
    });
    process.stdout.write(`\r    window ${windows.length} (${t.toFixed(0)}-${end.toFixed(0)}s)`);
  }
  process.stdout.write('\n\n');

  /*
   * For each predicted word, find the reference window that actually contains it.
   * Words repeated across the clip are skipped — they cannot be attributed to one
   * window unambiguously.
   */
  const predicted = pipeline.words.map((w) => ({ ...w, key: norm(w.w) }));
  const occurrences = new Map<string, number>();
  for (const w of predicted) occurrences.set(w.key, (occurrences.get(w.key) ?? 0) + 1);

  const errors: Array<{ word: string; predicted: number; actualLo: number; actualHi: number; err: number }> = [];
  for (const w of predicted) {
    if (!w.key || (occurrences.get(w.key) ?? 0) !== 1) continue;
    const hits = windows.filter((win) => win.words.includes(w.key));
    if (hits.length !== 1) continue;

    const win = hits[0]!;
    const mid = (w.start + w.end) / 2;
    // Zero error if the prediction lands inside the window that really contains it.
    const err = mid < win.start ? win.start - mid : mid > win.end ? mid - win.end : 0;
    errors.push({ word: w.w, predicted: mid, actualLo: win.start, actualHi: win.end, err });
  }

  if (errors.length === 0) {
    console.log('Could not match any unique words between the two passes.');
  } else {
    const errs = errors.map((e) => e.err).sort((a, b) => a - b);
    const inside = errors.filter((e) => e.err === 0).length;
    const mean = errs.reduce((a, b) => a + b, 0) / errs.length;
    const p90 = errs[Math.floor(errs.length * 0.9)] ?? 0;
    const max = errs[errs.length - 1] ?? 0;

    console.log(`matched ${errors.length} uniquely-identifiable words\n`);
    console.log(`  landed inside the correct ${WINDOW}s window : ${inside}/${errors.length} (${((inside / errors.length) * 100).toFixed(0)}%)`);
    console.log(`  mean error outside window                : ${(mean * 1000).toFixed(0)}ms`);
    console.log(`  p90 error                                : ${(p90 * 1000).toFixed(0)}ms`);
    console.log(`  worst error                              : ${(max * 1000).toFixed(0)}ms`);

    const worst = [...errors].sort((a, b) => b.err - a.err).slice(0, 8).filter((e) => e.err > 0);
    if (worst.length) {
      console.log('\n  worst offenders:');
      for (const e of worst) {
        console.log(
          `    "${e.word}" predicted ${e.predicted.toFixed(2)}s but spoken within ` +
            `${e.actualLo.toFixed(0)}-${e.actualHi.toFixed(0)}s  (off by ${(e.err * 1000).toFixed(0)}ms)`,
        );
      }
    }
    console.log(
      `\nverdict: ${max <= 0.4 ? 'ACCEPTABLE for karaoke' : max <= 1.0 ? 'NOTICEABLE drift' : 'BAD — needs forced alignment'}`,
    );
  }
} finally {
  await fs.rm(workDir, { recursive: true, force: true });
}
