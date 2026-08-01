// Probe 2: is segmentation VAD-driven? Does saarika:v2.5 give finer timestamps?
// Builds a multi-utterance WAV (3 phrases + silence gaps) with a pure-JS WAV splicer.
import fs from 'node:fs';
import path from 'node:path';

const KEY = process.env.SARVAM_API_KEY;
const BASE = 'https://api.sarvam.ai';
const H = { 'api-subscription-key': KEY };
const OUT = path.join(import.meta.dirname, 'out');
fs.mkdirSync(OUT, { recursive: true });
const log = (...a) => console.log(...a);

// --- minimal WAV parse/build (PCM only) -----------------------------------
function parseWav(buf) {
  if (buf.toString('ascii', 0, 4) !== 'RIFF' || buf.toString('ascii', 8, 12) !== 'WAVE')
    throw new Error('not a RIFF/WAVE file');
  let off = 12, fmt = null, data = null;
  while (off + 8 <= buf.length) {
    const id = buf.toString('ascii', off, off + 4);
    const size = buf.readUInt32LE(off + 4);
    const body = buf.subarray(off + 8, off + 8 + size);
    if (id === 'fmt ') fmt = { audioFormat: body.readUInt16LE(0), channels: body.readUInt16LE(2), sampleRate: body.readUInt32LE(4), bitsPerSample: body.readUInt16LE(14) };
    if (id === 'data') data = body;
    off += 8 + size + (size % 2);
  }
  if (!fmt || !data) throw new Error('missing fmt/data chunk');
  return { ...fmt, data };
}
function buildWav({ channels, sampleRate, bitsPerSample }, data) {
  const byteRate = (sampleRate * channels * bitsPerSample) / 8;
  const blockAlign = (channels * bitsPerSample) / 8;
  const h = Buffer.alloc(44);
  h.write('RIFF', 0); h.writeUInt32LE(36 + data.length, 4); h.write('WAVE', 8);
  h.write('fmt ', 12); h.writeUInt32LE(16, 16); h.writeUInt16LE(1, 20);
  h.writeUInt16LE(channels, 22); h.writeUInt32LE(sampleRate, 24);
  h.writeUInt32LE(byteRate, 28); h.writeUInt16LE(blockAlign, 32);
  h.writeUInt16LE(bitsPerSample, 34);
  h.write('data', 36); h.writeUInt32LE(data.length, 40);
  return Buffer.concat([h, data]);
}
const silence = (fmt, sec) => Buffer.alloc(Math.round(sec * fmt.sampleRate * fmt.channels * (fmt.bitsPerSample / 8)));

async function tts(text, lang = 'ta-IN', model = 'bulbul:v2') {
  const r = await fetch(`${BASE}/text-to-speech`, {
    method: 'POST', headers: { ...H, 'Content-Type': 'application/json' },
    body: JSON.stringify({ text, target_language_code: lang, model }),
  });
  if (!r.ok) throw new Error(`TTS ${r.status}: ${(await r.text()).slice(0, 300)}`);
  return Buffer.from((await r.json()).audios[0], 'base64');
}
async function stt(buf, params) {
  const fd = new FormData();
  fd.append('file', new Blob([buf]), 'probe.wav');
  for (const [k, v] of Object.entries(params)) fd.append(k, String(v));
  const r = await fetch(`${BASE}/speech-to-text`, { method: 'POST', headers: H, body: fd });
  const t = await r.text();
  try { return { status: r.status, json: JSON.parse(t) }; } catch { return { status: r.status, json: { _raw: t } }; }
}
function report(tag, res) {
  log(`\n=== ${tag} -> HTTP ${res.status} ===`);
  if (res.status !== 200) return log('  ' + JSON.stringify(res.json).slice(0, 400));
  const ts = res.json.timestamps;
  log('  transcript:', JSON.stringify(res.json.transcript || '').slice(0, 200));
  if (!ts?.words?.length) return log('  timestamps: ABSENT/EMPTY');
  log(`  segments: ${ts.words.length}`);
  ts.words.forEach((w, i) =>
    log(`    [${i}] ${ts.start_time_seconds[i]}s -> ${ts.end_time_seconds[i]}s  ${JSON.stringify(String(w).slice(0, 70))}`));
}

const PHRASES = [
  'Vanakkam friends, epdi irukeenga.',
  'Indha video la oru super tip iruku.',
  'Definitely try pannunga okay.',
];

const main = async () => {
  log('# Building multi-utterance WAV with 1.2s silence gaps');
  const clips = [];
  for (const p of PHRASES) { clips.push(parseWav(await tts(p))); log(`  "${p}" ok`); }
  const fmt = clips[0];
  log(`  fmt: ${fmt.sampleRate}Hz ${fmt.channels}ch ${fmt.bitsPerSample}bit format=${fmt.audioFormat}`);
  const gap = silence(fmt, 1.2);
  const parts = [];
  clips.forEach((c, i) => { if (i) parts.push(gap); parts.push(c.data); });
  const data = Buffer.concat(parts);
  const wav = buildWav(fmt, data);
  const dur = data.length / ((fmt.sampleRate * fmt.channels * fmt.bitsPerSample) / 8);
  fs.writeFileSync(path.join(OUT, 'multi.wav'), wav);
  log(`  -> multi.wav ${wav.length} bytes, ${dur.toFixed(2)}s`);

  const matrix = [
    ['saaras:v3 translit',            { model: 'saaras:v3', mode: 'translit', language_code: 'unknown', with_timestamps: 'true' }],
    ['saaras:v3 verbatim',            { model: 'saaras:v3', mode: 'verbatim', language_code: 'unknown', with_timestamps: 'true' }],
    ['saarika:v2.5 ta-IN',            { model: 'saarika:v2.5', language_code: 'ta-IN', with_timestamps: 'true' }],
    ['saarika:v2.5 + diarize',        { model: 'saarika:v2.5', language_code: 'ta-IN', with_timestamps: 'true', with_diarization: 'true' }],
    ['saaras:v3 translit + diarize',  { model: 'saaras:v3', mode: 'translit', language_code: 'unknown', with_timestamps: 'true', with_diarization: 'true' }],
  ];
  for (const [tag, params] of matrix) {
    const res = await stt(wav, params);
    fs.writeFileSync(path.join(OUT, `p2_${tag.replace(/[^a-z0-9]+/gi, '_')}.json`), JSON.stringify(res.json, null, 2));
    report(tag, res);
  }
};
main().catch((e) => { console.error(e); process.exit(1); });
