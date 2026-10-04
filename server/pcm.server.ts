/**
 * The engine renders 24 kHz mono 16-bit PCM, which is exactly what the Paseo client
 * assembles when it is told the format is `pcm`. One sample is two bytes, so a
 * millisecond is 48 of them.
 */
export const BYTES_PER_MS = 48;

/**
 * How much of the engine's own lead-in to keep. It pads every render with about 80 ms
 * of digital silence, and Paseo plays one sentence per message — so that padding is
 * paid once per sentence and an eight-sentence answer carries two thirds of a second
 * of nothing. A cushion is left behind so no word is ever clipped by rounding.
 */
const CUSHION_MS = 10;

/**
 * Drops the engine's leading and trailing padding. Only exact zeros are removed: that
 * is what the padding is, and anything quiet but non-zero is the voice itself starting.
 */
export function trimPadding(pcm: Buffer): Buffer {
  const cushion = CUSHION_MS * BYTES_PER_MS;

  let head = 0;
  while (head + 1 < pcm.length && pcm.readInt16LE(head) === 0) {
    head += 2;
  }
  let tail = pcm.length;
  while (tail - 2 >= head && pcm.readInt16LE(tail - 2) === 0) {
    tail -= 2;
  }
  if (tail <= head) {
    // Nothing but silence. Hand it back untouched rather than returning an empty body,
    // which downstream cannot tell apart from a failure.
    return pcm;
  }
  return pcm.subarray(Math.max(0, head - cushion), Math.min(pcm.length, tail + cushion));
}

export function durationSeconds(pcm: Buffer): number {
  return pcm.length / 2 / 24_000;
}

/**
 * Wraps raw samples in a RIFF header. Everything downstream of the proxy wants the
 * bytes bare, but a browser `<audio>` will not play them without one.
 */
export function wavOf(pcm: Buffer, sampleRate = 24_000): Buffer {
  const header = Buffer.alloc(44);
  header.write("RIFF", 0, "ascii");
  header.writeUInt32LE(36 + pcm.length, 4);
  header.write("WAVEfmt ", 8, "ascii");
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20);                       // PCM
  header.writeUInt16LE(1, 22);                       // mono
  header.writeUInt32LE(sampleRate, 24);
  header.writeUInt32LE(sampleRate * 2, 28);          // bytes per second
  header.writeUInt16LE(2, 32);                       // block align
  header.writeUInt16LE(16, 34);                      // bits per sample
  header.write("data", 36, "ascii");
  header.writeUInt32LE(pcm.length, 40);
  return Buffer.concat([header, pcm]);
}

/**
 * Takes everything above `cutoff` out of 24 kHz speech, so the phone can throw the
 * band away quietly instead of folding it back as grit.
 *
 * The app's native engine is 16 kHz only and downsamples every chunk with plain linear
 * interpolation — no anti-aliasing filter — so content between 8 and 12 kHz aliases
 * into the audible range. That band is lost either way; this decides whether it leaves
 * politely. Upstream has it as getpaseo/paseo#4981, where the reporter concluded it
 * could not be worked around from outside: delivering 16 kHz does not help, because
 * the app hardcodes the incoming rate. Filtering the 24 kHz does.
 *
 * A windowed-sinc FIR, Blackman window. The transition from 7.5 to 8 kHz is what sets
 * the length: roughly 5.5 / (width / rate) taps, which lands near 127.
 */
export function lowPass(pcm: Buffer, cutoffHz = 7_500, rate = 24_000, taps = 127): Buffer {
  const samples = pcm.length >> 1;
  if (samples === 0) {
    return pcm;
  }
  const half = (taps - 1) / 2;
  const omega = (2 * Math.PI * cutoffHz) / rate;

  const kernel = new Float64Array(taps);
  let sum = 0;
  for (let i = 0; i < taps; i += 1) {
    const n = i - half;
    // sinc, with the limit at the centre written out rather than divided by zero.
    const sinc = n === 0 ? omega / Math.PI : Math.sin(omega * n) / (Math.PI * n);
    const window =
      0.42 - 0.5 * Math.cos((2 * Math.PI * i) / (taps - 1)) + 0.08 * Math.cos((4 * Math.PI * i) / (taps - 1));
    kernel[i] = sinc * window;
    sum += kernel[i];
  }
  // Normalised so a steady tone keeps its level rather than drifting with the window.
  for (let i = 0; i < taps; i += 1) {
    kernel[i] /= sum;
  }

  const out = Buffer.alloc(pcm.length);
  for (let at = 0; at < samples; at += 1) {
    let value = 0;
    for (let k = 0; k < taps; k += 1) {
      const index = at + k - half;
      // Edges are held rather than zeroed: zero-padding a word's first sample reads
      // as a click, which is the thing being removed.
      const clamped = index < 0 ? 0 : index >= samples ? samples - 1 : index;
      value += pcm.readInt16LE(clamped << 1) * kernel[k]!;
    }
    out.writeInt16LE(Math.max(-32768, Math.min(32767, Math.round(value))), at << 1);
  }
  return out;
}
