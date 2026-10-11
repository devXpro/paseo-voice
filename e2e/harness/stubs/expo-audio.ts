/**
 * Paseo's audio engine imports `expo-audio` for encoded files — mp3, m4a — played through
 * the system player. Voice is PCM and never goes that way, so in the harness these only
 * have to exist; being called means a scenario went somewhere it was not built for.
 */

function unavailable(name: string): never {
  throw new Error(`expo-audio.${name} is not available in the harness: only PCM playback is simulated`);
}

export function createAudioPlayer(): never {
  return unavailable("createAudioPlayer");
}

export async function setAudioModeAsync(): Promise<never> {
  return unavailable("setAudioModeAsync");
}
