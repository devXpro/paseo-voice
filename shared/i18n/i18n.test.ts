import assert from "node:assert/strict";
import { test } from "node:test";
import { en } from "./en.ts";
import { ALL_DICTIONARIES, msg, pluralOf, say, t, tn, type Key, UI_LANGUAGES } from "./index.ts";

const placeholders = (text: string): string[] => [...text.matchAll(/\{(\w+)\}/g)].map((m) => m[1]!).sort();

test("every interface language has every string, shaped as in English", () => {
  for (const { id } of UI_LANGUAGES) {
    const dictionary = ALL_DICTIONARIES[id] as Record<string, unknown>;
    assert.deepEqual(Object.keys(dictionary).sort(), Object.keys(en).sort(), id);
    for (const key of Object.keys(en) as Key[]) {
      assert.equal(typeof dictionary[key], typeof en[key], `${id} ${key}`);
    }
  }
});

test("a translation fills the same placeholders as the English it translates", () => {
  for (const { id } of UI_LANGUAGES) {
    const dictionary = ALL_DICTIONARIES[id] as Record<string, string | Record<string, string>>;
    for (const key of Object.keys(en) as Key[]) {
      const source = en[key];
      const want = placeholders(typeof source === "string" ? source : source.other);
      const entry = dictionary[key]!;
      const forms = typeof entry === "string" ? [entry] : Object.values(entry);
      for (const form of forms) {
        assert.deepEqual(placeholders(form), want, `${id} ${key}: «${form}»`);
      }
    }
  }
});

test("Russian and Ukrainian count in three forms, the rest in two", () => {
  for (const { id } of UI_LANGUAGES) {
    const dictionary = ALL_DICTIONARIES[id] as Record<string, unknown>;
    for (const key of Object.keys(en) as Key[]) {
      const entry = dictionary[key];
      if (typeof entry !== "object" || entry === null) {
        continue;
      }
      const forms = Object.keys(entry).sort();
      const want = id === "ru" || id === "uk" ? ["few", "many", "one", "other"] : ["one", "other"];
      assert.deepEqual(forms, want, `${id} ${key}`);
    }
  }
});

test("plural forms follow each language's rule", () => {
  const forms = (language: Parameters<typeof pluralOf>[0], ns: number[]) => ns.map((n) => pluralOf(language, n));
  assert.deepEqual(forms("ru", [1, 2, 4, 5, 11, 12, 14, 21, 22, 25, 111, 112, 101]), [
    "one", "few", "few", "many", "many", "many", "many", "one", "few", "many", "many", "many", "one",
  ]);
  assert.deepEqual(forms("uk", [1, 3, 7, 21]), ["one", "few", "many", "one"]);
  assert.deepEqual(forms("en", [0, 1, 2]), ["other", "one", "other"]);
  assert.deepEqual(forms("de", [0, 1, 2]), ["other", "one", "other"]);
  // Zero is singular in French and Brazilian Portuguese.
  assert.deepEqual(forms("fr", [0, 1, 2]), ["one", "one", "other"]);
  assert.deepEqual(forms("pt", [0, 1, 2]), ["one", "one", "other"]);
  assert.equal(pluralOf("ru", 1.5), "other");
});

test("a count is put in the right form and formatted for the language", () => {
  assert.equal(tn("en", "cue.count", 1), "1 track");
  assert.equal(tn("en", "cue.count", 3), "3 tracks");
  assert.equal(tn("ru", "cue.count", 3), "3 трека");
  assert.equal(tn("ru", "cue.count", 5), "5 треков");
  assert.match(tn("en", "common.characters", 4_000_000), /^4,000,000 characters$/);
});

test("a server's message is said in the panel's language, values included", () => {
  const text = msg("patch.fileGone", { title: msg("patch.drain.title") });
  assert.equal(say("en", text), "Read the sound at once: file not found — Paseo was updated");
  assert.equal(say("ru", text), "Читать звук сразу: файл не найден — Paseo обновился");
});

test("anything that is not a message passes through as it came", () => {
  assert.equal(say("ru", "Google: 403 API key not valid"), "Google: 403 API key not valid");
  assert.equal(say("ru", ""), "");
  assert.equal(say("ru", 'i18n:["no.such.key"]'), 'i18n:["no.such.key"]');
  assert.equal(say("ru", "i18n:{broken"), "i18n:{broken");
});

test("a placeholder with no value is left visible rather than eaten", () => {
  assert.equal(t("en", "app.portDown"), "Speech is not working: the plugin does not hold port {port}");
});

test("a log line is put into English wherever a message sits inside it", async () => {
  const { sayAll } = await import("./index.ts");
  const error = msg("whisper.exited", { code: 3 });
  assert.equal(sayAll("en", `voice: dictation did not resume: ${error}`), "voice: dictation did not resume: the engine exited with code 3");
  assert.equal(
    sayAll("en", `a ${msg("patch.tooBig")} and b ${msg("patch.fileGone", { title: msg("patch.cue.title") })}.`),
    "a the correction does not fit into the original size and b Your own waiting music: file not found — Paseo was updated.",
  );
  assert.equal(sayAll("en", "nothing to say [here]"), "nothing to say [here]");
});
