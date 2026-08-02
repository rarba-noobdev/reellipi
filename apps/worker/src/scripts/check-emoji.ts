/**
 * Does an emoji actually survive the burn?
 *
 * libass resolves glyphs through fontconfig. Nothing in the bundled font set covers
 * emoji, so this renders a short clip with emoji in the caption and extracts a frame to
 * see what the viewer would get: colour, monochrome outline, or a tofu box.
 */
import { spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';
import { renderCaptionedVideo } from '../jobs/render.js';
import { env } from '../lib/env.js';
import type { Cue } from '../lib/subtitles.js';

const input = process.argv[2] ?? 'tmp/sample/sample.mp4';
const outDir = path.resolve('tmp/render/emoji');
await fs.mkdir(outDir, { recursive: true });

const word = (w: string, start: number, end: number) => ({ w, start, end });

const cues: Cue[] = [
  {
    idx: 0,
    start: 0.2,
    end: 2.4,
    lines: ['Ghee cream 🧊 ready'],
    words: [word('Ghee', 0.2, 0.8), word('cream', 0.8, 1.4), word('🧊', 1.4, 1.8), word('ready', 1.8, 2.4)],
  },
  {
    idx: 1,
    start: 2.6,
    end: 4.8,
    lines: ['Try pannunga 🔥 ✨'],
    words: [word('Try', 2.6, 3.2), word('pannunga', 3.2, 4.0), word('🔥', 4.0, 4.4), word('✨', 4.4, 4.8)],
  },
];

const r = await renderCaptionedVideo({
  inputPath: path.resolve(input),
  cues,
  outputPath: path.join(outDir, 'out.mp4'),
  presetId: 'karaoke_bold',
  languageCode: 'ta-IN',
});
console.log(`rendered ${r.width}x${r.height}`);

for (const [i, t] of [1.2, 3.4].entries()) {
  await new Promise<void>((resolve, reject) => {
    const p = spawn(
      env.ffmpegPath,
      ['-hide_banner', '-nostdin', '-y', '-ss', String(t), '-i', r.outputPath, '-frames:v', '1', '-q:v', '2', path.join(outDir, `frame${i}.jpg`)],
      { windowsHide: true },
    );
    p.on('error', reject);
    p.on('close', () => resolve());
  });
}
console.log(`frames -> ${outDir}`);
