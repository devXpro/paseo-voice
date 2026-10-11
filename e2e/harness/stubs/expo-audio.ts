import { mp3Duration } from "../../../server/mp3.server.ts";
import { currentNativeAudio } from "../native-audio.ts";
import { readFile } from "./expo-file-system.ts";

/**
 * Paseo's audio engine plays encoded files — MP3 speech among them — through `expo-audio`,
 * the system player, rather than through the native module PCM goes to. This plays them
 * on the harness's speaker for as long as the file lasts, and reports back the way
 * `expo-audio` does: loaded with a duration, then finished.
 */

type Status = { playbackState: string; isLoaded: boolean; didJustFinish: boolean; duration: number };
type Listener = (status: Status) => void;

export async function setAudioModeAsync(): Promise<void> {}

export function createAudioPlayer(uri: string) {
  const listeners = new Set<Listener>();
  const emit = (status: Status) => {
    for (const listener of listeners) {
      listener(status);
    }
  };
  let sounding: { stop(): void } | null = null;
  let finish: ReturnType<typeof setTimeout> | undefined;

  return {
    addListener(_event: "playbackStatusUpdate", listener: Listener) {
      listeners.add(listener);
      return {
        remove() {
          listeners.delete(listener);
        },
      };
    },

    play(): void {
      const bytes = readFile(uri);
      const seconds = bytes ? mp3Duration(bytes) : 0;
      if (!bytes || seconds === 0) {
        // What the real player says about a file it cannot decode.
        queueMicrotask(() => emit({ playbackState: "failed", isLoaded: false, didJustFinish: false, duration: 0 }));
        return;
      }
      sounding = currentNativeAudio().playFile("speech", seconds * 1000);
      queueMicrotask(() => emit({ playbackState: "playing", isLoaded: true, didJustFinish: false, duration: seconds }));
      finish = setTimeout(() => {
        sounding = null;
        emit({ playbackState: "finished", isLoaded: true, didJustFinish: true, duration: seconds });
      }, seconds * 1000);
    },

    remove(): void {
      clearTimeout(finish);
      sounding?.stop();
      sounding = null;
      listeners.clear();
    },
  };
}
