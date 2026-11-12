import { readFile, rename, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";

/**
 * The daemon's own config. Edited in place rather than through an API because the plugin
 * SDK exposes nothing for speech: `PaseoApi` has `setVoiceMode` and the dictation stream,
 * but no way to say which provider those should run on.
 */
const configPath = () => path.join(process.env.PASEO_HOME || path.join(homedir(), ".paseo"), "config.json");

/**
 * The local STT model voice mode should transcribe with outside Russian. The default is Parakeet v2,
 * which is English-only — the reason voice mode in any other language produces silence
 * out of the box.
 * v3 covers 25 European languages and auto-detects, and the daemon downloads it itself
 * when the config names a model that is not on disk yet.
 */
const VOICE_STT_MODEL = "parakeet-tdt-0.6b-v3-int8";

/**
 * Russian gets a model of its own: GigaAM v3, which Paseo carries in its catalogue too.
 * It makes fewer mistakes in Russian than Parakeet v3 (5.35% against 6.54% of words on
 * FLEURS), with punctuation, at a quarter of the download.
 */
const RUSSIAN_STT_MODEL = "giga-am-v3-ru";

/**
 * The models this plugin may replace: the ones it writes itself, and Paseo's
 * English-only default, which nobody chose. Anything else was picked by hand on Paseo's
 * Voice page and is kept.
 */
const REPLACEABLE_STT_MODELS = new Set([VOICE_STT_MODEL, RUSSIAN_STT_MODEL, "parakeet-tdt-0.6b-v2-int8"]);

/** The local recogniser for `language`, given the one a site names now, if any. */
export function localSttModel(language: string, current?: unknown): string {
  if (typeof current === "string" && current !== "" && !REPLACEABLE_STT_MODELS.has(current)) {
    return current;
  }
  return language === "ru" ? RUSSIAN_STT_MODEL : VOICE_STT_MODEL;
}

/** The model a site runs locally, or nothing when it is not a local site. */
const localModelOf = (site: Json): unknown => (site.provider === "local" ? site.model : undefined);

type Json = Record<string, unknown>;

function object(value: unknown): Json {
  return value && typeof value === "object" && !Array.isArray(value) ? { ...(value as Json) } : {};
}

async function read(): Promise<Json> {
  try {
    return JSON.parse(await readFile(configPath(), "utf8")) as Json;
  } catch {
    return {};
  }
}

/**
 * A speech site's endpoint, read the way Paseo reads it: the site's own `baseUrl`, else the
 * one in the shared `providers.openai` block older plugin versions wrote. Paseo folds that
 * block into the sites when it loads the file and drops it at its next save, so a config
 * that has not been saved since the update still carries the address only there.
 */
function baseUrlOf(config: Json, feature: "dictation" | "voiceMode", kind: "stt" | "tts"): unknown {
  const site = object(object(object(config.features)[feature])[kind]);
  const shared = object(object(config.providers).openai);
  return site.baseUrl ?? object(shared[kind]).baseUrl ?? shared.baseUrl;
}

/**
 * Whether dictation currently transcribes through a proxy on `port`.
 *
 * Separate from the speech side on purpose: somebody may want this plugin's
 * recogniser and Paseo's own voices, or the other way round.
 */
export async function isDictationWired(port: number): Promise<boolean> {
  const config = await read();
  const baseUrl = baseUrlOf(config, "dictation", "stt");
  const site = object(object(object(config.features).dictation).stt);
  return typeof baseUrl === "string" && baseUrl.includes(`:${port}`) && site.provider === "openai";
}

/**
 * Points dictation at this plugin, or puts Paseo's own recogniser back.
 *
 * Nothing is written when nothing would change — the desktop app watches this file and
 * restarts the daemon on every touch, which drops phones and breaks the agent's MCP
 * transport. Returns whether anything was actually written.
 */
export async function wireDictation(
  port: number,
  on: boolean,
  model: string,
  language: string,
): Promise<boolean> {
  const config = await read();
  const before = JSON.stringify(config);

  const features = object(config.features);
  const dictation = object(features.dictation);
  const site = object(dictation.stt);

  if (on) {
    dictation.stt = {
      ...site,
      provider: "openai",
      // Ignored by the engine, but the daemon drops the whole site without one.
      apiKey: "local",
      baseUrl: `http://127.0.0.1:${port}/v1`,
      model,
      // The language matters more than it looks. Without it Paseo sends its own default,
      // which is English, and the engine transcribes any other language as English —
      // which is the exact failure this whole feature exists to remove.
      language,
    };
    // `enabled` is the other half: the feature can be pointed here and still be switched off.
    dictation.enabled = true;
  } else {
    // Back to what Paseo ships with, rather than leaving it pointed at a dead port. The
    // local shape is strict: a leftover key or address would make the daemon refuse the site.
    dictation.stt = {
      provider: "local",
      model: localSttModel(language, localModelOf(site)),
      ...(site.language ? { language: site.language } : {}),
    };
  }

  features.dictation = dictation;
  config.features = features;

  if (JSON.stringify(config) === before) {
    return false;
  }
  const target = configPath();
  const staged = `${target}.voice-plugin.tmp`;
  await writeFile(staged, `${JSON.stringify(config, null, 2)}\n`, { mode: 0o600 });
  await rename(staged, target);
  return true;
}

/**
 * What Paseo's own recogniser runs in each feature: what the config names now, and
 * what writing it for `language` would name. Dictation's `current` is empty while it
 * reads through this plugin.
 */
export async function localStt(language: string): Promise<{
  voice: { current: string; wanted: string };
  dictation: { current: string; wanted: string };
}> {
  const features = object((await read()).features);
  const voice = object(object(features.voiceMode).stt);
  const dictation = object(object(features.dictation).stt);
  const named = (site: Json) => {
    const model = localModelOf(site);
    return typeof model === "string" ? model : "";
  };
  return {
    voice: { current: named(voice), wanted: localSttModel(language, localModelOf(voice)) },
    dictation: { current: named(dictation), wanted: localSttModel(language, localModelOf(dictation)) },
  };
}

/** Whether voice mode currently reads through a proxy on `port`. */
export async function isWired(port: number): Promise<boolean> {
  const config = await read();
  const baseUrl = baseUrlOf(config, "voiceMode", "tts");
  const ttsFeature = object(object(object(config.features).voiceMode).tts);
  return typeof baseUrl === "string" && baseUrl.includes(`:${port}`) && ttsFeature.provider === "openai";
}

/**
 * Points voice mode at this plugin, touching only the keys that have to change.
 *
 * Dictation is deliberately left alone: it may well be running against a different
 * engine that somebody tuned — a local Whisper with its own term list, say — and
 * "I want a voice for conversations" is not a request to redo transcription too.
 */
export async function wire(port: number, language: string): Promise<boolean> {
  const config = await read();
  const before = JSON.stringify(config);

  const features = object(config.features);
  const voiceMode = object(features.voiceMode);
  voiceMode.enabled = true;
  const stt = object(voiceMode.stt);
  voiceMode.stt = { ...stt, provider: "local", model: localSttModel(language, localModelOf(stt)), language };
  voiceMode.tts = {
    ...object(voiceMode.tts),
    provider: "openai",
    // The engine ignores the credential, but the daemon drops the whole site when no key
    // is present, so a placeholder is load-bearing.
    apiKey: "local",
    baseUrl: `http://127.0.0.1:${port}/v1`,
    // Placeholders: the real speaker is chosen in this plugin and substituted by the proxy.
    model: "tts-1",
    voice: "alloy",
  };
  features.voiceMode = voiceMode;
  config.features = features;

  /**
   * Nothing is written when nothing would change.
   *
   * The desktop app watches this file and restarts the daemon whenever it is touched
   * — which drops every connected phone, breaks the agent's MCP transport, and once
   * took the port out from under this plugin's own proxy mid-sentence. Pressing a
   * button that was already pressed should not cost all that, and it did: the button
   * rewrote an identical file every time.
   */
  if (JSON.stringify(config) === before) {
    return false;
  }

  // Written beside the original and renamed over it: a daemon reading a half-written
  // config at the wrong moment would lose every plugin registration in it.
  const target = configPath();
  const staged = `${target}.voice-plugin.tmp`;
  await writeFile(staged, `${JSON.stringify(config, null, 2)}\n`, { mode: 0o600 });
  await rename(staged, target);
  return true;
}
