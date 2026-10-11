/**
 * Imported by Paseo's audio engine alongside `expo-audio`, for the temporary files encoded
 * audio is played from. Voice is PCM and never needs one; see `expo-audio.ts`.
 */

export class File {
  constructor() {
    throw new Error("expo-file-system.File is not available in the harness: only PCM playback is simulated");
  }
}

export const Paths = { cache: "" };
