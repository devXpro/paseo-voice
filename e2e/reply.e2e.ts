import assert from "node:assert/strict";
import { test } from "node:test";
import { RELAY, runProgressNote, runReply, UPSTREAM_CUE_WAIT, WEAK_RELAY } from "./harness/scenario.ts";

/**
 * A spoken reply, end to end through the phone's real voice code, over a simulated relay.
 *
 * The cue's rule, as the person using it put it: music while the agent is thinking, and
 * only then — not between its sentences, not after its last word. The tests on the
 * phone as built check that rule; the ones that change a single thing — the cue's
 * source, the wait before it, the link — show what a failure hangs on.
 */

const THREE_SENTENCES = [600, 600, 600];

test("the cue plays while the agent is thinking, on the phone as built", async () => {
  // The other half of the rule: a fix that silenced the cue altogether would pass
  // every test about silence.
  const run = await runReply({ network: RELAY, segmentsMs: [600], pluginCue: true, thinkMs: 2500 });
  assert.notDeepEqual(run.cueBeforeTheReply, [], run.timeline.render());
});

test("a reply in several segments is played to its end, on the phone as built", async () => {
  const run = await runReply({ network: RELAY, segmentsMs: THREE_SENTENCES, pluginCue: true });
  assert.equal(run.spoken.stuckAt, null, run.timeline.render());
});

test("the cue never sounds between two segments of one reply, on the phone as built", async () => {
  const run = await runReply({ network: RELAY, segmentsMs: THREE_SENTENCES, pluginCue: true });
  assert.deepEqual(run.cueWithinTheReply, [], run.timeline.render());
});

test("nothing but silence follows the last words of a reply, on the phone as built", async () => {
  const run = await runReply({ network: RELAY, segmentsMs: [600], pluginCue: true });
  assert.deepEqual(run.cueAfterTheLastWords, [], run.timeline.render());
});

test("once the reply is over the speaker goes quiet, on the phone as built", async () => {
  const run = await runReply({ network: RELAY, segmentsMs: [600], pluginCue: true });
  assert.equal(run.spoken.stuckAt, null, run.timeline.render());
  assert.deepEqual(run.heardAfterTheEnd, [], run.timeline.render());
});

test("the cue comes back while the agent works on after saying something, on the phone as built", async () => {
  const run = await runProgressNote({ network: RELAY, workMs: 6000, pluginCue: true });
  assert.notDeepEqual(run.cueWhileWorking, [], run.timeline.render());
});

// One thing changed at a time.

test("the cue never sounds between two segments of one reply, even with a cue that needs no fetching", async () => {
  // As built, the plugin's cue is fetched before every play, and that round trip alone
  // can outlast the pause between two sentences — which hides the gap rather than
  // closing it. Paseo's built-in cue starts at once, so here the gap is all there is.
  const run = await runReply({ network: RELAY, segmentsMs: THREE_SENTENCES, pluginCue: false });
  assert.deepEqual(run.cueWithinTheReply, [], run.timeline.render());
});

test("a reply in several segments is played to its end with Paseo's built-in cue", async () => {
  const run = await runReply({ network: RELAY, segmentsMs: THREE_SENTENCES, pluginCue: false });
  assert.equal(run.spoken.stuckAt, null, run.timeline.render());
});

test("a reply in several segments is played to its end with upstream's wait before the cue", async () => {
  const run = await runReply({
    network: RELAY,
    segmentsMs: THREE_SENTENCES,
    pluginCue: true,
    runtimeVariant: UPSTREAM_CUE_WAIT,
  });
  assert.equal(run.spoken.stuckAt, null, run.timeline.render());
});

test("a reply is played to its end on a weak link, where a segment takes longer than 1.5 s to arrive", async () => {
  const run = await runReply({
    network: WEAK_RELAY,
    segmentsMs: [3000, 3000],
    pluginCue: true,
    runtimeVariant: UPSTREAM_CUE_WAIT,
  });
  assert.equal(run.spoken.stuckAt, null, run.timeline.render());
});
