import assert from "node:assert/strict";
import { test } from "node:test";
import { RELAY, runCutIn, runReply } from "./harness/scenario.ts";

/**
 * Cutting into the agent, end to end through the phone's real voice code: the person
 * starts talking while a reply is being spoken, the daemon's detector confirms it, and
 * the agent's voice has to stop there — not at the end of its sentence.
 *
 * Each format is checked on its own. Since this plugin's `format` correction the agent's
 * voice reaches the phone as MP3, which it plays through the system player; as PCM it
 * goes through the engine's own speaker. They stop in different ways.
 */

/** One long segment, the way merged sentences come, cut into three seconds in. */
const LONG_SEGMENT = { segmentsMs: [8000], cutAfterMs: 3000 };

test("the agent's voice stops as soon as the person cuts in, as MP3", async () => {
  const run = await runCutIn({ network: RELAY, pluginCue: true, voice: "mp3", ...LONG_SEGMENT });
  assert.deepEqual(run.voiceAfterTheCut, [], run.timeline.render());
});

test("the agent's voice stops as soon as the person cuts in, as PCM", async () => {
  const run = await runCutIn({ network: RELAY, pluginCue: true, voice: "pcm", ...LONG_SEGMENT });
  assert.deepEqual(run.voiceAfterTheCut, [], run.timeline.render());
});

test("an MP3 reply nobody cuts into is played to its end", async () => {
  // The other half: a phone that silenced MP3 for good would pass the tests above.
  const run = await runReply({ network: RELAY, segmentsMs: [1500, 1500], pluginCue: true, voice: "mp3" });
  assert.equal(run.spoken.stuckAt, null, run.timeline.render());
  const heardMs = run.timeline.heard
    .filter((one) => one.label === "speech")
    .reduce((sum, one) => sum + Math.max(0, one.to - one.from), 0);
  assert.ok(heardMs >= 2900, `${heardMs} ms of 3000 heard\n${run.timeline.render()}`);
  assert.deepEqual(run.heardAfterTheEnd, [], run.timeline.render());
});
