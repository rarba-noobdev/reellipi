import { useState } from 'react';
import { Link } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { deleteLocalProject, listLocalProjects, listPresets, uploadLocal } from '../lib/localApi';
import { LANGUAGE_CHOICES } from '../lib/types';

const BUSY = ['uploaded', 'transcribing', 'styling', 'rendering'];

/** Pastel block per status — the design system's colour-block motif. */
const STATUS_BLOCK: Record<string, string> = {
  done: 'bg-block-mint',
  failed: 'bg-block-pink',
  ready_to_render: 'bg-block-cream',
};

export function LocalDashboard() {
  const qc = useQueryClient();
  const [choice, setChoice] = useState(LANGUAGE_CHOICES[0]!);
  const [presetId, setPresetId] = useState('karaoke_bold');
  const [progress, setProgress] = useState(0);
  const [busy, setBusy] = useState(false);
  const [dragging, setDragging] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const presets = useQuery({ queryKey: ['presets'], queryFn: listPresets });
  const projects = useQuery({
    queryKey: ['localProjects'],
    queryFn: listLocalProjects,
    refetchInterval: (q) =>
      q.state.data?.projects.some((p) => BUSY.includes(p.status)) ? 1500 : 5000,
  });

  const remove = useMutation({
    mutationFn: deleteLocalProject,
    onSuccess: () => void qc.invalidateQueries({ queryKey: ['localProjects'] }),
  });

  const handleFile = async (file: File) => {
    setError(null);
    if (!file.type.startsWith('video/')) return setError('That is not a video file.');
    setBusy(true);
    setProgress(0);
    try {
      await uploadLocal(file, {
        langMode: choice.mode,
        languageCode: choice.languageCode,
        stylePreset: presetId,
        onProgress: setProgress,
      });
      await qc.invalidateQueries({ queryKey: ['localProjects'] });
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="space-y-12">
      <section className="grid gap-8 lg:grid-cols-[1fr_minmax(0,420px)]">
        <div className="flex flex-col justify-center">
          <h1 className="text-5xl leading-[1.02] font-medium tracking-tight sm:text-6xl">
            Captions that
            <br />
            speak Tanglish.
          </h1>
          <p className="mt-5 max-w-md text-base text-ink/60">
            Upload a reel. Speech is transcribed in the language mix people actually speak, then
            burned in as captions you can style down to the pixel.
          </p>
          <div className="mt-6 flex flex-wrap gap-2">
            {['Tanglish', 'Hinglish', 'Native script', 'English'].map((t, i) => (
              <span
                key={t}
                className={`rounded-[--radius-pill] px-3 py-1.5 text-xs font-medium ${
                  ['bg-block-lime', 'bg-block-lilac', 'bg-block-cream', 'bg-block-mint'][i]
                }`}
              >
                {t}
              </span>
            ))}
          </div>
        </div>

        <div className="card space-y-5 p-6">
          <div>
            <div className="label mb-2">Caption language</div>
            <div className="grid grid-cols-2 gap-2">
              {LANGUAGE_CHOICES.map((c) => (
                <button
                  key={c.id}
                  type="button"
                  onClick={() => setChoice(c)}
                  className={`rounded-[--radius-md] border p-2.5 text-left transition-colors ${
                    choice.id === c.id
                      ? 'border-ink bg-surface-soft'
                      : 'border-hairline hover:border-ink/40'
                  }`}
                >
                  <div className="text-sm font-medium">{c.label}</div>
                  <div className="text-[10px] leading-tight text-ink/45">{c.description}</div>
                </button>
              ))}
            </div>
          </div>

          <div>
            <div className="label mb-2">Starting style</div>
            <div className="flex flex-wrap gap-1.5">
              {(presets.data?.presets ?? []).map((p) => (
                <button
                  key={p.id}
                  type="button"
                  onClick={() => setPresetId(p.id)}
                  title={p.description}
                  className={`rounded-[--radius-pill] border px-3 py-1.5 text-xs font-medium transition-colors ${
                    presetId === p.id
                      ? 'border-ink bg-ink text-canvas'
                      : 'border-hairline hover:border-ink/40'
                  }`}
                >
                  {p.label}
                </button>
              ))}
            </div>
            <p className="mt-1.5 text-[11px] text-ink/40">
              Everything stays editable after upload.
            </p>
          </div>

          <label
            onDragOver={(e) => {
              e.preventDefault();
              setDragging(true);
            }}
            onDragLeave={() => setDragging(false)}
            onDrop={(e) => {
              e.preventDefault();
              setDragging(false);
              const f = e.dataTransfer.files[0];
              if (f && !busy) void handleFile(f);
            }}
            className={`block cursor-pointer rounded-[--radius-lg] border-2 border-dashed p-8 text-center transition-colors ${
              busy
                ? 'border-hairline opacity-60'
                : dragging
                  ? 'border-ink bg-block-lime'
                  : 'border-hairline hover:border-ink'
            }`}
          >
            <input
              type="file"
              accept="video/*"
              className="hidden"
              disabled={busy}
              onChange={(e) => {
                const f = e.target.files?.[0];
                if (f) void handleFile(f);
              }}
            />
            {busy ? (
              <div className="space-y-2">
                <div className="text-sm font-medium">Uploading… {progress}%</div>
                <div className="h-1 overflow-hidden rounded-full bg-hairline">
                  <div className="h-full bg-ink transition-all" style={{ width: `${progress}%` }} />
                </div>
              </div>
            ) : (
              <>
                <div className="text-sm font-medium">Drop a reel here</div>
                <div className="mt-0.5 text-xs text-ink/45">or click to browse · 9:16 · up to 500 MB</div>
              </>
            )}
          </label>

          {error && <p className="text-sm text-accent-magenta">{error}</p>}
        </div>
      </section>

      <section>
        <div className="mb-4 flex items-baseline justify-between border-b border-hairline pb-3">
          <h2 className="text-xl font-medium">Your reels</h2>
          <span className="text-xs text-ink/40">{projects.data?.projects.length ?? 0} total</span>
        </div>

        {projects.data?.projects.length === 0 && (
          <p className="py-10 text-center text-sm text-ink/40">
            Nothing yet. Drop a reel above to get started.
          </p>
        )}

        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
          {projects.data?.projects.map((p) => (
            <div key={p.id} className="card group overflow-hidden transition-colors hover:border-ink">
              <Link to={`/project/${p.id}`} className="block p-4">
                <div className="flex items-start justify-between gap-2">
                  <div className="min-w-0">
                    <div className="truncate font-medium">{p.title}</div>
                    <div className="mt-0.5 text-xs text-ink/45">
                      {p.durationSeconds ? `${p.durationSeconds.toFixed(0)}s · ` : ''}
                      {new Date(p.createdAt).toLocaleDateString()}
                    </div>
                  </div>
                  <span
                    className={`shrink-0 rounded-[--radius-pill] px-2 py-0.5 text-[10px] font-medium ${
                      STATUS_BLOCK[p.status] ?? 'bg-surface-soft'
                    }`}
                  >
                    {p.status.replace(/_/g, ' ')}
                  </span>
                </div>

                {BUSY.includes(p.status) && (
                  <div className="mt-3 h-1 overflow-hidden rounded-full bg-hairline">
                    <div className="h-full bg-ink transition-all" style={{ width: `${p.progress}%` }} />
                  </div>
                )}
              </Link>
              <div className="flex justify-end border-t border-hairline-soft px-4 py-2">
                <button
                  type="button"
                  onClick={() => remove.mutate(p.id)}
                  className="text-[11px] text-ink/35 transition-colors hover:text-accent-magenta"
                >
                  Delete
                </button>
              </div>
            </div>
          ))}
        </div>
      </section>
    </div>
  );
}
