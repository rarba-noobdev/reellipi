import 'dotenv/config';

function req(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`Missing required env var: ${name}`);
  return v;
}
function opt(name: string, fallback: string): string {
  return process.env[name] || fallback;
}

export const env = {
  port: Number(opt('PORT', '8787')),
  sarvamKey: req('SARVAM_API_KEY'),
  sarvamRpm: Number(opt('SARVAM_RATE_LIMIT_RPM', '60')),
  supabaseUrl: process.env.SUPABASE_URL ?? '',
  supabaseServiceKey: process.env.SUPABASE_SERVICE_ROLE_KEY ?? '',
  redisUrl: opt('REDIS_URL', 'redis://localhost:6379'),
  razorpayKeyId: process.env.RAZORPAY_KEY_ID ?? '',
  razorpayKeySecret: process.env.RAZORPAY_KEY_SECRET ?? '',
  razorpayWebhookSecret: process.env.RAZORPAY_WEBHOOK_SECRET ?? '',
  retentionDays: Number(opt('CAPTION_RETENTION_DAYS', '7')),
  ffmpegPath: opt('FFMPEG_PATH', 'ffmpeg'),
  ffprobePath: opt('FFPROBE_PATH', 'ffprobe'),
};

/** Supabase is optional in local probe mode so the pipeline can run off the filesystem. */
export const hasSupabase = Boolean(env.supabaseUrl && env.supabaseServiceKey);
