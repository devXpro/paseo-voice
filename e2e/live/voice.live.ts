import assert from "node:assert/strict";
import { after, before, describe, test } from "node:test";
import { setTimeout as sleep } from "node:timers/promises";
import { openLiveSession } from "../harness/live-daemon.ts";
import { createTimeline, type Heard, type Timeline } from "../harness/timeline.ts";

/**
 * Against the real daemon, through the relay, with a test agent on Haiku: the person
 * speaks in the plugin's voice, and the phone's own code plays whatever comes back.
 *
 * Each block holds one real conversation and states several things about it, so a run
 * costs a couple of Haiku turns and a few hundred characters of Google TTS rather than
 * one per assertion. Questions are ones a model answers without reaching for a tool:
 * a tool would wait on a permission nobody is there to grant.
 */

type Exchange = {
  timeline: Timeline;
  ended: string;
  transcript: string;
  audioIds: string[];
  unconfirmed: string[];
  heardAfterTheEnd: Heard[];
  /** The cue between the first and the last words of the answer. */
  cueWithinTheAnswer: Heard[];
  /** The cue after the last words, while the model was ending its turn and later. */
  cueAfterTheLastWords: Heard[];
};

async function exchange(question: string): Promise<Exchange> {
  const timeline = createTimeline();
  const session = await openLiveSession({ timeline });
  try {
    await session.say(question);
    const ended = await session.turnEnd(120_000);
    const endedAt = timeline.now();
    // Listening on past the end, which is where the cue that should be gone would be.
    await sleep(4000);
    const confirmed = new Set(timeline.moments.filter((one) => one.what === "phone.confirms").map((one) => one.detail));
    const sounded = timeline.heard.filter((one) => one.to > one.from);
    const speech = sounded.filter((one) => one.label === "speech");
    const cue = sounded.filter((one) => one.label === "cue");
    const answerFrom = Math.min(...speech.map((one) => one.from));
    const answerTo = Math.max(...speech.map((one) => one.to));
    return {
      timeline,
      ended,
      transcript: timeline.moments.find((one) => one.what === "phone.transcript")?.detail ?? "",
      audioIds: [...session.audioIds],
      unconfirmed: session.audioIds.filter((id) => !confirmed.has(id)),
      heardAfterTheEnd: timeline.heardAfter(endedAt + 1000),
      cueWithinTheAnswer: cue.filter((one) => one.from >= answerFrom && one.from < answerTo),
      cueAfterTheLastWords: cue.filter((one) => one.from >= answerTo),
    };
  } finally {
    await session.close();
  }
}

describe("a short spoken question", { timeout: 240_000 }, () => {
  let run: Exchange;
  before(async () => {
    run = await exchange("Скажи одним коротким предложением, какого цвета небо днём.");
  });
  after(() => {
    console.log(`\n--- short question ---\n${run?.timeline.render()}\n`);
  });

  test("is heard: the daemon recognises what was said", () => {
    assert.match(run.transcript, /неб/i, run.timeline.render());
  });

  test("is answered aloud, and the turn ends", () => {
    assert.equal(run.ended, "turn_completed", run.timeline.render());
    assert.ok(run.audioIds.length > 0, run.timeline.render());
  });

  test("every sentence of the answer is played and confirmed", () => {
    assert.deepEqual(run.unconfirmed, [], run.timeline.render());
  });

  test("nothing but silence follows its last words", () => {
    assert.deepEqual(run.cueAfterTheLastWords, [], run.timeline.render());
  });

  test("once the answer is over the speaker goes quiet", () => {
    assert.deepEqual(run.heardAfterTheEnd, [], run.timeline.render());
  });
});

describe("a question with a long answer", { timeout: 300_000 }, () => {
  let run: Exchange;
  before(async () => {
    run = await exchange("Расскажи пятью предложениями, зачем нужен голосовой режим. Без списков, просто текстом.");
  });
  after(() => {
    console.log(`\n--- long answer ---\n${run?.timeline.render()}\n`);
  });

  test("is answered in several sentences that all play to the end", () => {
    assert.ok(run.audioIds.length > 1, `one segment only — not the case under test\n${run.timeline.render()}`);
    assert.deepEqual(run.unconfirmed, [], run.timeline.render());
    assert.equal(run.ended, "turn_completed", run.timeline.render());
  });

  test("the cue never sounds between its sentences", () => {
    assert.deepEqual(run.cueWithinTheAnswer, [], run.timeline.render());
  });

  test("nothing but silence follows its last words", () => {
    assert.deepEqual(run.cueAfterTheLastWords, [], run.timeline.render());
  });

  test("once the answer is over the speaker goes quiet", () => {
    assert.deepEqual(run.heardAfterTheEnd, [], run.timeline.render());
  });
});
