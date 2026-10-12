/**
 * The languages the panel itself can be read in — the same seven it speaks, chosen
 * apart from them: somebody may talk to their agents in Ukrainian and read settings in
 * English. Paseo does not tell a plugin which language its own interface is in, so this
 * is a setting of its own.
 */
export const UI_LANGUAGES = [
  // `locale` is what numbers and dates are formatted with.
  { id: "en", label: "English", locale: "en-US" },
  { id: "es", label: "Español", locale: "es-ES" },
  { id: "fr", label: "Français", locale: "fr-FR" },
  { id: "pt", label: "Português (Brasil)", locale: "pt-BR" },
  { id: "de", label: "Deutsch", locale: "de-DE" },
  { id: "ru", label: "Русский", locale: "ru-RU" },
  { id: "uk", label: "Українська", locale: "uk-UA" },
] as const;

export type UiLanguage = (typeof UI_LANGUAGES)[number]["id"];

export const DEFAULT_UI_LANGUAGE: UiLanguage = "en";

export const isUiLanguage = (id: unknown): id is UiLanguage => UI_LANGUAGES.some((one) => one.id === id);

/** What `toLocaleString` should be given for this interface language. */
export const formatLocaleOf = (language: UiLanguage): string =>
  UI_LANGUAGES.find((one) => one.id === language)?.locale ?? "en-US";
