import assert from "node:assert/strict";
import { after, before, describe, test } from "node:test";
import { setTimeout as sleep } from "node:timers/promises";
import { type LiveSession, openLiveSession } from "../harness/live-daemon.ts";
import { startTestDaemon, type TestDaemon } from "../harness/test-daemon.ts";
import { createTimeline, type Moment, type Timeline } from "../harness/timeline.ts";

/**
 * A person in voice mode who does not press mute: who listens while the agent works,
 * cuts in on it, and keeps talking past a crash of the daemon's speech worker. Each of
 * these once left the agent stopped and the session deaf, mute, or both.
 *
 * On a daemon of the tests' own (see `test-daemon.ts`), never the real one: two of these
 * kill its speech worker, and the corrections they check are only loaded by a daemon
 * that starts after they were written.
 */

const TURN_ENDS = new Set(["turn_completed", "turn_failed", "turn_canceled"]);

/** The first moment from `since` on that `match` accepts; null once `timeoutMs` has passed. */
async function moment(
  timeline: Timeline,
  since: number,
  match: (one: Moment) => boolean,
  timeoutMs: number,
): Promise<Moment | null> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const found = timeline.moments.find((one) => one.at >= since && match(one));
    if (found || Date.now() > deadline) {
      return found ?? null;
    }
    await sleep(100);
  }
}

const transcriptAfter = (timeline: Timeline, since: number, timeoutMs = 30_000) =>
  moment(timeline, since, (one) => one.what === "phone.transcript", timeoutMs);

const turnEndAfter = (timeline: Timeline, since: number, timeoutMs = 120_000) =>
  moment(timeline, since, (one) => one.what === "phone.turn" && TURN_ENDS.has(one.detail), timeoutMs);

/** Speech the speaker actually played from `since` on. */
const speechAfter = (timeline: Timeline, since: number) =>
  timeline.heard.filter((one) => one.label === "speech" && one.from >= since && one.to > one.from);

/** One spoken exchange to its end: what the daemon heard, and how the turn ended. */
async function exchange(session: LiveSession, words: string) {
  const { timeline } = session;
  const from = timeline.now();
  await session.say(words);
  const heard = await transcriptAfter(timeline, from);
  assert.ok(heard, `the daemon never answered "${words}" with a transcript\n${timeline.render()}`);
  const ended = await turnEndAfter(timeline, heard.at);
  return { heard, ended };
}

async function conversation(daemon: TestDaemon, body: (session: LiveSession) => Promise<void>): Promise<void> {
  const session = await openLiveSession({ timeline: createTimeline(), daemon });
  try {
    await body(session);
  } finally {
    await session.close();
  }
}

describe("listening without mute", { timeout: 900_000 }, () => {
  let daemon: TestDaemon;
  before(async () => {
    daemon = await startTestDaemon();
  });
  after(async () => {
    await daemon?.stop();
  });

  test("cutting into a long answer silences it, and the new question is heard from its first word", { timeout: 240_000 }, () =>
    conversation(daemon, async (session) => {
      const { timeline } = session;
      await session.say("Расскажи подробно, примерно на минуту, как устроен сборщик мусора в Go.");
      const answering = await moment(timeline, 0, (one) => one.what === "phone.audio_output", 90_000);
      assert.ok(answering, `the answer never started\n${timeline.render()}`);
      // Well into its first sentence.
      await sleep(3000);
      const cutAt = timeline.now();
      await session.say("Стоп, хватит. Скажи просто, сколько будет два плюс два.");
      const render = () => timeline.render();

      const spoke = timeline.moments.find((one) => one.at >= cutAt && one.what === "person.says");
      // PCM stops on the engine, MP3 on the file player: either way the speaker goes quiet.
      const silenced = await moment(
        timeline,
        cutAt,
        (one) => one.what === "speaker.stopped" || one.what === "speaker.file-stopped",
        10_000,
      );
      assert.ok(spoke && silenced && silenced.at - spoke.at < 2500, `the answer kept playing over the person\n${render()}`);
      assert.ok(await moment(timeline, cutAt, (one) => one.what === "phone.turn" && one.detail === "turn_canceled", 10_000), render());

      const heard = await transcriptAfter(timeline, cutAt);
      assert.ok(heard, render());
      // The first word is the one the detector had not confirmed yet when it was said.
      assert.match(heard.detail, /стоп/i, render());
      // The recogniser writes numbers either way: «два плюс два» one time, «2 плюс 2» the next.
      assert.match(heard.detail, /два|2/i, render());
      const ended = await turnEndAfter(timeline, heard.at);
      assert.equal(ended?.detail, "turn_completed", render());
      assert.ok(speechAfter(timeline, heard.at).length > 0, `the new question was never answered aloud\n${render()}`);
    }));

  test("a phrase said after ninety seconds of listening is heard whole", { timeout: 300_000 }, () =>
    conversation(daemon, async (session) => {
      const { timeline } = session;
      const first = await exchange(session, "Скажи одно слово: яблоко.");
      // The microphone stays open all this time, as a phone's does with mute off.
      await sleep(Math.max(0, first.heard.at + 90_000 - timeline.now()));
      const askedAt = timeline.now();
      await session.say("А теперь скажи одно слово: апельсин.");
      const heard = await transcriptAfter(timeline, askedAt);
      assert.ok(heard, timeline.render());
      assert.match(heard.detail, /теперь/i, `the start of the phrase was lost\n${timeline.render()}`);
      assert.match(heard.detail, /апельсин/i, timeline.render());
      const ended = await turnEndAfter(timeline, heard.at);
      assert.equal(ended?.detail, "turn_completed", timeline.render());
      assert.ok(speechAfter(timeline, heard.at).length > 0, timeline.render());
    }));

  test("after the speech worker dies between phrases, the next phrase is still heard", { timeout: 240_000 }, () =>
    conversation(daemon, async (session) => {
      const { timeline } = session;
      await exchange(session, "Скажи одно слово: яблоко.");
      timeline.note("test.kills-worker", String(await daemon.killWorker()));
      await sleep(3000);
      const askedAt = timeline.now();
      await session.say("А теперь скажи одно слово: апельсин.");
      const heard = await transcriptAfter(timeline, askedAt);
      assert.ok(heard, `nothing said after the crash reached the daemon: it went deaf\n${timeline.render()}`);
      assert.match(heard.detail, /апельсин/i, timeline.render());
      const ended = await turnEndAfter(timeline, heard.at);
      assert.equal(ended?.detail, "turn_completed", timeline.render());
      assert.ok(speechAfter(timeline, heard.at).length > 0, timeline.render());
    }));

  test("after a phrase that comes out empty, the agent is heard again", { timeout: 240_000 }, () =>
    conversation(daemon, async (session) => {
      const { timeline } = session;
      await exchange(session, "Скажи одно слово: яблоко.");
      // The worker dies in the quiet after the words, before the detector has called the
      // phrase over: what it heard dies with it, and the phrase ends with nothing in it.
      // Long enough for the detector to have confirmed it — it takes 800 ms of speech, and
      // a phrase it never noticed is not a phrase that comes out empty.
      const askedAt = timeline.now();
      let noticed = false;
      // Settled where it is started, so a failure waits for the assertion below rather
      // than surfacing as an unhandled rejection while the person is still talking.
      let killed: Promise<unknown> = Promise.resolve();
      await session.say("Подожди секунду, я сейчас соберусь с мыслями и продолжу.", {
        onSpoken: () => {
          noticed = timeline.moments.some(
            (one) => one.at >= askedAt && one.what === "phone.server-hears-speech" && one.detail === "yes",
          );
          if (noticed) {
            killed = sleep(300)
              .then(() => daemon.killWorker())
              .then((pid) => timeline.note("test.kills-worker", String(pid)))
              .catch((failure: unknown) => failure);
          }
        },
      });
      assert.ok(noticed, `the daemon never noticed the phrase: not the case under test\n${timeline.render()}`);
      const failure = await killed;
      assert.ok(!(failure instanceof Error), String(failure));
      const lost = await transcriptAfter(timeline, askedAt);
      assert.ok(lost, `nothing said after the crash reached the daemon: it went deaf\n${timeline.render()}`);
      assert.equal(lost.detail, "", `the phrase was recognised after all: not the case under test\n${timeline.render()}`);

      // What a person does next when saying it did not work.
      const typedAt = timeline.now();
      await session.type("Скажи голосом одно слово: груша.");
      const ended = await turnEndAfter(timeline, typedAt);
      assert.equal(ended?.detail, "turn_completed", timeline.render());
      assert.ok(
        timeline.moments.some((one) => one.at >= typedAt && one.what === "phone.audio_output"),
        `the agent answered, but none of its speech reached the phone\n${timeline.render()}`,
      );
      assert.ok(speechAfter(timeline, typedAt).length > 0, timeline.render());
    }));
});
