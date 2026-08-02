/**
 * Encoder benchmark for the burn-in step.
 *
 *   npx tsx src/scripts/bench-encode.ts <video>
 *
 * Splits the cost into two parts, because they are fixed by different things:
 *   - subtitle rasterisation (libass, CPU, scales with events per second)
 *   - video encoding (libx264 or a hardware encoder)
 * Optimising the wrong one wastes effort, so measure the split first.
 */
import { spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { transcribeMedia } from '../jobs/transcribe.js';
import { buildCues } from '../lib/subtitles.js';
import { buildAss } from '../lib/ass.js';
import { applyOverrides, resolvePreset } from '../lib/captionStyle.js';
import { escapeFilterPath, probe } from '../lib/ffmpeg.js';
import { env } from '../lib/env.js';

const input = path.resolve(process.argv[2] ?? 'tmp/sample/sample.mp4');
const FONTS = path.resolve('fonts');

function run(args: string[]): Promise<number> {
  const t0 = Date.now();
  return new Promise((resolve, reject) => {
    const p = spawn(env.ffmpegPath, ['-hide_banner', '-nostdin', '-y', ...args], { windowsHide: true });
    let err = '';
    p.stderr.on('data', (d) => (err += d.toString()));
    p.on('error', reject);
    p.on('close', (c) =>
      c === 0 ? resolve(Date.now() - t0) : reject(new Error(`ffmpeg ${c}: ${err.slice(-600)}`)),
    );
  });
}

const meta = await probe(input);
console.log(`${path.basename(input)}  ${meta.width}x${meta.height}  ${meta.durationSeconds.toFixed(1)}s\n`);

const t = await transcribeMedia(input, { mode: 'translit', languageCode: 'unknown' });
const workDir = await fs.mkdtemp(path.join(os.tmpdir(), 'reellipi-bench-'));

// Two workloads: a calm preset (one event per cue) and a per-word one (many events).
const variants: Array<{ label: string; presetId: string }> = [
  { label: 'karaoke (1 event/cue)', presetId: 'karaoke_bold' },
  { label: 'pop (1 event/word)', presetId: 'hormozi' },
];

for (const v of variants) {
  const style = applyOverrides(resolvePreset(v.presetId), {});
  const cues = buildCues(t.words, {
    mediaDuration: t.durationSeconds,
    maxWordsPerCue: style.maxWordsPerCue,
    maxCharsPerLine: style.maxCharsPerLine,
  });
  const assPath = path.join(workDir, `${v.presetId}.ass`);
  const ass = buildAss(cues, { style, languageCode: t.languageCode, playResX: meta.width, playResY: meta.height });
  await fs.writeFile(assPath, ass, 'utf8');
  const events = ass.split('\n').filter((l) => l.startsWith('Dialogue')).length;

  const vf = `ass=${escapeFilterPath(assPath)}:fontsdir=${escapeFilterPath(FONTS)}`;
  console.log(`--- ${v.label}: ${events} ASS events ---`);

  // Decode + rasterise only, no encode. Isolates the libass cost.
  const filterOnly = await run(['-i', input, '-vf', vf, '-f', 'null', '-']);
  console.log(`  decode + subtitle raster only : ${(filterOnly / 1000).toFixed(1)}s`);

  const configs: Array<[string, string[]]> = [
    ['libx264 medium crf18 (current)', ['-c:v', 'libx264', '-preset', 'medium', '-crf', '18']],
    ['libx264 veryfast crf20', ['-c:v', 'libx264', '-preset', 'veryfast', '-crf', '20']],
    ['libx264 ultrafast crf20', ['-c:v', 'libx264', '-preset', 'ultrafast', '-crf', '20']],
    ['h264_nvenc p4 cq23', ['-c:v', 'h264_nvenc', '-preset', 'p4', '-rc', 'vbr', '-cq', '23', '-b:v', '0']],
    ['h264_nvenc p1 cq23', ['-c:v', 'h264_nvenc', '-preset', 'p1', '-rc', 'vbr', '-cq', '23', '-b:v', '0']],
  ];

  for (const [label, enc] of configs) {
    const out = path.join(workDir, `${v.presetId}-${label.replace(/\W+/g, '_')}.mp4`);
    try {
      const ms = await run(['-i', input, '-vf', vf, ...enc, '-pix_fmt', 'yuv420p', '-c:a', 'copy', '-movflags', '+faststart', out]);
      const size = (await fs.stat(out)).size;
      console.log(
        `  ${label.padEnd(32)} ${(ms / 1000).toFixed(1)}s  ` +
          `${(meta.durationSeconds / (ms / 1000)).toFixed(2)}x realtime  ${(size / 1024 / 1024).toFixed(1)} MB`,
      );
    } catch (e) {
      console.log(`  ${label.padEnd(32)} FAILED: ${(e as Error).message.split('\n')[0]}`);
    }
  }
  console.log('');
}

await fs.rm(workDir, { recursive: true, force: true });
