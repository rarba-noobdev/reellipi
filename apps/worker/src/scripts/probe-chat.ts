/** Inspect the raw shape of a sarvam-105b chat completion. */
import { env } from '../lib/env.js';

async function call(label: string, body: Record<string, unknown>) {
  const res = await fetch('https://api.sarvam.ai/v1/chat/completions', {
    method: 'POST',
    headers: {
      'api-subscription-key': env.sarvamKey,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ model: 'sarvam-105b', ...body }),
  });
  const text = await res.text();
  console.log(`\n=== ${label} -> ${res.status} ===`);
  if (!res.ok) {
    console.log(text.slice(0, 600));
    return;
  }
  const j = JSON.parse(text) as any;
  const msg = j.choices?.[0]?.message ?? {};
  console.log('choice keys   :', Object.keys(j.choices?.[0] ?? {}).join(', '));
  console.log('message keys  :', Object.keys(msg).join(', '));
  console.log('finish_reason :', j.choices?.[0]?.finish_reason);
  console.log('usage         :', JSON.stringify(j.usage));
  for (const k of Object.keys(msg)) {
    const v = msg[k];
    if (typeof v === 'string') console.log(`  ${k} (${v.length} chars): ${JSON.stringify(v.slice(0, 400))}`);
    else console.log(`  ${k}:`, JSON.stringify(v)?.slice(0, 200));
  }
}

const messages = [
  { role: 'system', content: 'Reply with ONLY a JSON object: {"ok":true,"note":"<short string>"}' },
  { role: 'user', content: 'Group these tokens: 0 Vanakkam, 1 friends, 2 eppadi' },
];

await call('plain', { messages, temperature: 0.2 });
await call('reasoning_effort=low', { messages, temperature: 0.2, reasoning_effort: 'low' });
await call('max_tokens 2000', { messages, temperature: 0.2, max_tokens: 2000 });
await call('json_object', { messages, temperature: 0.2, max_tokens: 2000, response_format: { type: 'json_object' } });
