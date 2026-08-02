import crypto from 'node:crypto';
import cors from 'cors';
import express, { type NextFunction, type Request, type Response } from 'express';
import { env, hasSupabase } from './lib/env.js';
import { FONT_CHOICES, PRESETS } from './lib/captionStyle.js';
import { SAFE_AREA } from './lib/ass.js';
import { planFor, periodExpired, PLANS } from './lib/plans.js';
import { getProject, signedUrl, supabase, updateProject, BUCKET_OUT } from './lib/supabase.js';
import { deleteAllUserData, purgeExpiredProjects } from './jobs/retention.js';
import { localRouter } from './localRoutes.js';
import { recoverInterruptedProjects } from './jobs/localPipeline.js';

/**
 * With no Supabase configured we run single-user off the filesystem, with an in-process
 * job queue instead of Redis. That makes the app usable immediately with only a Sarvam
 * key; the cloud path is what adds auth, multi-tenancy and billing.
 */
const LOCAL_MODE = !hasSupabase;

const app = express();
app.use(cors());

// Razorpay signs the raw body, so the webhook must see bytes, not a parsed object.
app.use('/webhooks/razorpay', express.raw({ type: '*/*' }));
app.use(express.json({ limit: '1mb' }));

interface AuthedRequest extends Request {
  userId?: string;
}

/** Verify the caller's Supabase access token and pin the user id onto the request. */
async function requireAuth(req: AuthedRequest, res: Response, next: NextFunction): Promise<void> {
  const header = req.header('authorization') ?? '';
  const token = header.startsWith('Bearer ') ? header.slice(7) : null;
  if (!token) {
    res.status(401).json({ error: 'Missing bearer token' });
    return;
  }
  const { data, error } = await supabase().auth.getUser(token);
  if (error || !data.user) {
    res.status(401).json({ error: 'Invalid token' });
    return;
  }
  req.userId = data.user.id;
  next();
}

/** The service role bypasses RLS, so ownership must be checked in code. */
async function requireOwnedProject(req: AuthedRequest, res: Response) {
  const project = await getProject(String(req.params.id));
  if (project.user_id !== req.userId) {
    res.status(404).json({ error: 'Not found' });
    return null;
  }
  return project;
}

const asyncRoute =
  (fn: (req: AuthedRequest, res: Response) => Promise<unknown>) =>
  (req: Request, res: Response, next: NextFunction) => {
    fn(req as AuthedRequest, res).catch(next);
  };

app.get('/health', (_req, res) => {
  res.json({
    ok: true,
    mode: LOCAL_MODE ? 'local' : 'cloud',
    supabase: hasSupabase,
    presets: Object.keys(PRESETS),
  });
});

if (LOCAL_MODE) {
  app.use('/local', localRouter());
  // The in-memory queue does not survive a restart, so anything left mid-flight has to
  // be picked up or failed explicitly, or it spins in the UI forever.
  void recoverInterruptedProjects()
    .then((n) => n && console.log(`[recover] handled ${n} interrupted project(s)`))
    .catch((e) => console.error('[recover]', e));
}

/** The editor needs the full style objects so its preview can match the renderer. */
app.get('/presets', (_req, res) => {
  res.json({
    presets: Object.values(PRESETS),
    fonts: FONT_CHOICES,
    safeArea: SAFE_AREA,
    plans: Object.values(PLANS),
  });
});

/** Kick off (or re-run) processing for a project the caller owns. */
app.post(
  '/projects/:id/process',
  requireAuth,
  asyncRoute(async (req, res) => {
    const project = await requireOwnedProject(req, res);
    if (!project) return;

    const db = supabase();
    const { data: profile } = await db
      .from('profiles')
      .select('plan, reels_used_this_period, period_start')
      .eq('id', req.userId!)
      .single();

    const plan = planFor(profile?.plan);
    let used = profile?.reels_used_this_period ?? 0;

    // Roll the window before judging the quota, or a user is locked out forever.
    if (profile?.period_start && periodExpired(profile.period_start)) {
      used = 0;
      await db
        .from('profiles')
        .update({ reels_used_this_period: 0, period_start: new Date().toISOString() })
        .eq('id', req.userId!);
    }

    const stage = req.body?.stage === 'render' ? 'render' : 'full';
    // Re-rendering an existing project with a new style is not a new reel.
    if (stage === 'full' && used >= plan.reelsPerMonth) {
      res.status(402).json({
        error: 'quota_exceeded',
        plan: plan.id,
        used,
        limit: plan.reelsPerMonth,
      });
      return;
    }

    if (req.body?.stylePreset && PRESETS[req.body.stylePreset]) {
      await updateProject(project.id, { style_preset: req.body.stylePreset });
    }
    if (req.body?.langMode) {
      await updateProject(project.id, { lang_mode: req.body.langMode });
    }

    // Imported lazily: queue.js opens a Redis connection at module load, which local
    // mode has no reason to require.
    const { enqueuePipeline } = await import('./queue.js');
    const jobId = await enqueuePipeline({ projectId: project.id, stage });
    if (stage === 'full') {
      await db
        .from('profiles')
        .update({ reels_used_this_period: used + 1 })
        .eq('id', req.userId!);
    }

    res.json({ jobId, status: 'queued', used: stage === 'full' ? used + 1 : used, limit: plan.reelsPerMonth });
  }),
);

app.get(
  '/projects/:id',
  requireAuth,
  asyncRoute(async (req, res) => {
    const project = await requireOwnedProject(req, res);
    if (!project) return;

    const downloads: Record<string, string> = {};
    if (project.status === 'done' && project.output_path) {
      const base = project.output_path.replace(/\.mp4$/, '');
      downloads.mp4 = await signedUrl(BUCKET_OUT, project.output_path);
      downloads.srt = await signedUrl(BUCKET_OUT, `${base}.srt`).catch(() => '');
      downloads.vtt = await signedUrl(BUCKET_OUT, `${base}.vtt`).catch(() => '');
    }
    res.json({ project, downloads });
  }),
);

/**
 * Razorpay subscription lifecycle. The signature is an HMAC-SHA256 of the raw body
 * keyed by the webhook secret; compare in constant time.
 */
app.post(
  '/webhooks/razorpay',
  asyncRoute(async (req, res) => {
    const signature = req.header('x-razorpay-signature') ?? '';
    const raw = req.body as Buffer;

    if (!env.razorpayWebhookSecret) {
      res.status(503).json({ error: 'Webhook secret not configured' });
      return;
    }
    const expected = crypto
      .createHmac('sha256', env.razorpayWebhookSecret)
      .update(raw)
      .digest('hex');
    const sigBuf = Buffer.from(signature);
    const expBuf = Buffer.from(expected);
    if (sigBuf.length !== expBuf.length || !crypto.timingSafeEqual(sigBuf, expBuf)) {
      res.status(400).json({ error: 'Invalid signature' });
      return;
    }

    const event = JSON.parse(raw.toString('utf8')) as {
      event?: string;
      payload?: { subscription?: { entity?: Record<string, any> } };
    };
    const sub = event.payload?.subscription?.entity;
    if (!sub) {
      res.json({ ok: true, ignored: event.event });
      return;
    }

    // The plan is carried in subscription notes, set when the checkout was created.
    const userId = sub.notes?.user_id as string | undefined;
    const planId = (sub.notes?.plan as string | undefined) ?? 'creator';
    if (!userId) {
      res.json({ ok: true, ignored: 'no user_id in notes' });
      return;
    }

    const db = supabase();
    await db.from('subscriptions').upsert(
      {
        user_id: userId,
        razorpay_subscription_id: sub.id,
        plan: planId,
        status: sub.status,
        current_end: sub.current_end ? new Date(sub.current_end * 1000).toISOString() : null,
      },
      { onConflict: 'razorpay_subscription_id' },
    );

    // Only an active subscription grants the paid plan; everything else drops to free.
    const active = ['active', 'authenticated', 'resumed'].includes(String(sub.status));
    await db
      .from('profiles')
      .update({
        plan: active ? planId : 'free',
        ...(active ? { reels_used_this_period: 0, period_start: new Date().toISOString() } : {}),
      })
      .eq('id', userId);

    res.json({ ok: true, event: event.event });
  }),
);

/** DPDP "delete my data". Irreversible, and scoped to the caller's own account. */
app.delete(
  '/me/data',
  requireAuth,
  asyncRoute(async (req, res) => {
    await deleteAllUserData(req.userId!);
    res.json({ ok: true });
  }),
);

app.use((err: Error, _req: Request, res: Response, _next: NextFunction) => {
  console.error('[http]', err);
  res.status(500).json({ error: err.message });
});

const server = app.listen(env.port, () => {
  console.log(`[http] listening on :${env.port} (${LOCAL_MODE ? 'local' : 'cloud'} mode)`);
  if (LOCAL_MODE) {
    console.log('[http] no Supabase configured — running single-user off ./data');
  }
});

/**
 * A listen failure emits an 'error' event; with no handler Node rethrows it as an
 * unhandled exception and dumps a stack trace that buries the actual cause. The common
 * case is a previous dev server still holding the port, so say exactly that.
 */
server.on('error', (err: NodeJS.ErrnoException) => {
  if (err.code === 'EADDRINUSE') {
    console.error(
      `\n[http] Port ${env.port} is already in use — another worker is still running.\n` +
        '       Stop it, or set PORT to something else in apps/worker/.env\n\n' +
        '       Windows:  Get-NetTCPConnection -LocalPort ' + env.port +
        ' -State Listen | %{ Stop-Process -Id $_.OwningProcess -Force }\n' +
        '       macOS/Linux:  lsof -ti :' + env.port + ' | xargs kill -9\n',
    );
  } else {
    console.error('[http] server error:', err);
  }
  process.exit(1);
});

// Only the cloud path needs the Redis-backed worker.
const worker = LOCAL_MODE ? null : (await import('./queue.js')).startWorker();

// Retention sweep. Hourly is frequent enough for a day-granularity window, and cheap.
const RETENTION_INTERVAL_MS = 60 * 60_000;
const retentionTimer = setInterval(() => {
  if (!hasSupabase) return;
  purgeExpiredProjects()
    .then(({ scanned, purged }) => {
      if (scanned) console.log(`[retention] scanned ${scanned}, purged ${purged}`);
    })
    .catch((e) => console.error('[retention]', e));
}, RETENTION_INTERVAL_MS);
retentionTimer.unref();

for (const signal of ['SIGTERM', 'SIGINT'] as const) {
  process.on(signal, () => {
    console.log(`[shutdown] ${signal}`);
    // Let in-flight renders finish; a half-written mp4 helps nobody.
    void Promise.resolve(worker?.close()).then(() => server.close(() => process.exit(0)));
  });
}
