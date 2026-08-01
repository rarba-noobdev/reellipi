import { createClient } from '@supabase/supabase-js';

const url = import.meta.env.VITE_SUPABASE_URL as string | undefined;
const anonKey = import.meta.env.VITE_SUPABASE_ANON_KEY as string | undefined;

/**
 * Absent config is the normal case in local mode, where this client is never used —
 * the worker reports mode:'local' and the app routes to the filesystem API instead.
 * Only warn if someone explicitly asked for cloud mode.
 */
if ((!url || !anonKey) && import.meta.env.VITE_FORCE_CLOUD === '1') {
  console.warn('VITE_SUPABASE_URL / VITE_SUPABASE_ANON_KEY are not set — cloud mode will fail.');
}

export const supabase = createClient(url ?? 'http://localhost', anonKey ?? 'anon');

export const BUCKET_RAW = 'raw';

export async function accessToken(): Promise<string | null> {
  const { data } = await supabase.auth.getSession();
  return data.session?.access_token ?? null;
}
