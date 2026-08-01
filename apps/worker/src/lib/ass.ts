import type { Cue } from './subtitles.js';
import {
  fontForLanguage,
  needsIndicFont,
  resolveMetrics,
  type CaptionStyle,
} from './captionStyle.js';

/**
 * ASS (Advanced SubStation Alpha) generation.
 *
 * ASS is used rather than SRT because libass supports per-word karaoke timing, exact
 * positioning and per-word colour overrides — none of which SRT can express.
 */

export const PLAY_RES_X = 1080;
export const PLAY_RES_Y = 1920;

/**
 * Instagram draws its own UI over the frame. Captions must clear the bottom band
 * (caption text, audio attribution, action rail), the top band (username, audio ticker)
 * and the side rails. These are advisory bounds used by the editor's guide overlay.
 */
export const SAFE_AREA = {
  bottomPct: 0.25,
  topPct: 0.13,
  sidePct: 0.11,
} as const;

/** `#RRGGBB` -> ASS `&HAABBGGRR`. ASS alpha is inverted: 00 is opaque, FF transparent. */
export function toAssColor(hex: string, alpha = 0): string {
  const m = /^#?([0-9a-f]{6})$/i.exec((hex ?? '').trim());
  const v = m ? m[1]! : 'FFFFFF';
  const rr = v.slice(0, 2);
  const gg = v.slice(2, 4);
  const bb = v.slice(4, 6);
  return `&H${hex8(alpha)}${bb}${gg}${rr}`.toUpperCase();
}
const hex8 = (n: number) => Math.max(0, Math.min(255, Math.round(n))).toString(16).padStart(2, '0');

export function assTime(seconds: number): string {
  const t = Math.max(0, seconds);
  const cs = Math.round((t % 1) * 100);
  const whole = Math.floor(t);
  const h = Math.floor(whole / 3600);
  const m = Math.floor((whole % 3600) / 60);
  const s = whole % 60;
  return `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}.${String(cs).padStart(2, '0')}`;
}

/** `{`, `}` and newlines are ASS override syntax and must not survive in dialogue text. */
function escapeText(text: string): string {
  return text.replace(/[{}]/g, '').replace(/\r?\n/g, ' ').trim();
}

/**
 * Approximate advance width of a string, in ems.
 *
 * libass silently re-wraps any line wider than the text area, turning a 2-line cue into
 * 3 and breaking the karaoke layout. Rather than parse the TTFs, estimate per script:
 * Indic conjuncts are wider than Latin, and caps/digits wider than lowercase.
 */
export function estimateEms(text: string): number {
  let ems = 0;
  for (const ch of text) {
    const code = ch.codePointAt(0)!;
    if (code === 0x20) ems += 0.26;
    // Combining marks (Tamil/Devanagari vowel signs, viramas) add no advance.
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
 * Per-family width multiplier.
 *
 * estimateEms is calibrated against an average sans. Heavy display faces are markedly
 * wider per glyph and condensed ones narrower, and getting this wrong means captions
 * overflow the frame — which WrapStyle 2 no longer rescues, since \N breaks are
 * authoritative once the block is absolutely positioned.
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

/** Shrink the font until the widest line fits the safe text area. */
export function fitFontSize(
  cues: Cue[],
  style: CaptionStyle,
  resX: number,
  requestedSize: number,
  marginX: number,
  outlineWidth: number,
): number {
  const usable = resX - marginX * 2 - outlineWidth * 2;
  const familyFactor = FAMILY_WIDTH[style.fontFamily] ?? 1;
  let widest = 0;
  for (const cue of cues) {
    for (const line of cue.lines) {
      const text = style.uppercase ? line.toUpperCase() : line;
      widest = Math.max(widest, estimateEms(text) * familyFactor);
    }
  }
  if (widest <= 0 || usable <= 0) return requestedSize;
  return Math.max(20, Math.min(requestedSize, Math.floor(usable / widest)));
}

export interface BuildAssOptions {
  style: CaptionStyle;
  languageCode?: string | null;
  playResX?: number;
  playResY?: number;
}

export function buildAss(cues: Cue[], options: BuildAssOptions): string {
  const style = options.style;
  const resX = options.playResX || PLAY_RES_X;
  const resY = options.playResY || PLAY_RES_Y;
  const m = resolveMetrics(style, resX, resY);

  // If any cue carries Indic glyphs, a Latin display face would fall back mid-line and
  // mix two designs. Swap the whole style to a matching Noto family instead.
  const hasIndic = cues.some((c) => needsIndicFont(c.lines.join(' ')));
  const fontName = hasIndic ? fontForLanguage(options.languageCode) : style.fontFamily;

  const fontSize = fitFontSize(cues, style, resX, m.fontSize, m.marginX, m.outlineWidth);

  // BorderStyle 3 draws an opaque box behind the text instead of an outline.
  const boxed = style.background === 'box';
  const borderStyle = boxed ? 3 : 1;
  const outline = boxed ? Math.max(4, Math.round(fontSize * 0.18)) : round2(m.outlineWidth);
  const outlineColour = boxed
    ? toAssColor(style.backgroundColor, (1 - style.backgroundOpacity) * 255)
    : toAssColor(style.outlineColor);

  // The caption block is placed with \an5 (middle-centre) + \pos so the user can drag it
  // anywhere in the frame. That makes MarginL/R/V inert, so WrapStyle 2 is required —
  // otherwise libass re-wraps at its own width and our \N line breaks stop matching the
  // karaoke layout.
  const anchor = `{\\an5\\pos(${m.posX},${m.posY})}`;

  const header = [
    '[Script Info]',
    'ScriptType: v4.00+',
    'WrapStyle: 2',
    'ScaledBorderAndShadow: yes',
    'YCbCr Matrix: TV.709',
    `PlayResX: ${resX}`,
    `PlayResY: ${resY}`,
    '',
    '[V4+ Styles]',
    'Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding',
    [
      'Style: Caption',
      fontName,
      fontSize,
      // libass sweeps Secondary -> Primary in karaoke, so Primary must be the accent.
      toAssColor(style.animation === 'karaoke' ? style.accentColor : style.textColor),
      toAssColor(style.textColor),
      outlineColour,
      toAssColor(style.shadowColor, 60),
      style.bold ? -1 : 0,
      style.italic ? -1 : 0,
      0,
      0,
      100,
      100,
      round2(m.letterSpacing),
      0,
      borderStyle,
      outline,
      round2(m.shadowDepth),
      5,
      m.marginX,
      m.marginX,
      0,
      1,
    ].join(','),
    '',
    '[Events]',
    'Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text',
  ];

  const events: string[] = [];
  const waveAmp = (style.waveAmplitudePct / 100) * resY;

  for (const cue of cues) {
    switch (style.animation) {
      case 'karaoke':
        events.push(karaokeEvent(cue, style, anchor));
        break;
      case 'pop':
      case 'bounce':
      case 'typewriter':
        events.push(...popEvents(cue, style, anchor));
        break;
      case 'wave':
        events.push(...waveEvents(cue, style, fontSize, m.posX, m.posY, waveAmp));
        break;
      case 'fade':
        events.push(
          dialogue(
            cue.start,
            cue.end,
            `${anchor}{\\fad(140,120)}` + renderLines(cue.lines, style, cue.highlight),
          ),
        );
        break;
      case 'slide': {
        // Rise into place over 180ms, then hold.
        const travel = Math.round(fontSize * 0.5);
        const move = `{\\move(${m.posX},${m.posY + travel},${m.posX},${m.posY},0,180)}`;
        events.push(
          dialogue(
            cue.start,
            cue.end,
            `{\\an5}${move}{\\fad(120,80)}` + renderLines(cue.lines, style, cue.highlight),
          ),
        );
        break;
      }
      default:
        events.push(
          dialogue(cue.start, cue.end, anchor + renderLines(cue.lines, style, cue.highlight)),
        );
    }
  }

  return `${header.join('\n')}\n${events.join('\n')}\n`;
}

/**
 * Wave: every word gets its own absolutely-positioned event so it can sit at its own
 * height on a sine curve, with the active word lifted by a travelling bump.
 *
 * Word x-offsets are derived from estimateEms rather than real font metrics, so the
 * spacing is approximate — acceptable because the wave already breaks the baseline, and
 * the alternative is parsing TTF hmtx tables at render time.
 */
function waveEvents(
  cue: Cue,
  style: CaptionStyle,
  fontSize: number,
  centreX: number,
  centreY: number,
  amplitude: number,
): string[] {
  const layout = mapWordsToLines(cue);
  const lineHeight = fontSize * style.lineSpacing * 1.2;
  const events: string[] = [];

  layout.forEach((line, li) => {
    const spaceEm = 0.3;
    const widths = line.map((w) => estimateEms(style.uppercase ? w.w.toUpperCase() : w.w) * fontSize);
    const total = widths.reduce((a, b) => a + b, 0) + spaceEm * fontSize * (line.length - 1);
    const lineY = centreY + (li - (layout.length - 1) / 2) * lineHeight;

    let cursor = centreX - total / 2;
    line.forEach((entry, wi) => {
      const width = widths[wi]!;
      const wordCentre = cursor + width / 2;
      cursor += width + spaceEm * fontSize;

      // Static curve across the line, so the phrase reads as a single wavy unit.
      const phase = layout.length === 1 && line.length === 1 ? 0 : (wi / Math.max(1, line.length - 1)) * Math.PI;
      const restY = lineY - Math.sin(phase) * amplitude;

      const isKey = isKeyword(entry.w, cue.highlight);
      const colour = toAssColor(style.textColor);
      const accent = toAssColor(style.accentColor);
      const text = escapeText(casing(entry.w, style));
      const outline = isKey
        ? `\\3c${toAssColor(style.keywordColor)}`
        : `\\3c${toAssColor(style.outlineColor)}`;

      const x = Math.round(wordCentre);
      const rest = `{\\an5\\pos(${x},${Math.round(restY)})\\c${colour}${outline}}${text}`;

      // The rest state must not overlap the active window, or both events draw at once
      // and the word renders twice, offset. Emit it as the two surrounding segments.
      const spokenStart = Math.max(cue.start, Math.min(entry.start, cue.end));
      const spokenEnd = Math.max(spokenStart, Math.min(entry.end, cue.end));
      const hasSpoken = spokenEnd - spokenStart > 0.01;

      if (!hasSpoken) {
        events.push(dialogue(cue.start, cue.end, rest));
      } else {
        if (spokenStart - cue.start > 0.01) events.push(dialogue(cue.start, spokenStart, rest));
        if (cue.end - spokenEnd > 0.01) events.push(dialogue(spokenEnd, cue.end, rest));

        // Travelling bump: while this word is spoken it lifts, recolours and grows.
        const lift = Math.round(restY - amplitude * 0.9);
        events.push(
          dialogue(
            spokenStart,
            spokenEnd,
            `{\\an5\\pos(${x},${lift})\\c${accent}${outline}` +
              `\\fscx${Math.round(style.popScale)}\\fscy${Math.round(style.popScale)}}${text}`,
          ),
        );
      }
    });
  });

  return events;
}

const round2 = (n: number) => Math.round(n * 100) / 100;

function dialogue(start: number, end: number, text: string): string {
  return `Dialogue: 0,${assTime(start)},${assTime(end)},Caption,,0,0,0,,${text}`;
}

function casing(text: string, style: CaptionStyle): string {
  return style.uppercase ? text.toUpperCase() : text;
}

/** Match a rendered token against a keyword, ignoring case, punctuation and emoji. */
function isKeyword(token: string, highlight: string[] | undefined): boolean {
  if (!highlight?.length) return false;
  const core = token.toLowerCase().replace(/[^\p{L}\p{N}]/gu, '');
  return core.length > 0 && highlight.includes(core);
}

/**
 * Keyword emphasis.
 *
 * 'fill' recolours the glyph and is the calm default. 'outline' recolours the border,
 * which composes with the karaoke sweep but reads as a colour clash on a thick outline.
 */
function keywordWrap(text: string, style: CaptionStyle, on: boolean): string {
  if (!on || style.keywordStyle === 'none') return text;
  if (style.keywordStyle === 'outline') {
    return `{\\3c${toAssColor(style.keywordColor)}}${text}{\\3c${toAssColor(style.outlineColor)}}`;
  }
  return `{\\c${toAssColor(style.keywordColor)}}${text}{\\c${toAssColor(style.textColor)}}`;
}

function renderLines(lines: string[], style: CaptionStyle, highlight?: string[]): string {
  return lines
    .map((l) =>
      l
        .split(/\s+/)
        .filter(Boolean)
        .map((tok) => keywordWrap(escapeText(casing(tok, style)), style, isKeyword(tok, highlight)))
        .join(' '),
    )
    .join('\\N');
}

/**
 * One event per cue using `\k`, so libass fills each word at its own timing. `\k` units
 * are centiseconds and must tile the cue exactly, so lead-in silence is emitted as an
 * empty leading run.
 */
function karaokeEvent(cue: Cue, style: CaptionStyle, anchor: string): string {
  const parts: string[] = [anchor];
  const first = cue.words[0];
  const lead = first ? Math.round((first.start - cue.start) * 100) : 0;
  if (lead > 0) parts.push(`{\\k${lead}}`);

  const layout = mapWordsToLines(cue);
  layout.forEach((line, li) => {
    if (li > 0) parts.push('\\N');
    line.forEach((entry, wi) => {
      const cs = Math.max(1, Math.round((entry.end - entry.start) * 100));
      const text = keywordWrap(escapeText(casing(entry.w, style)), style, isKeyword(entry.w, cue.highlight));
      parts.push(`{\\k${cs}}${text}${wi < line.length - 1 ? ' ' : ''}`);
    });
  });
  return dialogue(cue.start, cue.end, parts.join(''));
}

/**
 * One event per word: the full cue is redrawn each time with only the active word
 * accented and scaled. `\k` cannot express "current word only", which is the cost of
 * this very popular style.
 */
function popEvents(cue: Cue, style: CaptionStyle, anchor: string): string[] {
  const layout = mapWordsToLines(cue);
  const flat = layout.flat();
  const accent = toAssColor(style.accentColor);
  const base = toAssColor(style.textColor);
  const scale = Math.round(style.popScale);

  return flat.map((active, i) => {
    const activeIndex = flat.indexOf(active);
    const parts: string[] = [anchor];

    layout.forEach((line, li) => {
      if (li > 0) parts.push('\\N');
      line.forEach((entry, wi) => {
        const flatIndex = flat.indexOf(entry);
        const text = keywordWrap(
          escapeText(casing(entry.w, style)),
          style,
          isKeyword(entry.w, cue.highlight),
        );

        if (style.animation === 'typewriter') {
          // Words not yet reached are fully transparent, so the line does not reflow
          // as each one appears.
          parts.push(
            flatIndex <= activeIndex ? text : `{\\alpha&HFF&}${text}{\\alpha&H00&}`,
          );
        } else if (entry === active) {
          const emphasis =
            style.animation === 'bounce'
              // Overshoot then settle: 120ms out, 140ms back.
              ? `{\\c${accent}\\fscx100\\fscy100\\t(0,120,\\fscx${scale}\\fscy${scale})` +
                `\\t(120,260,\\fscx100\\fscy100)}`
              : `{\\c${accent}\\fscx${scale}\\fscy${scale}}`;
          parts.push(`${emphasis}${text}{\\c${base}\\fscx100\\fscy100}`);
        } else {
          parts.push(text);
        }

        if (wi < line.length - 1) parts.push(' ');
      });
    });

    // Hold the final word until the cue ends so the block does not blink out early.
    const end = i === flat.length - 1 ? cue.end : flat[i + 1]!.start;
    return dialogue(active.start, Math.max(end, active.start + 0.05), parts.join(''));
  });
}

/**
 * Re-associate timed words with the wrapped lines produced by buildCues, so karaoke runs
 * and line breaks agree. Falls back to a single line if the counts disagree.
 */
function mapWordsToLines(cue: Cue): Array<Array<{ w: string; start: number; end: number }>> {
  const lines: Array<Array<{ w: string; start: number; end: number }>> = [];
  let cursor = 0;
  for (const line of cue.lines) {
    const count = line.split(/\s+/).filter(Boolean).length;
    const slice = cue.words.slice(cursor, cursor + count);
    if (slice.length === 0) break;
    lines.push(slice.map((w) => ({ w: w.w, start: w.start, end: w.end })));
    cursor += count;
  }
  if (cursor < cue.words.length) {
    const rest = cue.words.slice(cursor).map((w) => ({ w: w.w, start: w.start, end: w.end }));
    if (lines.length) lines[lines.length - 1]!.push(...rest);
    else lines.push(rest);
  }
  return lines.length ? lines : [cue.words.map((w) => ({ w: w.w, start: w.start, end: w.end }))];
}
