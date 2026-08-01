import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { detectSpeechRuns, extractAudio, probe, sliceAudio, type SpeechRun } from '../lib/ffmpeg.js';
import { distributeWords, mergeTimelines, type TimedWord } from '../lib/align.js';
import { sttCostInr, transcribeChunk, type LangMode } from '../lib/sarvam.js';

export interface TranscribeOptions {
  mode?: LangMode;
  languageCode?: string;
  /** Parallel Sarvam calls. The rate limiter is the real ceiling; this bounds memory. */
  concurrency?: number;
  onProgress?: (done: number, total: number) => void;
}

export interface RunTranscript extends SpeechRun {
  index: number;
  transcript: string;
  languageCode: string | null;
  words: TimedWord[];
}

export interface TranscribeResult {
  durationSeconds: number;
  width: number;
  height: number;
  languageCode: string | null;
  runs: RunTranscript[];
  words: TimedWord[];
  fullText: string;
  stats: {
    runCount: number;
    speechSeconds: number;
    billedSeconds: number;
    estimatedCostInr: number;
    /** True if the API ever returned usable multi-entry timestamps (it does not today). */
    apiProvidedTimestamps: boolean;
  };
}

export async function transcribeMedia(
  inputPath: string,
  opts: TranscribeOptions = {},
): Promise<TranscribeResult> {
  const mode = opts.mode ?? 'translit';
  const languageCode = opts.languageCode ?? 'unknown';
  const concurrency = opts.concurrency ?? 4;

  const workDir = await fs.mkdtemp(path.join(os.tmpdir(), 'reellipi-'));
  try {
    const meta = await probe(inputPath);
    if (!meta.hasAudio) throw new Error('Input has no audio track');

    const wav = await extractAudio(inputPath, path.join(workDir, 'audio.wav'));
    const runs = await detectSpeechRuns(wav, meta.durationSeconds);
    if (runs.length === 0) throw new Error('No speech detected in audio');

    const results: RunTranscript[] = new Array(runs.length);
    let completed = 0;
    let apiProvidedTimestamps = false;
    let cursor = 0;

    const workers = Array.from({ length: Math.min(concurrency, runs.length) }, async () => {
      for (;;) {
        const i = cursor++;
        const run = runs[i];
        if (!run) return;

        const chunkPath = path.join(workDir, `chunk-${String(i).padStart(3, '0')}.wav`);
        await sliceAudio(wav, run, chunkPath);
        const res = await transcribeChunk(chunkPath, { mode, languageCode });
        await fs.rm(chunkPath, { force: true });

        // Watch for the API growing real timestamp support; until then this stays false.
        if ((res.timestamps?.words?.length ?? 0) > 1) apiProvidedTimestamps = true;

        const transcript = (res.transcript ?? '').trim();
        results[i] = {
          index: i,
          start: run.start,
          end: run.end,
          transcript,
          languageCode: res.language_code ?? null,
          words: transcript ? distributeWords(transcript, run.start, run.end) : [],
        };
        opts.onProgress?.(++completed, runs.length);
      }
    });
    await Promise.all(workers);

    const ordered = results.filter(Boolean);
    const words = mergeTimelines(ordered.map((r) => r.words));
    const speechSeconds = runs.reduce((a, r) => a + (r.end - r.start), 0);
    const billedSeconds = runs.reduce((a, r) => a + Math.ceil(r.end - r.start), 0);

    return {
      durationSeconds: meta.durationSeconds,
      width: meta.width,
      height: meta.height,
      languageCode: ordered.find((r) => r.languageCode)?.languageCode ?? null,
      runs: ordered,
      words,
      fullText: ordered.map((r) => r.transcript).filter(Boolean).join(' '),
      stats: {
        runCount: runs.length,
        speechSeconds: Math.round(speechSeconds * 100) / 100,
        billedSeconds,
        estimatedCostInr: Math.round(sttCostInr(billedSeconds) * 10000) / 10000,
        apiProvidedTimestamps,
      },
    };
  } finally {
    await fs.rm(workDir, { recursive: true, force: true });
  }
}
