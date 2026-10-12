import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { DEFAULT_UI_LANGUAGE, isUiLanguage, type UiLanguage } from "../shared/i18n/languages.ts";
import {
  DEFAULT_SPEECH_LOCALE,
  isSpeechLocale,
  SPEECH_LANGUAGE_IDS,
  type SpeechLanguageId,
  speechLanguageOf,
} from "../shared/languages.shared.ts";
import { DEFAULT_PROMPT } from "./daemon-settings.server.ts";
import { paths } from "./paths.server.ts";

/**
 * What the person chose, kept next to the models rather than in Paseo's own settings.
 * It has to outlive `plugin remove`, for the same reason the weights do.
 */
export type Stored = {
  /** Where speech comes from. Google unless somebody deliberately falls back. */
  provider: "google" | "local";
  /** A full Google voice name, e.g. `ru-RU-Chirp3-HD-Orus`; the tier is read from it. */
  googleVoice: string;
  /**
   * The voice last chosen for every other accent, so going to Spanish and back gives
   * back the voice somebody picked rather than the default — which may be a family
   * billed seven times higher.
   */
  voicesByLocale: Record<string, string>;
  /** The local engine's speaker, used only while the provider is `local`. */
  voice: string;
  activeModel: string;
  /** The accent speech and dictation are in, as Google names it: `pt-BR`. */
  speechLocale: string;
  /** The panel's own language, chosen apart from the speech. */
  uiLanguage: UiLanguage;
  port: number;
  /** Speaking rate, pitch-preserving. Both providers take it per request. */
  rate: number;
  /** Read every sentence the same way instead of sampling a fresh delivery each time. */
  steady: boolean;
  /**
   * Take the top off the speech before sending it, because the phone's audio engine
   * is 16 kHz and downsamples without a filter — the band would alias into grit.
   */
  phoneSafe: boolean;
  /** Which waiting cue plays while the agent thinks. */
  cue: string;
  /** How loud it is: 1 is the level this plugin normalises every track to. */
  cueVolume: number;
  /**
   * The paragraph appended to every agent's system prompt, editable in the panel.
   * Kept here as well as in Paseo's config because this is what makes the plugin's own
   * text recognisable: to replace or remove it, it has to know exactly what it wrote.
   */
  prompt: string;
  /** Which whisper weights dictation uses. */
  dictationModel: string;
  /**
   * Words the recogniser should expect to hear, one list per language. A hint in the
   * wrong language does harm: a Russian list pulled Ukrainian «ясний» towards «ясный».
   */
  dictionaries: Partial<Record<SpeechLanguageId, string>>;
};

const file = paths.state;

/** Narrow enough that nobody can make the voice unintelligible by dragging a slider. */
export const RATE_MIN = 0.7;
export const RATE_MAX = 1.6;

/** Silent to twice the normalised level; past that a background loop stops being one. */
export const VOLUME_MAX = 2;

export const clampVolume = (value: number): number =>
  Number.isFinite(value) ? Math.min(VOLUME_MAX, Math.max(0, value)) : 1;

export const clampRate = (value: number): number =>
  Number.isFinite(value) ? Math.min(RATE_MAX, Math.max(RATE_MIN, value)) : 1;

/**
 * Any constant would do. The engine seeds itself from the clock when nobody says
 * otherwise, which is why consecutive sentences of one answer came out in different
 * voices-within-the-voice: each is a separate request, so each got a separate take.
 */
export const STEADY_SEED = 12345;

export const DEFAULTS: Stored = {
  provider: "google",
  googleVoice: "",
  voicesByLocale: {},
  voice: "",
  activeModel: "",
  speechLocale: DEFAULT_SPEECH_LOCALE,
  uiLanguage: DEFAULT_UI_LANGUAGE,
  // Arbitrary but fixed: it ends up inside `~/.paseo/config.json` as a base URL, so it
  // cannot be an ephemeral port that changes on every daemon restart.
  port: 8123,
  rate: 1,
  // On by default: an assistant reading an answer aloud should sound the same from one
  // sentence to the next, and the variety was what made it unbearable.
  steady: true,
  // On by default: the band it removes is lost on a phone either way, and most
  // listening happens there.
  phoneSafe: true,
  cue: "lobby-time",
  cueVolume: 1,
  prompt: DEFAULT_PROMPT,
  // The quantised one: half the size of the full weights, and the difference does not
  // show up in dictation.
  dictationModel: "large-v3-turbo-q8_0",
  dictionaries: {},
};

/** The dictionary of the language speech is in now. */
export const dictionaryOf = (stored: Pick<Stored, "speechLocale" | "dictionaries">): string =>
  stored.dictionaries[speechLanguageOf(stored.speechLocale).id] ?? "";

/** Voices kept per accent: only known accents, only names that belong to them. */
function voicesOf(given: unknown): Record<string, string> {
  const out: Record<string, string> = {};
  if (given && typeof given === "object") {
    for (const [locale, voice] of Object.entries(given as Record<string, unknown>)) {
      if (isSpeechLocale(locale) && typeof voice === "string" && voice.startsWith(`${locale}-`)) {
        out[locale] = voice;
      }
    }
  }
  return out;
}

/** What a state file written before languages existed carried instead. */
type Legacy = { language?: unknown; dictionary?: unknown };

function dictionariesOf(parsed: Partial<Stored> & Legacy, speechLocale: string): Stored["dictionaries"] {
  const out: Stored["dictionaries"] = {};
  const given = parsed.dictionaries;
  if (given && typeof given === "object") {
    for (const id of SPEECH_LANGUAGE_IDS) {
      const words = (given as Record<string, unknown>)[id];
      if (typeof words === "string") {
        out[id] = words;
      }
    }
    return out;
  }
  // One list, from the days when there was one language — so it is that language's.
  if (typeof parsed.dictionary === "string" && parsed.dictionary) {
    out[speechLanguageOf(speechLocale).id] = parsed.dictionary;
  }
  return out;
}

/**
 * The state file as read, every field checked. Pure, so the migration can be tested
 * without touching the real file.
 *
 * A file that has a `language` but no `speechLocale` was written before 0.9, which kept
 * one language for speech and panel alike. Its owner keeps it for both.
 */
export function parseStored(raw: unknown): Stored {
  const parsed = (raw && typeof raw === "object" ? raw : {}) as Partial<Stored> & Legacy;
  const legacy = parsed.speechLocale === undefined && parsed.language === "russian";
  const speechLocale =
    typeof parsed.speechLocale === "string" && isSpeechLocale(parsed.speechLocale)
      ? parsed.speechLocale
      : legacy
        ? "ru-RU"
        : DEFAULTS.speechLocale;
  const uiLanguage = isUiLanguage(parsed.uiLanguage) ? parsed.uiLanguage : legacy ? "ru" : DEFAULTS.uiLanguage;
  return {
    provider: parsed.provider === "local" ? "local" : DEFAULTS.provider,
    googleVoice: typeof parsed.googleVoice === "string" ? parsed.googleVoice : DEFAULTS.googleVoice,
    voicesByLocale: voicesOf(parsed.voicesByLocale),
    voice: typeof parsed.voice === "string" ? parsed.voice : DEFAULTS.voice,
    activeModel: typeof parsed.activeModel === "string" ? parsed.activeModel : DEFAULTS.activeModel,
    speechLocale,
    uiLanguage,
    port: Number.isInteger(parsed.port) && Number(parsed.port) > 0 ? Number(parsed.port) : DEFAULTS.port,
    rate: typeof parsed.rate === "number" ? clampRate(parsed.rate) : DEFAULTS.rate,
    steady: typeof parsed.steady === "boolean" ? parsed.steady : DEFAULTS.steady,
    phoneSafe: typeof parsed.phoneSafe === "boolean" ? parsed.phoneSafe : DEFAULTS.phoneSafe,
    cue: typeof parsed.cue === "string" && parsed.cue ? parsed.cue : DEFAULTS.cue,
    cueVolume: typeof parsed.cueVolume === "number" ? clampVolume(parsed.cueVolume) : DEFAULTS.cueVolume,
    prompt: typeof parsed.prompt === "string" && parsed.prompt.trim() ? parsed.prompt : DEFAULTS.prompt,
    dictationModel:
      typeof parsed.dictationModel === "string" && parsed.dictationModel
        ? parsed.dictationModel
        : DEFAULTS.dictationModel,
    dictionaries: dictionariesOf(parsed, speechLocale),
  };
}

export async function readStored(): Promise<Stored> {
  try {
    return parseStored(JSON.parse(await readFile(file, "utf8")));
  } catch {
    return { ...DEFAULTS };
  }
}

export async function writeStored(stored: Stored): Promise<void> {
  await mkdir(paths.root, { recursive: true });
  const staged = `${file}.tmp`;
  await writeFile(staged, `${JSON.stringify(stored, null, 2)}\n`, { mode: 0o600 });
  await rename(staged, file);
}
