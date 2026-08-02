import { useEffect, useMemo, useState } from 'react';

import { Link, useParams } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  getLocalProject,
  getPalette,
  listPresets,
  localFileUrl,
  rerenderLocal,
  saveLocalCues,
} from '../lib/localApi';
import { PreviewPlayer, type PreviewMode } from '../components/PreviewPlayer';
import { TranscriptEditor } from '../components/TranscriptEditor';
import { StyleEditor } from '../components/StyleEditor';
import type { Cue } from '../lib/types';
import { detectCollisions } from '../lib/captionStyle';
import type { CaptionStyle } from '../lib/captionStyle';

const BUSY = ['uploaded', 'transcribing', 'styling', 'rendering'];

const STATUS_LABEL: Record<string, string> = {
  uploaded: 'Queued',
  transcribing: 'Transcribing speech',
  styling: 'Writing caption',
  ready_to_render: 'Ready to render',
  rendering: 'Burning captions in',
  done: 'Ready',
  failed: 'Failed',
};

/** Fields the user can override; everything else is preset identity. */
const OVERRIDE_KEYS: Array<keyof CaptionStyle> = [
  'fontFamily', 'fontSizePct', 'bold', 'italic', 'uppercase', 'punctuation',
  'letterSpacing', 'lineSpacing',
  'textColor', 'accentColor', 'keywordColor', 'keywordStyle', 'outlineColor', 'outlineWidthPct',
  'shadowColor', 'shadowDepthPct', 'background', 'backgroundColor', 'backgroundOpacity',
  'positionY', 'positionX', 'marginXPct', 'animation', 'popScale', 'waveAmplitudePct',
  'maxWordsPerCue', 'maxLines', 'maxCharsPerLine', 'minDurationSec', 'maxDurationSec',
];

/** Fields that change cue grouping, so a restyle is needed rather than just a re-render. */
const REGROUP_KEYS: Array<keyof CaptionStyle> = [
  'maxWordsPerCue', 'maxLines', 'maxCharsPerLine', 'minDurationSec', 'maxDurationSec',
];

/**
 * Mirror of styleKey() in the worker's localPipeline.ts. Must stay in step, or the UI
 * will either nag about a fresh export or stay silent about a stale one.
 */
function styleKeyOf(
  style: CaptionStyle,
  base: CaptionStyle,
  offsetMs: number,
  smart: boolean,
): string {
  const overrides = diffOverrides(base, style);
  const serialised = Object.keys(overrides)
    .sort()
    .map((k) => `${k}=${String((overrides as Record<string, unknown>)[k])}`)
    .join(',');
  return [style.id, serialised, `offset=${offsetMs}`, `smart=${smart ? 1 : 0}`].join('|');
}

function diffOverrides(base: CaptionStyle, edited: CaptionStyle): Partial<CaptionStyle> {
  const out: Partial<CaptionStyle> = {};
  for (const k of OVERRIDE_KEYS) {
    if (edited[k] !== base[k]) (out as Record<string, unknown>)[k] = edited[k];
  }
  return out;
}

export function LocalProjectPage() {
  const { id = '' } = useParams();
  const qc = useQueryClient();
  const [localCues, setLocalCues] = useState<Cue[] | null>(null);
  const [draftStyle, setDraftStyle] = useState<CaptionStyle | null>(null);
  const [draftOffset, setDraftOffset] = useState<number | null>(null);
  const [showRendered, setShowRendered] = useState(true);
  const [previewMode, setPreviewMode] = useState<PreviewMode>('instagram');
  const [previewTime, setPreviewTime] = useState(0);
  const [draftSmart, setDraftSmart] = useState<boolean | null>(null);

  const q = useQuery({
    queryKey: ['localProject', id],
    queryFn: () => getLocalProject(id),
    refetchInterval: (query) => (BUSY.includes(query.state.data?.project.status ?? '') ? 1200 : false),
  });
  const presets = useQuery({ queryKey: ['presets'], queryFn: listPresets });

  // Sampling decodes frames, so only run it when the user asks.
  const palette = useQuery({
    queryKey: ['palette', id],
    queryFn: () => getPalette(id),
    enabled: false,
    staleTime: Infinity,
  });

  const project = q.data?.project;

  /**
   * Preset as authored, plus whatever overrides were last applied.
   *
   * Returns null until BOTH the presets and the project have loaded. They arrive from
   * different requests, and resolving early meant falling back to presets[0]: the draft
   * then adopted the wrong preset and, because it is only adopted once, never corrected
   * itself. The preview showed one style while the export used another.
   */
  const savedStyle = useMemo(() => {
    const list = presets.data?.presets;
    if (!list?.length || !project) return null;
    const base = list.find((p) => p.id === project.stylePreset) ?? list[0]!;
    return { ...base, ...(project.styleOverrides ?? {}) } as CaptionStyle;
  }, [presets.data, project]);

  useEffect(() => {
    if (q.data?.cues) setLocalCues(q.data.cues);
  }, [q.data?.cues]);

  // Adopt the saved style once, then leave the draft alone so edits are not clobbered
  // by the poll that runs while a render is in flight.
  useEffect(() => {
    if (savedStyle && !draftStyle) setDraftStyle(savedStyle);
  }, [savedStyle, draftStyle]);

  useEffect(() => {
    if (project && draftOffset === null) setDraftOffset(project.timingOffsetMs ?? 0);
    if (project && draftSmart === null) setDraftSmart(project.smartGrouping ?? false);
  }, [project, draftOffset, draftSmart]);

  const rerender = useMutation({
    mutationFn: (body: {
      stylePreset?: string;
      styleOverrides?: Partial<CaptionStyle>;
      timingOffsetMs?: number;
      smartGrouping?: boolean;
      regroup?: boolean;
    }) => rerenderLocal(id, body),
    onSuccess: () => void qc.invalidateQueries({ queryKey: ['localProject', id] }),
  });

  const saveCues = useMutation({ mutationFn: (cues: Cue[]) => saveLocalCues(id, cues) });

  // Worst case across every cue, so the warning is stable during playback.
  const collisions = useMemo(
    () => (localCues && draftStyle ? detectCollisions(localCues, draftStyle) : []),
    [localCues, draftStyle],
  );

  if (q.isLoading) return <p className="text-ink/50">Loading…</p>;
  if (q.error) return <p className="text-accent-magenta">{(q.error as Error).message}</p>;
  if (!project || !savedStyle || !draftStyle || draftOffset === null || draftSmart === null) {
    return <p className="text-ink/50">Loading…</p>;
  }

  const busy = BUSY.includes(project.status);
  const dirty =
    JSON.stringify(draftStyle) !== JSON.stringify(savedStyle) ||
    draftOffset !== (project.timingOffsetMs ?? 0) ||
    draftSmart !== (project.smartGrouping ?? false);

  const basePreset =
    presets.data!.presets.find((p) => p.id === draftStyle.id) ?? presets.data!.presets[0]!;

  /*
   * The download can also be behind without the draft being dirty — for example the
   * saved style was changed by a restyle that has not been re-rendered. Compare against
   * the fingerprint recorded when the file was actually produced.
   */
  const currentKey = styleKeyOf(draftStyle, basePreset, draftOffset, draftSmart);
  const exportStale =
    project.status === 'done' &&
    project.renderedStyleKey !== null &&
    project.renderedStyleKey !== currentKey;
  const renderedReady = project.status === 'done' && project.outputFile;
  // Only show the exported file when it actually represents the current style; otherwise
  // the preview would be silently displaying something the settings no longer describe.
  const showBaked = Boolean(renderedReady && showRendered && !dirty && !exportStale);

  const videoSrc = showBaked
    ? localFileUrl(project.id, project.outputFile!)
    : project.sourceFile
      ? localFileUrl(project.id, project.sourceFile)
      : null;

  return (
    <div className="space-y-6">
      <header className="flex flex-wrap items-end justify-between gap-4 border-b border-hairline pb-5">
        <div>
          <Link to="/" className="btn-ghost -ml-3 mb-1">
            ← All reels
          </Link>
          <h1 className="text-3xl font-medium">{project.title}</h1>
          <p className="mt-1 text-sm text-ink/50">
            {STATUS_LABEL[project.status] ?? project.status}
            {project.detectedLanguage ? ` · ${project.detectedLanguage}` : ''}
            {project.durationSeconds ? ` · ${project.durationSeconds.toFixed(1)}s` : ''}
          </p>
        </div>

        {renderedReady && (
          <div className="flex flex-wrap items-center gap-2">
            {exportStale && (
              <span className="rounded-[--radius-pill] bg-block-coral px-3 py-1.5 text-[11px] font-medium">
                Download is from an older style — Apply to update it
              </span>
            )}
            <a
              href={localFileUrl(project.id, project.outputFile!, true)}
              className={exportStale ? 'btn-secondary' : 'btn-primary'}
            >
              Download MP4
            </a>
            <a href={localFileUrl(project.id, 'out.srt', true)} className="btn-secondary">
              .srt
            </a>
            <a href={localFileUrl(project.id, 'out.vtt', true)} className="btn-secondary">
              .vtt
            </a>
          </div>
        )}
      </header>

      {busy && (
        <div className="rounded-[--radius-md] bg-block-lilac px-4 py-3">
          <div className="mb-2 flex justify-between text-xs font-medium">
            <span>{STATUS_LABEL[project.status]}</span>
            <span>{project.progress}%</span>
          </div>
          <div className="h-1 overflow-hidden rounded-full bg-ink/15">
            <div className="h-full bg-ink transition-all" style={{ width: `${project.progress}%` }} />
          </div>
        </div>
      )}

      {project.status === 'failed' && (
        <div className="rounded-[--radius-md] bg-block-pink px-4 py-3 text-sm">
          {project.error ?? 'Processing failed.'}
        </div>
      )}

      {project.timingApproximate && !busy && (
        <div className="rounded-[--radius-md] bg-block-cream px-4 py-3 text-xs">
          Word timings are estimated. Sarvam's speech API returns one timestamp for the whole
          clip, so word positions come from silence detection — expect up to ~0.3s of drift on
          the highlight.
        </div>
      )}

      {/*
        Three columns only once there is genuinely room for them. Below 1280px the
        preview and editor sit side by side with the transcript underneath, and below
        1024px everything stacks — cramming three columns into a laptop width made every
        one of them too narrow to use.
      */}
      <div className="grid items-start gap-6 lg:grid-cols-2 xl:grid-cols-[minmax(340px,400px)_minmax(320px,360px)_minmax(0,1fr)]">
        {/* Capped and centred: stacked on a narrow screen the 9:16 frame would otherwise
            stretch to full width and become taller than the viewport. */}
        <div className="mx-auto w-full max-w-[400px] space-y-3 lg:mx-0 xl:sticky xl:top-24">
          {videoSrc && localCues ? (
            <PreviewPlayer
              key={videoSrc}
              src={videoSrc}
              cues={localCues}
              style={draftStyle}
              languageCode={project.detectedLanguage}
              mode={previewMode}
              igCaption={project.igCaption}
              baked={showBaked}
              timingOffsetMs={draftOffset}
              onStyleChange={(patch) => setDraftStyle({ ...draftStyle, ...patch })}
              onTimeChange={setPreviewTime}
            />
          ) : (
            <div className="grid aspect-[9/16] w-full place-items-center rounded-[--radius-lg] bg-surface-soft text-sm text-ink/40">
              {busy ? 'Processing…' : 'No preview'}
            </div>
          )}

          <div className="flex flex-wrap items-center gap-2">
            {renderedReady && (
              <div className="flex rounded-[--radius-pill] border border-hairline p-0.5">
                <button
                  type="button"
                  onClick={() => setShowRendered(true)}
                  disabled={dirty}
                  className={`rounded-[--radius-pill] px-3 py-1 text-xs disabled:opacity-40 ${
                    showRendered && !dirty ? 'bg-ink text-canvas' : 'text-ink/60'
                  }`}
                >
                  Rendered
                </button>
                <button
                  type="button"
                  onClick={() => setShowRendered(false)}
                  className={`rounded-[--radius-pill] px-3 py-1 text-xs ${
                    !showRendered || dirty ? 'bg-ink text-canvas' : 'text-ink/60'
                  }`}
                >
                  Live
                </button>
              </div>
            )}
            <div className="flex rounded-[--radius-pill] border border-hairline p-0.5">
              {(
                [
                  ['instagram', 'Instagram'],
                  ['guides', 'Safe area'],
                  ['clean', 'Clean'],
                ] as Array<[PreviewMode, string]>
              ).map(([m, label]) => (
                <button
                  key={m}
                  type="button"
                  onClick={() => setPreviewMode(m)}
                  className={`rounded-[--radius-pill] px-2.5 py-1 text-xs transition-colors ${
                    previewMode === m ? 'bg-ink text-canvas' : 'text-ink/60 hover:text-ink'
                  }`}
                >
                  {label}
                </button>
              ))}
            </div>
          </div>

          {/* Fixed-height slot: the warning appearing and vanishing must not reflow the
              controls below it. */}
          <div className="min-h-[2.75rem]">
            {collisions.length > 0 && !showBaked ? (
              <div className="flex items-start gap-2 rounded-[--radius-md] bg-block-coral px-3 py-2 text-[11px]">
                <span>
                  Captions overlap Instagram's {collisions.join(' and ')}.
                </span>
                <button
                  type="button"
                  onClick={() => setDraftStyle({ ...draftStyle, positionX: 0.5, positionY: 0.55 })}
                  className="ml-auto shrink-0 rounded-[--radius-pill] border border-ink/30 px-2 py-0.5 font-medium hover:border-ink"
                >
                  Fix
                </button>
              </div>
            ) : dirty && renderedReady ? (
              <p className="text-[11px] text-ink/45">
                Live overlay of your unsaved style. Apply to bake it into the video.
              </p>
            ) : null}
          </div>
        </div>

        <StyleEditor
          style={draftStyle}
          presets={presets.data!.presets}
          fonts={presets.data!.fonts}
          dirty={dirty}
          busy={busy}
          timingOffsetMs={draftOffset}
          onTimingOffsetChange={setDraftOffset}
          smartGrouping={draftSmart}
          onSmartGroupingChange={setDraftSmart}
          palette={palette.data?.dominant}
          matchingPalette={palette.isFetching}
          onMatchPalette={() => {
            void palette.refetch().then(({ data }) => {
              if (data) setDraftStyle({ ...draftStyle, ...data.suggestion });
            });
          }}
          onChange={setDraftStyle}
          onSelectPreset={(presetId) => {
            const next = presets.data!.presets.find((p) => p.id === presetId);
            if (!next) return;
            /*
             * A preset defines the LOOK. Where the caption sits on the frame is a
             * placement decision the user made by dragging, and it survives a preset
             * change — having the block jump back to centre every time you audition a
             * style makes the picker unusable.
             */
            setDraftStyle({
              ...next,
              positionX: draftStyle.positionX,
              positionY: draftStyle.positionY,
            });
          }}
          onReset={() => {
            setDraftStyle({ ...basePreset });
            setDraftOffset(project.timingOffsetMs ?? 0);
            setDraftSmart(project.smartGrouping ?? false);
          }}
          onApply={() => {
            // Grouping fields need the cues rebuilt; colour and position do not.
            const regroup = REGROUP_KEYS.some((k) => draftStyle[k] !== savedStyle[k]);
            rerender.mutate({
              stylePreset: draftStyle.id,
              styleOverrides: diffOverrides(basePreset, draftStyle),
              timingOffsetMs: draftOffset,
              smartGrouping: draftSmart,
              regroup,
            });
            setShowRendered(true);
          }}
        />

        {/* Spans both columns at lg, becomes the third column at xl. */}
        <div className="space-y-5 lg:col-span-2 xl:col-span-1">
          {project.igCaption && (
            <div className="card p-4">
              <div className="label mb-2">Instagram caption</div>
              <p className="text-sm whitespace-pre-line">{project.igCaption}</p>
              {project.hashtags.length > 0 && (
                <p className="mt-2 text-sm text-ink/55">
                  {project.hashtags.map((h) => `#${h}`).join(' ')}
                </p>
              )}
              <button
                type="button"
                onClick={() =>
                  void navigator.clipboard.writeText(
                    `${project.igCaption}\n\n${project.hashtags.map((h) => `#${h}`).join(' ')}`,
                  )
                }
                className="btn-secondary mt-3"
              >
                Copy
              </button>
            </div>
          )}

          {localCues && localCues.length > 0 && (
            <div className="xl:sticky xl:top-24">
              <div className="mb-1 flex items-baseline justify-between">
                <span className="label">Transcript</span>
                <span className="text-[11px] text-ink/40">{localCues.length} cues</span>
              </div>
              <p className="mb-3 text-[11px] text-ink/45">
                Click any word to fix it. Timings stay locked to the audio — re-render to bake
                changes into the video.
              </p>
              {/* Capped and scrollable: a 60s reel is 40+ cues and would otherwise make
                  the page several thousand pixels tall. */}
              <div className="max-h-[26rem] overflow-y-auto pr-1 xl:max-h-[calc(100vh-16rem)]">
                <TranscriptEditor
                  cues={localCues}
                  currentTime={previewTime}
                  onChange={(cue) => {
                    const next = localCues.map((c) => (c.idx === cue.idx ? cue : c));
                    setLocalCues(next);
                    saveCues.mutate(next);
                  }}
                />
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
