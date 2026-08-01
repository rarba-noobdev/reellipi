/**
 * Build a synthetic 9:16 "reel" whose word timings we already know.
 *
 * Phrases are synthesised one at a time with Bulbul TTS and spliced together with
 * fixed silence gaps, so the exact start/end of every phrase is known ground truth.
 * probe-pipeline.ts then measures how far the silence-split + distribute pipeline
 * drifts from it. Run: npx tsx src/scripts/make-sample.ts
 */
import { spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';
import { env } from '../lib/env.js';

const OUT_DIR = path.resolve('tmp/sample');
const GAP_SECONDS = 0.9;

const PHRASES = [
  'Vanakkam friends, epdi irukeenga ellarum.',
  'Indha video la naan oru super tip share panren.',
  'Instagram reels ku caption romba mukkiyam.',
  'Definitely try pannunga, comment la sollunga.',
];

interface WavFmt {
  audioFormat: number;
  channels: number;
  sampleRate: number;
  bitsPerSample: number;
}

function parseWav(buf: Buffer): WavFmt & { data: Buffer } {
  if (buf.toString('ascii', 0, 4) !== 'RIFF' || buf.toString('ascii', 8, 12) !== 'WAVE') {
    throw new Error('TTS did not return a RIFF/WAVE payload');
  }
  let off = 12;
  let fmt: WavFmt | null = null;
  let data: Buffer | null = null;
  while (off + 8 <= buf.length) {
    const id = buf.toString('ascii', off, off + 4);
    const size = buf.readUInt32LE(off + 4);
    const body = buf.subarray(off + 8, off + 8 + size);
    if (id === 'fmt ') {
      fmt = {
        audioFormat: body.readUInt16LE(0),
        channels: body.readUInt16LE(2),
        sampleRate: body.readUInt32LE(4),
        bitsPerSample: body.readUInt16LE(14),
      };
    }
    if (id === 'data') data = body;
    off += 8 + size + (size % 2);
  }
  if (!fmt || !data) throw new Error('WAV missing fmt/data chunk');
  return { ...fmt, data };
}

function buildWav(fmt: WavFmt, data: Buffer): Buffer {
  const byteRate = (fmt.sampleRate * fmt.channels * fmt.bitsPerSample) / 8;
  const blockAlign = (fmt.channels * fmt.bitsPerSample) / 8;
  const h = Buffer.alloc(44);
  h.write('RIFF', 0);
  h.writeUInt32LE(36 + data.length, 4);
  h.write('WAVE', 8);
  h.write('fmt ', 12);
  h.writeUInt32LE(16, 16);
  h.writeUInt16LE(1, 20);
  h.writeUInt16LE(fmt.channels, 22);
  h.writeUInt32LE(fmt.sampleRate, 24);
  h.writeUInt32LE(byteRate, 28);
  h.writeUInt16LE(blockAlign, 32);
  h.writeUInt16LE(fmt.bitsPerSample, 34);
  h.write('data', 36);
  h.writeUInt32LE(data.length, 40);
  return Buffer.concat([h, data]);
}

const bytesPerSecond = (f: WavFmt) => (f.sampleRate * f.channels * f.bitsPerSample) / 8;

async function tts(text: string): Promise<Buffer> {
  const res = await fetch('https://api.sarvam.ai/text-to-speech', {
    method: 'POST',
    headers: { 'api-subscription-key': env.sarvamKey, 'Content-Type': 'application/json' },
    body: JSON.stringify({ text, target_language_code: 'ta-IN', model: 'bulbul:v2' }),
  });
  if (!res.ok) throw new Error(`TTS ${res.status}: ${(await res.text()).slice(0, 300)}`);
  const j = (await res.json()) as { audios?: string[] };
  const b64 = j.audios?.[0];
  if (!b64) throw new Error('TTS returned no audio');
  return Buffer.from(b64, 'base64');
}

function ffmpeg(args: string[]): Promise<void> {
  return new Promise((resolve, reject) => {
    const p = spawn(env.ffmpegPath, ['-hide_banner', '-nostdin', '-y', ...args], { windowsHide: true });
    let err = '';
    p.stderr.on('data', (d) => (err += d.toString()));
    p.on('error', reject);
    p.on('close', (c) => (c === 0 ? resolve() : reject(new Error(`ffmpeg ${c}\n${err.slice(-1500)}`))));
  });
}

async function main() {
  await fs.mkdir(OUT_DIR, { recursive: true });

  const clips: Array<{ text: string; wav: WavFmt & { data: Buffer } }> = [];
  for (const text of PHRASES) {
    process.stdout.write(`  synthesising: ${text}\n`);
    clips.push({ text, wav: parseWav(await tts(text)) });
  }

  const fmt = clips[0]!.wav;
  const bps = bytesPerSecond(fmt);
  const gap = Buffer.alloc(Math.round(GAP_SECONDS * bps));

  const parts: Buffer[] = [];
  const truth: Array<{ text: string; start: number; end: number }> = [];
  let offsetBytes = 0;
  clips.forEach((c, i) => {
    if (i > 0) {
      parts.push(gap);
      offsetBytes += gap.length;
    }
    const start = offsetBytes / bps;
    parts.push(c.wav.data);
    offsetBytes += c.wav.data.length;
    truth.push({ text: c.text, start: round3(start), end: round3(offsetBytes / bps) });
  });

  const audioData = Buffer.concat(parts);
  const wavPath = path.join(OUT_DIR, 'sample.wav');
  await fs.writeFile(wavPath, buildWav(fmt, audioData));
  const duration = audioData.length / bps;

  // Mux onto a 1080x1920 test pattern so the input looks like a real reel.
  const mp4Path = path.join(OUT_DIR, 'sample.mp4');
  await ffmpeg([
    '-f', 'lavfi',
    '-i', `testsrc2=size=1080x1920:rate=30:duration=${duration.toFixed(3)}`,
    '-i', wavPath,
    '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '28', '-pix_fmt', 'yuv420p',
    '-c:a', 'aac', '-b:a', '128k',
    '-shortest', '-movflags', '+faststart',
    mp4Path,
  ]);

  await fs.writeFile(path.join(OUT_DIR, 'truth.json'), JSON.stringify({ gapSeconds: GAP_SECONDS, duration: round3(duration), phrases: truth }, null, 2));

  console.log(`\nsample.mp4  ${duration.toFixed(2)}s  ->  ${mp4Path}`);
  console.table(truth.map((t) => ({ start: t.start, end: t.end, text: t.text.slice(0, 46) })));
}

const round3 = (n: number) => Math.round(n * 1000) / 1000;

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
