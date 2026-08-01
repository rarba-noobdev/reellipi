import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import fs from 'node:fs/promises';
import path from 'node:path';
import { env, hasSupabase } from './env.js';
import type { Cue } from './subtitles.js';

/**
 * Service-role client. It bypasses RLS, so every query here must scope by user_id
 * explicitly — the database will not do it for us.
 */
let client: SupabaseClient | null = null;

export function supabase(): SupabaseClient {
  if (!hasSupabase) {
    throw new Error('Supabase is not configured (SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY)');
  }
  client ??= createClient(env.supabaseUrl, env.supabaseServiceKey, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
  return client;
}

export const BUCKET_RAW = 'raw';
export const BUCKET_OUT = 'out';

export type ProjectStatus =
  | 'uploaded'
  | 'transcribing'
  | 'styling'
  | 'ready_to_render'
  | 'rendering'
  | 'done'
  | 'failed';

export interface ProjectRow {
  id: string;
  user_id: string;
  title: string | null;
  status: ProjectStatus;
  source_path: string | null;
  audio_path: string | null;
  output_path: string | null;
  lang_mode: string;
  language_code: string | null;
  style_preset: string | null;
  duration_seconds: number | null;
  timing_approximate: boolean;
  ig_caption: string | null;
  hashtags: string[] | null;
  error: string | null;
  progress: number;
  expires_at: string | null;
}

export async function getProject(projectId: string): Promise<ProjectRow> {
  const { data, error } = await supabase().from('projects').select('*').eq('id', projectId).single();
  if (error) throw new Error(`Project ${projectId} not found: ${error.message}`);
  return data as ProjectRow;
}

export async function updateProject(projectId: string, patch: Partial<ProjectRow>): Promise<void> {
  const { error } = await supabase().from('projects').update(patch).eq('id', projectId);
  if (error) throw new Error(`Failed to update project ${projectId}: ${error.message}`);
}

export async function setStatus(
  projectId: string,
  status: ProjectStatus,
  patch: Partial<ProjectRow> = {},
): Promise<void> {
  await updateProject(projectId, { status, ...patch });
}

export async function downloadToFile(bucket: string, objectPath: string, destPath: string): Promise<string> {
  const { data, error } = await supabase().storage.from(bucket).download(objectPath);
  if (error || !data) throw new Error(`Download failed ${bucket}/${objectPath}: ${error?.message}`);
  await fs.mkdir(path.dirname(destPath), { recursive: true });
  await fs.writeFile(destPath, Buffer.from(await data.arrayBuffer()));
  return destPath;
}

export async function uploadFile(
  bucket: string,
  objectPath: string,
  filePath: string,
  contentType: string,
): Promise<string> {
  const body = await fs.readFile(filePath);
  const { error } = await supabase()
    .storage.from(bucket)
    .upload(objectPath, body, { contentType, upsert: true });
  if (error) throw new Error(`Upload failed ${bucket}/${objectPath}: ${error.message}`);
  return objectPath;
}

export async function signedUrl(bucket: string, objectPath: string, expiresIn = 3600): Promise<string> {
  const { data, error } = await supabase().storage.from(bucket).createSignedUrl(objectPath, expiresIn);
  if (error || !data) throw new Error(`Signing failed ${bucket}/${objectPath}: ${error?.message}`);
  return data.signedUrl;
}

export async function replaceCues(projectId: string, cues: Cue[]): Promise<void> {
  const db = supabase();
  const { error: delError } = await db.from('cues').delete().eq('project_id', projectId);
  if (delError) throw new Error(`Failed clearing cues: ${delError.message}`);
  if (cues.length === 0) return;

  const rows = cues.map((c) => ({
    project_id: projectId,
    idx: c.idx,
    start_s: c.start,
    end_s: c.end,
    text: c.lines.join('\n'),
    words: c.words,
    highlight: c.highlight ?? null,
  }));
  const { error } = await db.from('cues').insert(rows);
  if (error) throw new Error(`Failed inserting cues: ${error.message}`);
}

export async function loadCues(projectId: string): Promise<Cue[]> {
  const { data, error } = await supabase()
    .from('cues')
    .select('*')
    .eq('project_id', projectId)
    .order('idx');
  if (error) throw new Error(`Failed loading cues: ${error.message}`);

  return (data ?? []).map((r) => ({
    idx: r.idx as number,
    start: Number(r.start_s),
    end: Number(r.end_s),
    lines: String(r.text).split('\n'),
    words: (r.words ?? []) as Cue['words'],
    highlight: (r.highlight ?? undefined) as string[] | undefined,
  }));
}
