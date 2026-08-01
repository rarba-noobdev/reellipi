export type ProjectStatus =
  | 'uploaded'
  | 'transcribing'
  | 'styling'
  | 'ready_to_render'
  | 'rendering'
  | 'done'
  | 'failed';

export type LangMode = 'translit' | 'codemix' | 'transcribe' | 'translate' | 'verbatim';

export interface TimedWord {
  w: string;
  start: number;
  end: number;
}

export interface Cue {
  idx: number;
  start: number;
  end: number;
  lines: string[];
  words: TimedWord[];
  highlight?: string[];
}

export interface Project {
  id: string;
  user_id: string;
  title: string | null;
  status: ProjectStatus;
  source_path: string | null;
  output_path: string | null;
  lang_mode: LangMode;
  language_code: string | null;
  style_preset: string | null;
  duration_seconds: number | null;
  timing_approximate: boolean;
  ig_caption: string | null;
  hashtags: string[] | null;
  error: string | null;
  progress: number;
  created_at: string;
}

/** Options offered in the language toggle, mapped to Sarvam STT parameters. */
export const LANGUAGE_CHOICES: Array<{
  id: string;
  label: string;
  description: string;
  mode: LangMode;
  languageCode: string;
}> = [
  {
    id: 'tanglish',
    label: 'Tanglish',
    description: 'Tamil speech, Roman script',
    mode: 'translit',
    languageCode: 'ta-IN',
  },
  {
    id: 'hinglish',
    label: 'Hinglish',
    description: 'Hindi speech, Roman script',
    mode: 'translit',
    languageCode: 'hi-IN',
  },
  {
    id: 'auto_roman',
    label: 'Auto (Roman)',
    description: 'Detect language, Roman script',
    mode: 'translit',
    languageCode: 'unknown',
  },
  {
    id: 'codemix',
    label: 'Code-mix',
    description: 'English in Latin, Indic in native script',
    mode: 'codemix',
    languageCode: 'unknown',
  },
  {
    id: 'native',
    label: 'Native script',
    description: 'Everything in the source script',
    mode: 'transcribe',
    languageCode: 'unknown',
  },
  {
    id: 'english',
    label: 'English',
    description: 'Translated to English',
    mode: 'translate',
    languageCode: 'unknown',
  },
];
