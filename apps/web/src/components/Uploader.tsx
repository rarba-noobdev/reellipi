import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { processProject, uploadReel } from '../lib/api';
import { LANGUAGE_CHOICES } from '../lib/types';
import type { CaptionStyle } from '../lib/captionStyle';

interface Props {
  presets: CaptionStyle[];
}

const MAX_BYTES = 500 * 1024 * 1024;

export function Uploader({ presets }: Props) {
  const navigate = useNavigate();
  const [choice, setChoice] = useState(LANGUAGE_CHOICES[0]!);
  const [presetId, setPresetId] = useState('karaoke_bold');
  const [consent, setConsent] = useState(false);
  const [busy, setBusy] = useState(false);
  const [progress, setProgress] = useState(0);
  const [error, setError] = useState<string | null>(null);

  const handleFile = async (file: File) => {
    setError(null);
    if (!file.type.startsWith('video/')) return setError('Please choose a video file.');
    if (file.size > MAX_BYTES) return setError('That file is over 500 MB.');
    if (!consent) return setError('Please confirm you have the rights to this video.');

    setBusy(true);
    try {
      const { projectId } = await uploadReel(file, {
        langMode: choice.mode,
        languageCode: choice.languageCode,
        stylePreset: presetId,
        onProgress: setProgress,
      });
      await processProject(projectId, { stage: 'full' });
      navigate(`/project/${projectId}`);
    } catch (e) {
      const err = e as Error & { status?: number };
      setError(
        err.status === 402
          ? 'Monthly reel limit reached — upgrade your plan to keep going.'
          : err.message,
      );
      setBusy(false);
    }
  };

  return (
    <div className="space-y-5 rounded-2xl border border-neutral-800 bg-neutral-900 p-6">
      <div>
        <h2 className="text-lg font-semibold">New reel</h2>
        <p className="text-sm text-neutral-400">
          Upload a 9:16 clip. We transcribe the speech, keep it in Tanglish or Hinglish, and burn
          the captions in.
        </p>
      </div>

      <div>
        <label className="mb-2 block text-xs font-medium tracking-wide text-neutral-400 uppercase">
          Caption language
        </label>
        <div className="grid grid-cols-2 gap-2 sm:grid-cols-3">
          {LANGUAGE_CHOICES.map((c) => (
            <button
              key={c.id}
              type="button"
              onClick={() => setChoice(c)}
              className={`rounded-lg border p-2 text-left text-sm transition-colors ${
                choice.id === c.id
                  ? 'border-emerald-500 bg-emerald-500/10'
                  : 'border-neutral-700 hover:border-neutral-500'
              }`}
            >
              <div className="font-medium">{c.label}</div>
              <div className="text-[11px] text-neutral-400">{c.description}</div>
            </button>
          ))}
        </div>
      </div>

      <div>
        <label className="mb-2 block text-xs font-medium tracking-wide text-neutral-400 uppercase">
          Caption style
        </label>
        <div className="flex flex-wrap gap-2">
          {presets.map((p) => (
            <button
              key={p.id}
              type="button"
              onClick={() => setPresetId(p.id)}
              className={`rounded-lg border px-3 py-2 text-sm transition-colors ${
                presetId === p.id
                  ? 'border-emerald-500 bg-emerald-500/10'
                  : 'border-neutral-700 hover:border-neutral-500'
              }`}
            >
              <span style={{ color: p.accentColor }}>●</span> {p.label}
            </button>
          ))}
        </div>
      </div>

      <label className="flex items-start gap-2 text-xs text-neutral-400">
        <input
          type="checkbox"
          checked={consent}
          onChange={(e) => setConsent(e.target.checked)}
          className="mt-0.5"
        />
        <span>
          I have the rights to this video and consent to it being processed. Source files,
          audio and transcripts are deleted automatically after the retention window.
        </span>
      </label>

      <label
        className={`block cursor-pointer rounded-xl border-2 border-dashed p-8 text-center transition-colors ${
          busy ? 'border-neutral-700 opacity-60' : 'border-neutral-600 hover:border-emerald-500'
        }`}
        onDragOver={(e) => e.preventDefault()}
        onDrop={(e) => {
          e.preventDefault();
          const file = e.dataTransfer.files[0];
          if (file && !busy) void handleFile(file);
        }}
      >
        <input
          type="file"
          accept="video/*"
          className="hidden"
          disabled={busy}
          onChange={(e) => {
            const file = e.target.files?.[0];
            if (file) void handleFile(file);
          }}
        />
        {busy ? (
          <div className="space-y-2">
            <div className="text-sm">Uploading… {progress}%</div>
            <div className="h-1.5 overflow-hidden rounded-full bg-neutral-800">
              <div
                className="h-full bg-emerald-500 transition-all"
                style={{ width: `${progress}%` }}
              />
            </div>
          </div>
        ) : (
          <div className="text-sm text-neutral-400">
            Drop a reel here, or <span className="text-emerald-400">browse</span>
          </div>
        )}
      </label>

      {error && <p className="text-sm text-red-400">{error}</p>}
    </div>
  );
}
