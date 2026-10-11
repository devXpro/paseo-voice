import { Buffer } from "node:buffer";

/**
 * Audio the speaker can tell apart.
 *
 * The cue is known by its own bytes: Paseo's built-in one and every track the plugin
 * hands out are remembered as they appear, and the engine passes a cue through to the
 * speaker byte for byte (it is already at the speaker's 16 kHz). Simulated speech is a
 * flat level that says which segment it is — a constant survives the engine's
 * resampling exactly. Anything else is real speech.
 */

const STEP = 1000;

const knownCues: Uint8Array[] = [];

/** A cue the phone may play from now on. */
export function rememberCue(pcm: Uint8Array): void {
  if (pcm.byteLength > 0 && !knownCues.some((one) => same(one, pcm))) {
    knownCues.push(pcm);
  }
}

/** Equal length and equal at a spread of positions — enough to tell one track from another. */
function same(a: Uint8Array, b: Uint8Array): boolean {
  if (a.byteLength !== b.byteLength) {
    return false;
  }
  const step = Math.max(1, Math.floor(a.byteLength / 64));
  for (let at = 0; at < a.byteLength; at += step) {
    if (a[at] !== b[at]) {
      return false;
    }
  }
  return true;
}

/** PCM16 mono, at the 24 kHz the daemon sends speech at. */
export function segmentPcm(index: number, ms: number, rate = 24_000): Buffer {
  const samples = Math.round((rate * ms) / 1000);
  const pcm = Buffer.alloc(samples * 2);
  for (let at = 0; at < samples; at++) {
    pcm.writeInt16LE(STEP * (index + 1), at * 2);
  }
  return pcm;
}

/** PCM16 mono at 16 kHz, the cue's own rate: a 440 Hz tone, plainly not speech. */
export function cuePcm(ms: number): Buffer {
  const samples = Math.round(16 * ms);
  const pcm = Buffer.alloc(samples * 2);
  for (let at = 0; at < samples; at++) {
    pcm.writeInt16LE(Math.round(3000 * Math.sin((2 * Math.PI * 440 * at) / 16_000)), at * 2);
  }
  return pcm;
}

export function labelOf(pcm: Uint8Array): string {
  if (pcm.byteLength < 2) {
    return "silence";
  }
  if (knownCues.some((one) => same(one, pcm))) {
    return "cue";
  }
  const view = Buffer.from(pcm.buffer, pcm.byteOffset, pcm.byteLength);
  const samples = Math.floor(view.length / 2);
  const level = view.readInt16LE(0);
  const flat = [samples >> 2, samples >> 1, samples - 1].every((at) => view.readInt16LE(at * 2) === level);
  return flat && level > 0 && level % STEP === 0 ? `segment ${level / STEP - 1}` : "speech";
}
