/**
 * The languages this plugin speaks and hears, in one place.
 *
 * Every part of the pipeline names a language its own way — Google by accent
 * (`es-ES`), Whisper by a bare code (`es`), the local engine by an English word
 * (`Spanish`) — so the choice is stored once, as Google's accent, and everything else
 * is read off this table. Adding a language is a row here and a phrase in the
 * language suite of the live tests.
 *
 * What is not here, on purpose: Paseo's own recogniser in voice mode. Parakeet v3
 * covers twenty-five European languages and detects which one it hears, so it needs
 * no telling.
 */

export const SPEECH_LANGUAGE_IDS = ["en", "es", "fr", "pt", "de", "ru", "uk"] as const;
export type SpeechLanguageId = (typeof SPEECH_LANGUAGE_IDS)[number];

export type SpeechLocale = {
  /** As Google names it, and as it is stored: `pt-BR`. */
  id: string;
  /** In the language itself, so it reads right whatever the interface is in. */
  label: string;
};

export type SpeechLanguage = {
  id: SpeechLanguageId;
  /** Whisper's code, sent with every dictated chunk. */
  whisper: string;
  /** The local engine's name for it, or null where the engine cannot speak it. */
  engine: string | null;
  /** Said when a voice is auditioned: one short line, so trying voices costs little. */
  probe: string;
  /**
   * Characters of text to an hour of speech, at the voice's own tempo. Languages differ
   * by more than half, so the estimate of how long the free allowance lasts is per
   * language. Measured on the first accent with two Chirp 3 HD voices, Orus and Aoede,
   * at tempo 1, and averaged: one voice runs as much as a fifth faster than another.
   */
  charsPerHour: number;
  /** Google's accents of it; the first is the default. */
  locales: readonly SpeechLocale[];
};

export const SPEECH_LANGUAGES: readonly SpeechLanguage[] = [
  {
    id: "en",
    whisper: "en",
    engine: "English",
    probe: "Testing, testing. Can you hear me?",
    charsPerHour: 65_000,
    locales: [
      { id: "en-US", label: "English (US)" },
      { id: "en-GB", label: "English (UK)" },
      { id: "en-AU", label: "English (Australia)" },
      { id: "en-IN", label: "English (India)" },
    ],
  },
  {
    id: "es",
    whisper: "es",
    engine: "Spanish",
    probe: "Probando, probando. ¿Me oyes?",
    charsPerHour: 61_000,
    locales: [
      { id: "es-ES", label: "Español (España)" },
      { id: "es-US", label: "Español (EE. UU.)" },
    ],
  },
  {
    id: "fr",
    whisper: "fr",
    engine: "French",
    probe: "Test, test. Vous m'entendez ?",
    charsPerHour: 69_000,
    locales: [
      { id: "fr-FR", label: "Français (France)" },
      { id: "fr-CA", label: "Français (Canada)" },
    ],
  },
  {
    id: "pt",
    whisper: "pt",
    engine: "Portuguese",
    probe: "Testando, testando. Você está me ouvindo?",
    charsPerHour: 53_000,
    locales: [
      { id: "pt-BR", label: "Português (Brasil)" },
      { id: "pt-PT", label: "Português (Portugal)" },
    ],
  },
  {
    id: "de",
    whisper: "de",
    engine: "German",
    probe: "Test, Test. Hörst du mich?",
    charsPerHour: 63_000,
    locales: [{ id: "de-DE", label: "Deutsch" }],
  },
  {
    id: "ru",
    whisper: "ru",
    engine: "Russian",
    probe: "Проверка связи. Слышно меня?",
    charsPerHour: 51_000,
    locales: [{ id: "ru-RU", label: "Русский" }],
  },
  {
    id: "uk",
    whisper: "uk",
    // Qwen3-TTS knows ten languages and Ukrainian is not among them.
    engine: null,
    probe: "Перевірка зв’язку. Мене чути?",
    charsPerHour: 51_000,
    locales: [{ id: "uk-UA", label: "Українська" }],
  },
];

export const SPEECH_LOCALES: readonly SpeechLocale[] = SPEECH_LANGUAGES.flatMap((language) => language.locales);

/** What a new install speaks until somebody chooses. */
export const DEFAULT_SPEECH_LOCALE = "en-US";

export const isSpeechLocale = (id: string): boolean => SPEECH_LOCALES.some((locale) => locale.id === id);

/** The language an accent belongs to; anything unknown is the default's. */
export function speechLanguageOf(locale: string): SpeechLanguage {
  return (
    SPEECH_LANGUAGES.find((language) => language.locales.some((one) => one.id === locale)) ??
    speechLanguageOf(DEFAULT_SPEECH_LOCALE)
  );
}

/**
 * The accent a Google voice speaks, read from its name: `pt-BR-Chirp3-HD-Orus` is
 * `pt-BR`. Google wants it beside the voice on every request, and a voice from another
 * accent is how a language ends up read with the wrong one.
 */
export function localeOfVoice(voice: string): string {
  return /^[a-z]{2,3}-[A-Z]{2}(?=-)/.exec(voice)?.[0] ?? "";
}
