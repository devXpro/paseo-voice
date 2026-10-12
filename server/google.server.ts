import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { localeOfVoice } from "../shared/languages.shared.ts";
import { paths } from "./paths.server.ts";

/**
 * Google Cloud Text-to-Speech, which is where the speech comes from unless somebody
 * asks for the local engine instead.
 *
 * Two things here are not obvious and were measured rather than assumed. `Standard`
 * and `Wavenet` voices of the same letter are one voice billed two ways — and
 * `Standard` carries four times the free allowance. Measured across all thirteen
 * accents by the length of the same sentence, since synthesis is not byte-for-byte
 * repeatable: 54 pairs of 55 came out the same length to within two milliseconds; the
 * one exception is pt-BR's letter A. And stress is set through
 * `customPronunciations`, a field on the request, not through a mark in the text: a
 * combining acute in the text is read aloud as a character and mangles the word.
 */

const ENDPOINT = "https://texttospeech.googleapis.com/v1";

/** What Google bills separately. Free allowances reset on the first of every month. */
export const TIERS = [
  {
    id: "chirp3-hd",
    marker: "Chirp3-HD",
    label: "Chirp 3 HD",
    note: "the newest generation, the most alive",
    freeChars: 1_000_000,
    dollarsPerMillion: 30,
  },
  {
    id: "standard",
    marker: "Standard",
    label: "Standard",
    note: "the same voices as WaveNet, four times as much free",
    freeChars: 4_000_000,
    dollarsPerMillion: 4,
  },
  {
    id: "wavenet",
    marker: "Wavenet",
    label: "WaveNet",
    note: "sounds like Standard — take Standard",
    freeChars: 1_000_000,
    dollarsPerMillion: 4,
  },
] as const;

export type TierId = (typeof TIERS)[number]["id"];

export const tierOf = (voice: string): TierId | "" =>
  TIERS.find((tier) => voice.includes(tier.marker))?.id ?? "";

export type GoogleVoice = { name: string; tier: TierId; gender: string };

export async function readKey(): Promise<string> {
  try {
    return (await readFile(paths.googleKey, "utf8")).trim();
  } catch {
    return "";
  }
}

/**
 * Enough of the key to recognise it, and not enough to use it.
 *
 * The settings panel is a screen that gets photographed and shared — this plugin's own
 * development ran on screenshots of it. So the key itself never leaves this process:
 * the surface is told the first six characters and the last three, which is sufficient
 * to answer "is this the key I think it is" and nothing else.
 */
export const hintOf = (key: string): string =>
  key.length < 12 ? (key ? "…" : "") : `${key.slice(0, 6)}…${key.slice(-3)}`;

/**
 * Keeps a key, having first made Google agree it is one.
 *
 * Checked before it is written, and deliberately so: a typo pasted over a working key
 * would otherwise leave no speech and no way back, since the old value is gone. An
 * empty string is the way to forget a key rather than a thing to validate.
 */
export async function writeKey(key: string): Promise<void> {
  const trimmed = key.trim();
  if (!trimmed) {
    await rm(paths.googleKey, { force: true });
    return;
  }
  // The call that proves it: cheap, read-only, and billed to nobody.
  await listVoices(trimmed, "en-US");
  await mkdir(path.dirname(paths.googleKey), { recursive: true });
  await writeFile(paths.googleKey, `${trimmed}\n`, { mode: 0o600 });
}

type VoicesReply = { voices?: { name: string; ssmlGender?: string }[] };

/**
 * The catalogue, asked of Google rather than written down: the Chirp line is new and
 * its naming has already moved once, and a stale list fails in a way that reads like a
 * credentials problem.
 *
 * Only the accent's own voices are kept. Asked for `fr-CA`, Google also offers `fr-FR`
 * voices that can read it — with a French accent, which is what choosing an accent is
 * there to avoid.
 */
export async function listVoices(key: string, locale: string): Promise<GoogleVoice[]> {
  const response = await fetch(`${ENDPOINT}/voices?languageCode=${locale}&key=${key}`, {
    signal: AbortSignal.timeout(15_000),
  });
  if (!response.ok) {
    throw new Error(`Google: ${response.status} ${(await response.text()).slice(0, 200)}`);
  }
  return (((await response.json()) as VoicesReply).voices ?? [])
    .map((voice) => ({
      name: voice.name,
      tier: tierOf(voice.name) as TierId,
      gender: voice.ssmlGender === "FEMALE" ? "female" : "male",
    }))
    .filter((voice) => voice.tier !== ("" as TierId) && localeOfVoice(voice.name) === locale);
}

export type Pronunciation = { phrase: string; ipa: string };

export type SpeakRequest = {
  key: string;
  voice: string;
  text: string;
  /** The accent, when it should not simply be read off the voice's name. */
  language?: string;
  /** Pitch-preserving tempo. Google takes 0.25–4.0; the surface offers a narrower band. */
  rate?: number;
  /** Only the entries whose phrase occurs in the text are worth sending. */
  pronunciations?: Pronunciation[];
  /** MP3 comes back ready to send; LINEAR16 is the default. */
  encoding?: "LINEAR16" | "MP3";
};

/**
 * Returns raw 24 kHz mono 16-bit PCM, the header stripped — what the Paseo client wants —
 * or, asked for MP3, Google's own MP3 at the same rate.
 */
export async function speak(request: SpeakRequest): Promise<Buffer> {
  const input: Record<string, unknown> = { text: request.text };
  const used = (request.pronunciations ?? []).filter((entry) =>
    request.text.toLowerCase().includes(entry.phrase.toLowerCase()),
  );
  if (used.length > 0) {
    input.customPronunciations = {
      pronunciations: used.map((entry) => ({
        phrase: entry.phrase,
        phoneticEncoding: "PHONETIC_ENCODING_IPA",
        pronunciation: entry.ipa,
      })),
    };
  }

  const response = await fetch(`${ENDPOINT}/text:synthesize?key=${request.key}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      input,
      voice: { languageCode: request.language ?? localeOfVoice(request.voice), name: request.voice },
      audioConfig: {
        audioEncoding: request.encoding ?? "LINEAR16",
        sampleRateHertz: 24_000,
        ...(request.rate && request.rate !== 1 ? { speakingRate: request.rate } : {}),
      },
    }),
    signal: AbortSignal.timeout(60_000),
  });
  if (!response.ok) {
    throw new Error(`Google: ${response.status} ${(await response.text()).slice(0, 300)}`);
  }
  const audio = Buffer.from(((await response.json()) as { audioContent: string }).audioContent, "base64");
  return request.encoding === "MP3" ? audio : stripWavHeader(audio);
}

/**
 * LINEAR16 comes back as a RIFF file. The header has to go: Paseo is told the format is
 * `pcm` and would otherwise play the forty-odd header bytes as a click.
 */
export function stripWavHeader(wav: Buffer): Buffer {
  if (wav.length < 12 || wav.toString("ascii", 0, 4) !== "RIFF") {
    return wav;
  }
  let at = 12;
  while (at + 8 <= wav.length) {
    const id = wav.toString("ascii", at, at + 4);
    const size = wav.readUInt32LE(at + 4);
    if (id === "data") {
      return wav.subarray(at + 8, Math.min(wav.length, at + 8 + size));
    }
    at += 8 + size + (size % 2);
  }
  return wav;
}
