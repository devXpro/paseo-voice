import type { Timeline } from "./timeline.ts";

/**
 * A stand-in for `@getpaseo/expo-two-way-audio`, the phone's native audio module.
 *
 * It keeps the one behaviour the engine above it relies on: buffers handed to
 * `playPCMData` queue up and play one after another at the real rate — PCM16 mono at
 * 16 kHz, which the engine resamples everything to — and `stopPlayback` silences
 * whatever is queued. What comes out of the speaker, and when, goes into the timeline.
 *
 * The microphone works the way the real module's does: whoever subscribed to
 * `onMicrophoneData` and `onInputVolumeLevelData` gets frames and levels — here, when
 * the harness says something through `hear`.
 */

const BYTES_PER_MS = 32; // 16 000 samples a second, two bytes each

export type NativeAudio = ReturnType<typeof createNativeAudio>;

let current: NativeAudio | null = null;

/** What the engine gets from its `require`, installed per scenario. */
export function currentNativeAudio(): NativeAudio {
  if (!current) {
    throw new Error("no native audio stand-in installed — create one before the engine");
  }
  return current;
}

type Listener = (event: { data: unknown }) => void;

/** Loudness of a PCM16 frame, 0 to 1, for the volume events that go with it. */
function levelOf(pcm: Uint8Array): number {
  const view = new DataView(pcm.buffer, pcm.byteOffset, pcm.byteLength);
  let sum = 0;
  const samples = Math.floor(pcm.byteLength / 2);
  for (let at = 0; at < samples; at++) {
    const sample = view.getInt16(at * 2, true) / 32768;
    sum += sample * sample;
  }
  return samples === 0 ? 0 : Math.min(1, Math.sqrt(sum / samples) * 4);
}

export function createNativeAudio(timeline: Timeline, labelOf: (pcm: Uint8Array) => string) {
  // When the speaker is next free: anything queued before then plays after it.
  let freeAt = 0;
  const listeners = new Map<string, Set<Listener>>();

  const native = {
    addExpoTwoWayAudioEventListener(name: string, listener: Listener) {
      const set = listeners.get(name) ?? new Set<Listener>();
      listeners.set(name, set);
      set.add(listener);
      return {
        remove() {
          set.delete(listener);
        },
      };
    },

    /** One frame from the microphone, as the native module delivers it. */
    hear(pcm: Uint8Array): void {
      for (const listener of listeners.get("onMicrophoneData") ?? []) {
        listener({ data: pcm });
      }
      for (const listener of listeners.get("onInputVolumeLevelData") ?? []) {
        listener({ data: levelOf(pcm) });
      }
    },

    async initialize() {
      return true;
    },
    releaseAudioSession() {},
    async getMicrophonePermissionsAsync() {
      return { granted: true };
    },
    async requestMicrophonePermissionsAsync() {
      return { granted: true };
    },
    toggleRecording(on: boolean) {
      return on;
    },
    resumePlayback() {},

    playPCMData(pcm: Uint8Array) {
      const now = timeline.now();
      const from = Math.max(now, freeAt);
      const to = from + pcm.byteLength / BYTES_PER_MS;
      freeAt = to;
      const label = labelOf(pcm);
      timeline.heard.push({ label, from: Math.round(from), to: Math.round(to) });
      timeline.note("speaker.queued", `${label}, ${Math.round(to - from)} ms`);
    },

    stopPlayback() {
      const now = timeline.now();
      for (const one of timeline.heard) {
        // Cut what is playing; collapse what had not started yet.
        if (one.to > now) {
          one.to = Math.max(one.from, now);
        }
      }
      freeAt = now;
      timeline.note("speaker.stopped");
    },

    tearDown() {},
  };

  current = native;
  return native;
}
