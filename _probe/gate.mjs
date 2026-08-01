// Phase 1 go/no-go probe: does saaras:v3 REST return WORD-LEVEL timestamps?
// Generates a Tanglish test clip via Bulbul TTS, feeds it back through STT.
import fs from 'node:fs';
import path from 'node:path';

const KEY = process.env.SARVAM_API_KEY;
if (!KEY) throw new Error('SARVAM_API_KEY not set');
const BASE = 'https://api.sarvam.ai';
const H = { 'api-subscription-key': KEY };
const OUT = path.join(import.meta.dirname, 'out');
fs.mkdirSync(OUT, { recursive: true });

const log = (...a) => console.log(...a);
const dump = (name, obj) => {
  fs.writeFileSync(path.join(OUT, name), JSON.stringify(obj, null, 2));
};

async function tts(text, lang, model) {
  const r = await fetch(`${BASE}/text-to-speech`, {
    method: 'POST',
    headers: { ...H, 'Content-Type': 'application/json' },
    body: JSON.stringify({ text, target_language_code: lang, model }),
  });
  const body = await r.text();
  if (!r.ok) {
    log(`  TTS ${model} ${lang} -> ${r.status}: ${body.slice(0, 400)}`);
    return null;
  }
  const j = JSON.parse(body);
  const b64 = j.audios?.[0];
  if (!b64) { log('  TTS ok but no audio in response', Object.keys(j)); return null; }
  return Buffer.from(b64, 'base64');
}

async function stt(buf, filename, params) {
  const fd = new FormData();
  fd.append('file', new Blob([buf]), filename);
  for (const [k, v] of Object.entries(params)) fd.append(k, String(v));
  const r = await fetch(`${BASE}/speech-to-text`, { method: 'POST', headers: H, body: fd });
  const body = await r.text();
  let j; try { j = JSON.parse(body); } catch { j = { _raw: body }; }
  return { status: r.status, json: j };
}

function analyze(tag, res) {
  log(`\n=== ${tag} -> HTTP ${res.status} ===`);
  if (res.status !== 200) { log(JSON.stringify(res.json).slice(0, 600)); return null; }
  const j = res.json;
  log('  top-level keys :', Object.keys(j).join(', '));
  log('  transcript     :', JSON.stringify(j.transcript)?.slice(0, 300));
  log('  language_code  :', j.language_code);
  const ts = j.timestamps;
  if (!ts) { log('  timestamps     : ABSENT (null/undefined)'); return null; }
  log('  timestamps keys:', Object.keys(ts).join(', '));
  const w = ts.words, s = ts.start_time_seconds, e = ts.end_time_seconds;
  if (!Array.isArray(w) || w.length === 0) { log('  words[]        : EMPTY'); return null; }
  log(`  words[] count  : ${w.length}  (start[] ${s?.length} end[] ${e?.length})`);
  const nSpaces = w.filter((x) => typeof x === 'string' && x.trim().includes(' ')).length;
  log(`  granularity    : ${nSpaces === 0 ? 'WORD-LEVEL (no multi-word entries)' : `CHUNK-LEVEL (${nSpaces}/${w.length} entries contain spaces)`}`);
  log('  first 8        :');
  for (let i = 0; i < Math.min(8, w.length); i++) {
    log(`    [${i}] ${JSON.stringify(w[i])}  ${s?.[i]}s -> ${e?.[i]}s`);
  }
  return { count: w.length, wordLevel: nSpaces === 0 };
}

const TANGLISH = 'Vanakkam friends, indha video la naan unga kitta oru super tip share panna poren. Definitely try pannunga okay.';

const main = async () => {
  log('# STEP 1: synthesize test audio via Bulbul TTS');
  let audio = null, ext = 'wav';
  for (const [model, lang] of [['bulbul:v2', 'ta-IN'], ['bulbul:v3', 'ta-IN'], ['bulbul:v2', 'en-IN']]) {
    log(` trying ${model} / ${lang}`);
    audio = await tts(TANGLISH, lang, model);
    if (audio) { log(`  -> got ${audio.length} bytes`); break; }
  }
  if (!audio) {
    log('\nTTS unavailable. Drop a real clip at _probe/sample.wav (or .mp3) and rerun.');
    const local = ['sample.wav', 'sample.mp3', 'sample.m4a'].map((f) => path.join(import.meta.dirname, f)).find(fs.existsSync);
    if (!local) return;
    audio = fs.readFileSync(local); ext = path.extname(local).slice(1);
    log(` using local ${local} (${audio.length} bytes)`);
  }
  fs.writeFileSync(path.join(OUT, `probe.${ext}`), audio);

  log('\n# STEP 2: STT matrix');
  const results = {};
  const matrix = [
    ['translit + with_timestamps=true', { model: 'saaras:v3', mode: 'translit', language_code: 'unknown', with_timestamps: 'true' }],
    ['translit, no flag',               { model: 'saaras:v3', mode: 'translit', language_code: 'unknown' }],
    ['codemix + with_timestamps=true',  { model: 'saaras:v3', mode: 'codemix',  language_code: 'unknown', with_timestamps: 'true' }],
    ['transcribe + with_timestamps=true',{ model: 'saaras:v3', mode: 'transcribe', language_code: 'unknown', with_timestamps: 'true' }],
    ['translit ta-IN + timestamps=true',{ model: 'saaras:v3', mode: 'translit', language_code: 'ta-IN', timestamps: 'true' }],
  ];
  for (const [tag, params] of matrix) {
    const res = await stt(audio, `probe.${ext}`, params);
    dump(`stt_${tag.replace(/[^a-z0-9]+/gi, '_')}.json`, res.json);
    results[tag] = analyze(tag, res);
  }

  log('\n===== VERDICT =====');
  const any = Object.entries(results).filter(([, v]) => v?.wordLevel);
  if (any.length) log(`GO. Word-level timestamps available via: ${any.map(([k]) => k).join(' | ')}`);
  else if (Object.values(results).some(Boolean)) log('PARTIAL. Timestamps returned but CHUNK-level only -> karaoke needs approximation or forced alignment.');
  else log('NO-GO on REST word timings. Need fallback (even distribution) or WhisperX alignment.');
  log(`raw responses -> ${OUT}`);
};
main().catch((e) => { console.error(e); process.exit(1); });
