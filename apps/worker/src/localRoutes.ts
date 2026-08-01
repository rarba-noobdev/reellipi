import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { Router, type Request, type Response } from 'express';
import multer from 'multer';
import { applyOverrides, PRESETS, resolvePreset } from './lib/captionStyle.js';
import { analysePalette } from './lib/palette.js';
import {
  DATA_DIR,
  createProject,
  deleteProject,
  ensureDataDir,
  listProjects,
  patchProject,
  readCues,
  readProject,
  resolveProjectFile,
  writeCues,
} from './lib/localstore.js';
import { queueDepth, runLocalProject } from './jobs/localPipeline.js';
import type { Cue } from './lib/subtitles.js';

/**
 * Local-mode API: no auth, no Supabase, no Redis. Everything is keyed off the
 * filesystem under apps/worker/data/. Intended for single-user local use.
 */

const upload = multer({
  storage: multer.diskStorage({
    destination: (req, _file, cb) => {
      const id = (req as Request & { projectId?: string }).projectId!;
      const dir = path.join(DATA_DIR, id);
      fs.mkdirSync(dir, { recursive: true });
      cb(null, dir);
    },
    filename: (_req, file, cb) => cb(null, `source${path.extname(file.originalname) || '.mp4'}`),
  }),
  limits: { fileSize: 500 * 1024 * 1024 },
  fileFilter: (_req, file, cb) => {
    if (!file.mimetype.startsWith('video/')) return cb(new Error('Only video files are accepted'));
    cb(null, true);
  },
});

const asyncRoute =
  (fn: (req: Request, res: Response) => Promise<unknown>) =>
  (req: Request, res: Response, next: (e?: unknown) => void) => {
    fn(req, res).catch(next);
  };

export function localRouter(): Router {
  const router = Router();

  router.get(
    '/projects',
    asyncRoute(async (_req, res) => {
      res.json({ projects: await listProjects(), queueDepth: queueDepth() });
    }),
  );

  // Assign the id before multer runs so the upload lands in its final directory.
  router.post(
    '/projects',
    (req, _res, next) => {
      (req as Request & { projectId?: string }).projectId = crypto.randomUUID();
      next();
    },
    upload.single('file'),
    asyncRoute(async (req, res) => {
      const id = (req as Request & { projectId?: string }).projectId!;
      if (!req.file) {
        res.status(400).json({ error: 'No file uploaded' });
        return;
      }
      const body = req.body as Record<string, string>;
      const project = await createProject({
        id,
        title: (req.file.originalname || 'reel').replace(/\.[^.]+$/, ''),
        langMode: body.langMode || 'translit',
        languageCode: body.languageCode || 'unknown',
        stylePreset: PRESETS[body.stylePreset ?? ''] ? body.stylePreset! : 'karaoke_bold',
        sourceFile: req.file.filename,
      });
      runLocalProject(id, 'full');
      res.json({ project });
    }),
  );

  router.get(
    '/projects/:id',
    asyncRoute(async (req, res) => {
      const project = await readProject(req.params.id!);
      if (!project) {
        res.status(404).json({ error: 'Not found' });
        return;
      }
      res.json({ project, cues: await readCues(project.id) });
    }),
  );

  /** Re-render with a different style. Reuses stored cues, so no new STT spend. */
  router.post(
    '/projects/:id/render',
    asyncRoute(async (req, res) => {
      const project = await readProject(req.params.id!);
      if (!project) {
        res.status(404).json({ error: 'Not found' });
        return;
      }
      const body = req.body as {
        stylePreset?: string;
        styleOverrides?: Record<string, unknown>;
        timingOffsetMs?: number;
        smartGrouping?: boolean;
        /** Set when a grouping field changed and the cues must be rebuilt. */
        regroup?: boolean;
      };
      const patch: Record<string, unknown> = {};
      if (body.stylePreset && PRESETS[body.stylePreset]) patch.stylePreset = body.stylePreset;
      if (typeof body.timingOffsetMs === 'number' && Number.isFinite(body.timingOffsetMs)) {
        patch.timingOffsetMs = Math.max(-5000, Math.min(5000, Math.round(body.timingOffsetMs)));
      }

      // Changing grouping needs the cues rebuilt, not just a re-render.
      const groupingChanged =
        typeof body.smartGrouping === 'boolean' && body.smartGrouping !== project.smartGrouping;
      if (typeof body.smartGrouping === 'boolean') patch.smartGrouping = body.smartGrouping;
      // Switching preset discards prior overrides — otherwise the new preset arrives
      // wearing the old one's colours and the picker appears not to work.
      if (body.styleOverrides !== undefined) patch.styleOverrides = body.styleOverrides ?? {};
      else if (patch.stylePreset) patch.styleOverrides = {};

      if (Object.keys(patch).length) await patchProject(project.id, patch);
      const stage = groupingChanged || body.regroup ? 'restyle' : 'render';
      runLocalProject(project.id, stage);
      res.json({ ok: true, stage });
    }),
  );

  /** Persist a transcript edit. Timings are taken from the stored cues, never the client. */
  router.put(
    '/projects/:id/cues',
    asyncRoute(async (req, res) => {
      const project = await readProject(req.params.id!);
      if (!project) {
        res.status(404).json({ error: 'Not found' });
        return;
      }
      const incoming = (req.body as { cues?: Cue[] })?.cues;
      if (!Array.isArray(incoming)) {
        res.status(400).json({ error: 'Expected { cues: [...] }' });
        return;
      }
      const stored = await readCues(project.id);
      const byIdx = new Map(stored.map((c) => [c.idx, c]));

      // Only text may change. Start/end come from the stored cue so a client cannot
      // desynchronise the captions from the audio.
      const merged = incoming.map((edit) => {
        const original = byIdx.get(edit.idx);
        if (!original) return edit;
        return {
          ...original,
          lines: edit.lines,
          words: original.words.map((w, i) => ({ ...w, w: edit.words[i]?.w ?? w.w })),
        };
      });
      await writeCues(project.id, merged);
      res.json({ ok: true, cues: merged });
    }),
  );

  router.delete(
    '/projects/:id',
    asyncRoute(async (req, res) => {
      await deleteProject(req.params.id!);
      res.json({ ok: true });
    }),
  );

  /** Suggest caption colours sampled from the video itself. */
  router.get(
    '/projects/:id/palette',
    asyncRoute(async (req, res) => {
      const project = await readProject(req.params.id!);
      if (!project?.sourceFile) {
        res.status(404).json({ error: 'Not found' });
        return;
      }
      const source = resolveProjectFile(project.id, project.sourceFile);
      const style = applyOverrides(resolvePreset(project.stylePreset), project.styleOverrides);
      // Sample the band the captions actually sit in, not the whole frame.
      const palette = await analysePalette(source, {
        top: Math.max(0, style.positionY - 0.15),
        height: 0.3,
      });
      res.json(palette);
    }),
  );

  /** Stream source or output video. Range requests keep <video> seeking responsive. */
  router.get(
    '/projects/:id/file/:name',
    asyncRoute(async (req, res) => {
      const filePath = resolveProjectFile(req.params.id!, req.params.name!);
      const stat = await fs.promises.stat(filePath).catch(() => null);
      if (!stat) {
        res.status(404).json({ error: 'Not found' });
        return;
      }

      const ext = path.extname(filePath).toLowerCase();
      const contentType =
        ext === '.mp4' ? 'video/mp4' : ext === '.vtt' ? 'text/vtt' : ext === '.srt' ? 'application/x-subrip' : 'application/octet-stream';

      /**
       * Pipe with explicit teardown. A <video> element opens several ranged requests
       * and aborts most of them while seeking; without this the orphaned read stream
       * stays open and an unhandled 'error' on it takes the process down, which the
       * browser sees as ERR_CONNECTION_RESET on every subsequent request.
       */
      const pipe = (stream: fs.ReadStream) => {
        stream.on('error', (err) => {
          console.error('[file] read failed', err);
          if (!res.headersSent) res.status(500).end();
          else res.destroy();
        });
        res.on('close', () => stream.destroy());
        stream.pipe(res);
      };

      res.setHeader('Accept-Ranges', 'bytes');
      if (req.query.download) {
        res.setHeader('Content-Disposition', `attachment; filename="${path.basename(filePath)}"`);
      }

      const range = req.headers.range;
      if (range && contentType === 'video/mp4') {
        const match = /bytes=(\d*)-(\d*)/.exec(range);
        const start = Math.min(Number(match?.[1] || 0), Math.max(0, stat.size - 1));
        const end = Math.min(match?.[2] ? Number(match[2]) : stat.size - 1, stat.size - 1);
        if (start > end) {
          res.status(416).setHeader('Content-Range', `bytes */${stat.size}`);
          res.end();
          return;
        }
        res.writeHead(206, {
          'Content-Range': `bytes ${start}-${end}/${stat.size}`,
          'Accept-Ranges': 'bytes',
          'Content-Length': end - start + 1,
          'Content-Type': contentType,
        });
        pipe(fs.createReadStream(filePath, { start, end }));
        return;
      }

      res.setHeader('Content-Type', contentType);
      res.setHeader('Content-Length', stat.size);
      pipe(fs.createReadStream(filePath));
    }),
  );

  void ensureDataDir();
  return router;
}
