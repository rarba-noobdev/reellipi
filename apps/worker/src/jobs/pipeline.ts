import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { env } from '../lib/env.js';
import {
  BUCKET_OUT,
  BUCKET_RAW,
  downloadToFile,
  getProject,
  loadCues,
  replaceCues,
  setStatus,
  supabase,
  updateProject,
  uploadFile,
} from '../lib/supabase.js';
import { planFor } from '../lib/plans.js';
import { transcribeMedia } from './transcribe.js';
import { styleCues } from './style.js';
import { renderCaptionedVideo } from './render.js';
import type { LangMode } from '../lib/sarvam.js';

export interface PipelineJob {
  projectId: string;
  /** 'full' runs transcribe -> style -> render. 'render' reuses stored cues. */
  stage?: 'full' | 'render';
}

/**
 * End-to-end project processing. Each stage writes its status back to Postgres so the
 * SPA's Realtime subscription can follow along, and any throw is recorded on the row
 * rather than left to a silent retry.
 */
export async function runPipeline(job: PipelineJob): Promise<void> {
  const project = await getProject(job.projectId);
  const workDir = await fs.mkdtemp(path.join(os.tmpdir(), `reellipi-${project.id}-`));

  try {
    if (!project.source_path) throw new Error('Project has no source_path');

    const localSource = path.join(workDir, `source${path.extname(project.source_path) || '.mp4'}`);
    await downloadToFile(BUCKET_RAW, project.source_path, localSource);

    let cues = await loadCues(project.id);
    let languageCode = project.language_code ?? null;
    let durationSeconds = project.duration_seconds ?? undefined;
    let igCaption = project.ig_caption ?? '';
    let hashtags = project.hashtags ?? [];

    if (job.stage !== 'render' || cues.length === 0) {
      await setStatus(project.id, 'transcribing', { progress: 5 });
      const t = await transcribeMedia(localSource, {
        mode: (project.lang_mode as LangMode) ?? 'translit',
        languageCode: project.language_code ?? 'unknown',
        onProgress: (done, total) =>
          void updateProject(project.id, { progress: 5 + Math.round((done / total) * 45) }).catch(() => {}),
      });
      languageCode = t.languageCode;
      durationSeconds = t.durationSeconds;

      await setStatus(project.id, 'styling', { progress: 55 });
      const styled = await styleCues(t.words, {
        languageCode: t.languageCode,
        mediaDuration: t.durationSeconds,
      });
      if (!styled.llmApplied) {
        console.warn(`[style] fell back to deterministic grouping: ${styled.warning}`);
      } else if (styled.warning) {
        console.warn(`[style] ${styled.warning}`);
      }
      cues = styled.cues;
      igCaption = styled.igCaption;
      hashtags = styled.hashtags;

      await replaceCues(project.id, cues);
      await updateProject(project.id, {
        language_code: languageCode,
        duration_seconds: durationSeconds,
        // Sarvam returns no word-level timings, so this is always true today.
        timing_approximate: !t.stats.apiProvidedTimestamps,
        ig_caption: igCaption,
        hashtags,
        status: 'ready_to_render',
        progress: 65,
      });
    }

    if (cues.length === 0) throw new Error('No cues to render — is there speech in this clip?');

    await setStatus(project.id, 'rendering', { progress: 70 });

    // The owner's plan at render time decides branding, not the plan at upload time.
    const { data: profile } = await supabase()
      .from('profiles')
      .select('plan')
      .eq('id', project.user_id)
      .single();
    const plan = planFor(profile?.plan);

    const outputLocal = path.join(workDir, 'out.mp4');
    const result = await renderCaptionedVideo({
      inputPath: localSource,
      cues,
      outputPath: outputLocal,
      presetId: project.style_preset ?? 'karaoke_bold',
      languageCode,
      watermarkText: plan.watermark ? 'ReelLipi' : null,
    });

    const outObject = `${project.user_id}/${project.id}.mp4`;
    await uploadFile(BUCKET_OUT, outObject, result.outputPath, 'video/mp4');
    await uploadFile(BUCKET_OUT, `${project.user_id}/${project.id}.srt`, result.srtPath, 'text/plain');
    await uploadFile(BUCKET_OUT, `${project.user_id}/${project.id}.vtt`, result.vttPath, 'text/vtt');

    const expiresAt = new Date(Date.now() + env.retentionDays * 86_400_000).toISOString();
    await updateProject(project.id, {
      status: 'done',
      progress: 100,
      output_path: outObject,
      duration_seconds: result.durationSeconds,
      error: null,
      expires_at: expiresAt,
    });
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    await setStatus(job.projectId, 'failed', { error: message.slice(0, 1000) }).catch(() => {});
    throw e;
  } finally {
    await fs.rm(workDir, { recursive: true, force: true });
  }
}
