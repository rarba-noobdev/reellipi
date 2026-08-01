/** Inspect the colour suggestion for a clip: npx tsx src/scripts/check-palette.ts <video> */
import { analysePalette } from '../lib/palette.js';

const input = process.argv[2];
if (!input) throw new Error('Usage: check-palette.ts <video>');

const t0 = Date.now();
const p = await analysePalette(input, { top: 0.5, height: 0.3 });
console.log(`analysed in ${Date.now() - t0}ms\n`);
console.log('dominant colours :', p.dominant.join('  '));
console.log('band luminance   :', p.bandLuminance, p.bandLuminance > 0.5 ? '(bright)' : '(dark)');
console.log('\nsuggested caption colours');
for (const [k, v] of Object.entries(p.suggestion)) {
  console.log(`  ${k.padEnd(13)} ${v}`);
}
