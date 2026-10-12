import assert from "node:assert/strict";
import { test } from "node:test";
import {
  DEFAULT_SPEECH_LOCALE,
  isSpeechLocale,
  localeOfVoice,
  SPEECH_LANGUAGES,
  SPEECH_LOCALES,
  speechLanguageOf,
} from "./languages.shared.ts";

test("every accent belongs to exactly one language, and the default is one of them", () => {
  const ids = SPEECH_LOCALES.map((locale) => locale.id);
  assert.equal(new Set(ids).size, ids.length);
  assert.equal(ids.length, 13);
  assert.ok(isSpeechLocale(DEFAULT_SPEECH_LOCALE));
  for (const language of SPEECH_LANGUAGES) {
    assert.ok(language.locales.length > 0, language.id);
    for (const locale of language.locales) {
      assert.equal(speechLanguageOf(locale.id).id, language.id);
      // Google's accents of a language start with the language's own code.
      assert.ok(locale.id.startsWith(`${language.id}-`), locale.id);
    }
  }
});

test("an accent nobody offers is read as the default language rather than refused", () => {
  assert.equal(speechLanguageOf("xx-YY").id, "en");
  assert.equal(speechLanguageOf("").id, "en");
  assert.equal(isSpeechLocale("es"), false);
});

test("the accent is read off a Google voice name, whatever its tier", () => {
  assert.equal(localeOfVoice("pt-BR-Chirp3-HD-Orus"), "pt-BR");
  assert.equal(localeOfVoice("en-US-Standard-B"), "en-US");
  assert.equal(localeOfVoice("uk-UA-Wavenet-B"), "uk-UA");
  assert.equal(localeOfVoice("Orus"), "");
  assert.equal(localeOfVoice(""), "");
});

test("only Ukrainian is beyond the local engine", () => {
  const without = SPEECH_LANGUAGES.filter((language) => language.engine === null).map((language) => language.id);
  assert.deepEqual(without, ["uk"]);
});

test("every language has an audition line and a measured speaking rate", () => {
  for (const language of SPEECH_LANGUAGES) {
    assert.ok(language.probe.length > 10, language.id);
    // Measured rates sit between forty and eighty thousand characters an hour.
    assert.ok(language.charsPerHour > 40_000 && language.charsPerHour < 80_000, language.id);
    assert.equal(language.whisper, language.id);
  }
});
