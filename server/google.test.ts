import assert from "node:assert/strict";
import { test } from "node:test";
import { TIERS, hintOf, stripWavHeader, tierOf } from "./google.server.ts";

test("the billing family is read from the voice name", () => {
  assert.equal(tierOf("ru-RU-Chirp3-HD-Orus"), "chirp3-hd");
  assert.equal(tierOf("ru-RU-Wavenet-D"), "wavenet");
  assert.equal(tierOf("ru-RU-Standard-D"), "standard");
  assert.equal(tierOf("dylan"), "");
});

test("Standard carries four times the free allowance of WaveNet", () => {
  // Measured, not assumed: across all thirteen accents, Standard and WaveNet of the same
  // letter read a sentence to the same length in 54 pairs of 55 — one voice billed two ways.
  const standard = TIERS.find((tier) => tier.id === "standard");
  const wavenet = TIERS.find((tier) => tier.id === "wavenet");
  assert.equal(standard?.dollarsPerMillion, wavenet?.dollarsPerMillion);
  assert.equal(standard?.freeChars, 4_000_000);
  assert.equal(wavenet?.freeChars, 1_000_000);
});

function wav(samples: Buffer, extraChunk = false): Buffer {
  const chunks: Buffer[] = [];
  if (extraChunk) {
    // A LIST chunk before the data, which some encoders insert and a naive 44-byte
    // slice would mistake for audio.
    const list = Buffer.alloc(8 + 10);
    list.write("LIST", 0, "ascii");
    list.writeUInt32LE(10, 4);
    chunks.push(list);
  }
  const data = Buffer.alloc(8);
  data.write("data", 0, "ascii");
  data.writeUInt32LE(samples.length, 4);
  const fmt = Buffer.alloc(8 + 16);
  fmt.write("fmt ", 0, "ascii");
  fmt.writeUInt32LE(16, 4);
  const head = Buffer.alloc(12);
  head.write("RIFF", 0, "ascii");
  head.write("WAVE", 8, "ascii");
  const body = Buffer.concat([fmt, ...chunks, data, samples]);
  head.writeUInt32LE(4 + body.length, 4);
  return Buffer.concat([head, body]);
}

test("the RIFF header comes off, whatever chunks precede the samples", () => {
  const samples = Buffer.from([1, 0, 2, 0, 3, 0]);
  assert.deepEqual(stripWavHeader(wav(samples)), samples);
  // The header would otherwise be played as a click, and a fixed 44-byte slice would
  // eat the start of the first word whenever an extra chunk is present.
  assert.deepEqual(stripWavHeader(wav(samples, true)), samples);
});

test("bytes that are already bare are left alone", () => {
  const raw = Buffer.from([9, 9, 9, 9]);
  assert.deepEqual(stripWavHeader(raw), raw);
});

/**
 * The panel is a screen people photograph — this plugin was built from screenshots of
 * it. So what matters here is not that the hint is pretty but that it is useless to
 * anyone who reads it off an image.
 */
test("the key hint is recognisable and cannot be reassembled", () => {
  // Shaped like a key and obviously not one, so no secret scanner has to decide.
  const key = "AIzaSyEXAMPLEEXAMPLEEXAMPLEEXAMPLEEX0zY";
  assert.equal(hintOf(key), "AIzaSy…0zY");
  // Nine characters of thirty-nine, six of which every Google key shares.
  const revealed = hintOf(key).replace("…", "").length;
  assert.ok(revealed <= 9, `показано ${revealed} символов из ${key.length}`);
});

test("nothing to show is shown as nothing", () => {
  assert.equal(hintOf(""), "");
  // Too short to split without handing over most of it.
  assert.equal(hintOf("AIza"), "…");
});

/** Runs `work` with `fetch` answered by `reply`, and hands back what was asked of it. */
async function withFetch(
  reply: (url: string) => unknown,
  work: () => Promise<void>,
): Promise<{ url: string; body: Record<string, any> }[]> {
  const asked: { url: string; body: Record<string, any> }[] = [];
  const real = globalThis.fetch;
  globalThis.fetch = (async (input: string | URL, init?: RequestInit) => {
    const url = String(input);
    asked.push({ url, body: init?.body ? JSON.parse(String(init.body)) : {} });
    return new Response(JSON.stringify(reply(url)), { status: 200, headers: { "content-type": "application/json" } });
  }) as typeof fetch;
  try {
    await work();
  } finally {
    globalThis.fetch = real;
  }
  return asked;
}

test("every sentence is sent with the voice's own accent beside it", async () => {
  const { speak } = await import("./google.server.ts");
  const asked = await withFetch(
    () => ({ audioContent: Buffer.from([1, 0, 2, 0]).toString("base64") }),
    async () => {
      await speak({ key: "k", voice: "pt-BR-Chirp3-HD-Orus", text: "Olá." });
      await speak({ key: "k", voice: "uk-UA-Chirp3-HD-Orus", text: "Привіт." });
    },
  );
  // It used to be ru-RU whatever the voice: right for one language out of seven.
  assert.equal(asked[0]?.body.voice.languageCode, "pt-BR");
  assert.equal(asked[1]?.body.voice.languageCode, "uk-UA");
});

test("an accent's voices are its own, not a neighbour's that can also read it", async () => {
  const { listVoices } = await import("./google.server.ts");
  let voices: { name: string }[] = [];
  // Asked for fr-CA, Google also offers fr-FR voices — which would read Canadian French
  // with a French accent, the very thing choosing an accent is for.
  await withFetch(
    () => ({
      voices: [
        { name: "fr-CA-Chirp3-HD-Orus", ssmlGender: "MALE" },
        { name: "fr-CA-Standard-A", ssmlGender: "FEMALE" },
        { name: "fr-FR-Standard-F", ssmlGender: "FEMALE" },
        { name: "fr-FR-Wavenet-G", ssmlGender: "MALE" },
      ],
    }),
    async () => {
      voices = await listVoices("k", "fr-CA");
    },
  );
  assert.deepEqual(
    voices.map((voice) => voice.name),
    ["fr-CA-Chirp3-HD-Orus", "fr-CA-Standard-A"],
  );
});
