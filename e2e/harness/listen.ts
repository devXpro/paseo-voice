import { Buffer } from "node:buffer";
import { lowPass, wavOf } from "../../server/pcm.server.ts";
import { createRecogniser, installedBytes, MODELS } from "../../server/whisper.server.ts";
import { resample } from "./tts.ts";

/**
 * Listening back: what reached the person, put through Whisper with the language left
 * for it to detect. It answers the one question a timeline cannot — which language the
 * speaker actually spoke — so a Spanish answer read by a Russian voice, or an English one
 * where Spanish was asked, fails as the person would hear it.
 *
 * A recogniser of its own, started with no vocabulary hint: the plugin's running one
 * carries its owner's dictionary, and a hint in one language pulls every other towards it.
 */

/** Whisper names the language it heard in English; the suite speaks in codes. */
const CODES: Record<string, string> = {
  english: "en",
  spanish: "es",
  french: "fr",
  portuguese: "pt",
  german: "de",
  russian: "ru",
  ukrainian: "uk",
};

export type Listener = Awaited<ReturnType<typeof startListener>>;

export async function startListener(port = 8135) {
  let model: string | undefined;
  for (const one of MODELS) {
    if ((await installedBytes(one.id)) > 0) {
      model = one.id;
      break;
    }
  }
  if (!model) {
    throw new Error("no dictation model on disk: listening back needs one — download it in the panel's Dictation section");
  }
  const recogniser = createRecogniser({ port });
  await recogniser.ensure(model, "auto", "");

  return {
    port,

    /** 24 kHz PCM16 in, the language it was in and the words out. */
    async hear(pcm24: Buffer, language = "auto"): Promise<{ language: string; text: string }> {
      const wav = wavOf(resample(lowPass(pcm24), 24_000, 16_000), 16_000);
      const form = new FormData();
      form.set("file", new Blob([new Uint8Array(wav)], { type: "audio/wav" }), "heard.wav");
      form.set("language", language);
      form.set("response_format", "verbose_json");
      const reply = await fetch(`http://127.0.0.1:${port}/inference`, { method: "POST", body: form as unknown as BodyInit });
      const body = (await reply.json()) as { text?: string; language?: string };
      const name = (body.language ?? "").toLowerCase();
      return { language: CODES[name] ?? name, text: (body.text ?? "").trim() };
    },

    stop(): void {
      recogniser.stop();
    },
  };
}
