import assert from "node:assert/strict";
import { test } from "node:test";
import { createPhone } from "./harness/phone.ts";
import { cuePcm } from "./harness/speech.ts";
import { createTimeline } from "./harness/timeline.ts";
import { say } from "./harness/tts.ts";

/**
 * The way in: what the harness says goes through the phone's own capture path — native
 * module, engine, runtime, uploader — to whatever the daemon side is. Checked here before
 * anything depends on it live.
 */

test("what is said into the microphone reaches the daemon in real time, as 16 kHz PCM", async () => {
  const timeline = createTimeline();
  const chunks: { mimeType: string; at: number }[] = [];
  const phone = await createPhone({
    timeline,
    audioPlayed() {},
    sendVoiceAudioChunk: (_audio, mimeType) => chunks.push({ mimeType, at: timeline.now() }),
  });

  // A second of sound and half a second of silence after it, in 100 ms frames.
  await say(phone.native, cuePcm(1000), { frameMs: 100, silenceMs: 500 });
  await phone.hangUp();

  assert.equal(phone.microphoneMs(), 1500, "every frame, the silence included");
  assert.deepEqual([...new Set(chunks.map((one) => one.mimeType))], ["audio/pcm;rate=16000;bits=16"]);
  const spread = (chunks.at(-1)?.at ?? 0) - (chunks[0]?.at ?? 0);
  assert.ok(spread >= 1300, `sent over ${spread} ms — at the speed of speech, not all at once`);
});
