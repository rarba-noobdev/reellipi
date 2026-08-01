/** Confirm the free-plan watermark filter composes with the ASS burn-in. */
import path from 'node:path';
import { spawn } from 'node:child_process';
import { transcribeMedia } from '../jobs/transcribe.js';
import { renderCaptionedVideo } from '../jobs/render.js';
import { buildCues } from '../lib/subtitles.js';
import { env } from '../lib/env.js';

const input = path.resolve('tmp/sample/sample.mp4');
const outDir = path.resolve('tmp/render/watermark');

const t = await transcribeMedia(input, { mode: 'translit', languageCode: 'unknown' });
const cues = buildCues(t.words, { mediaDuration: t.durationSeconds });

const r = await renderCaptionedVideo({
  inputPath: input,
  cues,
  outputPath: path.join(outDir, 'out.mp4'),
  presetId: 'karaoke_bold',
  languageCode: t.languageCode,
  watermarkText: 'ReelLipi',
});

console.log(`rendered ${r.width}x${r.height} in ${(r.renderMs / 1000).toFixed(1)}s`);

await new Promise<void>((resolve, reject) => {
  const p = spawn(
    env.ffmpegPath,
    ['-hide_banner', '-nostdin', '-y', '-ss', '1.2', '-i', r.outputPath, '-frames:v', '1', '-q:v', '2', path.join(outDir, 'frame.jpg')],
    { windowsHide: true },
  );
  p.on('error', reject);
  p.on('close', (c) => (c === 0 ? resolve() : reject(new Error(`ffmpeg ${c}`))));
});
console.log(`frame -> ${path.join(outDir, 'frame.jpg')}`);
