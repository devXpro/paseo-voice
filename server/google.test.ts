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
  // Measured, not assumed: ru-RU Standard and Wavenet of the same letter return
  // byte-identical audio, so this is the same voice billed two ways.
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
