import path from 'node:path';
import { transcribeMedia } from './transcribe.js';
import { styleCues } from './style.js';
import { renderCaptionedVideo } from './render.js';
import {
  listProjects,
  patchProject,
  readCues,
  readProject,
  resolveProjectFile,
  writeCues,
  type LocalProject,
} from '../lib/localstore.js';
import { applyOverrides, resolvePreset } from '../lib/captionStyle.js';
import { shiftCues } from '../lib/subtitles.js';
import type { LangMode } from '../lib/sarvam.js';

/**
 * In-process job runner for local mode.
 *
 * Replaces BullMQ + Redis with a plain FIFO. Concurrency is 1 because ffmpeg saturates
 * the CPU anyway and a single local user has no reason to contend with themselves.
 */
const queue: Array<() => Promise<void>> = [];
let draining = false;

function enqueue(task: () => Promise<void>): void {
  queue.push(task);
  void drain();
}

async function drain(): Promise<void> {
  if (draining) return;
  draining = true;
  try {
    for (;;) {
      const task = queue.shift();
      if (!task) break;
      try {
        await task();
      } catch (e) {
        console.error('[local-queue]', e);
      }
    }
  } finally {
    draining = false;
  }
}

export function queueDepth(): number {
  return queue.length + (draining ? 1 : 0);
}

export type LocalStage =
  /** Transcribe, style, render. */
  | 'full'
  /** Reuse the stored word timings, redo grouping/emoji, then render. */
  | 'restyle'
  /** Reuse the stored cues verbatim and just render. */
  | 'render';

/**
 * Cue segmentation is driven by the resolved style, so changing words-per-cue or the
 * duration bounds regroups on the next restyle rather than needing a fresh transcription.
 */
/**
 * Fingerprint of everything that changes the burned-in output.
 *
 * Stable key order matters: JSON.stringify over an object literal would reorder as
 * fields are added and spuriously invalidate every existing render.
 */
export function styleKey(project: {
  stylePreset: string;
  styleOverrides: Record<string, unknown>;
  timingOffsetMs: number;
  smartGrouping: boolean;
}): string {
  const overrides = Object.keys(project.styleOverrides ?? {})
    .sort()
    .map((k) => `${k}=${String((project.styleOverrides as Record<string, unknown>)[k])}`)
    .join(',');
  return [
    project.stylePreset,
    overrides,
    `offset=${project.timingOffsetMs ?? 0}`,
    `smart=${project.smartGrouping ? 1 : 0}`,
  ].join('|');
}

function cueOptionsFor(project: LocalProject) {
  const style = applyOverrides(resolvePreset(project.stylePreset), project.styleOverrides);
  return {
    maxWordsPerCue: style.maxWordsPerCue,
    maxLines: style.maxLines,
    maxCharsPerLine: style.maxCharsPerLine,
    minDuration: style.minDurationSec,
    maxDuration: style.maxDurationSec,
  };
}

/**
 * Recover projects left mid-flight by a crash or restart.
 *
 * The queue lives in memory, so a worker that dies during a render leaves the project
 * row saying 'rendering' forever with nothing scheduled to finish it. On boot, resume
 * anything that already has cues (cheap: no transcription) and fail the rest with a
 * message rather than leaving them spinning in the UI.
 */
export async function recoverInterruptedProjects(): Promise<number> {
  const busy = ['uploaded', 'transcribing', 'styling', 'rendering'];
  const projects = await listProjects();
  let recovered = 0;

  for (const p of projects.filter((x) => busy.includes(x.status))) {
    const cues = await readCues(p.id);
    if (cues.length > 0 && p.sourceFile) {
      console.warn(`[recover] resuming render for ${p.id.slice(0, 8)} (was ${p.status})`);
      await patchProject(p.id, { status: 'ready_to_render', progress: 65, error: null });
      runLocalProject(p.id, 'render');
    } else {
      console.warn(`[recover] marking ${p.id.slice(0, 8)} failed (was ${p.status}, no cues)`);
      await patchProject(p.id, {
        status: 'failed',
        error: 'Processing was interrupted before it finished. Re-run to try again.',
      });
    }
    recovered++;
  }
  return recovered;
}

export function runLocalProject(projectId: string, stage: LocalStage = 'full'): void {
  enqueue(() => processLocal(projectId, stage));
}

async function processLocal(projectId: string, stage: LocalStage): Promise<void> {
  const project = await readProject(projectId);
  if (!project?.sourceFile) throw new Error(`Project ${projectId} has no source file`);
  const sourcePath = resolveProjectFile(projectId, project.sourceFile);

  try {
    let cues = await readCues(projectId);
    let detectedLanguage = project.detectedLanguage;
    let durationSeconds = project.durationSeconds;
    let igCaption = project.igCaption;
    let hashtags = project.hashtags;

    // 'restyle' and 'render' both reuse the stored transcription; only a missing set of
    // cues forces a fresh STT pass.
    if (stage === 'full' || cues.length === 0) {
      await patchProject(projectId, { status: 'transcribing', progress: 5, error: null });
      const t = await transcribeMedia(sourcePath, {
        mode: (project.langMode as LangMode) ?? 'translit',
        languageCode: project.languageCode || 'unknown',
        onProgress: (done, total) => {
          void patchProject(projectId, { progress: 5 + Math.round((done / total) * 45) }).catch(() => {});
        },
      });
      detectedLanguage = t.languageCode;
      durationSeconds = t.durationSeconds;

      await patchProject(projectId, {
        status: 'styling',
        progress: 55,
        detectedLanguage,
        durationSeconds,
        timingApproximate: !t.stats.apiProvidedTimestamps,
      });

      const styled = await styleCues(t.words, {
        languageCode: t.languageCode,
        mediaDuration: t.durationSeconds,
        groupWithLlm: project.smartGrouping,
        ...cueOptionsFor(project),
      });
      // Styling degrades silently by design; surface it or failures are invisible.
      if (!styled.llmApplied) {
        console.warn(`[style] fell back to deterministic grouping: ${styled.warning}`);
      } else if (styled.warning) {
        console.warn(`[style] ${styled.warning}`);
      }
      cues = styled.cues;
      igCaption = styled.igCaption;
      hashtags = styled.hashtags;
      await writeCues(projectId, cues);
      await patchProject(projectId, {
        status: 'ready_to_render',
        progress: 65,
        igCaption,
        hashtags,
      });
    }

    /*
     * Re-group without re-transcribing. The stored cues already hold every timed word,
     * so toggling smart grouping or emoji costs one LLM pass rather than a fresh STT
     * run over the whole clip.
     */
    if (stage === 'restyle' && cues.length > 0) {
      await patchProject(projectId, { status: 'styling', progress: 40 });
      const words = cues.flatMap((c) => c.words);
      const styled = await styleCues(words, {
        languageCode: detectedLanguage,
        mediaDuration: durationSeconds ?? undefined,
        groupWithLlm: project.smartGrouping,
        ...cueOptionsFor(project),
      });
      if (!styled.llmApplied) {
        console.warn(`[style] restyle fell back: ${styled.warning}`);
      }
      cues = styled.cues;
      igCaption = styled.igCaption || igCaption;
      hashtags = styled.hashtags.length ? styled.hashtags : hashtags;
      await writeCues(projectId, cues);
      await patchProject(projectId, { igCaption, hashtags, progress: 60 });
    }

    if (cues.length === 0) throw new Error('No speech detected in this clip');

    await patchProject(projectId, { status: 'rendering', progress: 70 });
    const outputPath = resolveProjectFile(projectId, 'out.mp4');

    // Drift correction is applied at render time only; the stored cues stay canonical
    // so the offset can be re-adjusted later without compounding.
    const shifted = shiftCues(cues, (project.timingOffsetMs ?? 0) / 1000, durationSeconds ?? undefined);

    const result = await renderCaptionedVideo({
      inputPath: sourcePath,
      cues: shifted,
      outputPath,
      presetId: project.stylePreset || 'karaoke_bold',
      styleOverrides: project.styleOverrides,
      languageCode: detectedLanguage,
      artifactDir: path.dirname(outputPath),
    });

    await patchProject(projectId, {
      status: 'done',
      progress: 100,
      // Record exactly what was burned in, so the UI can tell when the download has
      // fallen behind the draft the user is looking at.
      renderedStyleKey: styleKey(project),
      outputFile: path.basename(result.outputPath),
      durationSeconds: result.durationSeconds,
      error: null,
    });
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    await patchProject(projectId, { status: 'failed', error: message.slice(0, 1000) }).catch(() => {});
    throw e;
  }
}
