import { useEffect, useState } from 'react';
import { useParams } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { getCues, getDownloads, listPresets, processProject, saveCue, sourceUrl } from '../lib/api';
import { supabase } from '../lib/supabase';
import { PreviewPlayer } from '../components/PreviewPlayer';
import { TranscriptEditor } from '../components/TranscriptEditor';
import type { Cue, Project } from '../lib/types';

const BUSY_STATUSES = ['uploaded', 'transcribing', 'styling', 'rendering'];

const STATUS_LABEL: Record<string, string> = {
  uploaded: 'Queued',
  transcribing: 'Transcribing speech',
  styling: 'Grouping captions',
  ready_to_render: 'Ready to render',
  rendering: 'Burning captions in',
  done: 'Done',
  failed: 'Failed',
};

export function ProjectPage() {
  const { id = '' } = useParams();
  const qc = useQueryClient();
  const [preview, setPreview] = useState<string | null>(null);
  const [localCues, setLocalCues] = useState<Cue[] | null>(null);

  const project = useQuery({
    queryKey: ['project', id],
    queryFn: async () => {
      const { data, error } = await supabase.from('projects').select('*').eq('id', id).single();
      if (error) throw new Error(error.message);
      return data as Project;
    },
    refetchInterval: (q) => (BUSY_STATUSES.includes(q.state.data?.status ?? '') ? 2000 : false),
  });

  const cues = useQuery({
    queryKey: ['cues', id],
    queryFn: () => getCues(id),
    enabled: Boolean(project.data && !BUSY_STATUSES.includes(project.data.status)),
  });

  const presets = useQuery({ queryKey: ['presets'], queryFn: listPresets });

  const downloads = useQuery({
    queryKey: ['downloads', id],
    queryFn: () => getDownloads(id),
    enabled: project.data?.status === 'done',
  });

  // Realtime beats polling once the row starts moving; polling stays as the fallback.
  useEffect(() => {
    const channel = supabase
      .channel(`project-${id}`)
      .on(
        'postgres_changes',
        { event: 'UPDATE', schema: 'public', table: 'projects', filter: `id=eq.${id}` },
        () => {
          void qc.invalidateQueries({ queryKey: ['project', id] });
          void qc.invalidateQueries({ queryKey: ['cues', id] });
        },
      )
      .subscribe();
    return () => {
      void supabase.removeChannel(channel);
    };
  }, [id, qc]);

  useEffect(() => {
    const path = project.data?.source_path;
    if (path) void sourceUrl(path).then(setPreview).catch(() => setPreview(null));
  }, [project.data?.source_path]);

  useEffect(() => {
    if (cues.data) setLocalCues(cues.data);
  }, [cues.data]);

  const rerender = useMutation({
    mutationFn: (presetId: string) =>
      processProject(id, { stage: 'render', stylePreset: presetId }),
    onSuccess: () => void qc.invalidateQueries({ queryKey: ['project', id] }),
  });

  const saveEdit = useMutation({
    mutationFn: (cue: Cue) => saveCue(id, cue),
  });

  if (project.isLoading) return <p className="text-neutral-400">Loading…</p>;
  if (project.error) return <p className="text-red-400">{(project.error as Error).message}</p>;
  const p = project.data!;

  const activeStyle =
    presets.data?.presets.find((x) => x.id === (p.style_preset ?? 'karaoke_bold')) ??
    presets.data?.presets[0];

  return (
    <div className="space-y-6">
      <header className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="text-xl font-semibold">{p.title ?? 'Untitled reel'}</h1>
          <p className="text-sm text-neutral-400">
            {STATUS_LABEL[p.status] ?? p.status}
            {p.language_code ? ` · ${p.language_code}` : ''}
            {p.duration_seconds ? ` · ${p.duration_seconds.toFixed(1)}s` : ''}
          </p>
        </div>
        {BUSY_STATUSES.includes(p.status) && (
          <div className="w-48">
            <div className="h-1.5 overflow-hidden rounded-full bg-neutral-800">
              <div className="h-full bg-emerald-500 transition-all" style={{ width: `${p.progress}%` }} />
            </div>
          </div>
        )}
      </header>

      {p.status === 'failed' && (
        <div className="rounded-lg border border-red-500/40 bg-red-500/10 p-3 text-sm text-red-300">
          {p.error ?? 'Processing failed.'}
        </div>
      )}

      {p.timing_approximate && p.status !== 'uploaded' && (
        <div className="rounded-lg border border-amber-500/40 bg-amber-500/10 p-3 text-xs text-amber-200">
          Word timings are estimated. Sarvam's speech API returns one timestamp for the whole
          clip, so each word's position is derived from silence detection — expect up to ~0.3s
          of drift on the karaoke highlight.
        </div>
      )}

      <div className="grid gap-6 lg:grid-cols-[minmax(0,380px)_1fr]">
        <div className="space-y-4">
          {preview && activeStyle && localCues ? (
            <PreviewPlayer
              src={preview}
              cues={localCues}
              style={activeStyle}
              languageCode={p.language_code}
            />
          ) : (
            <div className="grid aspect-[9/16] w-full max-w-sm place-items-center rounded-2xl bg-neutral-900 text-sm text-neutral-500">
              {BUSY_STATUSES.includes(p.status) ? 'Processing…' : 'No preview'}
            </div>
          )}

          {presets.data && (
            <div className="space-y-2">
              <div className="text-xs font-medium tracking-wide text-neutral-400 uppercase">Style</div>
              <div className="flex flex-wrap gap-2">
                {presets.data.presets.map((preset) => (
                  <button
                    key={preset.id}
                    type="button"
                    disabled={rerender.isPending || BUSY_STATUSES.includes(p.status)}
                    onClick={() => rerender.mutate(preset.id)}
                    className={`rounded-lg border px-3 py-1.5 text-sm disabled:opacity-40 ${
                      preset.id === p.style_preset
                        ? 'border-emerald-500 bg-emerald-500/10'
                        : 'border-neutral-700 hover:border-neutral-500'
                    }`}
                  >
                    <span style={{ color: preset.accentColor }}>●</span> {preset.label}
                  </button>
                ))}
              </div>
              <p className="text-[11px] text-neutral-500">
                Changing style re-renders the video. It does not count against your monthly quota.
              </p>
            </div>
          )}

          {downloads.data?.downloads.mp4 && (
            <div className="flex flex-wrap gap-2">
              <a
                href={downloads.data.downloads.mp4}
                download
                className="rounded-lg bg-emerald-500 px-4 py-2 text-sm font-medium text-black hover:bg-emerald-400"
              >
                Download MP4
              </a>
              {downloads.data.downloads.srt && (
                <a href={downloads.data.downloads.srt} download className="rounded-lg border border-neutral-700 px-3 py-2 text-sm">
                  .srt
                </a>
              )}
              {downloads.data.downloads.vtt && (
                <a href={downloads.data.downloads.vtt} download className="rounded-lg border border-neutral-700 px-3 py-2 text-sm">
                  .vtt
                </a>
              )}
            </div>
          )}
        </div>

        <div className="space-y-4">
          {p.ig_caption && (
            <div className="rounded-xl border border-neutral-800 bg-neutral-900 p-4">
              <div className="mb-2 text-xs font-medium tracking-wide text-neutral-400 uppercase">
                Instagram caption
              </div>
              <p className="text-sm">{p.ig_caption}</p>
              {p.hashtags?.length ? (
                <p className="mt-2 text-sm text-emerald-400">
                  {p.hashtags.map((h) => `#${h}`).join(' ')}
                </p>
              ) : null}
              <button
                type="button"
                onClick={() =>
                  void navigator.clipboard.writeText(
                    `${p.ig_caption}\n\n${(p.hashtags ?? []).map((h) => `#${h}`).join(' ')}`,
                  )
                }
                className="mt-3 rounded border border-neutral-700 px-2 py-1 text-xs hover:border-neutral-500"
              >
                Copy
              </button>
            </div>
          )}

          {localCues?.length ? (
            <div>
              <div className="mb-2 text-xs font-medium tracking-wide text-neutral-400 uppercase">
                Transcript — click a word to fix it
              </div>
              <TranscriptEditor
                cues={localCues}
                onChange={(cue) => {
                  setLocalCues((prev) => prev?.map((c) => (c.idx === cue.idx ? cue : c)) ?? null);
                  saveEdit.mutate(cue);
                }}
              />
            </div>
          ) : null}
        </div>
      </div>
    </div>
  );
}
