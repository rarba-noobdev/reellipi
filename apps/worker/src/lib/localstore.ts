import fs from 'node:fs/promises';
import path from 'node:path';
import type { Cue } from './subtitles.js';
import type { CaptionStyle } from './captionStyle.js';

/**
 * Filesystem-backed project store for local mode.
 *
 * Lets the whole app run with no Supabase and no Redis — everything lives under
 * `apps/worker/data/`. Single-user by definition; the cloud path in lib/supabase.ts is
 * what handles auth, RLS and multi-tenancy.
 */

export const DATA_DIR = path.resolve('data');

export type LocalStatus =
  | 'uploaded'
  | 'transcribing'
  | 'styling'
  | 'ready_to_render'
  | 'rendering'
  | 'done'
  | 'failed';

export interface LocalProject {
  id: string;
  title: string;
  status: LocalStatus;
  progress: number;
  langMode: string;
  languageCode: string;
  stylePreset: string;
  /** User edits layered over the preset. Empty means "preset as authored". */
  styleOverrides: Partial<CaptionStyle>;
  /**
   * Global caption timing correction, in milliseconds.
   *
   * Word timings are derived from silence detection rather than the STT API, which
   * leaves up to ~300ms of drift. Positive values push captions later.
   */
  timingOffsetMs: number;
  /**
   * Let the LLM regroup cues and place emoji/keyword highlights.
   *
   * Off by default: sarvam-105b spirals on the index arithmetic this needs and most
   * batches fall back, costing time and tokens for a cosmetic gain.
   */
  smartGrouping: boolean;
  /**
   * Fingerprint of the style that produced the current output file.
   *
   * The preview always reflects the live draft while the download reflects the last
   * render, so the two legitimately diverge the moment anything is edited. Recording
   * what was actually burned in lets the UI say so instead of leaving the user to spot
   * the difference themselves.
   */
  renderedStyleKey: string | null;
  durationSeconds: number | null;
  detectedLanguage: string | null;
  timingApproximate: boolean;
  igCaption: string;
  hashtags: string[];
  error: string | null;
  sourceFile: string | null;
  outputFile: string | null;
  createdAt: string;
  updatedAt: string;
}

const projectDir = (id: string) => path.join(DATA_DIR, id);
const metaPath = (id: string) => path.join(projectDir(id), 'project.json');
const cuesPath = (id: string) => path.join(projectDir(id), 'cues.json');

export async function ensureDataDir(): Promise<void> {
  await fs.mkdir(DATA_DIR, { recursive: true });
}

export async function createProject(init: {
  id: string;
  title: string;
  langMode: string;
  languageCode: string;
  stylePreset: string;
  sourceFile: string;
}): Promise<LocalProject> {
  const now = new Date().toISOString();
  const project: LocalProject = {
    id: init.id,
    title: init.title,
    status: 'uploaded',
    progress: 0,
    langMode: init.langMode,
    languageCode: init.languageCode,
    stylePreset: init.stylePreset,
    styleOverrides: {},
    timingOffsetMs: 0,
    smartGrouping: false,
    renderedStyleKey: null,
    durationSeconds: null,
    detectedLanguage: null,
    timingApproximate: true,
    igCaption: '',
    hashtags: [],
    error: null,
    sourceFile: init.sourceFile,
    outputFile: null,
    createdAt: now,
    updatedAt: now,
  };
  await fs.mkdir(projectDir(init.id), { recursive: true });
  await fs.writeFile(metaPath(init.id), JSON.stringify(project, null, 2));
  return project;
}

export async function readProject(id: string): Promise<LocalProject | null> {
  try {
    const raw = JSON.parse(await fs.readFile(metaPath(id), 'utf8')) as LocalProject;
    // Projects written before these fields existed need defaults.
    return {
      ...raw,
      styleOverrides: raw.styleOverrides ?? {},
      timingOffsetMs: raw.timingOffsetMs ?? 0,
      smartGrouping: raw.smartGrouping ?? false,
      renderedStyleKey: raw.renderedStyleKey ?? null,
    };
  } catch {
    return null;
  }
}

export async function patchProject(id: string, patch: Partial<LocalProject>): Promise<LocalProject> {
  const current = await readProject(id);
  if (!current) throw new Error(`Unknown project ${id}`);
  const next = { ...current, ...patch, updatedAt: new Date().toISOString() };
  await fs.writeFile(metaPath(id), JSON.stringify(next, null, 2));
  return next;
}

export async function listProjects(): Promise<LocalProject[]> {
  await ensureDataDir();
  const entries = await fs.readdir(DATA_DIR, { withFileTypes: true });
  const projects: LocalProject[] = [];
  for (const e of entries) {
    if (!e.isDirectory()) continue;
    const p = await readProject(e.name);
    if (p) projects.push(p);
  }
  return projects.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}

export async function writeCues(id: string, cues: Cue[]): Promise<void> {
  await fs.writeFile(cuesPath(id), JSON.stringify(cues, null, 2));
}

export async function readCues(id: string): Promise<Cue[]> {
  try {
    return JSON.parse(await fs.readFile(cuesPath(id), 'utf8')) as Cue[];
  } catch {
    return [];
  }
}

export async function deleteProject(id: string): Promise<void> {
  await fs.rm(projectDir(id), { recursive: true, force: true });
}

/** Resolve a file inside a project, refusing anything that escapes the directory. */
export function resolveProjectFile(id: string, name: string): string {
  const dir = projectDir(id);
  const resolved = path.resolve(dir, name);
  if (!resolved.startsWith(path.resolve(dir) + path.sep)) {
    throw new Error('Path traversal rejected');
  }
  return resolved;
}
