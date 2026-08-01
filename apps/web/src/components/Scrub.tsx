import { useCallback, useRef, useState } from 'react';

/**
 * Drag-to-change numeric control, in the style of Figma and After Effects.
 *
 * Preferred over a range input because it needs no track, keeps precision independent
 * of the control's width, and supports fine adjustment via a modifier. Pointer capture
 * keeps the drag alive when the cursor leaves the element.
 *
 * - drag horizontally to change
 * - hold Shift for 1/5 speed
 * - double-click to type an exact value
 * - arrow keys to step, Shift+arrow for 10x
 */

interface Props {
  label: string;
  value: number;
  min: number;
  max: number;
  step: number;
  /** Value units per pixel dragged. Defaults to step. */
  sensitivity?: number;
  suffix?: string;
  format?: (v: number) => string;
  onChange: (v: number) => void;
  hint?: string;
}

export function Scrub({
  label,
  value,
  min,
  max,
  step,
  sensitivity,
  suffix,
  format,
  onChange,
  hint,
}: Props) {
  const [dragging, setDragging] = useState(false);
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState('');
  const origin = useRef({ x: 0, value: 0 });

  const clamp = useCallback((v: number) => Math.min(max, Math.max(min, v)), [min, max]);

  // Snap to the step grid so dragging cannot produce 0.30000000000000004.
  const quantise = useCallback(
    (v: number) => {
      const snapped = Math.round(v / step) * step;
      const decimals = (String(step).split('.')[1] ?? '').length;
      return Number(clamp(snapped).toFixed(decimals));
    },
    [step, clamp],
  );

  const onPointerDown = (e: React.PointerEvent<HTMLDivElement>) => {
    if (editing) return;
    e.preventDefault();
    (e.target as HTMLElement).setPointerCapture(e.pointerId);
    origin.current = { x: e.clientX, value };
    setDragging(true);
  };

  const onPointerMove = (e: React.PointerEvent<HTMLDivElement>) => {
    if (!dragging) return;
    const perPx = (sensitivity ?? step) * (e.shiftKey ? 0.2 : 1);
    onChange(quantise(origin.current.value + (e.clientX - origin.current.x) * perPx));
  };

  const endDrag = (e: React.PointerEvent<HTMLDivElement>) => {
    if (!dragging) return;
    (e.target as HTMLElement).releasePointerCapture?.(e.pointerId);
    setDragging(false);
  };

  const commitDraft = () => {
    const parsed = Number(draft.replace(/[^\d.-]/g, ''));
    if (Number.isFinite(parsed)) onChange(quantise(parsed));
    setEditing(false);
  };

  const display = format ? format(value) : String(Number(value.toFixed(3)));
  const pct = ((value - min) / (max - min)) * 100;

  return (
    <div className="select-none">
      <div className="mb-1 flex items-baseline justify-between gap-2">
        <span className="label">{label}</span>
        {editing ? (
          <input
            autoFocus
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            onBlur={commitDraft}
            onKeyDown={(e) => {
              if (e.key === 'Enter') commitDraft();
              if (e.key === 'Escape') setEditing(false);
            }}
            className="w-16 rounded-[--radius-xs] border border-ink px-1 text-right font-mono text-[11px] outline-none"
          />
        ) : (
          <span className="font-mono text-[11px] text-ink/60">
            {display}
            {suffix ? ` ${suffix}` : ''}
          </span>
        )}
      </div>

      <div
        role="slider"
        tabIndex={0}
        aria-label={label}
        aria-valuenow={value}
        aria-valuemin={min}
        aria-valuemax={max}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={endDrag}
        onPointerCancel={endDrag}
        onDoubleClick={() => {
          setDraft(String(Number(value.toFixed(3))));
          setEditing(true);
        }}
        onKeyDown={(e) => {
          const mult = e.shiftKey ? 10 : 1;
          if (e.key === 'ArrowRight' || e.key === 'ArrowUp') {
            e.preventDefault();
            onChange(quantise(value + step * mult));
          }
          if (e.key === 'ArrowLeft' || e.key === 'ArrowDown') {
            e.preventDefault();
            onChange(quantise(value - step * mult));
          }
        }}
        className={`group relative h-7 cursor-ew-resize rounded-[--radius-sm] border transition-colors focus:outline-none ${
          dragging
            ? 'border-ink bg-surface-soft'
            : 'border-hairline hover:border-ink/40 focus-visible:border-ink'
        }`}
      >
        {/* Fill indicates position in range without pretending to be a hit target. */}
        <div
          className="pointer-events-none absolute inset-y-0 left-0 rounded-l-[--radius-sm] bg-ink/8 transition-[width] duration-75"
          style={{ width: `${Math.max(0, Math.min(100, pct))}%` }}
        />
        <div className="pointer-events-none absolute inset-0 flex items-center justify-center gap-1 text-[10px] text-ink/25 opacity-0 transition-opacity group-hover:opacity-100">
          <span>◄</span>
          <span>drag</span>
          <span>►</span>
        </div>
      </div>

      {hint && <p className="mt-1 text-[10px] text-ink/40">{hint}</p>}
    </div>
  );
}
