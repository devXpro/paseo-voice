import assert from "node:assert/strict";
import { test } from "node:test";
import { durationSeconds, lowPass, trimPadding } from "./pcm.server.ts";

/** 24 kHz mono 16-bit: `ms` milliseconds is `ms * 24` samples. */
function pcm(samples: number[]): Buffer {
  const buffer = Buffer.alloc(samples.length * 2);
  samples.forEach((value, index) => buffer.writeInt16LE(value, index * 2));
  return buffer;
}

const silence = (ms: number) => new Array(ms * 24).fill(0);
const sound = (ms: number) => new Array(ms * 24).fill(4000);

test("the engine's lead-in is dropped, leaving a cushion", () => {
  // Measured on a real render: about 80 ms of exact zeros before the first word.
  const trimmed = trimPadding(pcm([...silence(80), ...sound(500), ...silence(6)]));
  // 500 ms of speech plus 10 ms of cushion at each end.
  assert.equal(Math.round(durationSeconds(trimmed) * 1000), 516);
});

test("a quiet start is speech, not padding, and survives", () => {
  const quiet = new Array(24 * 20).fill(3);
  const trimmed = trimPadding(pcm([...silence(80), ...quiet, ...sound(100)]));
  assert.equal(Math.round(durationSeconds(trimmed) * 1000), 130);
  // The first non-zero sample is still in there, only the cushion precedes it.
  assert.equal(trimmed.readInt16LE(10 * 24 * 2), 3);
});

test("audio that needs no trimming comes back unchanged", () => {
  const original = pcm(sound(100));
  assert.equal(trimPadding(original).length, original.length);
});

test("a render that is nothing but silence is handed back whole", () => {
  // Returning an empty buffer here would reach Paseo as a valid but empty reply, and
  // a sentence that plays as nothing is indistinguishable from one that was skipped.
  const original = pcm(silence(50));
  assert.equal(trimPadding(original).length, original.length);
});

test("an empty buffer is not an error", () => {
  assert.equal(trimPadding(Buffer.alloc(0)).length, 0);
});

test("the band the phone would alias is taken out, and speech is left alone", () => {
  const rate = 24_000;
  const tone = (hz: number) => {
    const buffer = Buffer.alloc(rate * 2);
    for (let i = 0; i < rate; i += 1) {
      buffer.writeInt16LE(Math.round(Math.sin((2 * Math.PI * hz * i) / rate) * 12_000), i * 2);
    }
    return buffer;
  };
  /** Level in the steady middle, away from the filter's settling at the edges. */
  const level = (pcm: Buffer) => {
    let peak = 0;
    for (let i = rate * 0.25; i < rate * 0.75; i += 1) {
      peak = Math.max(peak, Math.abs(pcm.readInt16LE(i * 2)));
    }
    return peak;
  };

  // 1 kHz is ordinary voice and has to come through untouched.
  const low = level(lowPass(tone(1000)));
  assert.ok(low > 11_000, `1 кГц должен пройти целым, получил ${low}`);

  // 10 kHz is what folds back as grit on the phone, so it has to be gone.
  const high = level(lowPass(tone(10_000)));
  assert.ok(high < 400, `10 кГц должен исчезнуть, получил ${high}`);

  // 6 kHz is inside the passband: sibilants must not be dulled more than the phone
  // would dull them anyway.
  const edge = level(lowPass(tone(6000)));
  assert.ok(edge > 10_000, `6 кГц должен пройти, получил ${edge}`);
});

test("filtering leaves the length and the silence exactly as they were", () => {
  const quiet = Buffer.alloc(2400, 0);
  const filtered = lowPass(quiet);
  assert.equal(filtered.length, quiet.length);
  assert.deepEqual(filtered, quiet);
  assert.equal(lowPass(Buffer.alloc(0)).length, 0);
});
