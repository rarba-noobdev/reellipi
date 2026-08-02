/**
 * Mirror of the worker's lib/captionStyle.ts.
 *
 * Kept in sync by hand rather than shared through a package: the worker is deployed
 * separately and this avoids a build-order dependency between the two apps. If a field
 * is added there, add it here or the preview silently stops matching the render.
 */

export type AnimationMode =
  | 'karaoke'
  | 'pop'
  | 'wave'
  | 'bounce'
  | 'fade'
  | 'slide'
  | 'typewriter'
  | 'none';

export type BackgroundMode = 'none' | 'box' | 'perWord';

export const ANIMATION_CHOICES: Array<{ id: AnimationMode; label: string; hint: string }> = [
  { id: 'karaoke', label: 'Karaoke', hint: 'Fills as spoken' },
  { id: 'pop', label: 'Pop', hint: 'Active word grows' },
  { id: 'wave', label: 'Wave', hint: 'Words ride a curve' },
  { id: 'bounce', label: 'Bounce', hint: 'Springs then settles' },
  { id: 'typewriter', label: 'Typewriter', hint: 'Appear one by one' },
  { id: 'fade', label: 'Fade', hint: 'Soft in and out' },
  { id: 'slide', label: 'Slide', hint: 'Rises into place' },
  { id: 'none', label: 'Static', hint: 'No effect' },
];

export interface CaptionStyle {
  id: string;
  label: string;
  description: string;

  fontFamily: string;
  fontSizePct: number;
  bold: boolean;
  italic: boolean;
  uppercase: boolean;
  /** 'strip' removes sentence-final marks from the burned-in caption only. */
  punctuation: 'keep' | 'strip';
  letterSpacing: number;
  lineSpacing: number;

  textColor: string;
  accentColor: string;
  keywordColor: string;
  /** 'fill' recolours the glyph; 'outline' recolours the border and clashes more. */
  keywordStyle: 'none' | 'fill' | 'outline';

  outlineColor: string;
  outlineWidthPct: number;
  shadowColor: string;
  shadowDepthPct: number;

  background: BackgroundMode;
  backgroundColor: string;
  backgroundOpacity: number;

  positionY: number;
  positionX: number;
  marginXPct: number;

  animation: AnimationMode;
  popScale: number;
  waveAmplitudePct: number;

  maxWordsPerCue: number;
  maxLines: number;
  maxCharsPerLine: number;
  minDurationSec: number;
  maxDurationSec: number;
}

export interface FontChoice {
  family: string;
  label: string;
  indic: boolean;
}

/**
 * Map a bundled family name to a CSS font stack for the preview.
 *
 * The renderer resolves these through fontconfig against the TTFs in the worker image;
 * the browser needs the Google Fonts webfont equivalents, plus a weight, since CSS has
 * no "Montserrat Black" family — it is Montserrat at 900.
 */
export function cssFontFor(family: string): { fontFamily: string; fontWeight: number } {
  switch (family) {
    case 'Montserrat Black':
      return { fontFamily: "'Montserrat', sans-serif", fontWeight: 900 };
    case 'Montserrat Bold':
      return { fontFamily: "'Montserrat', sans-serif", fontWeight: 700 };
    case 'Poppins ExtraBold':
      return { fontFamily: "'Poppins', sans-serif", fontWeight: 800 };
    case 'Poppins Bold':
      return { fontFamily: "'Poppins', sans-serif", fontWeight: 700 };
    case 'Anton':
      return { fontFamily: "'Anton', sans-serif", fontWeight: 400 };
    case 'Bebas Neue':
      return { fontFamily: "'Bebas Neue', sans-serif", fontWeight: 400 };
    case 'Bangers':
      return { fontFamily: "'Bangers', cursive", fontWeight: 400 };
    case 'Inter Bold':
      return { fontFamily: "'Inter', sans-serif", fontWeight: 700 };
    case 'Noto Sans Tamil':
      return { fontFamily: "'Noto Sans Tamil', sans-serif", fontWeight: 700 };
    case 'Noto Sans Devanagari':
      return { fontFamily: "'Noto Sans Devanagari', sans-serif", fontWeight: 700 };
    default:
      return { fontFamily: "'Noto Sans', sans-serif", fontWeight: 700 };
  }
}

/** Latin display faces carry no Indic glyphs; steer native script to a Noto family. */
export function fontForLanguage(languageCode: string | null | undefined): string {
  const lang = (languageCode ?? '').toLowerCase();
  if (lang.startsWith('ta')) return 'Noto Sans Tamil';
  if (/^(hi|mr|ne|sa)/.test(lang)) return 'Noto Sans Devanagari';
  return 'Noto Sans';
}

export function needsIndicFont(text: string): boolean {
  return /[ऀ-෿]/.test(text);
}

/**
 * Approximate advance width in ems. Mirrors estimateEms in the worker's ass.ts so the
 * preview shrinks oversized lines exactly like the renderer does.
 */
export function estimateEms(text: string): number {
  let ems = 0;
  for (const ch of text) {
    const code = ch.codePointAt(0)!;
    if (code === 0x20) ems += 0.26;
    else if (/\p{Mn}|\p{Mc}/u.test(ch)) ems += 0.08;
    else if (code >= 0x0900 && code <= 0x0dff) ems += 0.62;
    else if (/[A-Z0-9]/.test(ch)) ems += 0.62;
    else if (/[ilj.,'!|:;]/.test(ch)) ems += 0.28;
    else if (/[mw]/.test(ch)) ems += 0.86;
    else ems += 0.55;
  }
  return ems;
}

/**
 * Shrink the font until the widest line fits the usable width — the same guard the
 * renderer applies. Without it the preview shows text overflowing the frame that would
 * actually be scaled down in the exported video.
 */
/**
 * Per-family width multiplier. Must stay identical to FAMILY_WIDTH in the worker's
 * ass.ts — estimateEms is calibrated for an average sans, and heavy display faces are
 * far wider per glyph while condensed ones are much narrower.
 */
const FAMILY_WIDTH: Record<string, number> = {
  'Montserrat Black': 1.28,
  'Montserrat Bold': 1.18,
  'Poppins ExtraBold': 1.2,
  'Poppins Bold': 1.14,
  Anton: 0.92,
  'Bebas Neue': 0.72,
  Bangers: 0.88,
  'Inter Bold': 1.06,
};

export function fitFontSize(
  lines: string[],
  style: CaptionStyle,
  frameWidth: number,
  requestedSize: number,
): number {
  const marginX = (style.marginXPct / 100) * frameWidth;
  const outline = (style.outlineWidthPct / 100) * frameWidth;
  const usable = frameWidth - marginX * 2 - outline * 2;
  const familyFactor = FAMILY_WIDTH[style.fontFamily] ?? 1;
  let widest = 0;
  for (const line of lines) {
    const text = style.uppercase ? line.toUpperCase() : line;
    widest = Math.max(widest, estimateEms(text) * familyFactor);
  }
  if (widest <= 0 || usable <= 0) return requestedSize;
  return Math.max(8, Math.min(requestedSize, usable / widest));
}

/**
 * Fractions of the frame Instagram's own UI covers.
 *
 * Meta publishes 14% top / 35% bottom / 6% sides for Reels, with the right rail about
 * 90px of a 1080px width. Keep in step with IG_OCCLUSION in InstagramChrome.tsx.
 */
export const IG_OCCLUSION = {
  topPct: 0.14,
  bottomPct: 0.35,
  rightRailPct: 0.09,
} as const;

/**
 * Which parts of Instagram's UI the captions will sit under.
 *
 * Evaluated across ALL cues rather than whichever one is on screen: measuring the live
 * cue made the warning appear and vanish as playback moved between short and long
 * lines, which flickered and shifted the layout. The worst case is what the creator
 * needs to fix, and it stays constant until the style changes.
 */
export function detectCollisions(
  cues: Array<{ lines: string[] }>,
  style: CaptionStyle,
): string[] {
  if (cues.length === 0) return [];

  const familyFactor = FAMILY_WIDTH[style.fontFamily] ?? 1;
  const usable = 1 - (style.marginXPct / 100) * 2;

  let widestFrac = 0;
  let maxLines = 1;
  for (const cue of cues) {
    maxLines = Math.max(maxLines, cue.lines.length);
    for (const line of cue.lines) {
      const text = style.uppercase ? line.toUpperCase() : line;
      // Width in frame-widths, after the same auto-fit shrink the renderer applies.
      const ems = estimateEms(text) * familyFactor;
      const sizeFrac = Math.min(style.fontSizePct / 100, usable / Math.max(ems, 0.001));
      widestFrac = Math.max(widestFrac, ems * sizeFrac);
    }
  }

  // fontSizePct is a share of HEIGHT; a line box is roughly 1.25x the font size.
  const blockHeight = (style.fontSizePct / 100) * maxLines * style.lineSpacing * 1.25;
  const top = style.positionY - blockHeight / 2;
  const bottom = style.positionY + blockHeight / 2;
  const right = style.positionX + widestFrac / 2;

  const zones: string[] = [];
  if (bottom > 1 - IG_OCCLUSION.bottomPct) zones.push('caption & audio row');
  if (top < IG_OCCLUSION.topPct) zones.push('Reels header');
  if (right > 1 - IG_OCCLUSION.rightRailPct && bottom > 0.3) zones.push('action buttons');
  return zones;
}

/** `#RRGGBB` + 0..1 alpha -> `rgba(...)`, for the preview's background plate. */
export function withAlpha(hex: string, alpha: number): string {
  const m = /^#?([0-9a-f]{6})$/i.exec(hex ?? '');
  if (!m) return `rgba(0,0,0,${alpha})`;
  const v = m[1]!;
  const r = parseInt(v.slice(0, 2), 16);
  const g = parseInt(v.slice(2, 4), 16);
  const b = parseInt(v.slice(4, 6), 16);
  return `rgba(${r},${g},${b},${alpha})`;
}

/**
 * Outline via text-shadow rather than -webkit-text-stroke: the stroke property centres
 * on the glyph edge and eats into the letterform, while libass draws the border
 * outside it. Eight offsets approximate a round join closely enough at preview size.
 */
export function outlineShadow(color: string, widthPx: number): string {
  if (widthPx <= 0) return 'none';
  const w = widthPx;
  const d = w * 0.71;
  return [
    `${-w}px 0 0 ${color}`,
    `${w}px 0 0 ${color}`,
    `0 ${-w}px 0 ${color}`,
    `0 ${w}px 0 ${color}`,
    `${-d}px ${-d}px 0 ${color}`,
    `${d}px ${-d}px 0 ${color}`,
    `${-d}px ${d}px 0 ${color}`,
    `${d}px ${d}px 0 ${color}`,
  ].join(', ');
}
