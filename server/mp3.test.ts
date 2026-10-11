import assert from "node:assert/strict";
import { test } from "node:test";
import { canEncodeMp3, encodeMp3, isMp3, mp3Duration } from "./mp3.server.ts";

/** One silent MPEG-2 Layer III frame at 24 kHz and 64 kbit/s: 576 samples, 192 bytes. */
function frame(padding = 0): Buffer {
  const bytes = Buffer.alloc(Math.floor((72_000 * 64) / 24_000) + padding);
  bytes[0] = 0xff;
  bytes[1] = 0xf3; // MPEG-2, Layer III, no CRC
  bytes[2] = (8 << 4) | (1 << 2) | (padding << 1); // 64 kbit/s, 24 kHz
  bytes[3] = 0xc4; // mono
  return bytes;
}

test("an MP3's length is read from its frames", () => {
  const twenty = Buffer.concat(Array.from({ length: 20 }, () => frame()));
  assert.ok(Math.abs(mp3Duration(twenty) - (20 * 576) / 24_000) < 1e-9, String(mp3Duration(twenty)));
  assert.equal(isMp3(twenty), true);
});

test("a tag in front and stray bytes between frames do not count", () => {
  // ID3v2 with a ten-byte body, then junk, then two frames.
  const tag = Buffer.from([0x49, 0x44, 0x33, 4, 0, 0, 0, 0, 0, 10, ...Array.from({ length: 10 }, () => 0)]);
  const mp3 = Buffer.concat([tag, frame(), Buffer.from([1, 2, 3]), frame(1)]);
  assert.ok(Math.abs(mp3Duration(mp3) - (2 * 576) / 24_000) < 1e-9, String(mp3Duration(mp3)));
});

test("PCM is not an MP3", () => {
  assert.equal(isMp3(Buffer.alloc(4096, 0x11)), false);
  assert.equal(mp3Duration(Buffer.alloc(4096, 0x11)), 0);
});

test("the local engine's PCM is encoded to an MP3 of the same length", { skip: !canEncodeMp3() }, async () => {
  const seconds = 2;
  const pcm = Buffer.alloc(24_000 * seconds * 2);
  for (let at = 0; at < pcm.length / 2; at++) {
    pcm.writeInt16LE(Math.round(8000 * Math.sin((2 * Math.PI * 220 * at) / 24_000)), at * 2);
  }
  const mp3 = await encodeMp3(pcm);
  assert.equal(isMp3(mp3), true);
  // An encoder adds a frame or two of padding; it must not lose or invent seconds.
  assert.ok(Math.abs(mp3Duration(mp3) - seconds) < 0.15, `${mp3Duration(mp3)} s`);
  assert.ok(mp3.length < pcm.length / 5, `${mp3.length} bytes for ${pcm.length} of PCM`);
});
