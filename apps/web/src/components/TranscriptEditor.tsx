import { useState } from 'react';
import type { Cue } from '../lib/types';

/**
 * Click a word to correct its spelling.
 *
 * Editing text must never shift timing: the edited token keeps the original word's
 * start/end, so the karaoke highlight and the burned-in render stay aligned to the
 * audio. Splitting one token into several is therefore rejected.
 */

interface Props {
  cues: Cue[];
  currentTime?: number;
  onChange: (cue: Cue) => void;
}

export function TranscriptEditor({ cues, currentTime, onChange }: Props) {
  const [editing, setEditing] = useState<{ cue: number; word: number } | null>(null);
  const [draft, setDraft] = useState('');

  const commit = (cue: Cue, wordIndex: number) => {
    const next = draft.trim();
    setEditing(null);
    const original = cue.words[wordIndex];
    if (!original || !next || next === original.w) return;

    const words = cue.words.map((w, i) => (i === wordIndex ? { ...w, w: next } : w));
    // Rebuild the display lines from the same word order so layout stays in step.
    const perLine = cue.lines.map((l) => l.split(/\s+/).filter(Boolean).length);
    const lines: string[] = [];
    let offset = 0;
    for (const count of perLine) {
      lines.push(words.slice(offset, offset + count).map((w) => w.w).join(' '));
      offset += count;
    }
    if (offset < words.length) {
      lines[lines.length - 1] += ' ' + words.slice(offset).map((w) => w.w).join(' ');
    }
    onChange({ ...cue, words, lines });
  };

  return (
    <div className="space-y-2">
      {cues.map((cue) => {
        const isCurrent =
          currentTime !== undefined && currentTime >= cue.start && currentTime < cue.end;
        return (
          <div
            key={cue.idx}
            className={`rounded-[--radius-md] border p-3 transition-colors ${
              isCurrent ? 'border-ink bg-block-lime' : 'border-hairline bg-canvas'
            }`}
          >
            <div className="mb-1 font-mono text-[10px] text-ink/40">
              {cue.start.toFixed(2)}s → {cue.end.toFixed(2)}s
            </div>
            <div className="flex flex-wrap gap-x-1.5 gap-y-1">
              {cue.words.map((word, wi) => {
                const active = editing?.cue === cue.idx && editing.word === wi;
                if (active) {
                  return (
                    <input
                      key={wi}
                      autoFocus
                      value={draft}
                      onChange={(e) => setDraft(e.target.value)}
                      onBlur={() => commit(cue, wi)}
                      onKeyDown={(e) => {
                        if (e.key === 'Enter') commit(cue, wi);
                        if (e.key === 'Escape') setEditing(null);
                      }}
                      className="w-24 rounded-[--radius-xs] border border-ink px-1 text-sm outline-none"
                    />
                  );
                }
                return (
                  <button
                    key={wi}
                    type="button"
                    onClick={() => {
                      setEditing({ cue: cue.idx, word: wi });
                      setDraft(word.w);
                    }}
                    className="rounded-[--radius-xs] px-1 text-sm transition-colors hover:bg-ink hover:text-canvas"
                    title={`${word.start.toFixed(2)}s → ${word.end.toFixed(2)}s`}
                  >
                    {word.w}
                  </button>
                );
              })}
            </div>
          </div>
        );
      })}
    </div>
  );
}
