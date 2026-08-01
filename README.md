# ReelLipi

Tanglish / Hinglish / Indic captions, burned into Instagram Reels. Built on Sarvam AI.

```
apps/web      React 18 + Vite + TS + Tailwind v4   -> Vercel
apps/worker   Express + BullMQ + ffmpeg + libass   -> Railway
supabase/     Postgres schema, RLS, storage buckets
```

---

## Verified Sarvam API behaviour (probed 2026-07-31 / 08-01)

These findings contradict the public docs. They were established against the live API,
and the architecture depends on them. Re-probe with `_probe/gate.mjs` before assuming
any of it still holds.

### 1. There are no word-level timestamps. Anywhere.

The REST API-reference page shows a `timestamps` object with parallel `words[]`,
`start_time_seconds[]` and `end_time_seconds[]` arrays. In practice:

- `with_timestamps=true` is a **real but undocumented** request field. Without it, no
  `timestamps` key is returned at all.
- With it, `timestamps.words[]` contains **exactly one entry spanning the whole file**
  (`0 -> duration`). Confirmed on `saaras:v3` in `translit`, `codemix`, `transcribe`
  and `verbatim` modes, and on `saarika:v2.5`.
- Tested against audio containing 1.2s of digital silence between phrases, so this is
  not a VAD sensitivity problem. The STT FAQ ("word-level timestamps are not
  supported") is the accurate source.
- `with_diarization=true` is rejected on REST: *"Diarization is not supported in the
  real-time API. Please use the batch API for diarization."*

**Consequence:** word timing is derived, not received. See "How timing works" below.

### 2. `sarvam-30b` is deprecated

`POST /v1/chat/completions` with `sarvam-30b` returns 400: *"Model 'sarvam-30b' has
been deprecated. Please use one of the available models instead: sarvam-105b."*

### 3. `sarvam-105b` is a reasoning model

It emits a long `reasoning_content` before any `content`, and that reasoning is billed
and counted against `max_tokens`. On a trivial prompt it produced **1233 completion
tokens at default effort versus 246 at `reasoning_effort: 'low'`**. If `max_tokens` is
too small the reply truncates mid-thought and `content` comes back empty with
`finish_reason: 'length'` — a 200 response that looks like a silent failure.

`max_tokens` is capped by plan: **the starter tier rejects anything above 4096.**

Practical consequence: **LLM cue grouping is not viable on the starter tier.** Asking the
model to group word tokens by index makes it spiral — on a 152-word clip, 6 of 7 batches
exhausted their budget on reasoning and returned nothing, costing ~100s and ~₹0.2 per
reel. Shortening the prompt and shrinking batches did not help; the index arithmetic is
what triggers it. Grouping is off by default (`STYLE_LLM_GROUPING=1` to enable) and
deterministic grouping is used instead. Caption + hashtag generation needs no index
reasoning and works reliably in ~10s, so it stays on.

### 4. Text quality is genuinely good

This is the product wedge and it holds up:

| mode | output |
|---|---|
| `translit` | `Indha video-la njaan oru super tip share penran.` |
| `codemix` | `இந்த video-ல நான் ஒரு super tip share பண்றேன்.` |
| `transcribe` | `இந்த வீடியோல நான் ஒரு சூப்பர் டிப் ஷேர் பண்றேன்.` |

---

## How timing works

Since the API gives no usable timings, word positions come from where *we* cut the
audio:

1. `ffmpeg silencedetect` finds speech runs (default: `-32dB`, 0.35s minimum silence).
2. Runs are padded 0.15s, short ones merged, anything over 28s split — the sync REST
   endpoint caps at 30s.
3. Each run is transcribed separately. Its start/end are exact, because we produced them.
4. Words are distributed inside the run in proportion to speaking time, using **grapheme
   clusters** rather than UTF-16 length — a Tamil syllable is one base plus combining
   marks, and `String.length` overcounts it badly enough to starve Latin words in a
   code-mixed line.

Measured against a ground-truth clip with known phrase boundaries:
**mean boundary error 89ms, max 130ms.** Most of that is the intentional 0.15s onset
padding, not detection error.

This is why `projects.timing_approximate` exists and why the UI warns about it. To
reach true ~30ms accuracy you would add a CTC forced-aligner (torchaudio MMS_FA) fed
with the audio plus Sarvam's transcript; the pipeline is structured so that would slot
in at `lib/align.ts` without touching anything else.

---

## Running it

### Local mode — no accounts needed

With no `SUPABASE_URL` set, the worker runs single-user off the filesystem and swaps
BullMQ/Redis for an in-process queue. Only a Sarvam key is required.

```bash
# terminal 1
npm run dev:worker      # http://localhost:8787  -> {"mode":"local"}

# terminal 2
npm run dev:web         # http://localhost:5173
```

The frontend calls `/health`, sees `mode: local`, and skips auth entirely. Projects live
in `apps/worker/data/{projectId}/` as `source.mp4`, `out.mp4`, `out.ass|srt|vtt`,
`project.json` and `cues.json`. Delete the folder to delete the project.

Local API: `GET|POST /local/projects`, `GET|DELETE /local/projects/:id`,
`POST /local/projects/:id/render`, `PUT /local/projects/:id/cues`,
`GET /local/projects/:id/file/:name` (supports HTTP range, so `<video>` seeking works).

### Cloud mode

Fill `SUPABASE_URL` + `SUPABASE_SERVICE_ROLE_KEY` and the worker switches to the
Supabase/Redis path with auth, RLS, quotas and Razorpay. See Setup below.

## Setup

```bash
npm install
cp .env.example apps/worker/.env     # add SARVAM_API_KEY
cp .env.example apps/web/.env        # add VITE_SUPABASE_*

npm run -w @reellipi/worker exec -- tsx src/scripts/fetch-fonts.ts   # Noto TTFs
```

`ffmpeg` must be built with `--enable-libass`. On Windows,
`winget install Gyan.FFmpeg` and point `FFMPEG_PATH` / `FFPROBE_PATH` at the absolute
binary paths — winget installs to a versioned directory that existing shells will not
pick up.

Apply `supabase/migrations/0001_init.sql` to your project. It creates the schema, RLS
policies, the `raw`/`out` buckets and a trigger that provisions a `profiles` row on
signup.

### Verification scripts

```bash
cd apps/worker
npx tsx src/scripts/make-sample.ts        # synth a Tanglish clip with known timings
npx tsx src/scripts/probe-pipeline.ts     # STT + timing, reports drift vs ground truth
npx tsx src/scripts/render-sample.ts --preset highlight_pop --mode codemix
npx tsx src/scripts/check-watermark.ts
```

`render-sample` asserts: no words dropped, ≤2 lines, ≤32 chars/line, cue duration
0.83–7s, on-screen density, 1080×1920 output, render under 1.5× realtime.

---

## Pipeline

```
upload -> Storage raw/{user}/{project}.mp4  +  projects row
   |
   v  BullMQ job on the Railway worker
extract 16kHz mono wav
silencedetect -> speech runs (<=28s)
per run: POST /speech-to-text  (saaras:v3, mode=translit|codemix|...)
distribute words inside each run, merge into one monotonic timeline
sarvam-105b: group into cues, add emoji + keywords, write IG caption + hashtags
   |                          (regroups and decorates only; never moves a timestamp)
   v
build ASS (karaoke \k or per-word pop events) -> ffmpeg -vf "ass=...:fontsdir=..."
   |
   v  Storage out/  ->  Realtime flips status to done  ->  SPA offers MP4 + SRT + VTT
```

### Non-negotiables

1. STT run boundaries are the single source of truth for timing. The LLM and the
   transcript editor may change text, emoji and grouping — never a start or end time.
2. Every transcribed word must survive into a rendered line. `render-sample.ts` asserts
   this; an early version of the styling pass silently dropped the tail of each cue.
3. Never run ffmpeg in a Supabase Edge Function — Deno isolate, no shell,
   `Deno.Command` blocked, 256MB.
4. Fonts are bundled and passed via `fontsdir`. A missing Indic font renders as tofu
   boxes rather than erroring, so the Dockerfile fails the build if `fc-list` cannot
   find Noto Tamil and Noto Devanagari.
5. Cue segmentation targets 17 CPS, ≤2 lines, ≤22 chars/line. Splitting a cue cannot
   lower the speaker's actual rate, so the CPS limit is applied as a character budget
   of `maxCps * duration` — it caps how much text is on screen at once.

---

## Cost

Measured on a 13.4s clip: **₹0.10** of STT (₹30/hour, rounded up per chunk), plus a
sub-paisa LLM call at `reasoning_effort: 'low'`, plus ~6s of CPU to encode. Extrapolates
to roughly **₹1.5–3 per 60s reel** all-in, against a ₹199–999/month plan ladder.

## Known gaps

- Razorpay checkout creation is not implemented — only the webhook that reacts to
  subscription lifecycle events. Plans live in `lib/plans.ts`.
- Instagram Graph API publishing is deliberately out of scope: it needs a Business
  account, two App Review submissions and ~2–4 weeks. MVP ships download + manual upload.
- The in-browser preview approximates libass; the exported MP4 is the source of truth.
- Retention sweep runs hourly in-process. On multiple worker instances this duplicates
  work harmlessly, but it belongs in a single scheduled job.
