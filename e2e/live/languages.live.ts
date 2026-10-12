import assert from "node:assert/strict";
import { after, before, describe, test } from "node:test";
import { setTimeout as sleep } from "node:timers/promises";
import { speechLanguageOf } from "../../shared/languages.shared.ts";
import { DEFAULT_PROMPT } from "../../server/daemon-settings.server.ts";
import { createEngine, type Engine } from "../../server/engine.server.ts";
import { readKey } from "../../server/google.server.ts";
import { createProxy, type Proxy as SpeechProxy } from "../../server/proxy.server.ts";
import { openDictation } from "../harness/dictation.ts";
import { startListener, type Listener } from "../harness/listen.ts";
import { openLiveSession } from "../harness/live-daemon.ts";
import { startTestDaemon, type TestDaemon } from "../harness/test-daemon.ts";
import { createTimeline, type Timeline } from "../harness/timeline.ts";

/**
 * Seven languages, end to end, each the way somebody who speaks it would use this.
 *
 * A daemon of the suite's own, with this plugin's proxy built here and set to one
 * language at a time: the person asks a question aloud in a voice of that language, a
 * test agent on Haiku answers, and the phone's own code plays the answer. Then the
 * answer is listened back — what reached the speaker, through Whisper with the
 * language left for it to detect — because a timeline cannot say which language the
 * speaker actually spoke. Then a sentence is dictated.
 *
 * The agent works in a folder whose Claude profile has no personal instructions: one
 * that says "answer in Russian" would answer every one of these in Russian, and the
 * suite would be measuring that rather than this plugin. See docs/e2e.md.
 *
 * The audio goes as PCM: compression is another suite's business, and raw samples can
 * be listened back without a decoder.
 */

type Case = {
  locale: string;
  question: string;
  /** What the daemon's recogniser must have caught of the question. */
  heard: RegExp;
  /** The answer's key word, in the language. */
  answer: RegExp;
  dictation: string;
};

const CASES: Case[] = [
  {
    locale: "en-US",
    question: "What colour is the sky on a clear day? Answer in one short sentence.",
    heard: /sky/i,
    answer: /blue/i,
    dictation: "Please open the settings page and check the latest logs.",
  },
  {
    locale: "es-ES",
    question: "¿De qué color es el cielo en un día despejado? Responde con una frase corta.",
    heard: /cielo/i,
    answer: /azul/i,
    dictation: "Por favor, abre la página de ajustes y revisa los últimos registros.",
  },
  {
    locale: "fr-FR",
    question: "De quelle couleur est le ciel par temps clair ? Réponds en une phrase courte.",
    heard: /ciel/i,
    answer: /bleu/i,
    dictation: "S'il te plaît, ouvre la page des réglages et vérifie les derniers journaux.",
  },
  {
    locale: "pt-BR",
    question: "De que cor é o céu num dia limpo? Responda com uma frase curta.",
    heard: /c[ée]u/i,
    answer: /azul/i,
    dictation: "Por favor, abra a página de configurações e verifique os últimos registros.",
  },
  {
    locale: "de-DE",
    question: "Welche Farbe hat der Himmel an einem klaren Tag? Antworte mit einem kurzen Satz.",
    heard: /himmel/i,
    answer: /blau/i,
    dictation: "Bitte öffne die Einstellungsseite und prüfe die neuesten Protokolle.",
  },
  {
    locale: "ru-RU",
    question: "Какого цвета небо в ясный день? Ответь одним коротким предложением.",
    heard: /неб/i,
    answer: /голуб|син/i,
    dictation: "Пожалуйста, открой страницу настроек и проверь последние логи.",
  },
  {
    locale: "uk-UA",
    question: "Якого кольору небо в ясний день? Відповідай одним коротким реченням.",
    heard: /неб/i,
    answer: /блакит|синє|синій|синього/i,
    dictation: "Будь ласка, відкрий сторінку налаштувань і перевір останні логи.",
  },
];

/** The agent answers in Orus; the person asks in another voice, as a person would. */
const PERSON = "Chirp3-HD-Aoede";
const AGENT = "Chirp3-HD-Orus";

/** The local engine's speaker for these: a native English one reads the others best. */
const LOCAL_SPEAKER = "ryan";

/** Words of three letters or more, without case or punctuation. */
const wordsOf = (text: string): string[] =>
  text
    .toLowerCase()
    .split(/[^\p{L}\p{N}']+/u)
    .filter((word) => [...word].length >= 3);

/** How much of what was said came back as said: the share of its words found. */
function overlap(said: string, heard: string): number {
  const got = new Set(wordsOf(heard));
  const want = wordsOf(said);
  return want.filter((word) => got.has(word)).length / Math.max(1, want.length);
}

let key = "";
let daemon: TestDaemon;
let listener: Listener;
let proxy: SpeechProxy;
let engine: Engine;
/** What the proxy speaks and hears, switched per block. */
let speechLocale = "en-US";
let provider: "google" | "local" = "google";

before(async () => {
  key = await readKey();
  assert.ok(key, "no Google key in ~/.paseo-voice: the voices of this suite are Google's");
  listener = await startListener();
  engine = createEngine({ port: 8134, idleMs: 0 });
  proxy = createProxy({
    port: 0,
    engine,
    choice: () => ({
      provider,
      voice: provider === "google" ? `${speechLocale}-${AGENT}` : LOCAL_SPEAKER,
      model: "1.7b-customvoice",
      speechLocale,
      rate: 1,
      steady: true,
      cue: "lobby-time",
      cueVolume: 1,
      phoneSafe: false,
      dictionary: "",
      googleKey: key,
      pronunciations: [],
    }),
    recogniser: () => ({ port: listener.port, running: true }),
  });
  await proxy.start();
  const url = `http://127.0.0.1:${proxy.port}/v1`;
  daemon = await startTestDaemon({
    speechUrl: url,
    dictationUrl: url,
    // What a new install appends, rather than whatever the real daemon carries.
    prompt: DEFAULT_PROMPT,
    env: { PASEO_VOICE_TTS_FORMAT: "pcm" },
  });
});

after(async () => {
  await daemon?.stop();
  await proxy?.stop();
  engine?.stop();
  listener?.stop();
});

type Conversation = {
  timeline: Timeline;
  ended: string;
  transcript: string;
  spoken: string;
  unconfirmed: string[];
  heardAfterTheEnd: number;
  back: { language: string; text: string };
};

async function converse(one: Case): Promise<Conversation> {
  speechLocale = one.locale;
  const timeline = createTimeline();
  const session = await openLiveSession({ timeline, daemon });
  try {
    await session.say(one.question, { voice: `${one.locale}-${PERSON}` });
    const ended = await session.turnEnd(120_000);
    const endedAt = timeline.now();
    // Listening on past the end, where a cue that should be gone would be.
    await sleep(4000);
    const confirmed = new Set(timeline.moments.filter((m) => m.what === "phone.confirms").map((m) => m.detail));
    const pcm = Buffer.concat(session.received.filter((r) => r.format === "pcm").map((r) => r.audio));
    return {
      timeline,
      ended,
      transcript: timeline.moments.find((m) => m.what === "phone.transcript")?.detail ?? "",
      spoken: session.spoken.join(" "),
      unconfirmed: session.audioIds.filter((id) => !confirmed.has(id)),
      heardAfterTheEnd: timeline.heardAfter(endedAt + 1000).length,
      back: pcm.length > 0 ? await listener.hear(pcm) : { language: "", text: "" },
    };
  } finally {
    await session.close();
  }
}

for (const one of CASES) {
  const language = speechLanguageOf(one.locale).id;

  describe(`spoken to in ${one.locale}`, { timeout: 300_000 }, () => {
    let run: Conversation;
    before(async () => {
      provider = "google";
      run = await converse(one);
    });
    after(() => {
      console.log(`\n--- ${one.locale} ---\nheard back (${run?.back.language}): ${run?.back.text}\n${run?.timeline.render()}\n`);
    });

    test("the daemon hears the question", () => {
      assert.match(run.transcript, one.heard, run.timeline.render());
    });

    test("the agent answers, aloud, in the language it was asked in", () => {
      assert.equal(run.ended, "turn_completed", run.timeline.render());
      assert.match(run.spoken, one.answer, run.timeline.render());
    });

    test("every sentence of the answer plays to the end, then silence", () => {
      assert.deepEqual(run.unconfirmed, [], run.timeline.render());
      assert.equal(run.heardAfterTheEnd, 0, run.timeline.render());
    });

    test("listened back, the speaker spoke that language", () => {
      assert.equal(run.back.language, language, `heard back: ${run.back.text}`);
      assert.match(run.back.text, one.answer, `heard back: ${run.back.text}`);
    });

  });
}

/** Dictation needs no agent: the phone's sender, the daemon, this proxy and Whisper. */
for (const one of CASES) {
  test(`dictated in ${one.locale}, it comes back as said`, { timeout: 120_000 }, async () => {
    speechLocale = one.locale;
    const dictation = await openDictation({ timeline: createTimeline(), daemon });
    try {
      const { transcript } = await dictation.dictate(one.dictation, { voice: `${one.locale}-${PERSON}` });
      const share = overlap(one.dictation, transcript);
      console.log(`dictated in ${one.locale}: «${transcript}» (${Math.round(share * 100)}%)`);
      assert.ok(share >= 0.7, `${Math.round(share * 100)}% of the words: «${transcript}»`);
    } finally {
      await dictation.close();
    }
  });
}

describe("the local engine", { timeout: 600_000 }, () => {
  const speak = (text: string) =>
    fetch(`http://127.0.0.1:${proxy.port}/v1/audio/speech`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ model: "tts-1", voice: "alloy", input: text, response_format: "pcm" }),
    });

  for (const one of CASES) {
    const language = speechLanguageOf(one.locale);
    if (!language.engine) {
      continue;
    }
    test(`speaks ${one.locale}, as Whisper hears it`, async () => {
      provider = "local";
      speechLocale = one.locale;
      const reply = await speak(language.probe);
      assert.equal(reply.status, 200, await reply.clone().text());
      const back = await listener.hear(Buffer.from(await reply.arrayBuffer()));
      assert.equal(back.language, language.id, `heard back: ${back.text}`);
    });
  }

  test("refuses Ukrainian and says so, rather than reading it with another language's sounds", async () => {
    provider = "local";
    speechLocale = "uk-UA";
    const reply = await speak(speechLanguageOf("uk-UA").probe);
    assert.equal(reply.status, 503);
    assert.match(await reply.text(), /Ukrainian/);
  });
});
