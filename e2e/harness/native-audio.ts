import OpusScript from "opusscript";
import type { Heard, Timeline } from "./timeline.ts";

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
 *
 * And the Opus encoder the patched module carries works the way `VoiceOpusEncoder.swift`
 * does — 20 ms packets at 24 kbit/s, each prefixed with its length — through libopus
 * rather than AudioToolbox. The Swift encoder is proved on its own in
 * `e2e/opus-encoder.e2e.ts`; this is for everything around it.
 */

const OPUS_FRAME = 320; // 20 ms at 16 kHz

/**
 * Expo's bridge takes a typed array by its constructor's name, looked up in a table of
 * the standard ones (`TypedArray.cpp`, `nameToKindMap.at`). Anything else — a `Buffer`,
 * which is a `Uint8Array` subclass — fails on the phone with this very message, and so it
 * fails here: the stand-in that took any `Uint8Array` is how one reached a phone.
 */
const TYPED_ARRAYS = new Set([
  "Int8Array",
  "Uint8Array",
  "Uint8ClampedArray",
  "Int16Array",
  "Uint16Array",
  "Int32Array",
  "Uint32Array",
  "Float32Array",
  "Float64Array",
  "BigInt64Array",
  "BigUint64Array",
]);

function acrossTheBridge(bytes: Uint8Array): Uint8Array {
  if (!TYPED_ARRAYS.has(bytes.constructor.name)) {
    throw new Error(`Exception in HostFunction: unordered_map::at: key not found (given a ${bytes.constructor.name})`);
  }
  return bytes;
}

/** `VoiceOpusEncoder.encode`, in libopus: whole packets for everything handed in so far. */
function createOpusEncoder() {
  const encoder = new OpusScript(16_000, 1, OpusScript.Application.VOIP);
  encoder.setBitrate(24_000);
  let pending = Buffer.alloc(0);
  return {
    encode(pcm: Uint8Array): Uint8Array {
      pending = Buffer.concat([pending, Buffer.from(pcm.buffer, pcm.byteOffset, pcm.byteLength)]);
      const packets: Buffer[] = [];
      while (pending.length >= OPUS_FRAME * 2) {
        const packet = encoder.encode(pending.subarray(0, OPUS_FRAME * 2), OPUS_FRAME);
        const size = Buffer.alloc(2);
        size.writeUInt16LE(packet.length);
        packets.push(size, Buffer.from(packet));
        pending = pending.subarray(OPUS_FRAME * 2);
      }
      return new Uint8Array(Buffer.concat(packets));
    },
    free(): void {
      encoder.delete();
    },
  };
}

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
  // What `playPCMData` queued, which is all `stopPlayback` silences: a file the system
  // player is playing is not the native module's to stop.
  let queued: Heard[] = [];
  const listeners = new Map<string, Set<Listener>>();
  // One encoder per stream, as the patched module keeps them: voice and dictation.
  const opus = new Map<string, ReturnType<typeof createOpusEncoder>>();

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
      acrossTheBridge(pcm);
      const now = timeline.now();
      const from = Math.max(now, freeAt);
      const to = from + pcm.byteLength / BYTES_PER_MS;
      freeAt = to;
      const label = labelOf(pcm);
      const heard = { label, from: Math.round(from), to: Math.round(to) };
      timeline.heard.push(heard);
      queued.push(heard);
      timeline.note("speaker.queued", `${label}, ${Math.round(to - from)} ms`);
    },

    stopPlayback() {
      const now = timeline.now();
      for (const one of queued) {
        // Cut what is playing; collapse what had not started yet.
        if (one.to > now) {
          one.to = Math.max(one.from, now);
        }
      }
      queued = [];
      freeAt = now;
      timeline.note("speaker.stopped");
    },

    /**
     * An encoded file through the system player — the phone's other way to sound, which
     * MP3 speech takes. Heard from now for `ms`; `stop` cuts it where it is.
     */
    playFile(label: string, ms: number): { stop(): void } {
      const heard = { label, from: timeline.now(), to: Math.round(timeline.now() + ms) };
      timeline.heard.push(heard);
      timeline.note("speaker.file", `${label}, ${Math.round(ms)} ms`);
      return {
        stop() {
          const now = timeline.now();
          if (heard.to > now) {
            heard.to = Math.max(heard.from, now);
            timeline.note("speaker.file-stopped");
          }
        },
      };
    },

    /** The patched module's: the microphone's PCM as length-prefixed Opus packets. */
    encodeOpus(stream: string, pcm: Uint8Array): Uint8Array | null {
      acrossTheBridge(pcm);
      let encoder = opus.get(stream);
      if (!encoder) {
        encoder = createOpusEncoder();
        opus.set(stream, encoder);
      }
      return encoder.encode(pcm);
    },

    resetOpusEncoder(stream: string): void {
      opus.get(stream)?.free();
      opus.delete(stream);
    },

    tearDown() {},
  };

  current = native;
  return native;
}
