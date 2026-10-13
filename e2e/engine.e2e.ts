import assert from "node:assert/strict";
import { test } from "node:test";
import { setTimeout as sleep } from "node:timers/promises";
import { createNativeAudio } from "./harness/native-audio.ts";
import { engineSpecifier } from "./harness/paseo-source.ts";
import { cuePcm, labelOf, rememberCue, segmentPcm, speechMp3 } from "./harness/speech.ts";
import { createTimeline } from "./harness/timeline.ts";

/**
 * Paseo's native audio engine on its own, as the phone runs it — no voice runtime above.
 *
 * `playAudio` asks a source for its bytes and only then plays them. The patched phone's
 * cue source answers late, because it asks the plugin first; these are about what the
 * engine does when it is stopped in that window.
 */

const ENGINE = engineSpecifier;

/** A source whose bytes take a while to come, the way the patched cue's do. */
function lateSource(bytes: Uint8Array, delayMs: number) {
  return {
    size: bytes.byteLength,
    type: "audio/pcm;rate=16000;bits=16",
    async arrayBuffer() {
      await sleep(delayMs);
      return Uint8Array.from(bytes).buffer;
    },
  };
}

/** Speech as the runtime hands it to the engine: 24 kHz PCM, bytes at hand. */
function speechSource(index: number, ms: number) {
  const bytes = segmentPcm(index, ms);
  return {
    size: bytes.byteLength,
    type: "audio/pcm;rate=24000;bits=16",
    async arrayBuffer() {
      return Uint8Array.from(bytes).buffer;
    },
  };
}

/** Speech as it comes once the agent's voice is MP3: played through the system player. */
function mp3Source(ms: number) {
  const bytes = speechMp3(ms);
  return {
    size: bytes.byteLength,
    type: "audio/mpeg",
    async arrayBuffer() {
      return Uint8Array.from(bytes).buffer;
    },
  };
}

/** The late sound in these is a cue, and the speaker is told so. */
const LATE_CUE = cuePcm(1000);
rememberCue(LATE_CUE);

async function engineWithSpeaker() {
  const timeline = createTimeline();
  createNativeAudio(timeline, labelOf);
  const { createAudioEngine } = await import(ENGINE);
  return { timeline, engine: createAudioEngine({ onCaptureData() {}, onVolumeLevel() {} }) };
}

test("a sound stopped while its bytes are still coming does not take over the one played next", async () => {
  const { timeline, engine } = await engineWithSpeaker();

  const stopped = engine.play(lateSource(LATE_CUE, 300)).then(
    () => "played",
    () => "stopped",
  );
  await sleep(50);
  engine.stop();
  engine.clearQueue();
  const next = engine.play(speechSource(0, 400)).then(() => "finished");
  const outcome = await Promise.race([next, sleep(3000).then(() => "never finished")]);

  assert.equal(await stopped, "stopped");
  assert.equal(outcome, "finished", timeline.render());
  await engine.destroy();
});

test("a sound stopped while its bytes are still coming is never heard", async () => {
  const { timeline, engine } = await engineWithSpeaker();

  void engine.play(lateSource(LATE_CUE, 300)).catch(() => {});
  await sleep(50);
  engine.stop();
  engine.clearQueue();
  void engine.play(speechSource(0, 400)).catch(() => {});
  await sleep(1500);

  const cue = timeline.heard.filter((one) => one.label === "cue" && one.to > one.from);
  assert.deepEqual(cue, [], timeline.render());
  await engine.destroy();
});

test("MP3 speech goes quiet the moment the engine is stopped", async () => {
  const { timeline, engine } = await engineWithSpeaker();

  void engine.play(mp3Source(5000)).catch(() => {});
  await sleep(1000);
  const stoppedAt = timeline.now();
  engine.stop();
  engine.clearQueue();
  await sleep(500);

  assert.deepEqual(timeline.heardAfter(stoppedAt + 100), [], timeline.render());
  await engine.destroy();
});
