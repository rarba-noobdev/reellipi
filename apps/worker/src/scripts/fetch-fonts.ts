/**
 * Download the Noto families the renderer needs into apps/worker/fonts/.
 *
 * Fonts are bundled rather than relied upon from the host: Railway's base images have
 * no Indic fonts, and a missing family renders as tofu boxes rather than failing loudly.
 * All Noto fonts are SIL OFL 1.1 — redistribution in a container is permitted.
 */
import fs from 'node:fs/promises';
import path from 'node:path';

const FONT_DIR = path.resolve('fonts');

const GF = 'https://raw.githubusercontent.com/google/fonts/main';

/**
 * Display faces used by the real caption styles creators copy.
 *
 * All SIL OFL 1.1, so bundling them in the render image is permitted. None of them
 * cover Indic scripts — libass falls back to Noto per glyph via fontconfig, so a
 * code-mixed line renders Latin in the display face and Tamil/Devanagari in Noto.
 * Presets meant for native-script output should pick a Noto family directly.
 */
const DISPLAY_FONTS: Array<{ file: string; url: string }> = [
  // google/fonts now ships Montserrat variable-only, and a variable TTF renders at its
  // default 400 weight in libass — useless for a Black-weight caption style. Upstream
  // still publishes the statics.
  {
    file: 'Montserrat-Black.ttf',
    url: 'https://raw.githubusercontent.com/JulietaUla/Montserrat/master/fonts/ttf/Montserrat-Black.ttf',
  },
  {
    file: 'Montserrat-Bold.ttf',
    url: 'https://raw.githubusercontent.com/JulietaUla/Montserrat/master/fonts/ttf/Montserrat-Bold.ttf',
  },
  { file: 'Anton-Regular.ttf', url: `${GF}/ofl/anton/Anton-Regular.ttf` },
  { file: 'BebasNeue-Regular.ttf', url: `${GF}/ofl/bebasneue/BebasNeue-Regular.ttf` },
  { file: 'Poppins-Bold.ttf', url: `${GF}/ofl/poppins/Poppins-Bold.ttf` },
  { file: 'Poppins-ExtraBold.ttf', url: `${GF}/ofl/poppins/Poppins-ExtraBold.ttf` },
  { file: 'Bangers-Regular.ttf', url: `${GF}/ofl/bangers/Bangers-Regular.ttf` },
  /*
   * Emoji. Without this libass falls back to whatever the host happens to have — a flat
   * monochrome glyph on Windows, and nothing at all inside the Docker image, where an
   * emoji would render as a tofu box. Noto Color Emoji is a CBDT colour-bitmap font,
   * which libass has supported since 0.15.
   */
  {
    file: 'NotoColorEmoji.ttf',
    url: 'https://raw.githubusercontent.com/googlefonts/noto-emoji/main/fonts/NotoColorEmoji.ttf',
  },
];

/** Static TTFs from the notofonts.github.io mirror, which serves stable paths. */
const FONTS: Array<{ file: string; url: string }> = [
  {
    file: 'NotoSans-Regular.ttf',
    url: 'https://raw.githubusercontent.com/notofonts/notofonts.github.io/main/fonts/NotoSans/hinted/ttf/NotoSans-Regular.ttf',
  },
  {
    file: 'NotoSans-Bold.ttf',
    url: 'https://raw.githubusercontent.com/notofonts/notofonts.github.io/main/fonts/NotoSans/hinted/ttf/NotoSans-Bold.ttf',
  },
  {
    file: 'NotoSansTamil-Regular.ttf',
    url: 'https://raw.githubusercontent.com/notofonts/notofonts.github.io/main/fonts/NotoSansTamil/hinted/ttf/NotoSansTamil-Regular.ttf',
  },
  {
    file: 'NotoSansTamil-Bold.ttf',
    url: 'https://raw.githubusercontent.com/notofonts/notofonts.github.io/main/fonts/NotoSansTamil/hinted/ttf/NotoSansTamil-Bold.ttf',
  },
  {
    file: 'NotoSansDevanagari-Regular.ttf',
    url: 'https://raw.githubusercontent.com/notofonts/notofonts.github.io/main/fonts/NotoSansDevanagari/hinted/ttf/NotoSansDevanagari-Regular.ttf',
  },
  {
    file: 'NotoSansDevanagari-Bold.ttf',
    url: 'https://raw.githubusercontent.com/notofonts/notofonts.github.io/main/fonts/NotoSansDevanagari/hinted/ttf/NotoSansDevanagari-Bold.ttf',
  },
  {
    file: 'NotoSansTelugu-Bold.ttf',
    url: 'https://raw.githubusercontent.com/notofonts/notofonts.github.io/main/fonts/NotoSansTelugu/hinted/ttf/NotoSansTelugu-Bold.ttf',
  },
  {
    file: 'NotoSansKannada-Bold.ttf',
    url: 'https://raw.githubusercontent.com/notofonts/notofonts.github.io/main/fonts/NotoSansKannada/hinted/ttf/NotoSansKannada-Bold.ttf',
  },
  {
    file: 'NotoSansMalayalam-Bold.ttf',
    url: 'https://raw.githubusercontent.com/notofonts/notofonts.github.io/main/fonts/NotoSansMalayalam/hinted/ttf/NotoSansMalayalam-Bold.ttf',
  },
  {
    file: 'NotoSansBengali-Bold.ttf',
    url: 'https://raw.githubusercontent.com/notofonts/notofonts.github.io/main/fonts/NotoSansBengali/hinted/ttf/NotoSansBengali-Bold.ttf',
  },
  {
    file: 'NotoSansGujarati-Bold.ttf',
    url: 'https://raw.githubusercontent.com/notofonts/notofonts.github.io/main/fonts/NotoSansGujarati/hinted/ttf/NotoSansGujarati-Bold.ttf',
  },
  {
    file: 'NotoSansGurmukhi-Bold.ttf',
    url: 'https://raw.githubusercontent.com/notofonts/notofonts.github.io/main/fonts/NotoSansGurmukhi/hinted/ttf/NotoSansGurmukhi-Bold.ttf',
  },
];

/** A TTF starts with 0x00010000, and OpenType/CFF with 'OTTO'. */
function looksLikeFont(buf: Buffer): boolean {
  if (buf.length < 4) return false;
  const tag = buf.readUInt32BE(0);
  return tag === 0x00010000 || buf.toString('ascii', 0, 4) === 'OTTO' || buf.toString('ascii', 0, 4) === 'true';
}

async function main() {
  await fs.mkdir(FONT_DIR, { recursive: true });
  let ok = 0;
  const failed: string[] = [];
  const all = [...FONTS, ...DISPLAY_FONTS];

  for (const f of all) {
    const dest = path.join(FONT_DIR, f.file);
    const existing = await fs.stat(dest).catch(() => null);
    if (existing && existing.size > 10_000) {
      console.log(`  cached  ${f.file} (${(existing.size / 1024).toFixed(0)} KB)`);
      ok++;
      continue;
    }
    try {
      const res = await fetch(f.url);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const buf = Buffer.from(await res.arrayBuffer());
      if (!looksLikeFont(buf)) throw new Error(`not a font payload (${buf.length} bytes)`);
      await fs.writeFile(dest, buf);
      console.log(`  fetched ${f.file} (${(buf.length / 1024).toFixed(0)} KB)`);
      ok++;
    } catch (e) {
      console.warn(`  FAILED  ${f.file}: ${(e as Error).message}`);
      failed.push(f.file);
    }
  }

  console.log(`\n${ok}/${all.length} fonts available in ${FONT_DIR}`);
  if (failed.length) {
    console.warn('Missing fonts render as tofu boxes. Retry or drop the TTFs in manually.');
    process.exitCode = 1;
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
