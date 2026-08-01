import { env } from '../lib/env.js';
import { BUCKET_OUT, BUCKET_RAW, supabase } from '../lib/supabase.js';

/**
 * DPDP retention sweep.
 *
 * Source video, extracted audio, rendered output and the transcript are all personal
 * data under DPDPA 2023, so they are purged once the project's retention window closes.
 * The project row is kept (minus its content) so the user still sees their history.
 */
export async function purgeExpiredProjects(): Promise<{ scanned: number; purged: number }> {
  const db = supabase();
  const { data, error } = await db
    .from('projects')
    .select('id, user_id, source_path, audio_path, output_path')
    .lt('expires_at', new Date().toISOString())
    .not('source_path', 'is', null)
    .limit(200);

  if (error) throw new Error(`Retention scan failed: ${error.message}`);
  const rows = data ?? [];
  let purged = 0;

  for (const row of rows) {
    const rawPaths = [row.source_path, row.audio_path].filter(Boolean) as string[];
    const base = String(row.output_path ?? '').replace(/\.mp4$/, '');
    const outPaths = row.output_path ? [row.output_path, `${base}.srt`, `${base}.vtt`] : [];

    if (rawPaths.length) await db.storage.from(BUCKET_RAW).remove(rawPaths);
    if (outPaths.length) await db.storage.from(BUCKET_OUT).remove(outPaths);

    // Cues cascade from the project, but they hold transcript text, so drop them first.
    await db.from('cues').delete().eq('project_id', row.id);
    await db
      .from('projects')
      .update({
        source_path: null,
        audio_path: null,
        output_path: null,
        ig_caption: null,
        hashtags: null,
        expires_at: null,
        status: 'failed',
        error: `Files removed after ${env.retentionDays}-day retention window.`,
      })
      .eq('id', row.id);
    purged++;
  }

  return { scanned: rows.length, purged };
}

/** Delete everything belonging to a user — backs the "delete my data" request. */
export async function deleteAllUserData(userId: string): Promise<void> {
  const db = supabase();
  const { data } = await db.from('projects').select('id, source_path, output_path').eq('user_id', userId);

  const rawPaths: string[] = [];
  const outPaths: string[] = [];
  for (const row of data ?? []) {
    if (row.source_path) rawPaths.push(row.source_path);
    if (row.output_path) {
      const base = String(row.output_path).replace(/\.mp4$/, '');
      outPaths.push(row.output_path, `${base}.srt`, `${base}.vtt`);
    }
  }
  if (rawPaths.length) await db.storage.from(BUCKET_RAW).remove(rawPaths);
  if (outPaths.length) await db.storage.from(BUCKET_OUT).remove(outPaths);
  // cues cascade via the projects foreign key.
  await db.from('projects').delete().eq('user_id', userId);
}
