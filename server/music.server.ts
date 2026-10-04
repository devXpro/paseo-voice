/**
 * How audio is passed around here, and the shape of the module Paseo's app compiles
 * its waiting cue from.
 *
 * This file used to synthesise that cue as well — a bossa nova written in code, so the
 * repository would carry no audio and no licence to honour. Real recordings turned out
 * better, and Kevin MacLeod's CC BY allows shipping them, so the synthesiser went.
 */

export type Track = {
  /** Raw little-endian 16-bit mono samples. */
  pcm: Buffer;
  durationMs: number;
  rate: number;
};

/** Byte for byte the file the app generates, so a patched checkout still builds. */
export function moduleSource(track: Track): string {
  return (
    `export const THINKING_TONE_NATIVE_PCM_BASE64 =\n  "${track.pcm.toString("base64")}";\n` +
    `export const THINKING_TONE_NATIVE_PCM_DURATION_MS = ${track.durationMs.toFixed(1)};\n`
  );
}
