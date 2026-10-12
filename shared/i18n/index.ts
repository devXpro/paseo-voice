import { de } from "./de.ts";
import { en } from "./en.ts";
import { es } from "./es.ts";
import { fr } from "./fr.ts";
import { DEFAULT_UI_LANGUAGE, formatLocaleOf, type UiLanguage } from "./languages.ts";
import { pt } from "./pt.ts";
import { ru } from "./ru.ts";
import { uk } from "./uk.ts";

export { DEFAULT_UI_LANGUAGE, formatLocaleOf, isUiLanguage, UI_LANGUAGES, type UiLanguage } from "./languages.ts";

/**
 * The panel's words, in the seven languages it can be read in.
 *
 * Hand-rolled rather than i18next: a plugin bundle gets react, react-native, zod and
 * react-query from the host and nothing else, and what is needed here is a lookup, a
 * placeholder and a plural — a page of code. English is the reference: every other
 * dictionary has to have every key with the same shape, or the project does not
 * compile.
 */

/** Plural forms, by the categories the seven languages use. */
export type Plural = { one: string; few?: string; many?: string; other: string };
type Entry = string | Plural;

export type Key = keyof typeof en;

/** Strings where English has strings, plurals where it has plurals — nothing missing. */
export type Dictionary = { [K in Key]: (typeof en)[K] extends string ? string : Plural };

const DICTIONARIES: Record<UiLanguage, Dictionary> = { en, es, fr, pt, de, ru, uk };

export type Params = Record<string, string | number>;

/**
 * Which plural form a whole number takes. Written out rather than read from
 * `Intl.PluralRules`, which the phone's JavaScript engine may not have.
 */
export function pluralOf(language: UiLanguage, n: number): keyof Plural {
  if (!Number.isInteger(n)) {
    return "other";
  }
  const abs = Math.abs(n);
  switch (language) {
    case "ru":
    case "uk": {
      const ten = abs % 10;
      const hundred = abs % 100;
      if (ten === 1 && hundred !== 11) return "one";
      if (ten >= 2 && ten <= 4 && (hundred < 12 || hundred > 14)) return "few";
      return "many";
    }
    // Zero takes the singular in French and Brazilian Portuguese: «0 caractère».
    case "fr":
    case "pt":
      return abs === 0 || abs === 1 ? "one" : "other";
    default:
      return abs === 1 ? "one" : "other";
  }
}

function fill(template: string, params: Params | undefined, language: UiLanguage): string {
  if (!params) {
    return template;
  }
  return template.replace(/\{(\w+)\}/g, (whole, name: string) => {
    const value = params[name];
    if (value === undefined) {
      return whole;
    }
    return typeof value === "string" ? say(language, value) : String(value);
  });
}

function entryOf(language: UiLanguage, key: Key): Entry {
  return (DICTIONARIES[language] ?? DICTIONARIES[DEFAULT_UI_LANGUAGE])[key] ?? en[key];
}

/** One string, its placeholders filled. */
export function t(language: UiLanguage, key: Key, params?: Params): string {
  const entry = entryOf(language, key);
  return fill(typeof entry === "string" ? entry : entry.other, params, language);
}

/** A string that depends on a count; `{n}` is the count, formatted for the language. */
export function tn(language: UiLanguage, key: Key, count: number, params?: Params): string {
  const entry = entryOf(language, key);
  if (typeof entry === "string") {
    return fill(entry, { n: count.toLocaleString(formatLocaleOf(language)), ...params }, language);
  }
  const form = entry[pluralOf(language, count)] ?? entry.other;
  return fill(form, { n: count.toLocaleString(formatLocaleOf(language)), ...params }, language);
}

const MARK = "i18n:";

/**
 * A message from the server, for the panel to put into words.
 *
 * Statuses and errors are made on the server long before anybody reads them — some are
 * kept on disk between runs — so they travel as a key and its values, and the panel says
 * them in whatever language it is in when it shows them. A value can be a message too:
 * an error that names a correction carries the correction's own title that way.
 */
export function msg(key: Key, params?: Params): string {
  return `${MARK}${JSON.stringify(params ? [key, params] : [key])}`;
}

/** A server's text in `language`: a message put into words, anything else as it came. */
export function say(language: UiLanguage, text: string): string {
  if (!text.startsWith(MARK)) {
    return text;
  }
  try {
    const [key, params] = JSON.parse(text.slice(MARK.length)) as [Key, Params | undefined];
    if (!(key in en)) {
      return text;
    }
    return t(language, key, params);
  } catch {
    return text;
  }
}

/**
 * Every message inside a longer line put into words — for the daemon's log, where an
 * error's message ends up embedded in a sentence of the plugin's own.
 */
export function sayAll(language: UiLanguage, line: string): string {
  let out = "";
  let rest = line;
  for (;;) {
    const at = rest.indexOf(MARK);
    if (at < 0) {
      return out + rest;
    }
    out += rest.slice(0, at);
    // The message is JSON, so it ends at the first closing bracket that makes it parse.
    let said = "";
    let end = rest.indexOf("]", at);
    while (end >= 0 && !said) {
      const candidate = rest.slice(at, end + 1);
      const spoken = say(language, candidate);
      if (spoken !== candidate) {
        said = spoken;
        break;
      }
      end = rest.indexOf("]", end + 1);
    }
    if (!said) {
      return out + rest;
    }
    out += said;
    rest = rest.slice(end + 1);
  }
}

/** Every dictionary, for the tests that hold them to English's shape. */
export const ALL_DICTIONARIES = DICTIONARIES;

/** Everything a screen needs to speak one language, bound once per render. */
export type Translator = {
  language: UiLanguage;
  /** For `toLocaleString` and `toLocaleDateString`. */
  locale: string;
  t(key: Key, params?: Params): string;
  tn(key: Key, count: number, params?: Params): string;
  /** A server's message in this language; anything else as it came. */
  say(text: string): string;
  /** A number with this many decimals and the language's own decimal mark: `1,25` or `1.25`. */
  fixed(value: number, digits: number): string;
};

export function translator(language: UiLanguage): Translator {
  return {
    language,
    locale: formatLocaleOf(language),
    t: (key, params) => t(language, key, params),
    tn: (key, count, params) => tn(language, key, count, params),
    say: (text) => say(language, text),
    // By hand rather than `toLocaleString` with options, which the phone's engine may not honour.
    fixed: (value, digits) => {
      const text = value.toFixed(digits);
      return language === "en" ? text : text.replace(".", ",");
    },
  };
}
