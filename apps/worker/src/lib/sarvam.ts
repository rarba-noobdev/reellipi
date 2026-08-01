import fs from 'node:fs/promises';
import path from 'node:path';
import { env } from './env.js';

const BASE = 'https://api.sarvam.ai';

export type LangMode = 'translit' | 'codemix' | 'transcribe' | 'translate' | 'verbatim';

export interface SttResponse {
  request_id?: string;
  transcript?: string;
  language_code?: string;
  language_probability?: number;
  timestamps?: {
    words?: string[];
    start_time_seconds?: number[];
    end_time_seconds?: number[];
  } | null;
}

/**
 * Token bucket sized to the account's plan (starter 60 rpm, pro 200, business 1000).
 * Sarvam replies 429 without a Retry-After, so we throttle proactively.
 */
class RateLimiter {
  private queue: Array<() => void> = [];
  private timestamps: number[] = [];

  constructor(private readonly rpm: number) {}

  async acquire(): Promise<void> {
    for (;;) {
      const now = Date.now();
      this.timestamps = this.timestamps.filter((t) => now - t < 60_000);
      if (this.timestamps.length < this.rpm) {
        this.timestamps.push(now);
        return;
      }
      const oldest = this.timestamps[0]!;
      await sleep(60_000 - (now - oldest) + 25);
    }
  }
}

const limiter = new RateLimiter(env.sarvamRpm);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

interface RequestOptions {
  retries?: number;
  signal?: AbortSignal;
}

async function sarvamFetch(
  url: string,
  init: RequestInit,
  { retries = 4, signal }: RequestOptions = {},
): Promise<Response> {
  let lastErr: unknown;
  for (let attempt = 0; attempt <= retries; attempt++) {
    await limiter.acquire();
    try {
      const res = await fetch(url, { ...init, signal });
      // 429 and 5xx are transient; everything else is a real answer.
      if (res.status !== 429 && res.status < 500) return res;
      lastErr = new Error(`Sarvam ${res.status}: ${(await res.text()).slice(0, 300)}`);
    } catch (e) {
      lastErr = e;
    }
    if (attempt < retries) await sleep(Math.min(2 ** attempt * 500, 8000) + Math.random() * 250);
  }
  throw lastErr instanceof Error ? lastErr : new Error(String(lastErr));
}

/**
 * Transcribe one audio chunk.
 *
 * IMPORTANT — verified against the live API on 2026-07-31:
 * `with_timestamps=true` is accepted (it is absent from the public request schema)
 * and makes a `timestamps` object appear, but `timestamps.words[]` always contains a
 * SINGLE entry spanning the entire file — `0 -> duration`. This holds for saaras:v3 in
 * every mode and for saarika:v2.5. There are no word-level or sentence-level timings.
 * `with_diarization` is rejected outright: "Diarization is not supported in the
 * real-time API."
 *
 * Word timing therefore comes from silence-based chunking plus intra-chunk
 * distribution (see lib/align.ts), NOT from this response.
 */
export async function transcribeChunk(
  filePath: string,
  opts: { mode: LangMode; languageCode: string; model?: string; signal?: AbortSignal },
): Promise<SttResponse> {
  const buf = await fs.readFile(filePath);
  const fd = new FormData();
  fd.append('file', new Blob([new Uint8Array(buf)]), path.basename(filePath));
  fd.append('model', opts.model ?? 'saaras:v3');
  fd.append('mode', opts.mode);
  fd.append('language_code', opts.languageCode);
  fd.append('with_timestamps', 'true');

  const res = await sarvamFetch(
    `${BASE}/speech-to-text`,
    { method: 'POST', headers: { 'api-subscription-key': env.sarvamKey }, body: fd },
    { signal: opts.signal },
  );

  const text = await res.text();
  if (!res.ok) throw new Error(`Sarvam STT ${res.status}: ${text.slice(0, 500)}`);
  return JSON.parse(text) as SttResponse;
}

export interface ChatOptions {
  /**
   * `sarvam-30b` and `sarvam-m` are deprecated — the API rejects them with
   * "Please use one of the available models instead: sarvam-105b" (seen 2026-08-01).
   */
  model?: 'sarvam-105b';
  temperature?: number;
  maxTokens?: number;
  responseFormat?: unknown;
  /**
   * sarvam-105b is a reasoning model: it emits a long `reasoning_content` before any
   * `content`, and that reasoning is billed and counts against max_tokens. On a trivial
   * prompt 'high' produced 1233 completion tokens versus 246 on 'low'. Default to low —
   * cue grouping is a formatting task, not a reasoning one.
   */
  reasoningEffort?: 'low' | 'medium' | 'high';
  signal?: AbortSignal;
}

export async function chat(
  messages: Array<{ role: 'system' | 'user' | 'assistant'; content: string }>,
  opts: ChatOptions = {},
): Promise<string> {
  const body: Record<string, unknown> = {
    model: opts.model ?? 'sarvam-105b',
    messages,
    temperature: opts.temperature ?? 0.3,
    reasoning_effort: opts.reasoningEffort ?? 'low',
    // Must cover reasoning + answer, or the reply truncates mid-thought and `content`
    // comes back empty with finish_reason 'length'. The ceiling is plan-bound: the
    // starter tier rejects anything above 4096.
    max_tokens: opts.maxTokens ?? 4000,
  };
  if (opts.responseFormat) body.response_format = opts.responseFormat;

  const res = await sarvamFetch(
    `${BASE}/v1/chat/completions`,
    {
      method: 'POST',
      headers: {
        'api-subscription-key': env.sarvamKey,
        Authorization: `Bearer ${env.sarvamKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(body),
    },
    { signal: opts.signal },
  );

  const text = await res.text();
  if (!res.ok) throw new Error(`Sarvam chat ${res.status}: ${text.slice(0, 500)}`);
  const j = JSON.parse(text) as {
    choices?: Array<{
      finish_reason?: string;
      message?: { content?: string; reasoning_content?: string };
    }>;
    usage?: { completion_tokens?: number };
  };
  const choice = j.choices?.[0];
  const content = choice?.message?.content;
  if (!content) {
    const reasoned = choice?.message?.reasoning_content?.length ?? 0;
    throw new Error(
      `Sarvam chat returned no content (finish_reason=${choice?.finish_reason}, ` +
        `completion_tokens=${j.usage?.completion_tokens}, reasoning_chars=${reasoned}). ` +
        'Raise maxTokens or lower reasoningEffort.',
    );
  }
  return content;
}

/** STT is billed at Rs 30/hour, rounded up to the second. */
export function sttCostInr(audioSeconds: number): number {
  return (Math.ceil(audioSeconds) / 3600) * 30;
}
