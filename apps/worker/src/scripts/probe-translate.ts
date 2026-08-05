/** Verify Sarvam's translate endpoint against the live API before building on it. */
import { env } from '../lib/env.js';

const BASE = 'https://api.sarvam.ai';

async function call(label: string, body: Record<string, unknown>) {
  const res = await fetch(`${BASE}/translate`, {
    method: 'POST',
    headers: { 'api-subscription-key': env.sarvamKey, 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  const text = await res.text();
  console.log(`\n=== ${label} -> ${res.status} ===`);
  if (!res.ok) {
    console.log('  ' + text.slice(0, 400));
    return;
  }
  const j = JSON.parse(text) as Record<string, unknown>;
  console.log('  keys       :', Object.keys(j).join(', '));
  console.log('  translated :', JSON.stringify(j.translated_text));
  if (j.source_language_code) console.log('  detected   :', j.source_language_code);
}

const TANGLISH = 'Indha video-la naan oru super tip share panren. Definitely try pannunga.';

await call('ta-IN -> en-IN (mayura)', {
  input: TANGLISH,
  source_language_code: 'ta-IN',
  target_language_code: 'en-IN',
  model: 'mayura:v1',
});

await call('auto -> en-IN', {
  input: TANGLISH,
  source_language_code: 'auto',
  target_language_code: 'en-IN',
  model: 'mayura:v1',
});

await call('ta-IN -> hi-IN', {
  input: TANGLISH,
  source_language_code: 'ta-IN',
  target_language_code: 'hi-IN',
  model: 'mayura:v1',
});

await call('ta-IN -> hi-IN roman script', {
  input: TANGLISH,
  source_language_code: 'ta-IN',
  target_language_code: 'hi-IN',
  model: 'mayura:v1',
  output_script: 'roman',
});

await call('sarvam-translate:v1 ta-IN -> te-IN', {
  input: TANGLISH,
  source_language_code: 'ta-IN',
  target_language_code: 'te-IN',
  model: 'sarvam-translate:v1',
});

await call('ta-IN -> en-IN code-mixed mode', {
  input: TANGLISH,
  source_language_code: 'ta-IN',
  target_language_code: 'en-IN',
  model: 'mayura:v1',
  mode: 'code-mixed',
});
