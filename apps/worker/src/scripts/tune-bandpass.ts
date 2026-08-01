/**
 * Does band-passing to the speech formant range expose pauses that background music
 * hides from silencedetect?
 *
 * Music is usually broadband with heavy bass; speech energy concentrates roughly
 * 300-3400 Hz. Filtering to that band before measuring level can reveal gaps that a
 * full-spectrum threshold never sees.
 */
import { spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { env } from '../lib/env.js';
import { extractAudio, probe } from '../lib/ffmpeg.js';

const input = process.argv[2];
if (!input) throw new Error('Usage: tune-bandpass.ts <video>');

function ffmpegStderr(args: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    const p = spawn(env.ffmpegPath, ['-hide_banner', '-nostdin', '-y', ...args], { windowsHide: true });
    let err = '';
    p.stderr.on('data', (d) => (err += d.toString()));
    p.on('error', reject);
    p.on('close', () => resolve(err));
  });
}

function parseSilences(log: string, total: number) {
  const out: Array<{ start: number; end: number }> = [];
  let pending: number | null = null;
  for (const line of log.split(/\r?\n/)) {
    const s = line.match(/silence_start:\s*(-?[\d.]+)/);
    if (s?.[1] !== undefined) pending = Math.max(0, Number(s[1]));
    const e = line.match(/silence_end:\s*(-?[\d.]+)/);
    if (e?.[1] !== undefined && pending !== null) {
      out.push({ start: pending, end: Number(e[1]) });
      pending = null;
    }
  }
  if (pending !== null) out.push({ start: pending, end: total });
  return out;
}

const workDir = await fs.mkdtemp(path.join(os.tmpdir(), 'reellipi-bp-'));
try {
  const meta = await probe(input);
  const wav = await extractAudio(input, path.join(workDir, 'a.wav'));
  console.log(`${path.basename(input)}  ${meta.durationSeconds.toFixed(2)}s\n`);

  const chains: Array<[string, string]> = [
    ['raw', ''],
    ['speech band 300-3400', 'highpass=f=300,lowpass=f=3400,'],
    ['tight band 500-2500', 'highpass=f=500,lowpass=f=2500,'],
    ['band + compand', 'highpass=f=300,lowpass=f=3400,compand=attacks=0:decays=0:points=-80/-80|-40/-20|0/0,'],
  ];

  console.log('filter                 noiseDb  gaps  totalGap  longest');
  console.log('---------------------  -------  ----  --------  -------');

  for (const [label, prefix] of chains) {
    for (const noiseDb of [-40, -35, -30, -26]) {
      const log = await ffmpegStderr([
        '-i', wav,
        '-af', `${prefix}silencedetect=noise=${noiseDb}dB:d=0.20`,
        '-f', 'null', '-',
      ]);
      const gaps = parseSilences(log, meta.durationSeconds);
      const total = gaps.reduce((a, g) => a + (g.end - g.start), 0);
      const longest = gaps.reduce((a, g) => Math.max(a, g.end - g.start), 0);
      console.log(
        `${label.padEnd(21)}  ${String(noiseDb).padStart(7)}  ${String(gaps.length).padStart(4)}  ` +
          `${total.toFixed(2).padStart(8)}  ${longest.toFixed(2).padStart(7)}`,
      );
    }
  }
} finally {
  await fs.rm(workDir, { recursive: true, force: true });
}
