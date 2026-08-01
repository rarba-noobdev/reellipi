import { useState } from 'react';
import { Scrub } from './Scrub';
import { ANIMATION_CHOICES } from '../lib/captionStyle';
import type { BackgroundMode, CaptionStyle, FontChoice } from '../lib/captionStyle';

/**
 * Full caption style editor.
 *
 * Every control maps 1:1 to a field the ASS renderer honours, so nothing here is
 * decorative. Changes are reported immediately for the live preview; committing them to
 * a new burned-in video is a separate, explicit action because a render costs ~30s.
 */

interface Props {
  style: CaptionStyle;
  presets: CaptionStyle[];
  fonts: FontChoice[];
  /** Fired on every tweak — drives the preview only. */
  onChange: (next: CaptionStyle) => void;
  onSelectPreset: (presetId: string) => void;
  onApply: () => void;
  onReset: () => void;
  dirty: boolean;
  busy: boolean;
  /** Global caption timing correction, in milliseconds. */
  timingOffsetMs: number;
  onTimingOffsetChange: (ms: number) => void;
  smartGrouping: boolean;
  onSmartGroupingChange: (on: boolean) => void;
  /** Dominant colours sampled from the video, for the swatch strip. */
  palette?: string[];
  matchingPalette?: boolean;
  onMatchPalette: () => void;
}

type Section = 'preset' | 'type' | 'colour' | 'layout' | 'timing';

const SECTIONS: Array<{ id: Section; label: string }> = [
  { id: 'preset', label: 'Style' },
  { id: 'type', label: 'Type' },
  { id: 'colour', label: 'Colour' },
  { id: 'layout', label: 'Layout' },
  { id: 'timing', label: 'Timing' },
];

export function StyleEditor(props: Props) {
  const {
    style, presets, fonts, onChange, onSelectPreset, onApply, onReset, dirty, busy,
    timingOffsetMs, onTimingOffsetChange, smartGrouping, onSmartGroupingChange,
    palette, matchingPalette, onMatchPalette,
  } = props;
  const [section, setSection] = useState<Section>('preset');

  const set = <K extends keyof CaptionStyle>(key: K, value: CaptionStyle[K]) =>
    onChange({ ...style, [key]: value });

  return (
    <div className="card overflow-hidden">
      <nav className="flex border-b border-hairline">
        {SECTIONS.map((s) => (
          <button
            key={s.id}
            type="button"
            onClick={() => setSection(s.id)}
            className={`flex-1 px-2 py-3 text-xs font-medium transition-colors ${
              section === s.id
                ? 'border-b-2 border-ink text-ink'
                : 'border-b-2 border-transparent text-ink/40 hover:text-ink/70'
            }`}
          >
            {s.label}
          </button>
        ))}
      </nav>

      <div className="space-y-5 p-5">
        {section === 'preset' && (
          <div className="grid grid-cols-1 gap-2">
            <div className="mb-1 rounded-[--radius-sm] bg-block-lime px-2.5 py-2 text-[11px]">
              Drag the caption in the preview to move it. Drag the white corner dot to resize.
              Every number below can be dragged left/right, or double-clicked to type.
            </div>
            <label className="flex cursor-pointer items-start gap-2.5 rounded-[--radius-md] border border-hairline p-3">
              <input
                type="checkbox"
                checked={smartGrouping}
                onChange={(e) => onSmartGroupingChange(e.target.checked)}
                className="mt-0.5"
              />
              <span>
                <span className="block text-sm font-medium">Emoji &amp; keyword highlights</span>
                <span className="block text-[11px] text-ink/50">
                  Adds an emoji beside the word it describes and marks 1-2 keywords per cue
                  for colour emphasis. Roughly one cue in three gets decorated. Adds ~40s to
                  a re-render.
                </span>
              </span>
            </label>

            {presets.map((p) => (
              <button
                key={p.id}
                type="button"
                onClick={() => onSelectPreset(p.id)}
                className={`rounded-[--radius-md] border p-3 text-left transition-colors ${
                  style.id === p.id ? 'border-ink bg-surface-soft' : 'border-hairline hover:border-ink/40'
                }`}
              >
                <div className="flex items-center justify-between gap-2">
                  <span className="text-sm font-medium">{p.label}</span>
                  <PresetSwatch style={p} />
                </div>
                <p className="mt-0.5 text-xs text-ink/50">{p.description}</p>
              </button>
            ))}
          </div>
        )}

        {section === 'type' && (
          <>
            <Field label="Font">
              <select
                value={style.fontFamily}
                onChange={(e) => set('fontFamily', e.target.value)}
                className="w-full rounded-[--radius-sm] border border-hairline bg-canvas px-2 py-2 text-sm"
              >
                <optgroup label="Display (Latin)">
                  {fonts.filter((f) => !f.indic).map((f) => (
                    <option key={f.family} value={f.family}>{f.label}</option>
                  ))}
                </optgroup>
                <optgroup label="Indic scripts">
                  {fonts.filter((f) => f.indic).map((f) => (
                    <option key={f.family} value={f.family}>{f.label}</option>
                  ))}
                </optgroup>
              </select>
              <p className="mt-1 text-[11px] text-ink/40">
                Latin faces have no Tamil or Devanagari glyphs — native-script captions
                switch to Noto automatically.
              </p>
            </Field>

            <Scrub
              label="Size"
              value={style.fontSizePct}
              min={1.5}
              max={12}
              step={0.1}
              sensitivity={0.04}
              suffix="%"
              onChange={(v) => set('fontSizePct', v)}
              hint={
                style.fontSizePct > 4.6 && style.maxWordsPerCue > 4
                  ? 'Long lines auto-shrink to fit — lower Words per cue in Layout to see this take effect.'
                  : 'Or drag the corner dot on the caption.'
              }
            />
            <Scrub
              label="Letter spacing"
              value={style.letterSpacing}
              min={-3}
              max={12}
              step={0.5}
              sensitivity={0.08}
              suffix="px"
              onChange={(v) => set('letterSpacing', v)}
            />
            <Scrub
              label="Line spacing"
              value={style.lineSpacing}
              min={0.8}
              max={1.8}
              step={0.05}
              sensitivity={0.006}
              suffix="×"
              onChange={(v) => set('lineSpacing', v)}
            />
            <div className="flex gap-2">
              <Toggle label="Bold" on={style.bold} onClick={() => set('bold', !style.bold)} />
              <Toggle label="Italic" on={style.italic} onClick={() => set('italic', !style.italic)} />
              <Toggle
                label="UPPERCASE"
                on={style.uppercase}
                onClick={() => set('uppercase', !style.uppercase)}
              />
            </div>
          </>
        )}

        {section === 'colour' && (
          <>
            <div className="rounded-[--radius-md] border border-hairline p-3">
              <div className="flex items-center justify-between gap-2">
                <div>
                  <div className="text-sm font-medium">Match the video</div>
                  <div className="text-[11px] text-ink/50">
                    Samples the footage behind your captions and picks colours that stay
                    legible over it.
                  </div>
                </div>
                <button
                  type="button"
                  onClick={onMatchPalette}
                  disabled={matchingPalette}
                  className="btn-secondary shrink-0"
                >
                  {matchingPalette ? '…' : 'Match'}
                </button>
              </div>
              {palette && (
                <div className="mt-2.5 flex items-center gap-1.5">
                  <span className="text-[10px] text-ink/40">from video</span>
                  {palette.map((c) => (
                    <span
                      key={c}
                      title={c}
                      className="h-4 w-4 rounded-[3px] border border-hairline"
                      style={{ background: c }}
                    />
                  ))}
                </div>
              )}
            </div>

            <div className="grid grid-cols-2 gap-3">
              <Colour label="Text" value={style.textColor} onChange={(v) => set('textColor', v)} />
              <Colour
                label="Active word"
                value={style.accentColor}
                onChange={(v) => set('accentColor', v)}
              />
              <Colour
                label="Keyword"
                value={style.keywordColor}
                onChange={(v) => set('keywordColor', v)}
              />
              <Colour
                label="Outline"
                value={style.outlineColor}
                onChange={(v) => set('outlineColor', v)}
              />
            </div>

            <Field label="Keyword emphasis">
              <div className="grid grid-cols-3 gap-2">
                {(
                  [
                    ['fill', 'Fill'],
                    ['outline', 'Outline'],
                    ['none', 'Off'],
                  ] as Array<[CaptionStyle['keywordStyle'], string]>
                ).map(([k, label]) => (
                  <button
                    key={k}
                    type="button"
                    onClick={() => set('keywordStyle', k)}
                    className={`rounded-[--radius-md] border px-2 py-1.5 text-xs transition-colors ${
                      style.keywordStyle === k
                        ? 'border-ink bg-surface-soft font-medium'
                        : 'border-hairline hover:border-ink/40'
                    }`}
                  >
                    {label}
                  </button>
                ))}
              </div>
              <p className="mt-1 text-[10px] text-ink/40">
                Outline recolours the border, which clashes on thick strokes. Fill is calmer.
              </p>
            </Field>

            <Scrub
              label="Outline width"
              value={style.outlineWidthPct}
              min={0}
              max={1.2}
              step={0.02}
              sensitivity={0.006}
              suffix="%"
              onChange={(v) => set('outlineWidthPct', v)}
            />
            <Scrub
              label="Shadow"
              value={style.shadowDepthPct}
              min={0}
              max={1}
              step={0.02}
              sensitivity={0.005}
              suffix="%"
              onChange={(v) => set('shadowDepthPct', v)}
            />

            <Field label="Background">
              <div className="flex gap-2">
                {(['none', 'box'] as BackgroundMode[]).map((b) => (
                  <Toggle
                    key={b}
                    label={b === 'none' ? 'None' : 'Plate'}
                    on={style.background === b}
                    onClick={() => set('background', b)}
                  />
                ))}
              </div>
            </Field>
            {style.background === 'box' && (
              <>
                <Colour
                  label="Plate colour"
                  value={style.backgroundColor}
                  onChange={(v) => set('backgroundColor', v)}
                />
                <Scrub
                  label="Plate opacity"
                  value={style.backgroundOpacity}
                  min={0}
                  max={1}
                  step={0.05}
                  sensitivity={0.005}
                  format={(v) => `${Math.round(v * 100)}%`}
                  onChange={(v) => set('backgroundOpacity', v)}
                />
              </>
            )}
          </>
        )}

        {section === 'layout' && (
          <>
            <div className="grid grid-cols-2 gap-3">
              <Scrub
                label="Position X"
                value={style.positionX}
                min={0.06}
                max={0.94}
                step={0.005}
                sensitivity={0.003}
                format={(v) => `${Math.round(v * 100)}%`}
                onChange={(v) => set('positionX', v)}
              />
              <Scrub
                label="Position Y"
                value={style.positionY}
                min={0.06}
                max={0.94}
                step={0.005}
                sensitivity={0.003}
                format={(v) => `${Math.round(v * 100)}%`}
                onChange={(v) => set('positionY', v)}
              />
            </div>
            <button
              type="button"
              onClick={() => onChange({ ...style, positionX: 0.5, positionY: 0.65 })}
              className="btn-secondary w-full"
            >
              Recentre in safe area
            </button>

            <Scrub
              label="Max width"
              value={style.marginXPct}
              min={2}
              max={28}
              step={1}
              sensitivity={0.1}
              suffix="% margin"
              onChange={(v) => set('marginXPct', v)}
            />
            <Scrub
              label="Words per cue"
              value={style.maxWordsPerCue}
              min={1}
              max={12}
              step={1}
              sensitivity={0.05}
              suffix="words"
              onChange={(v) => set('maxWordsPerCue', v)}
              hint="Fewer words means bigger text. Viral styles use 3."
            />
            <div className="grid grid-cols-2 gap-3">
              <Scrub
                label="Max lines"
                value={style.maxLines}
                min={1}
                max={3}
                step={1}
                sensitivity={0.02}
                onChange={(v) => set('maxLines', v)}
              />
              <Scrub
                label="Chars / line"
                value={style.maxCharsPerLine}
                min={8}
                max={42}
                step={1}
                sensitivity={0.08}
                onChange={(v) => set('maxCharsPerLine', v)}
              />
            </div>

            <Field label="Animation">
              <div className="grid grid-cols-2 gap-2">
                {ANIMATION_CHOICES.map((a) => (
                  <button
                    key={a.id}
                    type="button"
                    onClick={() => set('animation', a.id)}
                    className={`rounded-[--radius-md] border p-2 text-left transition-colors ${
                      style.animation === a.id
                        ? 'border-ink bg-surface-soft'
                        : 'border-hairline hover:border-ink/40'
                    }`}
                  >
                    <div className="text-xs font-medium">{a.label}</div>
                    <div className="text-[10px] text-ink/45">{a.hint}</div>
                  </button>
                ))}
              </div>
            </Field>

            {(style.animation === 'pop' ||
              style.animation === 'bounce' ||
              style.animation === 'wave') && (
              <Scrub
                label="Emphasis scale"
                value={style.popScale}
                min={100}
                max={150}
                step={1}
                sensitivity={0.15}
                suffix="%"
                onChange={(v) => set('popScale', v)}
              />
            )}

            {style.animation === 'wave' && (
              <Scrub
                label="Wave height"
                value={style.waveAmplitudePct}
                min={0}
                max={4}
                step={0.1}
                sensitivity={0.02}
                suffix="%"
                onChange={(v) => set('waveAmplitudePct', v)}
                hint="Vertical travel of the curve, as a share of frame height."
              />
            )}
          </>
        )}

        {section === 'timing' && (
          <>
            <div className="rounded-[--radius-sm] bg-block-cream px-2.5 py-2 text-[11px]">
              Word timings are derived from silence detection, not the speech API, so they can
              sit up to ~0.3s off. Nudge until the highlight lands on the spoken word.
            </div>

            <div className="grid grid-cols-2 gap-3">
              <Scrub
                label="Min duration"
                value={style.minDurationSec}
                min={0.3}
                max={3}
                step={0.05}
                sensitivity={0.008}
                suffix="s"
                onChange={(v) => set('minDurationSec', v)}
              />
              <Scrub
                label="Max duration"
                value={style.maxDurationSec}
                min={1}
                max={12}
                step={0.25}
                sensitivity={0.03}
                suffix="s"
                onChange={(v) => set('maxDurationSec', v)}
              />
            </div>
            <p className="-mt-2 text-[10px] text-ink/40">
              How long a single caption may stay on screen. Changing these regroups the
              captions on the next render.
            </p>

            <Scrub
              label="Caption offset"
              value={timingOffsetMs}
              min={-3000}
              max={3000}
              step={10}
              sensitivity={2}
              format={(v) => `${v > 0 ? '+' : ''}${v}`}
              suffix="ms"
              onChange={onTimingOffsetChange}
              hint="Negative shows captions earlier, positive later."
            />

            <div className="flex flex-wrap gap-1.5">
              {[-250, -100, -50, 50, 100, 250].map((d) => (
                <button
                  key={d}
                  type="button"
                  onClick={() => onTimingOffsetChange(clampOffset(timingOffsetMs + d))}
                  className="rounded-[--radius-pill] border border-hairline px-2.5 py-1 font-mono text-[11px] transition-colors hover:border-ink"
                >
                  {d > 0 ? `+${d}` : d}
                </button>
              ))}
              <button
                type="button"
                onClick={() => onTimingOffsetChange(0)}
                className="rounded-[--radius-pill] border border-hairline px-2.5 py-1 text-[11px] transition-colors hover:border-ink"
              >
                Reset
              </button>
            </div>

            <p className="text-[11px] text-ink/45">
              Play the preview while adjusting — the overlay shifts live. The offset is baked in
              on the next render.
            </p>
          </>
        )}
      </div>

      <div className="flex items-center gap-2 border-t border-hairline bg-surface-soft px-5 py-3">
        <button type="button" className="btn-primary flex-1" disabled={busy} onClick={onApply}>
          {busy ? 'Rendering…' : dirty ? 'Apply & re-render' : 'Re-render'}
        </button>
        <button type="button" className="btn-secondary" disabled={busy || !dirty} onClick={onReset}>
          Reset
        </button>
      </div>
      {dirty && (
        <p className="px-5 pb-3 text-[11px] text-ink/45">
          Preview is live. The downloadable video updates only after you apply.
        </p>
      )}
    </div>
  );
}

function PresetSwatch({ style }: { style: CaptionStyle }) {
  return (
    <span className="flex gap-1">
      {[style.textColor, style.accentColor, style.keywordColor].map((c, i) => (
        <span
          key={i}
          className="h-3.5 w-3.5 rounded-full border border-hairline"
          style={{ background: c }}
        />
      ))}
    </span>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div>
      <div className="label mb-1.5">{label}</div>
      {children}
    </div>
  );
}

function Toggle({ label, on, onClick }: { label: string; on: boolean; onClick: () => void }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={`rounded-[--radius-pill] border px-3 py-1.5 text-xs font-medium transition-colors ${
        on ? 'border-ink bg-ink text-canvas' : 'border-hairline text-ink/60 hover:border-ink/40'
      }`}
    >
      {label}
    </button>
  );
}

function Colour({
  label,
  value,
  onChange,
}: {
  label: string;
  value: string;
  onChange: (v: string) => void;
}) {
  return (
    <div>
      <div className="label mb-1.5">{label}</div>
      <div className="flex items-center gap-2">
        <input
          type="color"
          value={value}
          onChange={(e) => onChange(e.target.value.toUpperCase())}
          className="swatch"
        />
        <input
          type="text"
          value={value}
          onChange={(e) => {
            const v = e.target.value.toUpperCase();
            // Only propagate complete hex values, or typing mid-edit resets the picker.
            if (/^#[0-9A-F]{6}$/.test(v)) onChange(v);
          }}
          className="w-20 rounded-[--radius-sm] border border-hairline px-1.5 py-1 font-mono text-[11px]"
        />
      </div>
    </div>
  );
}

const clampOffset = (ms: number) => Math.max(-3000, Math.min(3000, ms));
