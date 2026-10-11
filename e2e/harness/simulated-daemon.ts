import { setTimeout as sleep } from "node:timers/promises";
import type { AudioOutput, CueAnswer, Phone, TurnEvent } from "./phone.ts";
import { cuePcm, segmentPcm } from "./speech.ts";
import type { Timeline } from "./timeline.ts";

/**
 * The daemon and the relay between it and the phone, simulated where it matters for
 * playback, after `tts-manager.js` in Paseo 0.11.1:
 *
 * - every TTS segment goes out as a group of its own — its own `groupId`, `chunkIndex` 0,
 *   `isLastChunk` — with all of its audio in one message;
 * - the next segment goes out only once the phone confirms the current one has played,
 *   and the daemon waits for that confirmation without a timeout of its own;
 * - everything from the daemon to the phone shares one ordered connection, so a large
 *   message holds up whatever was sent after it — one websocket through the relay.
 */

export type Network = {
  /** One way, daemon to phone or back. */
  latencyMs: number;
  /** Throughput of the way down, which is where the audio goes. */
  bytesPerMs: number;
};

export type Spoken = { confirmed: number; stuckAt: number | null };

export type SimulatedDaemon = ReturnType<typeof createSimulatedDaemon>;

export function createSimulatedDaemon(timeline: Timeline, network: Network, cueMs = 3000) {
  let phone: Phone | null = null;
  let downFreeAt = 0;
  let audioCounter = 0;
  let speakCounter = 0;
  const confirmations = new Map<string, () => void>();
  const cueTag = "harness-cue";
  const cueBase64 = cuePcm(cueMs).toString("base64");

  /** Daemon to phone: arrives after everything sent before it, at the link's speed. */
  function down(bytes: number, deliver: () => void): void {
    const now = timeline.now();
    const begins = Math.max(now + network.latencyMs, downFreeAt);
    downFreeAt = begins + bytes / network.bytesPerMs;
    setTimeout(deliver, downFreeAt - now);
  }

  /** Phone to daemon: small messages, so latency alone. */
  function up(handle: () => void): void {
    setTimeout(handle, network.latencyMs);
  }

  return {
    attach(next: Phone): void {
      phone = next;
    },

    /** The phone's confirmation that a chunk has finished playing. */
    audioPlayed(chunkId: string): void {
      up(() => {
        timeline.note("daemon.confirmed", chunkId);
        confirmations.get(chunkId)?.();
      });
    },

    /** The plugin's cue RPC: the question goes up, the answer queues on the way down. */
    fetchCue(have: string): Promise<CueAnswer> {
      return new Promise((resolve) => {
        up(() => {
          const answer =
            have === cueTag
              ? { tag: cueTag, unchanged: true, pcmBase64: "" }
              : { tag: cueTag, unchanged: false, pcmBase64: cueBase64 };
          down(answer.pcmBase64.length + 64, () => resolve(answer));
        });
      });
    },

    transcript(text: string): void {
      down(64, () => phone?.receiveTranscript(text));
    },

    turn(event: TurnEvent): void {
      timeline.note("daemon.turn", event);
      down(64, () => phone?.receiveTurn(event));
    },

    /**
     * Speaks a reply made of segments of the given lengths, as one `speak` tool call:
     * the call shows as running before any audio — the first sentence is still being
     * synthesised — then the segments go out the way the TTS manager sends them, and the
     * call completes once the last one is confirmed. The real daemon waits for each
     * confirmation forever; the harness gives up after a segment's own length plus
     * `patienceMs` and calls the reply stuck.
     */
    async speak(segmentsMs: number[], patienceMs = 4000, synthMs = 800): Promise<Spoken> {
      const callId = `speak-${++speakCounter}`;
      timeline.note("daemon.speak", "running");
      down(64, () => phone?.receiveSpeakCall(callId, "running"));
      await sleep(synthMs);
      const finish = (status: string) => {
        timeline.note("daemon.speak", status);
        down(64, () => phone?.receiveSpeakCall(callId, status));
      };
      for (const [index, ms] of segmentsMs.entries()) {
        const audioId = `audio-${++audioCounter}`;
        const payload: AudioOutput = {
          id: `${audioId}:0`,
          groupId: audioId,
          chunkIndex: 0,
          isLastChunk: true,
          audio: segmentPcm(index, ms).toString("base64"),
          format: "pcm",
          isVoiceMode: true,
        };
        let giveUp: ReturnType<typeof setTimeout> | undefined;
        const confirmed = new Promise<boolean>((resolve) => {
          confirmations.set(payload.id, () => resolve(true));
          giveUp = setTimeout(() => resolve(false), ms + patienceMs + 2 * network.latencyMs + payload.audio.length / network.bytesPerMs);
        });
        timeline.note("daemon.emits", `segment ${index}, ${ms} ms of speech`);
        down(payload.audio.length, () => phone?.receiveAudio(payload));
        const played = await confirmed;
        clearTimeout(giveUp);
        confirmations.delete(payload.id);
        if (!played) {
          timeline.note("daemon.stuck", `segment ${index} was never confirmed`);
          return { confirmed: index, stuckAt: index };
        }
      }
      finish("completed");
      return { confirmed: segmentsMs.length, stuckAt: null };
    },
  };
}
