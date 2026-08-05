import type { Cue, LangMode } from './types';
import type { CaptionStyle, FontChoice } from './captionStyle';

/**
 * Local-mode client: talks to the worker's /local routes, which are backed by the
 * filesystem rather than Supabase. No auth, single user.
 */

const API_BASE = (import.meta.env.VITE_API_BASE as string | undefined) ?? 'http://localhost:8787';

export interface LocalProject {
  id: string;
  title: string;
  status: 'uploaded' | 'transcribing' | 'styling' | 'ready_to_render' | 'rendering' | 'done' | 'failed';
  progress: number;
  langMode: string;
  languageCode: string;
  stylePreset: string;
  styleOverrides: Partial<CaptionStyle>;
  timingOffsetMs: number;
  smartGrouping: boolean;
  /** Fingerprint of the style that produced the current output file. */
  renderedStyleKey: string | null;
  captionLanguage: string | null;
  durationSeconds: number | null;
  detectedLanguage: string | null;
  timingApproximate: boolean;
  igCaption: string;
  hashtags: string[];
  error: string | null;
  sourceFile: string | null;
  outputFile: string | null;
  createdAt: string;
}

async function json<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(`${API_BASE}${path}`, init);
  if (!res.ok) {
    let message = res.statusText;
    try {
      message = ((await res.json()) as { error?: string }).error ?? message;
    } catch {
      /* keep statusText */
    }
    throw new Error(message);
  }
  return res.json() as Promise<T>;
}

export async function serverMode(): Promise<'local' | 'cloud'> {
  try {
    const h = await json<{ mode?: string }>('/health');
    return h.mode === 'local' ? 'local' : 'cloud';
  } catch {
    return 'cloud';
  }
}

export interface PresetsResponse {
  presets: CaptionStyle[];
  fonts: FontChoice[];
  safeArea: { topPct: number; bottomPct: number; sidePct: number };
}

export function listPresets(): Promise<PresetsResponse> {
  return json('/presets');
}

export function listLocalProjects(): Promise<{ projects: LocalProject[]; queueDepth: number }> {
  return json('/local/projects');
}

export function getLocalProject(id: string): Promise<{ project: LocalProject; cues: Cue[] }> {
  return json(`/local/projects/${id}`);
}

export function uploadLocal(
  file: File,
  opts: { langMode: LangMode; languageCode: string; stylePreset: string; onProgress?: (pct: number) => void },
): Promise<{ project: LocalProject }> {
  const form = new FormData();
  form.append('langMode', opts.langMode);
  form.append('languageCode', opts.languageCode);
  form.append('stylePreset', opts.stylePreset);
  form.append('file', file);

  // XHR rather than fetch: fetch cannot report upload progress, and these are big files.
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open('POST', `${API_BASE}/local/projects`);
    xhr.upload.onprogress = (e) => {
      if (e.lengthComputable) opts.onProgress?.(Math.round((e.loaded / e.total) * 100));
    };
    xhr.onload = () => {
      if (xhr.status >= 200 && xhr.status < 300) {
        resolve(JSON.parse(xhr.responseText));
      } else {
        let message = `Upload failed (${xhr.status})`;
        try {
          message = JSON.parse(xhr.responseText).error ?? message;
        } catch {
          /* keep default */
        }
        reject(new Error(message));
      }
    };
    xhr.onerror = () => reject(new Error('Upload failed — is the worker running?'));
    xhr.send(form);
  });
}

export function rerenderLocal(
  id: string,
  body: {
    stylePreset?: string;
    styleOverrides?: Partial<CaptionStyle>;
    timingOffsetMs?: number;
    smartGrouping?: boolean;
    regroup?: boolean;
    captionLanguage?: string | null;
  },
): Promise<{ ok: boolean; stage?: string }> {
  return json(`/local/projects/${id}/render`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
}

export function saveLocalCues(id: string, cues: Cue[]): Promise<{ ok: boolean; cues: Cue[] }> {
  return json(`/local/projects/${id}/cues`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ cues }),
  });
}

export function deleteLocalProject(id: string): Promise<{ ok: boolean }> {
  return json(`/local/projects/${id}`, { method: 'DELETE' });
}

export interface TranslateTarget {
  code: string;
  label: string;
  native: string;
  romanised?: boolean;
}

export function listLanguages(
  id: string,
): Promise<{ available: string[]; targets: TranslateTarget[] }> {
  return json(`/local/projects/${id}/languages`);
}

export function translateProject(
  id: string,
  target: string,
): Promise<{ ok: boolean; target: string; translated: number; failed: number; languages: string[] }> {
  return json(`/local/projects/${id}/translate`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ target }),
  });
}

export interface VideoPalette {
  dominant: string[];
  bandLuminance: number;
  suggestion: {
    textColor: string;
    accentColor: string;
    keywordColor: string;
    outlineColor: string;
  };
}

export function getPalette(id: string): Promise<VideoPalette> {
  return json(`/local/projects/${id}/palette`);
}

export function localFileUrl(id: string, name: string, download = false): string {
  return `${API_BASE}/local/projects/${id}/file/${encodeURIComponent(name)}${download ? '?download=1' : ''}`;
}
