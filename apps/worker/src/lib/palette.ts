import { spawn } from 'node:child_process';
import { env } from './env.js';

/**
 * Derive caption colours from the video itself.
 *
 * Rather than guess, sample frames and pick an accent that is present in the footage but
 * still legible over it. Legibility is the hard constraint: a colour lifted straight from
 * the video often has poor contrast against that same video, so candidates are scored on
 * WCAG contrast against the average background and only then on how well they match.
 */

export interface VideoPalette {
  /** Most common colours in the sampled frames, brightest-first. */
  dominant: string[];
  /** Mean luminance of the caption band, 0-1. Decides light vs dark text. */
  bandLuminance: number;
  suggestion: {
    textColor: string;
    accentColor: string;
    keywordColor: string;
    outlineColor: string;
  };
}

interface Rgb {
  r: number;
  g: number;
  b: number;
}

/**
 * Downscale to a tiny grid and read raw pixels. 16x16 over a handful of frames is enough
 * to characterise a palette and costs a fraction of a second, versus decoding full frames.
 */
function samplePixels(input: string, cropFilter: string): Promise<Rgb[]> {
  return new Promise((resolve, reject) => {
    const args = [
      '-hide_banner',
      '-nostdin',
      '-i',
      input,
      // ~6 evenly spread frames, cropped to the region we care about.
      '-vf',
      `${cropFilter}fps=1/4,scale=16:16:flags=area`,
      '-frames:v',
      '6',
      '-f',
      'rawvideo',
      '-pix_fmt',
      'rgb24',
      '-',
    ];
    const p = spawn(env.ffmpegPath, args, { windowsHide: true });
    const chunks: Buffer[] = [];
    p.stdout.on('data', (d: Buffer) => chunks.push(d));
    p.on('error', reject);
    p.on('close', () => {
      const buf = Buffer.concat(chunks);
      const out: Rgb[] = [];
      for (let i = 0; i + 2 < buf.length; i += 3) {
        out.push({ r: buf[i]!, g: buf[i + 1]!, b: buf[i + 2]! });
      }
      resolve(out);
    });
  });
}

const toHex = (c: Rgb) =>
  `#${[c.r, c.g, c.b].map((v) => Math.round(v).toString(16).padStart(2, '0')).join('')}`.toUpperCase();

/** Relative luminance per WCAG 2.1. */
function luminance({ r, g, b }: Rgb): number {
  const ch = [r, g, b].map((v) => {
    const s = v / 255;
    return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * ch[0]! + 0.7152 * ch[1]! + 0.0722 * ch[2]!;
}

function contrast(a: Rgb, b: Rgb): number {
  const la = luminance(a);
  const lb = luminance(b);
  return (Math.max(la, lb) + 0.05) / (Math.min(la, lb) + 0.05);
}

function saturation({ r, g, b }: Rgb): number {
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  return max === 0 ? 0 : (max - min) / max;
}

/** Cluster by quantising to a coarse grid, then rank buckets by population. */
function dominantColors(pixels: Rgb[], count: number): Rgb[] {
  const buckets = new Map<string, { sum: Rgb; n: number }>();
  for (const p of pixels) {
    const key = `${p.r >> 5}-${p.g >> 5}-${p.b >> 5}`;
    const b = buckets.get(key);
    if (b) {
      b.sum.r += p.r;
      b.sum.g += p.g;
      b.sum.b += p.b;
      b.n++;
    } else {
      buckets.set(key, { sum: { ...p }, n: 1 });
    }
  }
  return [...buckets.values()]
    .sort((a, b) => b.n - a.n)
    .slice(0, count)
    .map((b) => ({ r: b.sum.r / b.n, g: b.sum.g / b.n, b: b.sum.b / b.n }));
}

/** Push a colour to full saturation and a readable lightness. */
function vivid(c: Rgb): Rgb {
  const max = Math.max(c.r, c.g, c.b) || 1;
  const scale = 255 / max;
  return { r: Math.min(255, c.r * scale), g: Math.min(255, c.g * scale), b: Math.min(255, c.b * scale) };
}

/** Accent candidates: warm, high-visibility hues that read on almost any footage. */
const FALLBACK_ACCENTS: Rgb[] = [
  { r: 255, g: 212, b: 0 }, // amber
  { r: 0, g: 229, b: 255 }, // cyan
  { r: 61, g: 220, b: 151 }, // mint
  { r: 255, g: 45, b: 149 }, // magenta
];

export async function analysePalette(
  input: string,
  captionBand: { top: number; height: number } = { top: 0.5, height: 0.3 },
): Promise<VideoPalette> {
  // Whole frame for the palette, caption band for the brightness decision.
  const [framePixels, bandPixels] = await Promise.all([
    samplePixels(input, ''),
    samplePixels(input, `crop=iw:ih*${captionBand.height}:0:ih*${captionBand.top},`),
  ]);

  if (framePixels.length === 0) {
    return {
      dominant: [],
      bandLuminance: 0.5,
      suggestion: {
        textColor: '#FFFFFF',
        accentColor: '#FFD400',
        keywordColor: '#FF2D55',
        outlineColor: '#000000',
      },
    };
  }

  const dominant = dominantColors(framePixels, 6);
  const bandAvg = (bandPixels.length ? bandPixels : framePixels).reduce(
    (acc, p) => ({ r: acc.r + p.r / 1, g: acc.g + p.g, b: acc.b + p.b }),
    { r: 0, g: 0, b: 0 },
  );
  const n = (bandPixels.length ? bandPixels : framePixels).length;
  const bg: Rgb = { r: bandAvg.r / n, g: bandAvg.g / n, b: bandAvg.b / n };
  const bandLuminance = luminance(bg);

  // Body text is plain white or near-black — whichever separates from the footage.
  const white: Rgb = { r: 255, g: 255, b: 255 };
  const near: Rgb = { r: 17, g: 17, b: 17 };
  const textColor = contrast(white, bg) >= contrast(near, bg) ? white : near;
  const outlineColor = textColor === white ? near : white;

  /*
   * Accent: prefer a saturated colour drawn from the footage, but only if it clears a
   * 3:1 contrast ratio against the caption band. Otherwise fall back to a known-legible
   * hue — matching the video is worthless if nobody can read the result.
   */
  const candidates = [...dominant.map(vivid), ...FALLBACK_ACCENTS]
    .map((c) => ({ c, score: contrast(c, bg) * 1.4 + saturation(c) * 2 }))
    .filter(({ c }) => contrast(c, bg) >= 3)
    .sort((a, b) => b.score - a.score);

  const accent = candidates[0]?.c ?? FALLBACK_ACCENTS[0]!;
  // Keyword colour: the next distinct candidate, so the two never collide.
  const keyword =
    candidates.find(({ c }) => colourDistance(c, accent) > 90)?.c ?? FALLBACK_ACCENTS[3]!;

  return {
    dominant: dominant.map(toHex),
    bandLuminance: Math.round(bandLuminance * 1000) / 1000,
    suggestion: {
      textColor: toHex(textColor),
      accentColor: toHex(accent),
      keywordColor: toHex(keyword),
      outlineColor: toHex(outlineColor),
    },
  };
}

function colourDistance(a: Rgb, b: Rgb): number {
  return Math.hypot(a.r - b.r, a.g - b.g, a.b - b.b);
}
