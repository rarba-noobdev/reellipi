import fs from 'node:fs/promises';
import path from 'node:path';
import { buildAss, type BuildAssOptions } from '../lib/ass.js';
import { applyOverrides, resolvePreset, type CaptionStyle } from '../lib/captionStyle.js';
import { burnSubtitles, probe } from '../lib/ffmpeg.js';
import { toSrt, toVtt, type Cue } from '../lib/subtitles.js';

/** Bundled with the worker image; see scripts/fetch-fonts.ts. */
export const FONTS_DIR = path.resolve('fonts');

export interface RenderOptions {
  inputPath: string;
  cues: Cue[];
  outputPath: string;
  presetId?: string;
  /** User edits layered on top of the preset. */
  styleOverrides?: Partial<CaptionStyle>;
  languageCode?: string | null;
  /** Directory for the .ass/.srt/.vtt sidecars. Defaults to the output's directory. */
  artifactDir?: string;
  crf?: number;
  ffmpegPreset?: string;
  /** Free-plan branding. Omit for paid plans. */
  watermarkText?: string | null;
}

export interface RenderResult {
  outputPath: string;
  assPath: string;
  srtPath: string;
  vttPath: string;
  width: number;
  height: number;
  durationSeconds: number;
  renderMs: number;
}

export async function renderCaptionedVideo(o: RenderOptions): Promise<RenderResult> {
  const style = applyOverrides(resolvePreset(o.presetId), o.styleOverrides);
  if (o.cues.length === 0) throw new Error('Nothing to render: no cues');

  const artifactDir = o.artifactDir ?? path.dirname(o.outputPath);
  await fs.mkdir(artifactDir, { recursive: true });

  const stem = path.basename(o.outputPath, path.extname(o.outputPath));
  const source = await probe(o.inputPath);

  const assOptions: BuildAssOptions = {
    style,
    languageCode: o.languageCode,
    // Match the source frame so percentage-based sizes land where they were designed to.
    playResX: source.width || undefined,
    playResY: source.height || undefined,
  };

  const assPath = path.join(artifactDir, `${stem}.ass`);
  const srtPath = path.join(artifactDir, `${stem}.srt`);
  const vttPath = path.join(artifactDir, `${stem}.vtt`);

  await fs.writeFile(assPath, buildAss(o.cues, assOptions), 'utf8');
  await fs.writeFile(srtPath, toSrt(o.cues), 'utf8');
  await fs.writeFile(vttPath, toVtt(o.cues), 'utf8');

  const t0 = Date.now();
  await burnSubtitles({
    input: o.inputPath,
    assPath,
    fontsDir: FONTS_DIR,
    output: o.outputPath,
    crf: o.crf,
    preset: o.ffmpegPreset,
    watermark: o.watermarkText
      ? { text: o.watermarkText, fontFile: path.join(FONTS_DIR, 'NotoSans-Bold.ttf') }
      : null,
  });
  const renderMs = Date.now() - t0;

  const out = await probe(o.outputPath);
  return {
    outputPath: o.outputPath,
    assPath,
    srtPath,
    vttPath,
    width: out.width,
    height: out.height,
    durationSeconds: out.durationSeconds,
    renderMs,
  };
}
