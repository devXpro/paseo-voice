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
 * The local STT model voice mode should transcribe with. The default is Parakeet v2,
 * which is English-only — the reason Russian voice mode produces silence out of the box.
 * v3 covers 25 European languages and auto-detects, and the daemon downloads it itself
 * when the config names a model that is not on disk yet.
 */
const VOICE_STT_MODEL = "parakeet-tdt-0.6b-v3-int8";

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
 * Whether dictation currently transcribes through a proxy on `port`.
 *
 * Separate from the speech side on purpose: somebody may want this plugin's Russian
 * recogniser and Paseo's own voices, or the other way round.
 */
export async function isDictationWired(port: number): Promise<boolean> {
  const config = await read();
  const stt = object(object(object(config.providers).openai).stt);
  const feature = object(object(object(config.features).dictation).stt);
  return typeof stt.baseUrl === "string" && stt.baseUrl.includes(`:${port}`) && feature.provider === "openai";
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

  const providers = object(config.providers);
  const openai = object(providers.openai);
  const features = object(config.features);
  const dictation = object(features.dictation);

  if (on) {
    openai.stt = {
      ...object(openai.stt),
      // Ignored by the engine, but the daemon drops the whole block without one.
      apiKey: "local",
      baseUrl: `http://127.0.0.1:${port}/v1`,
    };
    // The language matters more than it looks. Without it Paseo sends its own default,
    // which is English, and the engine transcribes Russian as though it were English —
    // which is the exact failure this whole feature exists to remove. `enabled` is the
    // other half: the feature can be pointed here and still be switched off.
    dictation.stt = { ...object(dictation.stt), provider: "openai", model, language };
    dictation.enabled = true;
  } else {
    // Back to what Paseo ships with, rather than leaving it pointed at a dead port.
    dictation.stt = { ...object(dictation.stt), provider: "local", model: VOICE_STT_MODEL };
  }

  providers.openai = openai;
  config.providers = providers;
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

/** Whether voice mode currently reads through a proxy on `port`. */
export async function isWired(port: number): Promise<boolean> {
  const config = await read();
  const tts = object(object(object(config.providers).openai).tts);
  const voiceMode = object(object(config.features).voiceMode);
  const ttsFeature = object(voiceMode.tts);
  return (
    typeof tts.baseUrl === "string" &&
    tts.baseUrl.includes(`:${port}`) &&
    ttsFeature.provider === "openai"
  );
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

  const providers = object(config.providers);
  const openai = object(providers.openai);
  openai.tts = {
    ...object(openai.tts),
    // The engine ignores the credential, but the daemon drops the whole TTS block when
    // no key is present, so a placeholder is load-bearing.
    apiKey: "local",
    baseUrl: `http://127.0.0.1:${port}/v1`,
  };
  providers.openai = openai;
  config.providers = providers;

  const features = object(config.features);
  const voiceMode = object(features.voiceMode);
  voiceMode.enabled = true;
  voiceMode.stt = { ...object(voiceMode.stt), provider: "local", model: VOICE_STT_MODEL, language };
  voiceMode.tts = {
    ...object(voiceMode.tts),
    provider: "openai",
    // Both are validated against OpenAI's own enums before the daemon will accept them.
    // The real speaker is chosen in this plugin and substituted by the proxy.
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
