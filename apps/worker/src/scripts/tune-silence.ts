/**
 * Sweep silencedetect parameters against a real clip.
 *
 * Studio-clean speech splits at -32dB, but a reel with background music never drops
 * that low, so the whole take reads as one run and word timing degrades to a guess.
 * This finds a threshold that yields usefully short runs.
 *
 *   npx tsx src/scripts/tune-silence.ts "C:\path\to\reel.mp4"
 */
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { detectSpeechRuns, extractAudio, probe } from '../lib/ffmpeg.js';

const input = process.argv[2];
if (!input) throw new Error('Usage: tune-silence.ts <video>');

const workDir = await fs.mkdtemp(path.join(os.tmpdir(), 'reellipi-tune-'));
try {
  const meta = await probe(input);
  const wav = await extractAudio(input, path.join(workDir, 'a.wav'));
  console.log(`${path.basename(input)}  ${meta.durationSeconds.toFixed(2)}s\n`);

  const noiseLevels = [-45, -40, -35, -32, -30, -27, -25, -22, -20, -18];
  const minSilences = [0.18, 0.25, 0.35];

  console.log('noiseDb  minSil  runs  medianRun  maxRun  covered  verdict');
  console.log('-------  ------  ----  ---------  ------  -------  -------');

  for (const noiseDb of noiseLevels) {
    for (const minSilenceSeconds of minSilences) {
      const runs = await detectSpeechRuns(wav, meta.durationSeconds, {
        noiseDb,
        minSilenceSeconds,
      });
      const lengths = runs.map((r) => r.end - r.start).sort((a, b) => a - b);
      const median = lengths[Math.floor(lengths.length / 2)] ?? 0;
      const max = lengths[lengths.length - 1] ?? 0;
      const covered = lengths.reduce((a, b) => a + b, 0);

      // A run over ~8s has no internal timing anchor, so words inside it are guesses.
      const verdict =
        max > 15 ? 'unusable' : median <= 5 && max <= 10 ? 'GOOD' : median <= 8 ? 'ok' : 'loose';

      console.log(
        `${String(noiseDb).padStart(7)}  ${minSilenceSeconds.toFixed(2).padStart(6)}  ` +
          `${String(runs.length).padStart(4)}  ${median.toFixed(2).padStart(9)}  ` +
          `${max.toFixed(2).padStart(6)}  ${((covered / meta.durationSeconds) * 100).toFixed(0).padStart(6)}%  ${verdict}`,
      );
    }
  }

  // Loudness floor tells us whether a quiet threshold could ever trigger.
  console.log('\nIf every row says "unusable", the audio has continuous background');
  console.log('music and silence detection cannot anchor timing on this clip.');
} finally {
  await fs.rm(workDir, { recursive: true, force: true });
}
