import { useCallback, useRef, useState } from 'react';

/**
 * Transport controls, deliberately placed BELOW the video rather than over it.
 *
 * An overlaid play button competes with the Instagram chrome mock and covers the exact
 * region a creator is trying to judge. Keeping the controls outside the frame leaves the
 * 9:16 area showing only what will actually be exported.
 */

interface Props {
  playing: boolean;
  currentTime: number;
  duration: number;
  /** Cue boundaries, drawn as ticks so the user can scrub between spoken phrases. */
  cueStarts?: number[];
  onTogglePlay: () => void;
  onSeek: (t: number) => void;
}

export function VideoTransport({
  playing,
  currentTime,
  duration,
  cueStarts = [],
  onTogglePlay,
  onSeek,
}: Props) {
  const trackRef = useRef<HTMLDivElement>(null);
  const [scrubbing, setScrubbing] = useState(false);

  const seekFromPointer = useCallback(
    (clientX: number) => {
      const el = trackRef.current;
      if (!el || duration <= 0) return;
      const box = el.getBoundingClientRect();
      const ratio = Math.min(1, Math.max(0, (clientX - box.left) / box.width));
      onSeek(ratio * duration);
    },
    [duration, onSeek],
  );

  const pct = duration > 0 ? (currentTime / duration) * 100 : 0;

  return (
    <div className="flex items-center gap-3">
      <button
        type="button"
        onClick={onTogglePlay}
        aria-label={playing ? 'Pause' : 'Play'}
        className="grid h-9 w-9 shrink-0 place-items-center rounded-full bg-ink text-canvas transition-opacity hover:opacity-85"
      >
        {playing ? (
          <svg viewBox="0 0 24 24" fill="currentColor" className="h-3.5 w-3.5">
            <rect x="6" y="4" width="4" height="16" rx="1" />
            <rect x="14" y="4" width="4" height="16" rx="1" />
          </svg>
        ) : (
          <svg viewBox="0 0 24 24" fill="currentColor" className="ml-0.5 h-3.5 w-3.5">
            <path d="M7 4l13 8-13 8z" />
          </svg>
        )}
      </button>

      <div className="min-w-0 flex-1">
        <div
          ref={trackRef}
          role="slider"
          tabIndex={0}
          aria-label="Seek"
          aria-valuemin={0}
          aria-valuemax={Math.round(duration)}
          aria-valuenow={Math.round(currentTime)}
          onPointerDown={(e) => {
            (e.target as HTMLElement).setPointerCapture(e.pointerId);
            setScrubbing(true);
            seekFromPointer(e.clientX);
          }}
          onPointerMove={(e) => scrubbing && seekFromPointer(e.clientX)}
          onPointerUp={(e) => {
            (e.target as HTMLElement).releasePointerCapture?.(e.pointerId);
            setScrubbing(false);
          }}
          onKeyDown={(e) => {
            // Arrow keys nudge; shift jumps a second. Handy for checking caption sync.
            const step = e.shiftKey ? 1 : 0.1;
            if (e.key === 'ArrowRight') {
              e.preventDefault();
              onSeek(Math.min(duration, currentTime + step));
            }
            if (e.key === 'ArrowLeft') {
              e.preventDefault();
              onSeek(Math.max(0, currentTime - step));
            }
          }}
          className="group relative flex h-6 cursor-pointer items-center focus:outline-none"
        >
          <div className="relative h-1.5 w-full overflow-hidden rounded-full bg-hairline">
            <div className="absolute inset-y-0 left-0 bg-ink" style={{ width: `${pct}%` }} />
          </div>

          {/* Cue ticks: show where each caption starts, so scrubbing lands on speech. */}
          {duration > 0 &&
            cueStarts.map((t, i) => (
              <span
                key={i}
                className="pointer-events-none absolute top-1/2 h-2 w-px -translate-y-1/2 bg-ink/25"
                style={{ left: `${(t / duration) * 100}%` }}
              />
            ))}

          <span
            className="pointer-events-none absolute top-1/2 h-3.5 w-3.5 -translate-x-1/2 -translate-y-1/2 rounded-full border-2 border-canvas bg-ink transition-transform group-hover:scale-110"
            style={{ left: `${pct}%`, boxShadow: '0 0 0 1px var(--color-ink)' }}
          />
        </div>
      </div>

      <span className="shrink-0 font-mono text-[11px] tabular-nums text-ink/55">
        {fmt(currentTime)} / {fmt(duration)}
      </span>
    </div>
  );
}

function fmt(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds < 0) return '0:00';
  const m = Math.floor(seconds / 60);
  const s = Math.floor(seconds % 60);
  return `${m}:${String(s).padStart(2, '0')}`;
}
