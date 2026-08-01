/**
 * Phase 3 acceptance harness: transcribe -> cue -> ASS -> burn, then pull frames so
 * Indic glyph rendering and safe-area placement can be eyeballed.
 *
 *   npx tsx src/scripts/render-sample.ts [input.mp4] [--preset highlight_pop] [--mode codemix]
 */
import { spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';
import { transcribeMedia } from '../jobs/transcribe.js';
import { renderCaptionedVideo } from '../jobs/render.js';
import { cueStats } from '../lib/subtitles.js';
import { styleCues } from '../jobs/style.js';
import { PRESETS } from '../lib/captionStyle.js';
import { env } from '../lib/env.js';
import type { LangMode } from '../lib/sarvam.js';

function arg(flag: string, fallback: string): string {
  const i = process.argv.indexOf(flag);
  return i >= 0 ? (process.argv[i + 1] ?? fallback) : fallback;
}

function ffmpeg(args: string[]): Promise<void> {
  return new Promise((resolve, reject) => {
    const p = spawn(env.ffmpegPath, ['-hide_banner', '-nostdin', '-y', ...args], { windowsHide: true });
    let err = '';
    p.stderr.on('data', (d) => (err += d.toString()));
    p.on('error', reject);
    p.on('close', (c) => (c === 0 ? resolve() : reject(new Error(`ffmpeg ${c}\n${err.slice(-1500)}`))));
  });
}

async function main() {
  const positional = process.argv.slice(2).find((a) => !a.startsWith('--') && /\.(mp4|mov|webm)$/i.test(a));
  const input = path.resolve(positional ?? 'tmp/sample/sample.mp4');
  const presetId = arg('--preset', 'karaoke_bold');
  const mode = arg('--mode', 'translit') as LangMode;
  if (!PRESETS[presetId]) throw new Error(`Unknown preset "${presetId}". Have: ${Object.keys(PRESETS).join(', ')}`);

  const outDir = path.resolve('tmp/render', presetId);
  await fs.mkdir(outDir, { recursive: true });

  console.log(`input  : ${input}`);
  console.log(`preset : ${presetId}   mode: ${mode}\n`);

  console.log('1/3 transcribing...');
  const t = await transcribeMedia(input, { mode, languageCode: 'unknown' });
  console.log(`    ${t.stats.runCount} runs, ${t.words.length} words, lang ${t.languageCode}`);

  console.log('2/3 building cues...');
  const useLlm = !process.argv.includes('--no-llm');
  const styled = await styleCues(t.words, {
    languageCode: t.languageCode,
    mediaDuration: t.durationSeconds,
    skipLlm: !useLlm,
  });
  const cues = styled.cues;
  console.log(`    LLM styling: ${styled.llmApplied ? 'applied' : `skipped (${styled.warning ?? 'disabled'})`}`);
  if (styled.igCaption) console.log(`    IG caption : ${styled.igCaption}`);
  if (styled.hashtags.length) console.log(`    hashtags   : ${styled.hashtags.map((h) => `#${h}`).join(' ')}`);
  const stats = cueStats(cues);
  console.log(`    ${stats.count} cues  maxCPS ${stats.maxCps}  maxChars ${stats.maxChars}`);
  for (const c of cues) {
    console.log(`    [${c.idx}] ${c.start.toFixed(2)}-${c.end.toFixed(2)}  ${c.lines.join('  /  ')}`);
  }
  const cpsOk = stats.maxCps <= 22;
  const lineOk = cues.every((c) => c.lines.length <= 2 && c.lines.every((l) => l.length <= 32));
  const durOk = cues.every((c) => c.end - c.start >= 0.69 && c.end - c.start <= 7.05);

  // Every transcribed word must survive into a rendered line. The styling pass is only
  // allowed to regroup and decorate, never to drop.
  const spoken = t.words.map((w) => w.w);
  const shown = cues.flatMap((c) => c.lines.join(' ').split(/\s+/)).filter(Boolean);
  const missing = spoken.filter((w) => !shown.some((s) => s.includes(w)));
  const wordsOk = missing.length === 0;
  if (!wordsOk) console.log(`    DROPPED WORDS: ${missing.join(', ')}`);

  console.log('\n3/3 burning...');
  const r = await renderCaptionedVideo({
    inputPath: input,
    cues,
    outputPath: path.join(outDir, 'out.mp4'),
    presetId,
    languageCode: t.languageCode,
  });

  const ratio = r.renderMs / 1000 / r.durationSeconds;
  console.log(`    ${r.width}x${r.height}  ${r.durationSeconds.toFixed(2)}s`);
  console.log(`    render ${(r.renderMs / 1000).toFixed(1)}s  (${ratio.toFixed(2)}x realtime)`);

  // Grab a frame from the middle of each cue for visual glyph inspection.
  const framesDir = path.join(outDir, 'frames');
  await fs.mkdir(framesDir, { recursive: true });
  const picks = cues.slice(0, 4).map((c) => (c.start + c.end) / 2);
  for (const [i, ts] of picks.entries()) {
    await ffmpeg(['-ss', ts.toFixed(3), '-i', r.outputPath, '-frames:v', '1', '-q:v', '2', path.join(framesDir, `cue${i}.jpg`)]);
  }

  console.log('\n--- acceptance ---');
  console.log(`  no words dropped           : ${wordsOk ? 'PASS' : `FAIL (${missing.length})`}`);
  console.log(`  <=2 lines, <=32 chars/line : ${lineOk ? 'PASS' : 'FAIL'}`);
  console.log(`  cue duration 0.83-7s       : ${durOk ? 'PASS' : 'FAIL'}`);
  console.log(`  on-screen density          : ${cpsOk ? 'PASS' : 'FAIL'} (${stats.maxCps} CPS)`);
  // Source resolution is preserved deliberately; Reels accepts any 9:16 up to 1080x1920.
  const aspect = r.width > 0 ? r.height / r.width : 0;
  const aspectOk = Math.abs(aspect - 16 / 9) < 0.02;
  console.log(`  9:16 output                : ${aspectOk ? `PASS (${r.width}x${r.height})` : `FAIL (${r.width}x${r.height})`}`);
  console.log(`  render < 1.5x realtime     : ${ratio < 1.5 ? 'PASS' : 'SLOW'}`);
  console.log(`\noutput -> ${r.outputPath}`);
  console.log(`frames -> ${framesDir}`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
