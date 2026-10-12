import { setTimeout as sleep } from "node:timers/promises";
import { createPhone } from "./phone.ts";
import { createSimulatedDaemon, type Network } from "./simulated-daemon.ts";
import { createTimeline, type Heard, type Timeline } from "./timeline.ts";

/** The phone and the daemon through the relay, on a decent connection. */
export const RELAY: Network = { latencyMs: 150, bytesPerMs: 1000 };

/** A weak connection: a few seconds of speech take longer than 1.5 s to come down. */
export const WEAK_RELAY: Network = { latencyMs: 150, bytesPerMs: 100 };

/** Upstream's wait before the cue, where the patched phone waits 250 ms. */
export const UPSTREAM_CUE_WAIT = "?minSilenceMs=1500";

/**
 * How long a model takes to end its turn once its last `speak` has returned: it still
 * has the tool's result to read. About a second for Haiku, measured live.
 */
const WRAP_UP_MS = 1000;

type Setup = { network: Network; pluginCue: boolean; runtimeVariant?: string };

async function setUp(options: Setup) {
  const timeline = createTimeline();
  const daemon = createSimulatedDaemon(timeline, options.network);
  const phone = await createPhone({
    timeline,
    runtimeVariant: options.runtimeVariant,
    audioPlayed: (chunkId) => daemon.audioPlayed(chunkId),
    fetchCue: options.pluginCue ? (have) => daemon.fetchCue(have) : undefined,
  });
  daemon.attach(phone);
  daemon.transcript("hello");
  daemon.turn("turn_started");
  return { timeline, daemon, phone };
}

const audible = (one: Heard) => one.to > one.from;
const cue = (timeline: Timeline) => timeline.heard.filter((one) => audible(one) && one.label === "cue");
const words = (timeline: Timeline) => timeline.heard.filter((one) => audible(one) && one.label.startsWith("segment"));

export type ReplyRun = Awaited<ReturnType<typeof runReply>>;

/**
 * One exchange: the person has spoken, the agent thinks for a while, then answers in
 * segments of the given lengths and ends its turn — and the scenario listens on past
 * the end of it.
 */
export async function runReply(options: Setup & { segmentsMs: number[]; thinkMs?: number }) {
  const { timeline, daemon, phone } = await setUp(options);
  await sleep(options.thinkMs ?? 1200);
  const spoken = await daemon.speak(options.segmentsMs);
  if (spoken.stuckAt === null) {
    await sleep(WRAP_UP_MS);
    daemon.turn("turn_completed");
  }
  // By then the phone has had the end of the turn and time to act on it.
  const over = timeline.now() + 2 * options.network.latencyMs + 300;
  await sleep(2000);

  const replyFrom = Math.min(...words(timeline).map((one) => one.from));
  const replyTo = Math.max(...words(timeline).map((one) => one.to));
  const run = {
    timeline,
    spoken,
    /** The cue, wherever it sounded before the first words of the reply. */
    cueBeforeTheReply: cue(timeline).filter((one) => one.from < replyFrom),
    /** The cue, wherever it sounded while the reply was still being spoken. */
    cueWithinTheReply: cue(timeline).filter((one) => one.from >= replyFrom && one.from < replyTo),
    /** The cue after the last words — the agent had nothing left to say. */
    cueAfterTheLastWords: cue(timeline).filter((one) => one.from >= replyTo),
    /** Anything the speaker was still putting out once the turn was over. */
    heardAfterTheEnd: timeline.heardAfter(over),
  };
  await phone.hangUp();
  return run;
}

/**
 * The agent says something short — "running the tests" — then works on in silence for
 * `workMs`, then answers and ends the turn. The cue belongs to the work in between.
 */
export async function runProgressNote(options: Setup & { workMs: number }) {
  const { timeline, daemon, phone } = await setUp(options);
  await sleep(1200);
  await daemon.speak([600]);
  const workFrom = timeline.now();
  await sleep(options.workMs);
  const workTo = timeline.now();
  await daemon.speak([600]);
  await sleep(WRAP_UP_MS);
  daemon.turn("turn_completed");
  await sleep(1500);

  const run = {
    timeline,
    /** The cue while the agent was working between the two things it said. */
    cueWhileWorking: cue(timeline).filter((one) => one.to > workFrom && one.from < workTo),
  };
  await phone.hangUp();
  return run;
}
