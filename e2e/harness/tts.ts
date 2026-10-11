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
 * Says `pcm` into the phone's microphone at the speed it would be spoken, then keeps the
 * microphone open on silence — which is how the daemon's voice detector hears a turn end.
 */
export async function say(native: NativeAudio, pcm: Buffer, options: { frameMs?: number; silenceMs?: number } = {}) {
  const frameMs = options.frameMs ?? 100;
  const frameBytes = 32 * frameMs; // 16 kHz, two bytes a sample
  const silence = Buffer.alloc(frameBytes);
  const started = performance.now();
  let sent = 0;
  const frames = [
    ...Array.from({ length: Math.ceil(pcm.length / frameBytes) }, (_, at) => pcm.subarray(at * frameBytes, (at + 1) * frameBytes)),
    ...Array.from({ length: Math.ceil((options.silenceMs ?? 1500) / frameMs) }, () => silence),
  ];
  for (const frame of frames) {
    native.hear(frame);
    sent += frameMs;
    // Paced against the clock rather than frame by frame, so timer drift does not add up.
    const ahead = sent - (performance.now() - started);
    if (ahead > 0) {
      await sleep(ahead);
    }
  }
}
