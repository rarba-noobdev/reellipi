import { spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';
import { env } from './env.js';

export interface ProbeResult {
  durationSeconds: number;
  width: number;
  height: number;
  hasAudio: boolean;
  videoCodec: string | null;
}

/** A contiguous run of speech, in seconds, relative to the start of the audio file. */
export interface SpeechRun {
  start: number;
  end: number;
}

function run(bin: string, args: string[]): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const p = spawn(bin, args, { windowsHide: true });
    let stdout = '';
    let stderr = '';
    p.stdout.on('data', (d) => (stdout += d.toString()));
    p.stderr.on('data', (d) => (stderr += d.toString()));
    p.on('error', reject);
    p.on('close', (code) => resolve({ code: code ?? -1, stdout, stderr }));
  });
}

async function ffmpeg(args: string[]): Promise<string> {
  const r = await run(env.ffmpegPath, ['-hide_banner', '-nostdin', '-y', ...args]);
  if (r.code !== 0) {
    // ffmpeg puts everything on stderr; surface the tail, which holds the actual error.
    throw new Error(`ffmpeg exited ${r.code}\n${r.stderr.slice(-2000)}`);
  }
  return r.stderr;
}

export async function probe(input: string): Promise<ProbeResult> {
  const r = await run(env.ffprobePath, [
    '-v', 'error',
    '-print_format', 'json',
    '-show_format',
    '-show_streams',
    input,
  ]);
  if (r.code !== 0) throw new Error(`ffprobe failed: ${r.stderr.slice(-1000)}`);

  const j = JSON.parse(r.stdout) as {
    format?: { duration?: string };
    streams?: Array<{ codec_type?: string; codec_name?: string; width?: number; height?: number }>;
  };
  const streams = j.streams ?? [];
  const video = streams.find((s) => s.codec_type === 'video');
  const duration = Number(j.format?.duration ?? 0);
  if (!Number.isFinite(duration) || duration <= 0) throw new Error('Could not determine media duration');

  return {
    durationSeconds: duration,
    width: video?.width ?? 0,
    height: video?.height ?? 0,
    hasAudio: streams.some((s) => s.codec_type === 'audio'),
    videoCodec: video?.codec_name ?? null,
  };
}

/** 16 kHz mono PCM — the format Sarvam STT performs best on. */
export async function extractAudio(input: string, outWav: string): Promise<string> {
  await fs.mkdir(path.dirname(outWav), { recursive: true });
  await ffmpeg(['-i', input, '-vn', '-ac', '1', '-ar', '16000', '-c:a', 'pcm_s16le', outWav]);
  return outWav;
}

export interface SegmentOptions {
  /** Anything quieter than this counts as silence. */
  noiseDb?: number;
  /** A gap must last at least this long to split a run. */
  minSilenceSeconds?: number;
  /** Speech runs shorter than this get merged into a neighbour. */
  minRunSeconds?: number;
  /** Hard ceiling — Sarvam's sync REST endpoint rejects audio over 30s. */
  maxRunSeconds?: number;
  /** Grow each run outward so onsets/tails are not clipped. */
  padSeconds?: number;
}

const SEGMENT_DEFAULTS: Required<SegmentOptions> = {
  noiseDb: -32,
  minSilenceSeconds: 0.35,
  minRunSeconds: 0.6,
  maxRunSeconds: 28,
  padSeconds: 0.15,
};

/**
 * Locate speech runs by inverting ffmpeg's silencedetect output.
 *
 * These run boundaries are the *only* timing ground truth we get: Sarvam's REST
 * endpoint returns a single timestamp entry spanning the whole file regardless of
 * mode or model (verified empirically), so per-word timing is derived from where
 * we cut the audio, not from the API.
 */
export async function detectSpeechRuns(
  wavPath: string,
  totalDuration: number,
  options: SegmentOptions = {},
): Promise<SpeechRun[]> {
  const o = { ...SEGMENT_DEFAULTS, ...options };

  const log = await ffmpeg([
    '-i', wavPath,
    '-af', `silencedetect=noise=${o.noiseDb}dB:d=${o.minSilenceSeconds}`,
    '-f', 'null', '-',
  ]);

  const silences: SpeechRun[] = [];
  let pendingStart: number | null = null;
  for (const line of log.split(/\r?\n/)) {
    const s = line.match(/silence_start:\s*(-?[\d.]+)/);
    if (s?.[1] !== undefined) pendingStart = Math.max(0, Number(s[1]));
    const e = line.match(/silence_end:\s*(-?[\d.]+)/);
    if (e?.[1] !== undefined && pendingStart !== null) {
      silences.push({ start: pendingStart, end: Number(e[1]) });
      pendingStart = null;
    }
  }
  // A trailing silence never emits silence_end — it runs to EOF.
  if (pendingStart !== null) silences.push({ start: pendingStart, end: totalDuration });

  // Invert silences into speech runs.
  let runs: SpeechRun[] = [];
  let cursor = 0;
  for (const s of silences) {
    if (s.start > cursor) runs.push({ start: cursor, end: s.start });
    cursor = Math.max(cursor, s.end);
  }
  if (cursor < totalDuration) runs.push({ start: cursor, end: totalDuration });

  // Entirely silent (or single unbroken take) — fall back to the whole file.
  if (runs.length === 0) runs = [{ start: 0, end: totalDuration }];

  runs = padRuns(runs, o.padSeconds, totalDuration);
  runs = mergeShortRuns(runs, o.minRunSeconds, o.maxRunSeconds);
  runs = splitLongRuns(runs, o.maxRunSeconds);
  return runs.filter((r) => r.end - r.start > 0.05);
}

function padRuns(runs: SpeechRun[], pad: number, total: number): SpeechRun[] {
  return runs.map((r, i) => ({
    // Never pad into the neighbouring run, or the same audio gets transcribed twice.
    start: Math.max(i === 0 ? 0 : (runs[i - 1]!.end + r.start) / 2, r.start - pad),
    end: Math.min(i === runs.length - 1 ? total : (r.end + runs[i + 1]!.start) / 2, r.end + pad),
  }));
}

function mergeShortRuns(runs: SpeechRun[], minRun: number, maxRun: number): SpeechRun[] {
  const out: SpeechRun[] = [];
  for (const r of runs) {
    const prev = out[out.length - 1];
    const tooShort = r.end - r.start < minRun;
    if (prev && tooShort && r.end - prev.start <= maxRun) prev.end = r.end;
    else out.push({ ...r });
  }
  return out;
}

/** Split anything past the 30s REST ceiling into equal sub-runs. */
function splitLongRuns(runs: SpeechRun[], maxRun: number): SpeechRun[] {
  const out: SpeechRun[] = [];
  for (const r of runs) {
    const dur = r.end - r.start;
    if (dur <= maxRun) {
      out.push(r);
      continue;
    }
    const parts = Math.ceil(dur / maxRun);
    const step = dur / parts;
    for (let i = 0; i < parts; i++) {
      out.push({ start: r.start + i * step, end: r.start + (i + 1) * step });
    }
  }
  return out;
}

/** Cut one speech run out to its own wav. `-ss` before `-i` for fast seeking. */
export async function sliceAudio(wavPath: string, run: SpeechRun, outWav: string): Promise<string> {
  await fs.mkdir(path.dirname(outWav), { recursive: true });
  await ffmpeg([
    '-ss', run.start.toFixed(3),
    '-t', (run.end - run.start).toFixed(3),
    '-i', wavPath,
    '-ac', '1', '-ar', '16000', '-c:a', 'pcm_s16le',
    outWav,
  ]);
  return outWav;
}

export interface BurnOptions {
  input: string;
  assPath: string;
  fontsDir: string;
  output: string;
  crf?: number;
  preset?: string;
  /** Free-plan watermark. Drawn after the subtitles so captions never cover it. */
  watermark?: { text: string; fontFile: string } | null;
}

export async function burnSubtitles(o: BurnOptions): Promise<string> {
  await fs.mkdir(path.dirname(o.output), { recursive: true });

  const filters = [`ass=${escapeFilterPath(o.assPath)}:fontsdir=${escapeFilterPath(o.fontsDir)}`];
  if (o.watermark) {
    // Sits just inside the top-right safe area, above Instagram's own overlays.
    filters.push(
      [
        `drawtext=fontfile=${escapeFilterPath(o.watermark.fontFile)}`,
        `text=${escapeDrawText(o.watermark.text)}`,
        'fontcolor=white@0.75',
        'fontsize=34',
        'borderw=2',
        'bordercolor=black@0.6',
        'x=w-tw-48',
        'y=180',
      ].join(':'),
    );
  }

  await ffmpeg([
    '-i', o.input,
    '-vf', filters.join(','),
    '-c:v', 'libx264',
    '-crf', String(o.crf ?? 18),
    '-preset', o.preset ?? 'medium',
    '-pix_fmt', 'yuv420p',
    '-c:a', 'copy',
    '-movflags', '+faststart',
    o.output,
  ]);
  return o.output;
}

/**
 * Escape a path for use as a filter option value.
 *
 * ffmpeg parses the -vf string twice: the filtergraph parser splits filters and
 * chains, then the AVOption parser splits `key=value:key=value`. A Windows drive
 * letter has to survive both, so the colon needs *two* backslashes — one is consumed
 * per pass, and a single `\:` gets unescaped to a bare `:` that then splits the
 * option list ("No option name near ...").
 */
/** drawtext has its own escaping rules on top of the filtergraph's. */
function escapeDrawText(text: string): string {
  return text.replace(/\\/g, '\\\\').replace(/'/g, "\\'").replace(/:/g, '\\:').replace(/%/g, '\\%');
}

export function escapeFilterPath(p: string): string {
  return p
    .replace(/\\/g, '/')
    .replace(/:/g, '\\\\:')
    .replace(/'/g, "\\\\'")
    .replace(/\[/g, '\\[')
    .replace(/\]/g, '\\]');
}
