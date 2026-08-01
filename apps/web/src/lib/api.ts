import { accessToken, supabase, BUCKET_RAW } from './supabase';
import type { Cue, LangMode, Project } from './types';
import type { CaptionStyle, FontChoice } from './captionStyle';

const API_BASE = (import.meta.env.VITE_API_BASE as string | undefined) ?? 'http://localhost:8787';

async function authedFetch(path: string, init: RequestInit = {}): Promise<Response> {
  const token = await accessToken();
  if (!token) throw new Error('Not signed in');
  const res = await fetch(`${API_BASE}${path}`, {
    ...init,
    headers: {
      ...(init.headers ?? {}),
      Authorization: `Bearer ${token}`,
      ...(init.body ? { 'Content-Type': 'application/json' } : {}),
    },
  });
  if (!res.ok) {
    const body = await res.text();
    let parsed: { error?: string } = {};
    try {
      parsed = JSON.parse(body);
    } catch {
      /* keep the raw body */
    }
    throw Object.assign(new Error(parsed.error ?? body ?? res.statusText), { status: res.status });
  }
  return res;
}

export async function listPresets(): Promise<{ presets: CaptionStyle[]; fonts: FontChoice[] }> {
  const res = await fetch(`${API_BASE}/presets`);
  if (!res.ok) throw new Error('Failed to load presets');
  return res.json();
}

export async function listProjects(): Promise<Project[]> {
  const { data, error } = await supabase
    .from('projects')
    .select('*')
    .order('created_at', { ascending: false })
    .limit(50);
  if (error) throw new Error(error.message);
  return (data ?? []) as Project[];
}

export async function getProject(id: string): Promise<Project> {
  const { data, error } = await supabase.from('projects').select('*').eq('id', id).single();
  if (error) throw new Error(error.message);
  return data as Project;
}

export async function getCues(projectId: string): Promise<Cue[]> {
  const { data, error } = await supabase
    .from('cues')
    .select('*')
    .eq('project_id', projectId)
    .order('idx');
  if (error) throw new Error(error.message);
  return (data ?? []).map((r) => ({
    idx: r.idx,
    start: Number(r.start_s),
    end: Number(r.end_s),
    lines: String(r.text).split('\n'),
    words: (r.words ?? []) as Cue['words'],
    highlight: r.highlight ?? undefined,
  }));
}

/**
 * Edits change the displayed text only. `words` keeps its original start/end values so
 * the karaoke timing and the burned-in render stay locked to the audio.
 */
export async function updateCueText(cueId: number, lines: string[], words: Cue['words']): Promise<void> {
  const { error } = await supabase
    .from('cues')
    .update({ text: lines.join('\n'), words })
    .eq('id', cueId);
  if (error) throw new Error(error.message);
}

export async function saveCue(projectId: string, cue: Cue): Promise<void> {
  const { error } = await supabase
    .from('cues')
    .update({ text: cue.lines.join('\n'), words: cue.words })
    .eq('project_id', projectId)
    .eq('idx', cue.idx);
  if (error) throw new Error(error.message);
}

export interface UploadResult {
  projectId: string;
  path: string;
}

/** Upload straight to Storage, then create the row that the worker will pick up. */
export async function uploadReel(
  file: File,
  opts: { langMode: LangMode; languageCode: string; stylePreset: string; onProgress?: (pct: number) => void },
): Promise<UploadResult> {
  const { data: userData } = await supabase.auth.getUser();
  const userId = userData.user?.id;
  if (!userId) throw new Error('Not signed in');

  const projectId = crypto.randomUUID();
  const ext = file.name.split('.').pop()?.toLowerCase() ?? 'mp4';
  const objectPath = `${userId}/${projectId}.${ext}`;

  opts.onProgress?.(10);
  const { error: uploadError } = await supabase.storage
    .from(BUCKET_RAW)
    .upload(objectPath, file, { contentType: file.type || 'video/mp4', upsert: false });
  if (uploadError) throw new Error(`Upload failed: ${uploadError.message}`);
  opts.onProgress?.(70);

  const { error: insertError } = await supabase.from('projects').insert({
    id: projectId,
    user_id: userId,
    title: file.name.replace(/\.[^.]+$/, ''),
    status: 'uploaded',
    source_path: objectPath,
    lang_mode: opts.langMode,
    language_code: opts.languageCode,
    style_preset: opts.stylePreset,
  });
  if (insertError) throw new Error(`Could not create project: ${insertError.message}`);
  opts.onProgress?.(100);

  return { projectId, path: objectPath };
}

export interface ProcessResponse {
  jobId: string;
  status: string;
  used: number;
  limit: number;
}

export async function processProject(
  projectId: string,
  body: { stage?: 'full' | 'render'; stylePreset?: string; langMode?: LangMode } = {},
): Promise<ProcessResponse> {
  const res = await authedFetch(`/projects/${projectId}/process`, {
    method: 'POST',
    body: JSON.stringify(body),
  });
  return res.json();
}

export async function getDownloads(projectId: string): Promise<{
  project: Project;
  downloads: { mp4?: string; srt?: string; vtt?: string };
}> {
  const res = await authedFetch(`/projects/${projectId}`);
  return res.json();
}

/** Signed URL for the uploaded source, used by the preview player. */
export async function sourceUrl(path: string): Promise<string> {
  const { data, error } = await supabase.storage.from(BUCKET_RAW).createSignedUrl(path, 3600);
  if (error || !data) throw new Error(error?.message ?? 'Could not sign source URL');
  return data.signedUrl;
}
