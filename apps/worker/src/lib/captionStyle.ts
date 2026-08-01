/**
 * Caption style model.
 *
 * Every field here is user-editable and is honoured by both the ASS renderer
 * (lib/ass.ts) and the browser preview, so what the editor shows is what burns in.
 *
 * Sizes are expressed as a percentage of FRAME HEIGHT rather than in pixels: a reel may
 * arrive at 720x1280 or 1080x1920, and a fixed pixel size would render at different
 * apparent scales. Percentages keep a preset looking identical at any resolution.
 */

export type AnimationMode =
  /** Every word spoken so far stays in the accent colour. */
  | 'karaoke'
  /** Only the word being spoken is accented, and it scales up. */
  | 'pop'
  /** Words sit on a static sine curve, and the active word rides a travelling bump. */
  | 'wave'
  /** Active word springs past its final size and settles. */
  | 'bounce'
  /** Each cue fades in and out. */
  | 'fade'
  /** Each cue slides up into place. */
  | 'slide'
  /** Words appear one at a time and stay. */
  | 'typewriter'
  /** Whole cue appears at once, no per-word treatment. */
  | 'none';

/** Modes that need one ASS event per word rather than one per cue. */
export const PER_WORD_ANIMATIONS: AnimationMode[] = ['pop', 'wave', 'bounce', 'typewriter'];

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

export type BackgroundMode = 'none' | 'box' | 'perWord';

export interface CaptionStyle {
  id: string;
  label: string;
  /** Short note shown in the preset picker. */
  description: string;

  fontFamily: string;
  /** Cap height as a percentage of frame height. 4.5 ≈ 86px on a 1920-tall frame. */
  fontSizePct: number;
  bold: boolean;
  italic: boolean;
  uppercase: boolean;
  /** Extra tracking in pixels at 1080 width, scaled with the frame. */
  letterSpacing: number;
  /** Multiplier on the font's natural line height. */
  lineSpacing: number;

  textColor: string;
  /** Applied by the animation mode. */
  accentColor: string;
  /** Outline recolour for words the styling pass marked as keywords. */
  keywordColor: string;

  outlineColor: string;
  /** Outline width as a percentage of frame height, so it scales with the text. */
  outlineWidthPct: number;
  shadowColor: string;
  shadowDepthPct: number;

  background: BackgroundMode;
  backgroundColor: string;
  /** 0 transparent, 1 opaque. */
  backgroundOpacity: number;

  /** Vertical centre of the caption block, 0 = top, 1 = bottom. */
  positionY: number;
  /** Horizontal centre of the caption block, 0 = left, 1 = right. */
  positionX: number;
  /** Horizontal safe margin per side, as a percentage of frame width. */
  marginXPct: number;

  animation: AnimationMode;
  /** Scale applied to the active word in pop/bounce, in percent. */
  popScale: number;
  /** Peak vertical travel of the wave, as a percentage of frame height. */
  waveAmplitudePct: number;

  /** Caption density. Real styles show very few words at a time. */
  maxWordsPerCue: number;
  maxLines: number;
  maxCharsPerLine: number;

  /** Shortest a cue may stay on screen, in seconds. Below ~0.5s it reads as flicker. */
  minDurationSec: number;
  /** Longest a cue may linger, in seconds. */
  maxDurationSec: number;
}

/** Resolve percentage-based fields against a real frame size. */
export interface ResolvedMetrics {
  fontSize: number;
  outlineWidth: number;
  shadowDepth: number;
  marginX: number;
  /** Absolute anchor for `\pos`, in frame pixels. The block is centred on this point. */
  posX: number;
  posY: number;
  letterSpacing: number;
}

export function resolveMetrics(style: CaptionStyle, width: number, height: number): ResolvedMetrics {
  return {
    fontSize: Math.round((style.fontSizePct / 100) * height),
    outlineWidth: Math.max(0, (style.outlineWidthPct / 100) * height),
    shadowDepth: Math.max(0, (style.shadowDepthPct / 100) * height),
    marginX: Math.round((style.marginXPct / 100) * width),
    posX: Math.round(style.positionX * width),
    posY: Math.round(style.positionY * height),
    letterSpacing: (style.letterSpacing * width) / 1080,
  };
}

const BASE: Omit<CaptionStyle, 'id' | 'label' | 'description'> = {
  fontFamily: 'Montserrat Black',
  fontSizePct: 4.2,
  bold: true,
  italic: false,
  uppercase: false,
  letterSpacing: 0,
  lineSpacing: 1,
  textColor: '#FFFFFF',
  accentColor: '#FFD93D',
  keywordColor: '#FF2D55',
  outlineColor: '#000000',
  outlineWidthPct: 0.42,
  shadowColor: '#000000',
  shadowDepthPct: 0.1,
  background: 'none',
  backgroundColor: '#000000',
  backgroundOpacity: 0.6,
  positionY: 0.65,
  positionX: 0.5,
  marginXPct: 11,
  animation: 'karaoke',
  popScale: 118,
  waveAmplitudePct: 1.2,
  maxWordsPerCue: 5,
  maxLines: 2,
  maxCharsPerLine: 22,
  minDurationSec: 0.7,
  maxDurationSec: 7,
};

/**
 * Presets modelled on the caption styles creators actually copy. Numbers come from
 * published breakdowns of each style, normalised to a 1080x1920 frame.
 */
export const PRESETS: Record<string, CaptionStyle> = {
  hormozi: {
    ...BASE,
    id: 'hormozi',
    label: 'Hormozi',
    description: 'All-caps Montserrat Black, heavy stroke, yellow keyword',
    fontFamily: 'Montserrat Black',
    fontSizePct: 4.6,
    uppercase: true,
    // Published breakdowns put the stroke at 8-12px on a 1920-tall frame.
    outlineWidthPct: 0.52,
    accentColor: '#FFD93D',
    keywordColor: '#FFD93D',
    animation: 'pop',
    popScale: 112,
    maxWordsPerCue: 3,
    maxLines: 2,
    maxCharsPerLine: 18,
  },
  mrbeast: {
    ...BASE,
    id: 'mrbeast',
    label: 'MrBeast',
    description: 'Bangers, punchy, coloured emphasis words',
    fontFamily: 'Bangers',
    fontSizePct: 5.2,
    bold: false,
    uppercase: false,
    outlineWidthPct: 0.3,
    accentColor: '#FFE600',
    keywordColor: '#FF3B30',
    animation: 'pop',
    popScale: 122,
    maxWordsPerCue: 3,
    maxLines: 1,
    maxCharsPerLine: 20,
  },
  karaoke_bold: {
    ...BASE,
    id: 'karaoke_bold',
    label: 'Karaoke',
    description: 'Words fill with colour as they are spoken',
    fontFamily: 'Poppins ExtraBold',
    animation: 'karaoke',
    accentColor: '#FFD400',
    maxWordsPerCue: 5,
  },
  clean_center: {
    ...BASE,
    id: 'clean_center',
    label: 'Clean',
    description: 'Understated, no per-word effect',
    fontFamily: 'Poppins Bold',
    fontSizePct: 3.6,
    outlineWidthPct: 0.22,
    animation: 'none',
    accentColor: '#FFFFFF',
    maxWordsPerCue: 7,
    maxCharsPerLine: 26,
  },
  subtitle_box: {
    ...BASE,
    id: 'subtitle_box',
    label: 'Boxed',
    description: 'Dark plate behind the text, maximum legibility',
    fontFamily: 'Inter Bold',
    fontSizePct: 3.4,
    outlineWidthPct: 0,
    shadowDepthPct: 0,
    background: 'box',
    backgroundOpacity: 0.72,
    animation: 'none',
    positionY: 0.72,
    maxWordsPerCue: 8,
    maxCharsPerLine: 28,
  },
  bebas_tall: {
    ...BASE,
    id: 'bebas_tall',
    label: 'Condensed',
    description: 'Tall condensed caps, fits more per line',
    fontFamily: 'Bebas Neue',
    fontSizePct: 5.4,
    bold: false,
    uppercase: true,
    letterSpacing: 1.5,
    outlineWidthPct: 0.36,
    accentColor: '#3DDC97',
    animation: 'karaoke',
    maxWordsPerCue: 4,
    maxCharsPerLine: 24,
  },
  wavy: {
    ...BASE,
    id: 'wavy',
    label: 'Wavy',
    description: 'Words sit on a curve, gold fill, deep shadow',
    fontFamily: 'Bangers',
    fontSizePct: 4.8,
    bold: false,
    textColor: '#FFD400',
    accentColor: '#FFFFFF',
    keywordColor: '#FF3B30',
    outlineColor: '#3A2400',
    outlineWidthPct: 0.34,
    shadowDepthPct: 0.24,
    animation: 'wave',
    waveAmplitudePct: 1.4,
    maxWordsPerCue: 4,
    maxCharsPerLine: 20,
  },
  neon_pop: {
    ...BASE,
    id: 'neon_pop',
    label: 'Neon',
    description: 'Electric accent on near-black outline, high contrast',
    fontFamily: 'Poppins ExtraBold',
    fontSizePct: 4.4,
    uppercase: true,
    letterSpacing: 0.5,
    textColor: '#FFFFFF',
    accentColor: '#00E5FF',
    keywordColor: '#FF2D95',
    outlineColor: '#050510',
    outlineWidthPct: 0.44,
    shadowDepthPct: 0.16,
    animation: 'bounce',
    popScale: 124,
    maxWordsPerCue: 3,
    maxCharsPerLine: 18,
  },
  minimal_caps: {
    ...BASE,
    id: 'minimal_caps',
    label: 'Minimal Caps',
    description: 'Tight tracked caps, thin outline, no colour shift',
    fontFamily: 'Inter Bold',
    fontSizePct: 3.2,
    uppercase: true,
    letterSpacing: 2,
    textColor: '#FFFFFF',
    accentColor: '#FFFFFF',
    outlineColor: '#000000',
    outlineWidthPct: 0.16,
    shadowDepthPct: 0.14,
    animation: 'fade',
    maxWordsPerCue: 6,
    maxCharsPerLine: 26,
  },
  typewriter_mono: {
    ...BASE,
    id: 'typewriter_mono',
    label: 'Typewriter',
    description: 'Words land one at a time, documentary feel',
    fontFamily: 'Inter Bold',
    fontSizePct: 3.4,
    textColor: '#FFFFFF',
    accentColor: '#FFE600',
    outlineColor: '#000000',
    outlineWidthPct: 0.24,
    animation: 'typewriter',
    maxWordsPerCue: 5,
    maxCharsPerLine: 24,
  },
  sunset_slide: {
    ...BASE,
    id: 'sunset_slide',
    label: 'Sunset',
    description: 'Warm cream on deep brown, rises into frame',
    fontFamily: 'Montserrat Bold',
    fontSizePct: 3.8,
    textColor: '#FFF3D6',
    accentColor: '#FFB300',
    keywordColor: '#FF6B35',
    outlineColor: '#2B1A0E',
    outlineWidthPct: 0.34,
    shadowDepthPct: 0.2,
    animation: 'slide',
    maxWordsPerCue: 5,
    maxCharsPerLine: 22,
  },
  indic_native: {
    ...BASE,
    id: 'indic_native',
    label: 'Indic Native',
    description: 'Noto family — use for Tamil/Devanagari script output',
    fontFamily: 'Noto Sans Tamil',
    fontSizePct: 3.8,
    animation: 'karaoke',
    accentColor: '#FFD400',
    maxWordsPerCue: 5,
    maxCharsPerLine: 20,
  },
};

export const DEFAULT_PRESET_ID = 'karaoke_bold';

/** Families bundled in the render image, for the editor's font picker. */
export const FONT_CHOICES: Array<{ family: string; label: string; indic: boolean }> = [
  { family: 'Montserrat Black', label: 'Montserrat Black', indic: false },
  { family: 'Montserrat Bold', label: 'Montserrat Bold', indic: false },
  { family: 'Anton', label: 'Anton', indic: false },
  { family: 'Bebas Neue', label: 'Bebas Neue', indic: false },
  { family: 'Poppins ExtraBold', label: 'Poppins ExtraBold', indic: false },
  { family: 'Poppins Bold', label: 'Poppins Bold', indic: false },
  { family: 'Bangers', label: 'Bangers', indic: false },
  { family: 'Inter Bold', label: 'Inter Bold', indic: false },
  { family: 'Noto Sans', label: 'Noto Sans', indic: true },
  { family: 'Noto Sans Tamil', label: 'Noto Sans Tamil', indic: true },
  { family: 'Noto Sans Devanagari', label: 'Noto Sans Devanagari', indic: true },
];

/**
 * Latin display faces carry no Indic glyphs. libass falls back per glyph via
 * fontconfig, which works but mixes two designs mid-line, so native-script output gets
 * steered to a matching Noto family instead.
 */
export function fontForLanguage(languageCode: string | null | undefined): string {
  const lang = (languageCode ?? '').toLowerCase();
  if (lang.startsWith('ta')) return 'Noto Sans Tamil';
  if (/^(hi|mr|ne|sa|kok|doi|mai|brx)/.test(lang)) return 'Noto Sans Devanagari';
  if (lang.startsWith('te')) return 'Noto Sans Telugu';
  if (lang.startsWith('kn')) return 'Noto Sans Kannada';
  if (lang.startsWith('ml')) return 'Noto Sans Malayalam';
  if (lang.startsWith('bn') || lang.startsWith('as')) return 'Noto Sans Bengali';
  if (lang.startsWith('gu')) return 'Noto Sans Gujarati';
  if (lang.startsWith('pa')) return 'Noto Sans Gurmukhi';
  return 'Noto Sans';
}

/** True when the text contains glyphs a Latin display face cannot render. */
export function needsIndicFont(text: string): boolean {
  return /[ऀ-෿]/.test(text);
}

export function resolvePreset(id: string | null | undefined): CaptionStyle {
  return PRESETS[id ?? ''] ?? PRESETS[DEFAULT_PRESET_ID]!;
}

/** Merge user overrides onto a preset, clamping anything that could break a render. */
export function applyOverrides(base: CaptionStyle, overrides: Partial<CaptionStyle> = {}): CaptionStyle {
  const merged = { ...base, ...overrides };
  const clamp = (n: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, n));
  return {
    ...merged,
    fontSizePct: clamp(Number(merged.fontSizePct) || base.fontSizePct, 1.5, 12),
    outlineWidthPct: clamp(Number(merged.outlineWidthPct) ?? base.outlineWidthPct, 0, 1.5),
    shadowDepthPct: clamp(Number(merged.shadowDepthPct) ?? base.shadowDepthPct, 0, 1.5),
    backgroundOpacity: clamp(Number(merged.backgroundOpacity) ?? base.backgroundOpacity, 0, 1),
    // Keep the block clear of Instagram's own top and bottom overlays.
    positionY: clamp(Number(merged.positionY) || base.positionY, 0.06, 0.94),
    positionX: clamp(Number(merged.positionX) ?? base.positionX, 0.06, 0.94),
    marginXPct: clamp(Number(merged.marginXPct) ?? base.marginXPct, 0, 30),
    popScale: clamp(Number(merged.popScale) || base.popScale, 100, 160),
    waveAmplitudePct: clamp(Number(merged.waveAmplitudePct) ?? base.waveAmplitudePct, 0, 5),
    letterSpacing: clamp(Number(merged.letterSpacing) ?? base.letterSpacing, -5, 20),
    lineSpacing: clamp(Number(merged.lineSpacing) || base.lineSpacing, 0.7, 2),
    maxWordsPerCue: Math.round(clamp(Number(merged.maxWordsPerCue) || base.maxWordsPerCue, 1, 12)),
    maxLines: Math.round(clamp(Number(merged.maxLines) || base.maxLines, 1, 3)),
    maxCharsPerLine: Math.round(clamp(Number(merged.maxCharsPerLine) || base.maxCharsPerLine, 8, 42)),
    minDurationSec: clamp(Number(merged.minDurationSec) || base.minDurationSec, 0.3, 3),
    // Never let the floor exceed the ceiling, or enforceDurations fights itself.
    maxDurationSec: Math.max(
      clamp(Number(merged.maxDurationSec) || base.maxDurationSec, 1, 12),
      clamp(Number(merged.minDurationSec) || base.minDurationSec, 0.3, 3) + 0.2,
    ),
  };
}
