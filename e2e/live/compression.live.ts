import assert from "node:assert/strict";
import { after, before, describe, test } from "node:test";
import { setTimeout as sleep } from "node:timers/promises";
import { openDictation } from "../harness/dictation.ts";
import { openLiveSession, type VoiceCodecChoice } from "../harness/live-daemon.ts";
import { startTestDaemon, type TestDaemon } from "../harness/test-daemon.ts";
import { createTimeline, type Heard, type Timeline } from "../harness/timeline.ts";

/**
 * Audio both ways, the way a phone sends and gets it — to and from a daemon of the tests'
 * own, through the relay, end-to-end encrypted — once uncompressed, as upstream has it,
 * and once compressed, as this plugin's corrections do it, with the same words both
 * times: the agent's voice as MP3, and the person's, in voice mode and in dictation, as
 * Opus. What differs is what crosses the link, and whether anything is lost on the way.
 */

/**
 * Anything with a few sentences in the answer. A model does not say the same thing twice
 * — asked to repeat a sentence word for word it adds a question, or repeats the words
 * "word for word" — so nothing here depends on the two answers being alike: sizes are
 * compared per second of speech, and the time on the link is reported, not raced.
 */
const ASK = "Расскажи двумя короткими предложениями, зачем нужен голосовой режим.";

type Run = {
  timeline: Timeline;
  ended: string;
  formats: string[];
  /** Base64 characters a second of speech: what actually crosses the link. */
  charsPerSecond: number;
  /** From the agent's `speak` going out to the first of its audio arriving. */
  firstAudioMs: number;
  /**
   * From the daemon having a sentence ready to the phone having all of it, per second of
   * that sentence's speech: the part compression changes. The rest — the model, the
   * synthesis — varies from run to run more than any link does.
   */
  deliveryMsPerSecond: number;
  /** The first sentence: how long it speaks, and how long it took from ready to arrived. */
  speechMs: number;
  deliveryMs: number;
  unconfirmed: string[];
  speech: Heard[];
  heardAfterTheEnd: Heard[];
};

async function run(format: "pcm" | "mp3"): Promise<Run> {
  const daemon = await startTestDaemon({ relay: true, env: { PASEO_VOICE_TTS_FORMAT: format } });
  const timeline = createTimeline();
  try {
    const session = await openLiveSession({ timeline, daemon });
    try {
      await session.say(ASK);
      const ended = await session.turnEnd(120_000);
      const endedAt = timeline.now();
      await sleep(4000);
      const asked = timeline.moments.find((one) => one.what === "agent.permission" && one.detail.includes("speak"));
      const arrived = timeline.moments.find((one) => one.what === "link.audio");
      const { down } = session.traffic;
      const ready = daemon
        .log()
        .find((line) => typeof line.msg === "string" && /^TTS segment 0 synthesis ready/.test(line.msg));
      const first = down.arrivals[0];
      return {
        timeline,
        ended,
        formats: [...down.formats],
        charsPerSecond: down.speechMs > 0 ? down.chars / (down.speechMs / 1000) : 0,
        firstAudioMs: asked && arrived ? arrived.at - asked.at : Number.NaN,
        deliveryMsPerSecond:
          ready && first && typeof ready.time === "number"
            ? (first.at - ready.time) / (first.speechMs / 1000)
            : Number.NaN,
        speechMs: first?.speechMs ?? Number.NaN,
        deliveryMs: ready && first && typeof ready.time === "number" ? first.at - ready.time : Number.NaN,
        unconfirmed: session.audioIds.filter((id) => !session.confirmed.has(id)),
        speech: timeline.heard.filter((one) => one.label === "speech" && one.to > one.from),
        heardAfterTheEnd: timeline.heardAfter(endedAt + 1000),
      };
    } finally {
      await session.close();
    }
  } finally {
    await daemon.stop();
  }
}

describe("the agent's voice, through the relay", { timeout: 600_000 }, () => {
  let pcm: Run;
  let mp3: Run;
  before(async () => {
    pcm = await run("pcm");
    mp3 = await run("mp3");
  });
  after(() => {
    for (const [name, one] of [
      ["PCM", pcm],
      ["MP3", mp3],
    ] as const) {
      if (one) {
        console.log(
          `\n--- ${name}: ${Math.round(one.charsPerSecond / 1024)} KB a second of speech as sent, delivered in ${Math.round(one.deliveryMsPerSecond)} ms a second of speech, first audio ${Math.round(one.firstAudioMs)} ms after speak ---\n${one.timeline.render()}\n`,
        );
      }
    }
  });

  test("arrives as MP3 once the correction is in, and as PCM without it", () => {
    assert.deepEqual(mp3.formats, ["mp3"], mp3.timeline.render());
    assert.deepEqual(pcm.formats, ["pcm"], pcm.timeline.render());
  });

  test("is at most a quarter of the PCM on the wire", () => {
    assert.ok(mp3.charsPerSecond > 0 && pcm.charsPerSecond > 0);
    assert.ok(
      mp3.charsPerSecond <= pcm.charsPerSecond / 4,
      `MP3 ${Math.round(mp3.charsPerSecond)} chars/s against PCM ${Math.round(pcm.charsPerSecond)}`,
    );
  });

  test("is played to the end and confirmed, and the turn completes", () => {
    assert.equal(mp3.ended, "turn_completed", mp3.timeline.render());
    assert.deepEqual(mp3.unconfirmed, [], mp3.timeline.render());
    assert.ok(mp3.speech.length > 0, `nothing was heard\n${mp3.timeline.render()}`);
  });

  test("leaves the speaker quiet once the answer is over", () => {
    assert.deepEqual(mp3.heardAfterTheEnd, [], mp3.timeline.render());
  });

  test("says how long its first sentence took on the link", () => {
    // Reported, not raced: part of the delivery is fixed — the round trips through the
    // relay — and the two answers are different sentences.
    assert.ok(Number.isFinite(mp3.deliveryMs), mp3.timeline.render());
    console.log(
      `delivery of the first sentence: MP3 ${Math.round(mp3.deliveryMs)} ms for ${Math.round(mp3.speechMs)} ms of speech, ` +
        `PCM ${Math.round(pcm.deliveryMs)} ms for ${Math.round(pcm.speechMs)} ms of speech`,
    );
  });
});

/** Said in voice mode: the word to listen for is «снег». */
const QUESTION = "Скажи одним словом, какого цвета снег зимой.";
/** Dictated: the words to listen for are «диктовка» and «сжимаем». */
const DICTATED = "Проверка диктовки: сегодня мы сжимаем голос в опус и смотрим, всё ли доходит до компьютера.";

type Uplink = { transcript: string; charsPerSecond: number; formats: string[]; timeline: Timeline };

/** One spoken question in voice mode, the microphone going up as `codec` says. */
async function ask(daemon: TestDaemon, codec: VoiceCodecChoice): Promise<Uplink & { ended: string; answered: boolean }> {
  const timeline = createTimeline();
  const session = await openLiveSession({ timeline, daemon, voiceCodec: codec });
  try {
    await session.say(QUESTION);
    const ended = await session.turnEnd(120_000);
    const { up } = session.traffic;
    return {
      timeline,
      ended,
      transcript: timeline.moments.find((one) => one.what === "phone.transcript")?.detail ?? "",
      // The microphone streams all along; its rate is what the uplink has to carry.
      charsPerSecond: up.lastAt > up.firstAt ? up.chars / ((up.lastAt - up.firstAt) / 1000) : 0,
      formats: [...up.formats],
      answered: session.audioIds.length > 0,
    };
  } finally {
    await session.close();
  }
}

/** One dictation, the microphone going up as `codec` says. */
async function dictate(daemon: TestDaemon, codec: VoiceCodecChoice): Promise<Uplink & { waitedMs: number }> {
  const timeline = createTimeline();
  const dictation = await openDictation({ timeline, daemon, voiceCodec: codec });
  try {
    const started = timeline.now();
    const { transcript, ms } = await dictation.dictate(DICTATED);
    const spokenSeconds = (timeline.now() - started - ms) / 1000;
    return {
      timeline,
      transcript,
      charsPerSecond: dictation.traffic.chars / spokenSeconds,
      formats: [...dictation.traffic.formats],
      waitedMs: ms,
    };
  } finally {
    await dictation.close();
  }
}

describe("the person's voice, through the relay", { timeout: 900_000 }, () => {
  let daemon: TestDaemon;
  let voice: { pcm: Awaited<ReturnType<typeof ask>>; opus: Awaited<ReturnType<typeof ask>> };
  let dictation: { pcm: Awaited<ReturnType<typeof dictate>>; opus: Awaited<ReturnType<typeof dictate>> };
  before(async () => {
    daemon = await startTestDaemon({ relay: true });
    voice = { pcm: await ask(daemon, "pcm"), opus: await ask(daemon, "opus") };
    dictation = { pcm: await dictate(daemon, "pcm"), opus: await dictate(daemon, "opus") };
  });
  after(async () => {
    await daemon?.stop();
    for (const [name, one] of [
      ["voice, PCM", voice?.pcm],
      ["voice, Opus", voice?.opus],
      ["dictation, PCM", dictation?.pcm],
      ["dictation, Opus", dictation?.opus],
    ] as const) {
      if (one) {
        console.log(`\n--- ${name}: ${Math.round(one.charsPerSecond / 1024)} KB a second up as sent, heard «${one.transcript}» ---\n${one.timeline.render()}\n`);
      }
    }
  });

  test("in voice mode it goes up as Opus once the daemon takes it", () => {
    assert.ok(voice.opus.formats.some((one) => one.startsWith("audio/opus")), voice.opus.timeline.render());
    assert.deepEqual(voice.pcm.formats, ["audio/pcm;rate=16000;bits=16"], voice.pcm.timeline.render());
  });

  test("in voice mode it is at most a sixth of the PCM on the wire", () => {
    assert.ok(
      voice.opus.charsPerSecond > 0 && voice.opus.charsPerSecond <= voice.pcm.charsPerSecond / 6,
      `Opus ${Math.round(voice.opus.charsPerSecond)} chars/s against PCM ${Math.round(voice.pcm.charsPerSecond)}`,
    );
  });

  test("in voice mode it is heard and answered as well as PCM is", () => {
    assert.match(voice.pcm.transcript, /снег/i, voice.pcm.timeline.render());
    assert.match(voice.opus.transcript, /снег/i, voice.opus.timeline.render());
    assert.equal(voice.opus.ended, "turn_completed", voice.opus.timeline.render());
    assert.ok(voice.opus.answered, `no answer was spoken\n${voice.opus.timeline.render()}`);
  });

  test("in dictation it goes up as Opus, at most a sixth of the PCM", () => {
    assert.deepEqual(dictation.opus.formats, ["audio/opus;rate=16000;framing=u16le"], dictation.opus.timeline.render());
    assert.deepEqual(dictation.pcm.formats, ["audio/pcm;rate=16000;bits=16"], dictation.pcm.timeline.render());
    assert.ok(
      dictation.opus.charsPerSecond <= dictation.pcm.charsPerSecond / 6,
      `Opus ${Math.round(dictation.opus.charsPerSecond)} chars/s against PCM ${Math.round(dictation.pcm.charsPerSecond)}`,
    );
  });

  test("in dictation it is transcribed as well as PCM is", () => {
    for (const one of [dictation.pcm, dictation.opus]) {
      assert.match(one.transcript, /диктовк/i, one.timeline.render());
      assert.match(one.transcript, /сжима/i, one.timeline.render());
    }
  });
});
