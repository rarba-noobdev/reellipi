import { useCallback, useEffect, useRef, useState } from 'react';
import type { Cue } from '../lib/types';
import { InstagramChrome } from './InstagramChrome';
import { VideoTransport } from './VideoTransport';
import {
  cssFontFor,
  fitFontSize,
  fontForLanguage,
  needsIndicFont,
  outlineShadow,
  withAlpha,
  type CaptionStyle,
} from '../lib/captionStyle';

/**
 * Live caption preview with direct manipulation.
 *
 * Mirrors the worker's ASS output field for field — same percentage-of-height sizing,
 * same \pos anchor, same animation semantics — so what is dragged here is what burns in.
 * Dragging the caption sets positionX/positionY; dragging the corner handle sets
 * fontSizePct.
 */

const SAFE = { topPct: 0.13, bottomPct: 0.25, sidePct: 0.11 };
/** Snap the caption to these fractions when dragged within SNAP_TOLERANCE. */
const SNAP_TARGETS = [0.5];
const SNAP_TOLERANCE = 0.02;

export type PreviewMode = 'clean' | 'guides' | 'instagram';

interface Props {
  src: string;
  cues: Cue[];
  style: CaptionStyle;
  languageCode: string | null;
  mode?: PreviewMode;
  /** Shown in the Instagram mock's caption row. */
  igCaption?: string;
  username?: string;
  baked?: boolean;
  /** Shifts caption display, in ms. Mirrors the render-time drift correction. */
  timingOffsetMs?: number;
  /** Omit to make the preview read-only. */
  onStyleChange?: (patch: Partial<CaptionStyle>) => void;
  onTimeChange?: (t: number) => void;
}

export function PreviewPlayer({
  src,
  cues,
  style,
  languageCode,
  mode = 'clean',
  igCaption,
  username = 'your_handle',
  baked,
  timingOffsetMs = 0,
  onStyleChange,
  onTimeChange,
}: Props) {
  const videoRef = useRef<HTMLVideoElement>(null);
  const frameRef = useRef<HTMLDivElement>(null);
  const [time, setTime] = useState(0);
  const [duration, setDuration] = useState(0);
  const [playing, setPlaying] = useState(false);
  const [frame, setFrame] = useState({ w: 0, h: 0 });
  const [dragMode, setDragMode] = useState<'idle' | 'move' | 'resize'>('idle');

  const drag = useRef({ x: 0, y: 0, posX: 0.5, posY: 0.65, size: 4 });

  // rAF, not timeupdate: timeupdate fires ~4x/second, far too coarse for word sync.
  useEffect(() => {
    const video = videoRef.current;
    if (!video) return;
    let raf = 0;
    const tick = () => {
      setTime(video.currentTime);
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, []);

  // `time` updates every animation frame to drive word highlighting. Parents only need
  // it for coarse UI like the transcript cursor, so throttle before propagating —
  // otherwise the whole page re-renders at 60fps.
  const lastEmitted = useRef(-1);
  useEffect(() => {
    if (!onTimeChange) return;
    if (Math.abs(time - lastEmitted.current) < 0.1) return;
    lastEmitted.current = time;
    onTimeChange(time);
  }, [time, onTimeChange]);

  // Percentage-based sizes need the rendered frame box to resolve to pixels.
  useEffect(() => {
    const el = frameRef.current;
    if (!el) return;
    const ro = new ResizeObserver(([entry]) => {
      if (entry) setFrame({ w: entry.contentRect.width, h: entry.contentRect.height });
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  const snap = useCallback((v: number) => {
    for (const t of SNAP_TARGETS) if (Math.abs(v - t) < SNAP_TOLERANCE) return t;
    return v;
  }, []);

  // Captions are shown at their shifted time so the drift control previews live.
  const shownTime = time - timingOffsetMs / 1000;
  const active = cues.find((c) => shownTime >= c.start && shownTime < c.end);
  const editable = Boolean(onStyleChange) && !baked;
  const showOverlay = !baked && active && frame.h > 0;

  const text = active?.lines.join(' ') ?? '';
  const family = needsIndicFont(text) ? fontForLanguage(languageCode) : style.fontFamily;
  const { fontFamily, fontWeight } = cssFontFor(family);

  // Match the renderer's overflow guard, or the preview shows text spilling past the
  // frame that would actually be shrunk in the exported video.
  const fontSize = active
    ? fitFontSize(active.lines, style, frame.w, (style.fontSizePct / 100) * frame.h)
    : (style.fontSizePct / 100) * frame.h;
  const outlineWidth = (style.outlineWidthPct / 100) * frame.h;
  const shadowDepth = (style.shadowDepthPct / 100) * frame.h;
  const waveAmplitude = (style.waveAmplitudePct / 100) * frame.h;

  // Cue-level entrance, matching the \fad and \move the renderer emits.
  const sinceCueStart = active ? shownTime - active.start : 0;
  const cueEnter =
    style.animation === 'fade'
      ? { opacity: Math.min(1, sinceCueStart / 0.14), translateY: 0 }
      : style.animation === 'slide'
        ? {
            opacity: Math.min(1, sinceCueStart / 0.12),
            translateY: Math.max(0, 1 - sinceCueStart / 0.18) * fontSize * 0.5,
          }
        : { opacity: 1, translateY: 0 };

  const beginDrag = (e: React.PointerEvent, next: 'move' | 'resize') => {
    if (!editable) return;
    e.preventDefault();
    e.stopPropagation();
    (e.target as HTMLElement).setPointerCapture(e.pointerId);
    drag.current = {
      x: e.clientX,
      y: e.clientY,
      posX: style.positionX,
      posY: style.positionY,
      size: style.fontSizePct,
    };
    setDragMode(next);
  };

  const onPointerMove = (e: React.PointerEvent) => {
    if (dragMode === 'idle' || !onStyleChange) return;
    const dx = e.clientX - drag.current.x;
    const dy = e.clientY - drag.current.y;

    if (dragMode === 'move') {
      onStyleChange({
        positionX: clamp(snap(drag.current.posX + dx / frame.w), 0.06, 0.94),
        positionY: clamp(snap(drag.current.posY + dy / frame.h), 0.06, 0.94),
      });
    } else {
      // Drag down to grow. Vertical travel maps to size directly.
      const deltaPct = (dy / frame.h) * 100 * 2;
      onStyleChange({ fontSizePct: round2(clamp(drag.current.size + deltaPct, 1.5, 12)) });
    }
  };

  const endDrag = (e: React.PointerEvent) => {
    if (dragMode === 'idle') return;
    (e.target as HTMLElement).releasePointerCapture?.(e.pointerId);
    setDragMode('idle');
  };

  return (
    <div className="space-y-2.5">
      <div
        ref={frameRef}
        data-preview-frame
        className="@container relative aspect-[9/16] w-full touch-none overflow-hidden rounded-[--radius-lg] bg-black"
        onPointerMove={onPointerMove}
        onPointerUp={endDrag}
        onPointerCancel={endDrag}
      >
        <video
          ref={videoRef}
          src={src}
          className="h-full w-full object-contain"
          playsInline
          onPlay={() => setPlaying(true)}
          onPause={() => setPlaying(false)}
          onLoadedMetadata={(e) => setDuration(e.currentTarget.duration || 0)}
        />

        {mode === 'guides' && (
          <div className="pointer-events-none absolute inset-0">
            <div
              className="absolute inset-x-0 top-0 border-b border-dashed border-white/40 bg-black/25"
              style={{ height: `${SAFE.topPct * 100}%` }}
            />
            <div
              className="absolute inset-x-0 bottom-0 border-t border-dashed border-white/40 bg-black/25"
              style={{ height: `${SAFE.bottomPct * 100}%` }}
            />
            <div className="absolute inset-y-0 left-1/2 w-px bg-white/20" />
          </div>
        )}

        {mode === 'instagram' && (
          <InstagramChrome
            username={username}
            caption={igCaption || 'Your Instagram caption will appear here.'}
            audioTitle={`${username} · original audio`}
          />
        )}

        {/* Centre snap indicator, only while dragging. */}
        {dragMode === 'move' && Math.abs(style.positionX - 0.5) < 0.001 && (
          <div className="pointer-events-none absolute inset-y-0 left-1/2 z-20 w-px bg-accent-magenta" />
        )}

        {showOverlay && (
          <div
            className="absolute z-20"
            style={{
              left: `${style.positionX * 100}%`,
              top: `${style.positionY * 100}%`,
              transform: 'translate(-50%, -50%)',
              maxWidth: `${100 - style.marginXPct * 2}%`,
            }}
          >
            <div
              data-caption-block
              onPointerDown={(e) => beginDrag(e, 'move')}
              className={`relative text-center ${
                editable
                  ? dragMode === 'move'
                    ? 'cursor-grabbing'
                    : 'cursor-grab'
                  : 'pointer-events-none'
              }`}
              style={{
                fontFamily,
                fontWeight: style.bold ? fontWeight : Math.min(fontWeight, 500),
                fontStyle: style.italic ? 'italic' : 'normal',
                fontSize: `${fontSize}px`,
                lineHeight: style.lineSpacing,
                letterSpacing: `${style.letterSpacing}px`,
                textTransform: style.uppercase ? 'uppercase' : 'none',
                whiteSpace: 'nowrap',
                opacity: cueEnter.opacity,
                transform: cueEnter.translateY ? `translateY(${cueEnter.translateY}px)` : undefined,
                ...(style.background === 'box'
                  ? {
                      background: withAlpha(style.backgroundColor, style.backgroundOpacity),
                      padding: `${fontSize * 0.12}px ${fontSize * 0.3}px`,
                      borderRadius: `${fontSize * 0.12}px`,
                    }
                  : {}),
              }}
            >
              {active.lines.map((line, li) => {
                const tokens = splitWords(line);
                return (
                  <div key={li} data-caption-line>
                    {tokens.map((token, wi) => {
                      const word = wordAt(active, li, wi);
                      const isActive = wordIsActive(word, shownTime, style.animation);
                      const keyword = isKeyword(token, active.highlight);
                      const anim = wordAnimation({
                        style,
                        isActive,
                        index: wi,
                        count: tokens.length,
                        elapsed: word ? shownTime - word.start : 0,
                        waveAmplitude,
                        reached: reachedIndex(active, li, wi, shownTime),
                      });
                      return (
                        <span
                          key={`${li}-${wi}`}
                          data-word
                          className="inline-block will-change-transform"
                          style={{
                            color: isActive ? style.accentColor : style.textColor,
                            // Scale via font-size, not transform: a transform does not
                            // reflow, so a popped word would visually overlap its
                            // neighbour. ASS `\fscx` scales the glyph advance too, so
                            // this also matches what the renderer produces.
                            fontSize: anim.scale !== 1 ? `${anim.scale * 100}%` : undefined,
                            transform: anim.translateY
                              ? `translateY(${anim.translateY}px)`
                              : undefined,
                            opacity: anim.opacity,
                            transition: anim.transition,
                            // Explicit gap. Whitespace between inline-blocks collapses to
                            // near nothing, which is what ran the words together.
                            marginRight: wi < tokens.length - 1 ? '0.26em' : undefined,
                            textShadow: composeShadow(
                              keyword ? style.keywordColor : style.outlineColor,
                              style.background === 'box' ? 0 : outlineWidth,
                              style.shadowColor,
                              style.background === 'box' ? 0 : shadowDepth,
                            ),
                          }}
                        >
                          {token}
                          {/*
                            The visible gap comes from marginRight, but a margin is not
                            text: without this the block's textContent would run every
                            word together for copy-paste and screen readers. Zero
                            font-size keeps it from adding width on top of the margin.
                          */}
                          {wi < tokens.length - 1 && <span style={{ fontSize: 0 }}> </span>}
                        </span>
                      );
                    })}
                  </div>
                );
              })}

              {editable && (
                <>
                  {/* Hairline selection box — visible enough to show the hit area, faint
                      enough not to read as part of the caption design. */}
                  <div
                    className={`pointer-events-none absolute -inset-2 rounded-[3px] border transition-colors ${
                      dragMode !== 'idle' ? 'border-accent-magenta/80' : 'border-white/20'
                    }`}
                  />
                  <div
                    onPointerDown={(e) => beginDrag(e, 'resize')}
                    title="Drag to resize"
                    className="absolute -right-2.5 -bottom-2.5 h-4 w-4 cursor-nwse-resize rounded-full border-2 border-black/60 bg-white shadow-md transition-transform hover:scale-110"
                  />
                </>
              )}
            </div>
          </div>
        )}

        {editable && showOverlay && dragMode === 'idle' && (
          <div className="pointer-events-none absolute bottom-2 left-1/2 z-30 -translate-x-1/2 rounded-[--radius-pill] bg-black/45 px-2.5 py-1 text-[10px] whitespace-nowrap text-white/70 backdrop-blur">
            drag to move · corner to resize
          </div>
        )}
      </div>

      <VideoTransport
        playing={playing}
        currentTime={time}
        duration={duration}
        cueStarts={cues.map((c) => c.start)}
        onTogglePlay={() => {
          const v = videoRef.current;
          if (!v) return;
          if (v.paused) void v.play();
          else v.pause();
        }}
        onSeek={(t) => {
          const v = videoRef.current;
          if (v) v.currentTime = t;
        }}
      />
    </div>
  );
}

const splitWords = (line: string) => line.split(/\s+/).filter(Boolean);
const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));
const round2 = (v: number) => Math.round(v * 100) / 100;

function composeShadow(
  outlineColor: string,
  outlineWidth: number,
  shadowColor: string,
  shadowDepth: number,
): string {
  const parts: string[] = [];
  const outline = outlineShadow(outlineColor, outlineWidth);
  if (outline !== 'none') parts.push(outline);
  if (shadowDepth > 0) {
    parts.push(`${shadowDepth}px ${shadowDepth}px ${shadowDepth * 1.5}px ${shadowColor}`);
  }
  return parts.length ? parts.join(', ') : 'none';
}

function isKeyword(token: string, highlight: string[] | undefined): boolean {
  if (!highlight?.length) return false;
  const core = token.toLowerCase().replace(/[^\p{L}\p{N}]/gu, '');
  return core.length > 0 && highlight.includes(core);
}

function wordAt(cue: Cue, lineIndex: number, wordIndex: number) {
  let offset = 0;
  for (let i = 0; i < lineIndex; i++) offset += splitWords(cue.lines[i] ?? '').length;
  return cue.words[offset + wordIndex];
}

function wordIsActive(
  word: { start: number; end: number } | undefined,
  time: number,
  mode: CaptionStyle['animation'],
): boolean {
  if (!word || mode === 'none' || mode === 'fade' || mode === 'slide') return false;
  // Karaoke and typewriter accumulate; the rest light only the current word.
  if (mode === 'karaoke' || mode === 'typewriter') return time >= word.start;
  return time >= word.start && time < word.end;
}

/** Has playback reached this word yet? Drives the typewriter reveal. */
function reachedIndex(cue: Cue, lineIndex: number, wordIndex: number, time: number): boolean {
  const word = wordAt(cue, lineIndex, wordIndex);
  return !word || time >= word.start;
}

interface WordAnim {
  scale: number;
  translateY: number;
  opacity: number;
  transition: string | undefined;
}

/**
 * Per-word animation state, mirroring what lib/ass.ts emits.
 *
 * Computed from the video clock rather than CSS keyframes: a keyframe animation would
 * drift out of sync the moment the user scrubs or pauses.
 */
function wordAnimation(o: {
  style: CaptionStyle;
  isActive: boolean;
  index: number;
  count: number;
  elapsed: number;
  waveAmplitude: number;
  reached: boolean;
}): WordAnim {
  const { style, isActive, index, count, elapsed, waveAmplitude, reached } = o;
  const idle: WordAnim = { scale: 1, translateY: 0, opacity: 1, transition: undefined };

  switch (style.animation) {
    case 'pop':
      return isActive
        ? { ...idle, scale: style.popScale / 100, transition: 'font-size 90ms ease-out' }
        : { ...idle, transition: 'font-size 90ms ease-out' };

    case 'bounce': {
      if (!isActive) return { ...idle, transition: 'font-size 140ms ease-out' };
      // Overshoot for 120ms, settle by 260ms — matches the ASS \t timings.
      const peak = style.popScale / 100;
      const t = Math.max(0, elapsed);
      const scale =
        t < 0.12
          ? 1 + (peak - 1) * (t / 0.12)
          : t < 0.26
            ? peak - (peak - 1) * ((t - 0.12) / 0.14)
            : 1;
      return { ...idle, scale, transition: 'none' };
    }

    case 'wave': {
      // Static sine across the line, plus a lift while the word is spoken.
      const phase = count <= 1 ? 0 : (index / (count - 1)) * Math.PI;
      const rest = -Math.sin(phase) * waveAmplitude;
      const lift = isActive ? -waveAmplitude * 0.9 : 0;
      return {
        scale: isActive ? style.popScale / 100 : 1,
        translateY: rest + lift,
        opacity: 1,
        transition: 'transform 130ms ease-out, font-size 130ms ease-out',
      };
    }

    case 'typewriter':
      return { ...idle, opacity: reached ? 1 : 0, transition: 'opacity 90ms linear' };

    default:
      return idle;
  }
}
