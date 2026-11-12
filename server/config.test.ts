import assert from "node:assert/strict";
import { mkdtemp, readFile, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";

/**
 * These run against a throwaway PASEO_HOME. The module reads the environment on every
 * call rather than at import, so each test can point it somewhere of its own.
 */
async function withHome(initial: unknown | null): Promise<string> {
  const home = await mkdtemp(path.join(tmpdir(), "paseo-voice-"));
  if (initial !== null) {
    await writeFile(path.join(home, "config.json"), JSON.stringify(initial, null, 2));
  }
  process.env.PASEO_HOME = home;
  return home;
}

async function readConfig(home: string): Promise<Record<string, any>> {
  return JSON.parse(await readFile(path.join(home, "config.json"), "utf8"));
}

test("wiring keeps every unrelated key in the config", async () => {
  const home = await withHome({
    version: 1,
    daemon: { listen: "127.0.0.1:6767" },
    plugins: { caffeine: { source: "directory", path: "/somewhere", enabled: true } },
    agents: { providers: { claude: { command: ["/bin/zsh", "-c", "exec claude"] } } },
  });
  const { wire } = await import("./config.server.ts");

  await wire(8123, "ru");

  const config = await readConfig(home);
  assert.equal(config.version, 1);
  assert.deepEqual(config.daemon, { listen: "127.0.0.1:6767" });
  assert.deepEqual(config.plugins.caffeine, { source: "directory", path: "/somewhere", enabled: true });
  assert.deepEqual(config.agents.providers.claude.command, ["/bin/zsh", "-c", "exec claude"]);
});

test("wiring leaves an existing dictation setup untouched", async () => {
  // The exact shape this laptop runs: dictation pointed at a local Whisper with its own
  // term list. Redirecting it would be a silent downgrade of something already tuned.
  const dictation = {
    enabled: true,
    stt: { provider: "openai", apiKey: "local", baseUrl: "http://127.0.0.1:8099/v1", model: "large-v3-turbo", language: "ru" },
  };
  const home = await withHome({ features: { dictation } });
  const { wire } = await import("./config.server.ts");

  await wire(8123, "ru");

  const config = await readConfig(home);
  assert.deepEqual(config.features.dictation, dictation);
});

test("wiring points voice mode at the proxy and at a recogniser for the chosen language", async () => {
  const home = await withHome({});
  const { wire } = await import("./config.server.ts");

  await wire(8123, "ru");

  const config = await readConfig(home);
  assert.equal(config.features.voiceMode.tts.baseUrl, "http://127.0.0.1:8123/v1");
  // Without a key the daemon discards the whole TTS site, so the placeholder matters.
  assert.equal(config.features.voiceMode.tts.apiKey, "local");
  assert.equal(config.providers, undefined, "the shared block Paseo no longer reads is not written");
  assert.equal(config.features.voiceMode.enabled, true);
  assert.equal(config.features.voiceMode.tts.provider, "openai");
  // Placeholders; the real speaker is substituted by the proxy.
  assert.equal(config.features.voiceMode.tts.model, "tts-1");
  assert.equal(config.features.voiceMode.tts.voice, "alloy");
  assert.equal(config.features.voiceMode.stt.model, "giga-am-v3-ru");
  assert.equal(config.features.voiceMode.stt.language, "ru");
});

/**
 * Paseo's default, Parakeet v2, is English-only — the reason voice mode in another
 * language is silent. v3 covers twenty-five languages; Russian has GigaAM, which makes
 * fewer mistakes in it.
 */
test("voice mode listens with GigaAM in Russian and with Parakeet v3 in the other languages", async () => {
  const home = await withHome({ features: { voiceMode: { stt: { provider: "local", model: "parakeet-tdt-0.6b-v2-int8" } } } });
  const { wire } = await import("./config.server.ts");

  await wire(8123, "ru");
  assert.equal((await readConfig(home)).features.voiceMode.stt.model, "giga-am-v3-ru");
  await wire(8123, "en");
  assert.equal((await readConfig(home)).features.voiceMode.stt.model, "parakeet-tdt-0.6b-v3-int8", "GigaAM knows Russian only");
});

test("a recogniser chosen by hand on Paseo's Voice page is kept", async () => {
  const home = await withHome({
    features: {
      voiceMode: { stt: { provider: "local", model: "whisper-turbo" } },
      dictation: { stt: { provider: "local", model: "whisper-turbo" } },
    },
  });
  const { wire, wireDictation } = await import("./config.server.ts");

  await wire(8123, "ru");
  await wireDictation(8123, false, "large-v3-turbo", "ru");

  const config = await readConfig(home);
  assert.equal(config.features.voiceMode.stt.model, "whisper-turbo");
  assert.equal(config.features.dictation.stt.model, "whisper-turbo");
});

test("the panel learns what Paseo's own recogniser runs and what it would be switched to", async () => {
  await withHome({
    features: {
      voiceMode: { stt: { provider: "local", model: "parakeet-tdt-0.6b-v3-int8", language: "ru" } },
      dictation: { stt: { provider: "openai", baseUrl: "http://127.0.0.1:8123/v1", model: "large-v3-turbo" } },
    },
  });
  const { localStt } = await import("./config.server.ts");

  assert.deepEqual(await localStt("ru"), {
    voice: { current: "parakeet-tdt-0.6b-v3-int8", wanted: "giga-am-v3-ru" },
    dictation: { current: "", wanted: "giga-am-v3-ru" },
  });
  assert.deepEqual((await localStt("de")).voice, { current: "parakeet-tdt-0.6b-v3-int8", wanted: "parakeet-tdt-0.6b-v3-int8" });
});

test("wiring survives a missing config file", async () => {
  const home = await withHome(null);
  const { wire } = await import("./config.server.ts");

  await wire(9000, "en");

  assert.equal((await readConfig(home)).features.voiceMode.tts.baseUrl, "http://127.0.0.1:9000/v1");
});

test("isWired only agrees when the port is the one in the config", async () => {
  await withHome({});
  const { isWired, wire } = await import("./config.server.ts");

  assert.equal(await isWired(8123), false);
  await wire(8123, "ru");
  assert.equal(await isWired(8123), true);
  assert.equal(await isWired(9999), false);
});

/**
 * Writing this file is not free: the desktop app watches it and restarts the daemon,
 * which drops connected phones, breaks the agent's MCP transport, and once took the
 * port out from under this plugin's own proxy mid-sentence. Pressing a button that
 * was already pressed used to cost all of that.
 */
test("wiring twice writes once", async () => {
  const home = await withHome({});
  const { wire } = await import("./config.server.ts");

  assert.equal(await wire(8123, "ru"), true, "в первый раз есть что записать");
  const after = await stat(path.join(home, "config.json"));

  assert.equal(await wire(8123, "ru"), false, "во второй — нечего");
  const again = await stat(path.join(home, "config.json"));
  assert.equal(again.mtimeMs, after.mtimeMs, "файл не тронут, демон не перезапущен");
});

test("a real change is still written", async () => {
  await withHome({});
  const { wire } = await import("./config.server.ts");
  assert.equal(await wire(8123, "ru"), true);
  assert.equal(await wire(9000, "ru"), true, "другой порт — другая запись");
});

/**
 * The language is the whole point and the easiest thing to leave out.
 *
 * Without it Paseo sends its own default — English — and the engine transcribes
 * any other language as though it were English, which is the exact failure this plugin's
 * dictation exists to remove. It shipped missing once, and only went unnoticed on the
 * machine where a previous tool had already written it.
 */
test("wiring dictation says which language is being spoken", async () => {
  const home = await withHome({});
  const { wireDictation } = await import("./config.server.ts");

  await wireDictation(8123, true, "large-v3-turbo", "ru");
  const stt = (await readConfig(home)).features.dictation.stt;
  assert.equal(stt.provider, "openai");
  assert.equal(stt.language, "ru", "без языка движок слышит английский");
  assert.equal((await readConfig(home)).features.dictation.enabled, true);
});

test("unwiring gives Paseo its own recogniser back", async () => {
  const home = await withHome({});
  const { wireDictation } = await import("./config.server.ts");
  await wireDictation(8123, true, "large-v3-turbo", "ru");
  await wireDictation(8123, false, "large-v3-turbo", "ru");

  const stt = (await readConfig(home)).features.dictation.stt;
  assert.equal(stt.provider, "local", "иначе диктовка указывает на мёртвый порт");
});

test("unwiring leaves no key or address on the local site, which would not accept them", async () => {
  const home = await withHome({});
  const { wireDictation } = await import("./config.server.ts");
  await wireDictation(8123, true, "large-v3-turbo", "ru");
  await wireDictation(8123, false, "large-v3-turbo", "ru");

  assert.deepEqual((await readConfig(home)).features.dictation.stt, {
    provider: "local",
    model: "giga-am-v3-ru",
    language: "ru",
  });
});

/**
 * An update does not rewrite the file: until Paseo saves it, the address a plugin of
 * the old kind wrote is still in the shared block, and Paseo reads it from there.
 */
test("an address still in the shared block counts, as it does for Paseo", async () => {
  await withHome({
    providers: { openai: { tts: { apiKey: "local", baseUrl: "http://127.0.0.1:8123/v1" }, stt: { apiKey: "local", baseUrl: "http://127.0.0.1:8123/v1" } } },
    features: { voiceMode: { tts: { provider: "openai" } }, dictation: { stt: { provider: "openai" } } },
  });
  const { isDictationWired, isWired } = await import("./config.server.ts");

  assert.equal(await isWired(8123), true);
  assert.equal(await isDictationWired(8123), true);
  assert.equal(await isWired(9999), false);
});

test("wiring dictation twice writes once", async () => {
  const home = await withHome({});
  const { wireDictation } = await import("./config.server.ts");
  assert.equal(await wireDictation(8123, true, "large-v3-turbo", "ru"), true);
  const after = await stat(path.join(home, "config.json"));
  assert.equal(await wireDictation(8123, true, "large-v3-turbo", "ru"), false);
  assert.equal((await stat(path.join(home, "config.json"))).mtimeMs, after.mtimeMs);
});
