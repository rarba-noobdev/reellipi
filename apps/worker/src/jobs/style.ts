import { chat } from '../lib/sarvam.js';
import type { TimedWord } from '../lib/align.js';
import { buildCues, type Cue, type CueOptions } from '../lib/subtitles.js';

/**
 * Display-layer polish.
 *
 * Grouping is deterministic (lib/subtitles.ts). The LLM only decorates the result with
 * emoji and keyword highlights, and writes the Instagram caption. It never changes word
 * text, order or timings.
 */

export interface StyleResult {
  cues: Cue[];
  igCaption: string;
  hashtags: string[];
  /** False when the LLM produced nothing usable. */
  llmApplied: boolean;
  warning?: string;
}

interface LlmPayload {
  igCaption?: string;
  hashtags?: string[];
}

/**
 * Decoration prompt.
 *
 * Deliberately separate from grouping. Asking the model to regroup tokens by index
 * range made it spiral — 5-13k characters of reasoning on a 24-token batch, exhausting
 * the token budget before it emitted anything, so every batch fell back and no emoji
 * ever appeared. Decorating already-grouped cues needs no index arithmetic, so the call
 * is short, cheap and actually succeeds.
 */
const DECORATE_PROMPT = `You decorate video captions. Each input line is "index: caption text".

For each line you MAY return:
- "emoji": one emoji matching the meaning, plus "after": the 0-based index of the word
  inside that caption it belongs beside. Put it next to the word it depicts — never
  default to the end of the line.
- "highlight": 1-2 exact words from that caption worth emphasising.

Most captions need nothing. Decorate only when it clearly adds meaning, roughly one line
in three. Never change the words themselves.

Answer with JSON only:
{"d":[{"i":0,"emoji":"🔥","after":2,"highlight":["super"]}]}`;

const CAPTION_PROMPT = `You write Instagram Reels captions for Indian creators.

Write the caption in the SAME language mix as the transcript. If the transcript is
Tanglish or Hinglish, the caption is Tanglish or Hinglish — never translate it to plain
English, that voice is the whole point.

STRUCTURE (Instagram truncates at ~125 characters behind "... more"):
1. HOOK — first line, under 100 characters, must earn the tap. Use the single most
   specific claim, number or result in the transcript. Never open with "In this video"
   or "Watch how".
2. PAYOFF — one short line naming the concrete benefit or result.
3. CTA — ask for a comment or a save, tied to the actual topic. Comments and saves
   weigh more than likes. Not a bare "follow for more".
Separate the three parts with a newline. Total under 300 characters. 1-3 emoji, placed
for scanning, never one per word.

HASHTAGS — exactly 8, lowercase, no # symbol, no spaces. Mix the tiers deliberately:
  2 broad (large reach, high competition)
  4 niche and specific to the actual subject matter
  2 language or region targeted (e.g. tamilreels, chennai, desi)
Only tags a real person would follow or search. No banned or spammy filler
(no followforfollow, like4like, viral, fyp, explorepage, trending).

Think briefly. Respond with ONLY a JSON object, no markdown fence:
{"igCaption":"hook line\\npayoff line\\ncta line","hashtags":["...", "..."]}`;

/**
 * `json_object` rather than `json_schema`: the schema variant is undocumented on
 * sarvam-105b and the shape is validated against the real token list anyway, so a
 * strict schema buys nothing that cuesFromPlan does not already enforce.
 */
const RESPONSE_FORMAT = { type: 'json_object' } as const;

export interface StyleOptions extends CueOptions {
  languageCode?: string | null;
  /** Skip the LLM entirely — no grouping, no caption. */
  skipLlm?: boolean;
  /**
   * Let the LLM regroup cues and add emoji/keyword highlights.
   *
   * Off by default. sarvam-105b spirals on the index arithmetic this needs: on a 152-word
   * clip, 6 of 7 batches exhausted their token budget on reasoning and produced nothing,
   * costing ~100s and ~Rs 0.2 per reel for a cosmetic gain. Deterministic grouping is
   * already good. Enable with STYLE_LLM_GROUPING=1 if a higher tier lifts the ceiling.
   */
  groupWithLlm?: boolean;
}

export async function styleCues(words: TimedWord[], options: StyleOptions = {}): Promise<StyleResult> {
  const fallback = (warning?: string): StyleResult => ({
    cues: buildCues(words, options),
    igCaption: '',
    hashtags: [],
    llmApplied: false,
    ...(warning ? { warning } : {}),
  });

  if (words.length === 0) return fallback('No words to style');
  if (options.skipLlm) return fallback();

  const decorate = options.groupWithLlm ?? process.env.STYLE_LLM_GROUPING === '1';

  // Grouping is always deterministic — it is reliable and the LLM was never able to do
  // it within the token budget. The model only decorates the result.
  const grouped = buildCues(words, options);
  const cues = decorate ? await decorateCues(grouped, options.languageCode) : grouped;
  const caption = await writeCaption(words.map((w) => w.w).join(' '), options.languageCode);

  return {
    cues,
    igCaption: caption.igCaption,
    hashtags: caption.hashtags,
    llmApplied: Boolean(caption.igCaption),
    ...(caption.igCaption ? {} : { warning: 'Caption generation returned nothing' }),
  };
}

interface Decoration {
  i: number;
  emoji?: string;
  after?: number;
  highlight?: string[];
}

/**
 * Add emoji and keyword highlights to already-grouped cues.
 *
 * Batched because the reply grows with cue count, and a partial result is fine: any cue
 * the model skips simply stays undecorated.
 */
async function decorateCues(cues: Cue[], languageCode: string | null | undefined): Promise<Cue[]> {
  const BATCH = 12;
  const decorations = new Map<number, Decoration>();

  for (let offset = 0; offset < cues.length; offset += BATCH) {
    const batch = cues.slice(offset, offset + BATCH);
    const listing = batch.map((c) => `${c.idx}: ${c.lines.join(' ')}`).join('\n');
    try {
      const raw = await chat(
        [
          { role: 'system', content: DECORATE_PROMPT },
          { role: 'user', content: `Language: ${languageCode ?? 'unknown'}\n${listing}` },
        ],
        { model: 'sarvam-105b', temperature: 0.3, responseFormat: RESPONSE_FORMAT, maxTokens: 2200 },
      );
      for (const d of parseDecorations(raw)) decorations.set(d.i, d);
    } catch (e) {
      console.warn(`[style] decorate batch@${offset} failed: ${(e as Error).message}`);
    }
  }

  if (decorations.size === 0) return cues;

  return cues.map((cue) => {
    const d = decorations.get(cue.idx);
    if (!d) return cue;

    const highlight = normaliseHighlight(d.highlight);
    let lines = cue.lines;

    if (d.emoji && /\p{Extended_Pictographic}/u.test(d.emoji)) {
      const tokens = cue.lines.join(' ').split(/\s+/).filter(Boolean);
      // Model's chosen position, then the highlighted keyword, then the last word.
      const chosen = typeof d.after === 'number' ? Math.trunc(d.after) : -1;
      const keywordIdx = tokens.findIndex((t) => highlight.includes(core(t)));
      const target =
        chosen >= 0 && chosen < tokens.length ? chosen : keywordIdx >= 0 ? keywordIdx : tokens.length - 1;
      tokens[target] = `${tokens[target]} ${d.emoji.trim()}`;

      // Re-wrap keeping the original line count so the karaoke word map still lines up.
      const perLine = cue.lines.map((l) => l.split(/\s+/).filter(Boolean).length);
      lines = [];
      let cursor = 0;
      for (const count of perLine) {
        lines.push(tokens.slice(cursor, cursor + count).join(' '));
        cursor += count;
      }
    }

    return { ...cue, lines, highlight: highlight.length ? highlight : cue.highlight };
  });
}

function parseDecorations(raw: string): Decoration[] {
  const trimmed = raw.trim().replace(/^```(?:json)?/i, '').replace(/```$/, '').trim();
  const start = trimmed.indexOf('{');
  const end = trimmed.lastIndexOf('}');
  if (start < 0 || end <= start) return [];
  try {
    const j = JSON.parse(trimmed.slice(start, end + 1)) as { d?: Decoration[] };
    return Array.isArray(j.d) ? j.d.filter((x) => typeof x?.i === 'number') : [];
  } catch {
    return [];
  }
}

/** Separate short call: caption writing needs the whole transcript but emits little. */
async function writeCaption(
  transcript: string,
  languageCode: string | null | undefined,
): Promise<{ igCaption: string; hashtags: string[] }> {
  try {
    const raw = await chat(
      [
        { role: 'system', content: CAPTION_PROMPT },
        { role: 'user', content: `Language: ${languageCode ?? 'unknown'}\nTranscript:\n${transcript.slice(0, 4000)}` },
      ],
      { model: 'sarvam-105b', temperature: 0.4, responseFormat: RESPONSE_FORMAT },
    );
    const trimmed = raw.trim().replace(/^```(?:json)?/i, '').replace(/```$/, '').trim();
    const start = trimmed.indexOf('{');
    const end = trimmed.lastIndexOf('}');
    if (start < 0 || end <= start) return { igCaption: '', hashtags: [] };
    const j = JSON.parse(trimmed.slice(start, end + 1)) as Partial<LlmPayload>;
    return {
      igCaption: (j.igCaption ?? '').trim().slice(0, 300),
      hashtags: normaliseHashtags(j.hashtags),
    };
  } catch {
    // The caption is a nice-to-have; never fail the render over it.
    return { igCaption: '', hashtags: [] };
  }
}

/** Strip case, punctuation and emoji so tokens can be compared by their word only. */
const core = (token: string) => token.toLowerCase().replace(/[^\p{L}\p{N}]/gu, '');

function normaliseHighlight(highlight: string[] | undefined): string[] {
  return (highlight ?? []).map(core).filter(Boolean).slice(0, 2);
}

/** Instagram tags cannot contain punctuation, so hyphens and separators are stripped. */
const BANNED_TAGS = new Set([
  'viral', 'fyp', 'foryou', 'foryoupage', 'explorepage', 'explore', 'trending',
  'followforfollow', 'like4like', 'follow4follow', 'l4l', 'f4f', 'instagram', 'reels',
]);
/** BCP-47 codes like "ta-IN" keep leaking in from the prompt context. */
const LANGUAGE_CODE = /^[a-z]{2}(in|us|gb)$/;

function normaliseHashtags(tags: unknown): string[] {
  if (!Array.isArray(tags)) return [];
  const seen = new Set<string>();
  const out: string[] = [];
  for (const t of tags) {
    const clean = String(t)
      .replace(/^#/, '')
      .toLowerCase()
      .replace(/[^a-z0-9ऀ-෿]/g, '');
    if (!clean || clean.length < 3) continue;
    if (seen.has(clean) || BANNED_TAGS.has(clean) || LANGUAGE_CODE.test(clean)) continue;
    seen.add(clean);
    out.push(clean);
    if (out.length >= 8) break;
  }
  return out;
}
