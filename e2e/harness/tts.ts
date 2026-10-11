import { Buffer } from "node:buffer";
import { setTimeout as sleep } from "node:timers/promises";
import type { NativeAudio } from "./native-audio.ts";

/**
 * What the person says, in the live scenarios: synthesised by this plugin's own proxy —
 * the same voice and provider the agent answers with — and fed to the phone's microphone
 * frame by frame, in real time, the way the native module delivers it.
 */

const PROXY = process.env.PASEO_VOICE_PROXY || "http://127.0.0.1:8123";

/** PCM16 mono at 16 kHz, the rate the phone captures at. */
export async function synthesize(text: string): Promise<Buffer> {
  const response = await fetch(`${PROXY}/v1/audio/speech`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ input: text, response_format: "pcm" }),
    signal: AbortSignal.timeout(30_000),
  });
  if (!response.ok) {
    throw new Error(`the plugin's proxy would not speak: ${response.status} ${await response.text()}`);
  }
  return resample(Buffer.from(await response.arrayBuffer()), 24_000, 16_000);
}

/** Linear interpolation; plenty for speech that only has to be recognised. */
export function resample(pcm: Buffer, from: number, to: number): Buffer {
  const input = Math.floor(pcm.length / 2);
  const output = Math.floor((input * to) / from);
  const out = Buffer.alloc(output * 2);
  for (let at = 0; at < output; at++) {
    const position = (at * from) / to;
    const left = Math.floor(position);
    const right = Math.min(input - 1, left + 1);
    const a = pcm.readInt16LE(left * 2);
    const b = pcm.readInt16LE(right * 2);
    out.writeInt16LE(Math.round(a + (b - a) * (position - left)), at * 2);
  }
  return out;
}

/**
 * What a microphone hears in a quiet room: a noise floor around −60 dBFS, never digital
 * zero. A real microphone does not produce exact zeros, and feeding them is not neutral —
 * the logarithm of zero energy is minus infinity, which a speech model can turn into
 * nonsense rather than into "nothing was said".
 */
export function roomTone(bytes: number): Buffer {
  const pcm = Buffer.alloc(bytes - (bytes % 2));
  for (let at = 0; at < pcm.length; at += 2) {
    pcm.writeInt16LE(Math.round((Math.random() * 2 - 1) * 32), at);
  }
  return pcm;
}

/** Loud enough to be a word rather than the breath around it: about −30 dBFS. */
const SPEECH_PEAK = 1000;

function peakOf(frame: Buffer): number {
  let peak = 0;
  for (let at = 0; at + 1 < frame.length; at += 2) {
    peak = Math.max(peak, Math.abs(frame.readInt16LE(at)));
  }
  return peak;
}

/**
 * Says `pcm` into the phone's microphone at the speed it would be spoken, then keeps the
 * microphone open on the room's quiet — which is how the daemon's voice detector hears a
 * turn end. `onSpoken` is called right after the last frame with a word in it: synthesised
 * speech trails off into silence of its own, and the end of the file is not the end of
 * the words.
 */
export async function say(
  native: NativeAudio,
  pcm: Buffer,
  options: { frameMs?: number; silenceMs?: number; onSpoken?: () => void } = {},
) {
  const frameMs = options.frameMs ?? 100;
  const frameBytes = 32 * frameMs; // 16 kHz, two bytes a sample
  const silence = roomTone(frameBytes);
  const started = performance.now();
  let sent = 0;
  const words = Array.from({ length: Math.ceil(pcm.length / frameBytes) }, (_, at) =>
    pcm.subarray(at * frameBytes, (at + 1) * frameBytes),
  );
  const lastWord = words.findLastIndex((frame) => peakOf(frame) >= SPEECH_PEAK);
  const frames = [...words, ...Array.from({ length: Math.ceil((options.silenceMs ?? 1500) / frameMs) }, () => silence)];
  for (const [at, frame] of frames.entries()) {
    native.hear(frame);
    if (at === lastWord) {
      options.onSpoken?.();
    }
    sent += frameMs;
    // Paced against the clock rather than frame by frame, so timer drift does not add up.
    const ahead = sent - (performance.now() - started);
    if (ahead > 0) {
      await sleep(ahead);
    }
  }
}
