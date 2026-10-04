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
export async function wire(port: number, language: string): Promise<void> {
  const config = await read();

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

  // Written beside the original and renamed over it: a daemon reading a half-written
  // config at the wrong moment would lose every plugin registration in it.
  const target = configPath();
  const staged = `${target}.voice-plugin.tmp`;
  await writeFile(staged, `${JSON.stringify(config, null, 2)}\n`, { mode: 0o600 });
  await rename(staged, target);
}
