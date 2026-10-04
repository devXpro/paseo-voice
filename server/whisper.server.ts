import { stat } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";

/**
 * The transcription model `paseo-whisper` runs dictation on. This plugin only ever puts
 * the file where that service already looks — it does not touch its `config.json` and
 * does not restart it. Dictation here is tuned (a term list, saved clips, a warm
 * whisper-server on 8099), and quietly re-pointing it would be a downgrade nobody asked for.
 */
export const WHISPER_MODEL = {
  name: "ggml-large-v3-turbo.bin",
  repo: "ggerganov/whisper.cpp",
  /** Published size, used for the progress bar before the first byte arrives. */
  bytes: 1_624_555_275,
};

/** Where `paseo-whisper` keeps its weights, per its own config.json. */
export const whisperDir = path.join(homedir(), ".config", "paseo-whisper", "models");
export const whisperFile = path.join(whisperDir, WHISPER_MODEL.name);

export async function whisperInstalled(): Promise<number> {
  try {
    const info = await stat(whisperFile);
    // A partial left by an interrupted run would be smaller; treat only a plausible
    // file as installed, so the surface offers to finish rather than claiming success.
    return info.size > WHISPER_MODEL.bytes * 0.98 ? info.size : 0;
  } catch {
    return 0;
  }
}
