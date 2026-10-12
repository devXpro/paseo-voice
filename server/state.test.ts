import assert from "node:assert/strict";
import { test } from "node:test";
import { DEFAULTS, dictionaryOf, parseStored } from "./state.server.ts";

test("a state file from before languages keeps its owner in Russian, interface and speech alike", () => {
  const stored = parseStored({ provider: "google", googleVoice: "ru-RU-Chirp3-HD-Orus", language: "russian", dictionary: "Paseo, докер" });
  assert.equal(stored.speechLocale, "ru-RU");
  assert.equal(stored.uiLanguage, "ru");
  assert.equal(stored.googleVoice, "ru-RU-Chirp3-HD-Orus");
  assert.deepEqual(stored.dictionaries, { ru: "Paseo, докер" });
  assert.equal(dictionaryOf(stored), "Paseo, докер");
});

test("a new install speaks and shows English", () => {
  assert.equal(DEFAULTS.speechLocale, "en-US");
  assert.equal(DEFAULTS.uiLanguage, "en");
  assert.deepEqual(DEFAULTS.dictionaries, {});
  const stored = parseStored({});
  assert.equal(stored.speechLocale, "en-US");
  assert.equal(stored.uiLanguage, "en");
});

test("languages already chosen are kept, and nonsense falls back to the defaults", () => {
  const kept = parseStored({ speechLocale: "pt-BR", uiLanguage: "uk", dictionaries: { pt: "Supabase", en: "kubectl" } });
  assert.equal(kept.speechLocale, "pt-BR");
  assert.equal(kept.uiLanguage, "uk");
  assert.equal(dictionaryOf(kept), "Supabase");

  const nonsense = parseStored({ speechLocale: "pt", uiLanguage: "klingon", dictionaries: { pt: 7, xx: "a", de: "Ruby" } });
  assert.equal(nonsense.speechLocale, "en-US");
  assert.equal(nonsense.uiLanguage, "en");
  assert.deepEqual(nonsense.dictionaries, { de: "Ruby" });
});

test("each language has its own dictionary, so switching does not carry Russian words into English", () => {
  const stored = parseStored({ speechLocale: "en-GB", dictionaries: { ru: "докер" } });
  assert.equal(dictionaryOf(stored), "");
});

test("an old file's new fields win over its old ones", () => {
  // Written by this version, then read again: the old `language` key is gone by then,
  // but a hand-edited file could carry both.
  const stored = parseStored({ language: "russian", speechLocale: "de-DE", uiLanguage: "de", dictionary: "x" });
  assert.equal(stored.speechLocale, "de-DE");
  assert.equal(stored.uiLanguage, "de");
});

test("the voice chosen for each accent is remembered, so switching away and back keeps it", () => {
  const stored = parseStored({
    speechLocale: "ru-RU",
    googleVoice: "ru-RU-Standard-A",
    voicesByLocale: { "en-US": "en-US-Chirp3-HD-Aoede", "xx-YY": "nonsense", "de-DE": 5 },
  });
  assert.deepEqual(stored.voicesByLocale, { "en-US": "en-US-Chirp3-HD-Aoede" });
  assert.deepEqual(parseStored({}).voicesByLocale, {});
});
