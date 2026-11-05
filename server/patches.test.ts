import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, utimes, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { pathToFileURL } from "node:url";
import { type Archive, locate, readArchive, readEntry } from "./asar.server.ts";
import {
  asarIntegrityOn,
  chooseFile,
  fingerprintOf,
  fit,
  judge,
  MARKER,
  patchSource,
  REPLY_FORMAT_HEADER,
  TARGETS,
} from "./patches.server.ts";

/** The shape of the two functions this corrects, as Paseo 0.10.2 compiles them. */
const splicesOf = (id: string) => TARGETS.find((target) => target.id === id)!.splices;
const TTS = splicesOf("drain");
const LISTEN = splicesOf("listen");

const ORIGINAL = `const MAX_TTS_SEGMENT_CHARS = 260;
function splitTextForTts(text) {
    const normalized = text.trim().replace(/\\s+/g, " ");
    const sentences = normalized.split(/(?<=[.!?])\\s+/);
    const parts = [];
    let segmentIndex = 0;
    for (const sentence of sentences) {
        const fragments = splitOversizedFragment(sentence, MAX_TTS_SEGMENT_CHARS);
        for (const fragment of fragments) {
            parts.push({ index: segmentIndex, text: fragment });
            segmentIndex += 1;
        }
    }
    return parts;
}
class TTSManager {
    async synthesizeSegment(segment, abortSignal) {
        const { stream, format } = await tts.synthesizeSpeech(segment.text);
        if (abortSignal.aborted) {
            this.destroySpeechStream(stream);
            throw new Error("TTS synthesis aborted");
        }
        return {
            ...segment,
            stream,
            format,
        };
    }
}
//# sourceMappingURL=tts-manager.js.map
`;

test("both corrections land, and the file says who made them", () => {
  const outcome = patchSource(ORIGINAL, TTS);
  assert.equal(outcome.ok, true);
  const text = outcome.ok ? outcome.text : "";
  assert.ok(text.includes(MARKER), "a patched file has to be recognisable");
  // The body is drained where it arrives, which is the whole point of the first fix.
  assert.ok(text.includes("for await (const chunk of stream)"));
  assert.ok(text.includes("Buffer.concat(collected)"));
  // And sentences are grouped before being handed out.
  assert.ok(text.includes("for (const sentence of grouped) {"));
  assert.ok(!text.includes("for (const sentence of sentences) {"));
});

test("the stale source map reference is dropped, not left lying", () => {
  const outcome = patchSource(ORIGINAL, TTS);
  assert.equal(outcome.ok && outcome.text.includes("sourceMappingURL"), false);
});

test("patching twice is refused rather than doubled", () => {
  const once = patchSource(ORIGINAL, TTS);
  assert.equal(once.ok, true);
  const twice = patchSource(once.ok ? once.text : "", TTS);
  assert.deepEqual(twice, { ok: false, reason: "already-patched" });
});

test("an unfamiliar Paseo is refused, not guessed at", () => {
  const rewritten = ORIGINAL.replace("for (const sentence of sentences) {", "for (const s of sentences) {");
  assert.deepEqual(patchSource(rewritten, TTS), { ok: false, reason: "unknown-version" });
});

test("an anchor that occurs twice is also a refusal", () => {
  // Two identical returns would make the splice ambiguous, and a wrong splice is worse
  // than no patch at all.
  const doubled = ORIGINAL.replace(
    "class TTSManager {",
    "function other() {\n        return {\n            ...segment,\n            stream,\n            format,\n        };\n}\nclass TTSManager {",
  );
  assert.deepEqual(patchSource(doubled, TTS), { ok: false, reason: "unknown-version" });
});

test("padding is whitespace, and the source above it is untouched", () => {
  const outcome = patchSource(ORIGINAL, TTS);
  const text = outcome.ok ? outcome.text : "";
  const fitted = fit(text, Buffer.byteLength(text) + 500) ?? "";
  assert.equal(fitted.slice(0, text.length), text, "the source must be untouched");
  assert.equal(fitted.slice(text.length).trim(), "", "and the rest must be blank");
});

test("squeezing gives up indentation and nothing else", () => {
  const roomy = ORIGINAL.split("\n").map((line) => `${" ".repeat(24)}${line}`).join("\n");
  const fitted = fit(roomy, Buffer.byteLength(roomy) - 600) ?? "";
  // Same code, same order, only the leading whitespace is shorter.
  const bare = (value: string) => value.split("\n").map((line) => line.trim()).filter(Boolean).join("\n");
  assert.equal(bare(fitted), bare(roomy));
  assert.equal(Buffer.byteLength(fitted), Buffer.byteLength(roomy) - 600);
});

test("a target too small to hold the patch is refused", () => {
  const outcome = patchSource(ORIGINAL, TTS);
  assert.equal(fit(outcome.ok ? outcome.text : "", 10), null);
});

const sha256 = (text: string) => createHash("sha256").update(text, "utf8").digest("hex");
/** Room to spare, so these are about the decision rather than about squeezing. */
const sized = (text: string) => ({ text, size: Buffer.byteLength(text) + 2000 });
/** The drain correction, as if reviewed against exactly the file above. */
const REVIEWED = { ...TARGETS.find((target) => target.id === "drain")!, verified: [sha256(ORIGINAL)] };

test("a file the correction was reviewed against is written without asking", () => {
  assert.equal(judge(REVIEWED, sized(ORIGINAL), true).kind, "write");
});

test("a changed file is left alone even when every anchor still fits", () => {
  // What the hash is for: no anchor mentions this constant, but the grouping the
  // correction inserts does — this would land, then throw on every sentence.
  const renamed = ORIGINAL.replaceAll("MAX_TTS_SEGMENT_CHARS", "MAX_SEGMENT_CHARS");
  assert.deepEqual(judge(REVIEWED, sized(renamed), true), {
    kind: "unverified",
    sha: sha256(renamed),
    anchorsFit: true,
  });
  // The person at the button is trusted with the same file; the hash is the automatic run's check.
  assert.equal(judge(REVIEWED, sized(renamed), false).kind, "write");
});

test("a changed file whose anchors are gone is reported as one to rewrite", () => {
  const rewritten = ORIGINAL.replace("for (const sentence of sentences) {", "for (const s of sentences) {");
  assert.deepEqual(judge(REVIEWED, sized(rewritten), true), {
    kind: "unverified",
    sha: sha256(rewritten),
    anchorsFit: false,
  });
});

/** The file as `judge` would write it, with the size of the entry it went into. */
function written(target: typeof REVIEWED, original: string) {
  const verdict = judge(target, sized(original), true);
  assert.equal(verdict.kind, "write");
  return { text: verdict.kind === "write" ? verdict.text : "", size: sized(original).size };
}

test("a correction already in place is left as it is", () => {
  assert.deepEqual(judge(REVIEWED, written(REVIEWED, ORIGINAL), true, ORIGINAL), { kind: "in-place" });
});

test("an earlier version of a correction is made again from the original kept beside it", () => {
  // What a plugin update that changes a correction looks like from here: the marker is
  // there, but what is under it is not what the correction makes now.
  const earlier = { ...REVIEWED, splices: REVIEWED.splices.slice(0, 1) };
  const verdict = judge(REVIEWED, written(earlier, ORIGINAL), true, ORIGINAL);
  assert.equal(verdict.kind, "write");
  assert.ok(verdict.kind === "write" && verdict.text.includes("for (const sentence of grouped) {"), "the new version, whole");
  assert.equal(verdict.kind === "write" && verdict.original, ORIGINAL, "and the original stays the one to revert to");
});

test("an earlier version on a file nobody reviewed is still not rewritten by itself", () => {
  const earlier = { ...REVIEWED, splices: REVIEWED.splices.slice(0, 1) };
  const unreviewed = { ...REVIEWED, verified: ["0".repeat(64)] };
  assert.equal(judge(unreviewed, written(earlier, ORIGINAL), true, ORIGINAL).kind, "unverified");
});

test("a patched file with nothing kept beside it is refused rather than taken for current", () => {
  assert.equal(judge(REVIEWED, written(REVIEWED, ORIGINAL), true).kind, "refused");
});

/**
 * Against the Paseo installed on this machine, when there is one. Its files have to be
 * ones the corrections were reviewed against, or the automatic run will leave them out
 * after an update — and this is the quickest place to find that out. A file already
 * carrying the correction is judged by the original kept beside it.
 */
const INSTALLED = "/Applications/Paseo.app/Contents/Resources/app.asar";

for (const target of TARGETS.filter((one) => one.kind === "asar")) {
  test(`правка «${target.title}» проверена на файле установленного Paseo`, async (t) => {
    let archive: Archive;
    try {
      archive = await readArchive(INSTALLED);
    } catch {
      t.skip("Paseo не установлен");
      return;
    }
    const entry = locate(archive, target.entry);
    assert.ok(entry, `в архиве нет ${target.entry}`);
    const name = target.entry.split("/").pop() ?? target.id;
    let source = (await readEntry(archive.path, entry)).toString("utf8");
    if (source.includes(MARKER)) {
      try {
        source = await readFile(path.join(homedir(), ".paseo-voice", "patches", `${name}.original`), "utf8");
      } catch {
        t.skip(`правка наложена, а оригинала ${name} рядом нет`);
        return;
      }
    }
    const verdict = judge(target, { text: source, size: Buffer.byteLength(source) }, true);
    assert.equal(
      verdict.kind,
      "write",
      `Paseo изменил ${name}: сравни с оригиналом, поправь правку и добавь в verified ${sha256(source)}`,
    );
    // The daemon imports these as modules when it starts: one that does not parse is a
    // daemon that does not start.
    const dir = await mkdtemp(path.join(tmpdir(), "voice-check-"));
    try {
      const file = path.join(dir, `${target.id}.mjs`);
      await writeFile(file, verdict.kind === "write" ? verdict.text : "");
      execFileSync(process.execPath, ["--check", file], { stdio: "pipe" });
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
}

/** The lines of `voice-turn-controller.js` the voice input correction is anchored on. */
const VTC = `
    const detector = params.turnDetection.createSession({
        logger: params.logger.child({ component: "turn-detection" }),
    });
    let state = { status: "idle" };
    let currentFinalizingTurn = null;
    async function handleSpeechStarted() {
        params.logger.info({
            utteranceId: state.utteranceId,
        }, "voice_turn.speech_started");
    }
    detector.on("speech_started", () => {
        void runSerial(handleSpeechStarted);
    });
    detector.on("speech_stopped", () => {
        void runSerial(handleSpeechStopped);
    });
    detector.on("error", fail);
    async function start() {
            await detector.connect();
    }
    async function stop() {
                detector.close();
    }
    async function append(input) {
                const pcm16 = Buffer.from(input.audioBase64, "base64");
                if (sttPcm16 && sttPcm16.length > 0) {
                    try {
                        currentSttSession?.appendPcm16(sttPcm16);
                    }
    }
`;

test("the mute part adds the watchdog, the flush and the chunk timestamp", () => {
  const outcome = patchSource(VTC, LISTEN);
  assert.equal(outcome.ok, true);
  const text = outcome.ok ? outcome.text : "";
  assert.ok(text.includes("voice_turn.client_audio_stalled"), "сторож обязан логировать, когда сработал");
  assert.ok(text.includes("detector.flush()"), "и звать flush, который в демоне не зовёт никто");
  assert.ok(text.includes("startStallWatch();"), "запускаться вместе с детектором");
  assert.ok(text.includes("stopStallWatch();"), "и останавливаться вместе с ним");
  assert.ok(text.includes("lastChunkAt = Date.now();"), "и видеть каждый приходящий кусок звука");
});

test("between phrases the recogniser gets nothing but the moments before the next one", () => {
  const outcome = patchSource(VTC, LISTEN);
  const text = outcome.ok ? outcome.text : "";
  assert.ok(
    text.includes(`if (sttPcm16 && sttPcm16.length > 0 && state.status !== "capturing") {`) &&
      text.includes("keepPreroll(sttPcm16, currentSttSession.requiredSampleRate);"),
    "звук между фразами обязан оседать в коротком буфере, а не в распознавателе",
  );
  // Handed over where the phrase is confirmed, after the line that logs it.
  const confirmed = text.indexOf(`"voice_turn.speech_started");`);
  const handed = text.indexOf("sttSession.appendPcm16(before);");
  assert.ok(confirmed !== -1 && handed > confirmed, "а начало фразы — уходить в распознаватель, как только она подтверждена");
});

test("a detector that dies with the speech worker is replaced", () => {
  const outcome = patchSource(VTC, LISTEN);
  const text = outcome.ok ? outcome.text : "";
  assert.ok(text.includes("let detector = params.turnDetection.createSession({"), "детектор обязан быть заменяемым");
  assert.ok(!text.includes(`detector.on("error", fail);`), "ошибку детектора больше нельзя просто логировать");
  assert.ok(text.includes("watchDetector(detector);") && text.includes("watchDetector(next);"), text);
  assert.ok(text.includes("voice_turn.detector_reconnected"), "и замена обязана быть видна в логе");
  // A phrase the dead detector was in the middle of has no end coming.
  assert.ok(text.includes(`if (state.status === "capturing")\n                        await handleSpeechStopped();`), text);
});

test("an empty turn of the person's lifts the abort it started", () => {
  const session = [
    "    clearSpeechInProgress(reason) {",
    "        if (!this.speechInProgress) {",
    "            return;",
    "        }",
    "        this.speechInProgress = false;",
    "        this.sessionLogger.debug({ reason }, `Speech turn complete (${reason}) – resuming TTS`);",
    "    }",
  ].join("\n");
  const outcome = patchSource(session, ABORT);
  assert.equal(outcome.ok, true);
  const text = outcome.ok ? outcome.text : "";
  assert.ok(text.includes("if (this.abortController.signal.aborted) {\n            this.createAbortController();"), text);
});

/** The session correction, split back into its two parts. */
const SESSION = splicesOf("session");
const ABORT = SESSION.slice(0, 1);
const OPUS = SESSION.slice(1);

test("Opus from the phone is decoded before the turn controller sees it", () => {
  const session = [
    'import { toResolver } from "../../speech/provider-resolver.js";',
    "    async stopVoiceTurnController() {",
    "        if (!this.voiceTurnController) {",
    "            return;",
    "        }",
    "    }",
    "    async forwardAudioChunkToVoiceTurn(msg, chunkFormat) {",
    "        await this.voiceTurnController.appendClientChunk({",
    "            audioBase64: msg.audio,",
    "            format: chunkFormat,",
    "        });",
    "    }",
  ].join("\n");
  const outcome = patchSource(session, OPUS);
  assert.equal(outcome.ok, true);
  const text = outcome.ok ? outcome.text : "";
  assert.ok(text.includes('chunkFormat.startsWith("audio/opus")'), "Opus is told apart by its format");
  assert.ok(text.includes('format = "audio/pcm;rate=16000;bits=16"'), "and handed on as 16 kHz PCM");
  assert.ok(text.includes(".paseo-voice/codec/opus.mjs"), "by the decoder the plugin keeps");
  assert.ok(text.includes("decodeOpusChunk(this, msg.audio)"), "which does the decoding, not the correction");
  assert.ok(text.includes("codec.freeOpus(this)"), "and which a stopped voice session lets go of");
});

test("dictation decodes Opus the same way, once per chunk, before the stream sees it", () => {
  const manager = [
    'import { parsePcmRateFromFormat, pcm16lePeakAbs } from "../speech/audio.js";',
    "    async handleChunk(params) {",
    "        if (params.format !== state.inputFormat) {",
    "        }",
    "    }",
    "    cleanupDictationStream(dictationId) {",
    "        this.streams.delete(dictationId);",
    "    }",
  ].join("\n");
  const outcome = patchSource(manager, splicesOf("dictation"));
  assert.equal(outcome.ok, true);
  const text = outcome.ok ? outcome.text : "";
  assert.ok(text.includes("decodeOpusChunk(state, params.audioBase64)"), "the shared decoder, one per dictation");
  assert.ok(text.includes("!state.receivedChunks.has(params.seq)"), "and a chunk that arrives twice is decoded once");
  assert.ok(text.includes("params = { ...params, audioBase64, format: state.inputFormat };"), "then it is the stream's own PCM");
  assert.ok(text.includes("codec.freeOpus(state)"), "and the decoder goes with the stream");
});

/** The speaking site's config, as Paseo 0.14 compiles it. */
const TTS_CONFIG = `function resolveTts(site, env) {
    const config = site?.provider === "openai" ? site : undefined;
    const apiKey = firstString(config?.apiKey, env.OPENAI_TTS_API_KEY, env.OPENAI_API_KEY);
    if (!apiKey)
        return undefined;
    const baseUrl = firstString(config?.baseUrl, env.OPENAI_TTS_BASE_URL, env.OPENAI_BASE_URL);
    return {
        apiKey,
        ...(baseUrl ? { baseUrl } : {}),
        model: firstString(env.TTS_MODEL, config?.model) ?? DEFAULT_OPENAI_TTS_MODEL,
        voice: firstString(env.TTS_VOICE, config?.voice) ?? "alloy",
        responseFormat: "pcm",
    };
}
`;

test("the agent's voice is asked for as MP3, and PCM stays one variable away", () => {
  const outcome = patchSource(TTS_CONFIG, splicesOf("format"));
  assert.equal(outcome.ok, true);
  const text = outcome.ok ? outcome.text : "";
  assert.ok(text.includes('responseFormat: process.env.PASEO_VOICE_TTS_FORMAT || "mp3",'));
  assert.ok(!text.includes('responseFormat: "pcm"'), "the hard-coded PCM is gone");
  assert.ok(text.includes('voice: firstString(env.TTS_VOICE, config?.voice) ?? "alloy",'), "and nothing around it moved");
});

/** The daemon's speech client, cut down to the lines the reply correction is anchored on. */
const SPEECH_CLIENT = `export class OpenAITTS {
    constructor(openaiClient) {
        this.config = { model: "tts-1", voice: "alloy", responseFormat: "mp3" };
        this.openaiClient = openaiClient;
    }
    async synthesizeSpeech(text) {
        try {
            const response = await this.openaiClient.audio.speech.create({
                model: this.config.model,
                voice: this.config.voice,
                input: text,
                response_format: this.config.responseFormat,
            });
            const audioStream = response.body;
            return {
                stream: audioStream,
                format: this.config.responseFormat || "mp3",
            };
        }
        catch (error) {
            throw error;
        }
    }
}
`;

type Asked = { body: Record<string, unknown>; options?: { headers?: Record<string, string> } };
type SpeechClient = new (client: unknown) => { synthesizeSpeech(text: string): Promise<{ format: string }> };

test("a sentence is labelled by what came back, and the daemon tells the proxy so", async () => {
  const outcome = patchSource(SPEECH_CLIENT, splicesOf("reply"));
  assert.equal(outcome.ok, true);
  const dir = await mkdtemp(path.join(tmpdir(), "voice-reply-"));
  try {
    const file = path.join(dir, "tts.mjs");
    await writeFile(file, outcome.ok ? outcome.text : "");
    const { OpenAITTS } = (await import(pathToFileURL(file).href)) as { OpenAITTS: SpeechClient };
    const asked: Asked[] = [];
    // The OpenAI SDK hands back the fetch response itself for audio.
    const answering = (contentType: string) =>
      new OpenAITTS({
        audio: {
          speech: {
            create: async (body: Asked["body"], options?: Asked["options"]) => {
              asked.push({ body, options });
              return { body: "audio", headers: new Headers({ "content-type": contentType }) };
            },
          },
        },
      });
    assert.equal((await answering("audio/pcm").synthesizeSpeech("Привет.")).format, "pcm", "PCM from the proxy goes as PCM");
    assert.equal((await answering("audio/mpeg").synthesizeSpeech("Привет.")).format, "mp3", "and MP3 as MP3");
    assert.equal(asked[0]?.options?.headers?.[REPLY_FORMAT_HEADER], "from-response");
    // A real OpenAI endpoint refuses parameters it does not know, so the body stays upstream's.
    assert.deepEqual(Object.keys(asked[0]?.body ?? {}), ["model", "voice", "input", "response_format"]);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

/** The daemon's push service, whole, as Paseo 0.15.2 compiles it. */
const PUSH_SERVICE = `const EXPO_PUSH_URL = "https://exp.host/--/api/v2/push/send";
const MAX_BATCH_SIZE = 100;
/**
 * Service for sending Expo push notifications.
 * Handles batching and invalid token removal.
 */
export class PushService {
    constructor(logger, revokeToken) {
        this.logger = logger.child({ component: "push-service" });
        this.revokeToken = revokeToken;
    }
    async sendPush(tokens, payload) {
        if (tokens.length === 0) {
            return;
        }
        const messages = tokens.map((token) => ({
            to: token,
            title: payload.title,
            body: payload.body,
            data: payload.data,
            sound: "default",
        }));
        // Batch tokens (max 100 per request per Expo limits)
        const batches = [];
        for (let i = 0; i < messages.length; i += MAX_BATCH_SIZE) {
            batches.push(messages.slice(i, i + MAX_BATCH_SIZE));
        }
        await Promise.all(batches.map((batch) => this.sendBatch(batch)));
    }
    async sendBatch(messages) {
        try {
            const response = await fetch(EXPO_PUSH_URL, {
                method: "POST",
                headers: {
                    "Content-Type": "application/json",
                    Accept: "application/json",
                },
                body: JSON.stringify(messages),
            });
            if (!response.ok) {
                this.logger.error({ status: response.status, statusText: response.statusText }, "Expo push API error");
                return;
            }
            const result = (await response.json());
            this.handleTickets(messages, result.data);
        }
        catch (error) {
            this.logger.error({ err: error }, "Failed to send push notifications");
        }
    }
    handleTickets(messages, tickets) {
        for (let i = 0; i < tickets.length; i++) {
            const ticket = tickets[i];
            const message = messages[i];
            if (ticket.status === "error") {
                this.logger.error({ token: message.to, message: ticket.message, details: ticket.details }, "Push failed for token");
                // Remove invalid tokens
                if (ticket.details?.error === "DeviceNotRegistered" ||
                    ticket.details?.error === "InvalidCredentials") {
                    this.revokeToken(message.to);
                }
            }
        }
    }
}
//# sourceMappingURL=push-service.js.map`;

type Pushed = { to: string }[];
type PushServiceClass = new (
  logger: unknown,
  revoke: (token: string) => void,
) => { sendPush(tokens: string[], payload: { title: string; body: string }): Promise<void> };

const PHONE = `apns:development:sh.paseo.debug.team:${"a1".repeat(32)}`;
const EXPO = "ExponentPushToken[xxxxxxxxxxxxxxxxxxxxxx]";

/**
 * Runs the corrected push service as the daemon would, with HOME pointing at a folder
 * that holds the given sender (or none), and Expo answered on the spot. Says what the
 * sender was handed, what went to Expo, and what was logged.
 */
async function pushThrough(tokens: string[], sender: string | null) {
  const outcome = patchSource(PUSH_SERVICE, splicesOf("push"));
  assert.equal(outcome.ok, true);
  const fitted = fit(outcome.ok ? outcome.text : "", Buffer.byteLength(PUSH_SERVICE));
  assert.ok(fitted, "the correction fits into the file it replaces");
  const dir = await mkdtemp(path.join(tmpdir(), "voice-push-service-"));
  const home = path.join(dir, "home");
  const file = path.join(dir, "push-service.mjs");
  const [savedHome, savedFetch] = [process.env.HOME, globalThis.fetch];
  const toExpo: Pushed[] = [];
  const errors: string[] = [];
  const logger = { child: () => logger, info: () => {}, error: (_: unknown, text: string) => errors.push(text) };
  try {
    await writeFile(file, fitted ?? "");
    if (sender !== null) {
      await mkdir(path.join(home, ".paseo-voice", "push"), { recursive: true });
      await writeFile(path.join(home, ".paseo-voice", "push", "apns.mjs"), sender);
    }
    process.env.HOME = home;
    globalThis.fetch = (async (_url: string, init: { body: string }) => {
      const messages = JSON.parse(init.body) as Pushed;
      toExpo.push(messages);
      return new Response(JSON.stringify({ data: messages.map(() => ({ status: "ok" })) }));
    }) as typeof fetch;
    const { PushService } = (await import(pathToFileURL(file).href)) as { PushService: PushServiceClass };
    await new PushService(logger, () => {}).sendPush(tokens, { title: "Agent finished", body: "Open the agent" });
    const handed = (globalThis as { paseoVoiceRouted?: string[] }).paseoVoiceRouted ?? null;
    return { handed, toExpo: toExpo.flat().map((message) => message.to), errors };
  } finally {
    process.env.HOME = savedHome;
    globalThis.fetch = savedFetch;
    delete (globalThis as { paseoVoiceRouted?: string[] }).paseoVoiceRouted;
    await rm(dir, { recursive: true, force: true });
  }
}

/** Stands in for the sender this plugin writes: notes what it was given, sends nothing. */
const STUB_SENDER = `export async function route(tokens, payload, service) {
  globalThis.paseoVoiceRouted = tokens;
  if (!service.logger || !service.revokeToken) throw new Error("the service was not handed over");
  return tokens.filter((token) => !token.startsWith("apns:"));
}
`;

test("a phone this plugin built gets its push from Apple, and every other token still goes to Expo", async () => {
  const { handed, toExpo, errors } = await pushThrough([PHONE, EXPO], STUB_SENDER);
  assert.deepEqual(handed, [PHONE, EXPO], "the sender sees every token and picks its own");
  assert.deepEqual(toExpo, [EXPO], "Expo gets only what it can deliver");
  assert.deepEqual(errors, []);
});

test("with no phone of this plugin's among the tokens the sender is not even loaded", async () => {
  const { handed, toExpo } = await pushThrough([EXPO], STUB_SENDER);
  assert.equal(handed, null);
  assert.deepEqual(toExpo, [EXPO]);
});

test("a sender that is not there is logged, and the phone's token is still kept away from Expo", async () => {
  const { toExpo, errors } = await pushThrough([PHONE, EXPO], null);
  assert.deepEqual(toExpo, [EXPO]);
  assert.deepEqual(errors, ["paseo-voice: the APNs sender did not load"]);
});

test("of several bundles under one name the one the page loads is the one patched", () => {
  const main = "index-70b2addcd0a87f9862ada37a54e1c5f5.js";
  const chunk = "index-25b6f4047ab2ce7c0c005067298ad2bc.js";
  const page = `<script src="/_expo/static/js/web/${main}" defer></script>`;
  assert.equal(chooseFile([chunk, main], page), main, "not the scanner chunk that sorts first");
  assert.equal(chooseFile([main], ""), main, "one is it, page or no page");
  assert.equal(chooseFile([chunk, main], "<html></html>"), "", "a page that names none settles nothing");
  assert.equal(chooseFile([chunk, main], `${page}<script src="${chunk}"></script>`), "", "nor one that names both");
  assert.equal(chooseFile([], page), "");
});

/** The source Paseo plays the cue from, as Metro minifies it. */
const BUNDLE =
  `C=Uint8Array.from(Buffer.from(s.THINKING_TONE_NATIVE_PCM_BASE64,"base64")),` +
  `T={size:C.byteLength,type:"audio/pcm;rate=16000;bits=16",` +
  `arrayBuffer:async()=>C.buffer.slice(C.byteOffset,C.byteOffset+C.byteLength)};` +
  `const zz=600,u=350,p=1500,q=7;`;

test("the cue correction makes the desktop ask the plugin for the sound", () => {
  const outcome = patchSource(BUNDLE, splicesOf("cue"));

  assert.equal(outcome.ok, true);
  const text = outcome.ok ? outcome.text : "";
  assert.ok(text.includes("/v1/cue"), "звук обязан запрашиваться у плагина");
  // Without a fallback a stopped plugin would mean silence instead of Paseo's own tone.
  assert.ok(text.includes("return C.buffer.slice(C.byteOffset,C.byteOffset+C.byteLength)"), text.slice(0, 300));
  assert.ok(text.includes(MARKER), "патч обязан быть узнаваемым");
  assert.ok(text.includes("u=0,p=250"), "и пауза перед первым проигрыванием");
  assert.ok(text.includes("zz=600"), "соседние числа трогать нельзя");
});

test("an ambiguous shape is refused rather than guessed at", () => {
  const twice = `x=350,y=1500 ... a=350,b=1500`;
  assert.deepEqual(patchSource(twice, splicesOf("cue")), { ok: false, reason: "unknown-version" });
});

test("the bundle has no hash to check, so its shape and a clean parse decide", () => {
  assert.equal(judge(TARGETS.find((one) => one.id === "cue")!, sized(BUNDLE), true).kind, "write");
});

test("a bundle that would not parse is never written", () => {
  const verdict = judge(TARGETS.find((one) => one.id === "cue")!, sized(`${BUNDLE}}{`), true);
  assert.equal(verdict.kind, "refused");
});

test("the asar integrity fuse is read off the wire, and only a 1 turns it on", () => {
  const wire = (fuses: string) =>
    Buffer.concat([
      Buffer.from("junk"),
      Buffer.from("dL7pKGdnNz796PbbjQWNKmHXBZaB9tsX"),
      Buffer.from([1, fuses.length]),
      Buffer.from(fuses),
      Buffer.from("tail"),
    ]);
  assert.equal(asarIntegrityOn(wire("101100011")), false, "Paseo 0.11.1 as it ships");
  assert.equal(asarIntegrityOn(wire("101110011")), true);
  assert.equal(asarIntegrityOn(wire("1011r0011")), false, "a removed fuse cannot be on");
  assert.equal(asarIntegrityOn(wire("101")), null, "a wire too short to carry this fuse says nothing");
  assert.equal(asarIntegrityOn(Buffer.from("no sentinel in here")), null);
  // A read that ends inside the wire must not pass for "off".
  assert.equal(asarIntegrityOn(wire("101110011").subarray(0, 4 + 32 + 2 + 3)), null);
});

/**
 * The status is answered from memory unless these say the files moved. Nothing here
 * is about speed: the thing worth proving is that a changed Paseo cannot be missed,
 * and in particular that a patch which deliberately keeps its byte length is still
 * seen — size alone would say nothing.
 */
test("the fingerprint catches an edit that kept the file's size", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "voice-fingerprint-"));
  const file = path.join(dir, "bundle.js");
  try {
    await writeFile(file, "aaaa");
    const before = await fingerprintOf([file]);
    assert.equal(await fingerprintOf([file]), before, "нетронутый файл — тот же отпечаток");

    await writeFile(file, "bbbb");
    // Set explicitly: two writes in the same millisecond would otherwise decide this.
    await utimes(file, new Date(), new Date(Date.now() + 1000));
    const after = await fingerprintOf([file]);
    assert.notEqual(after, before, "та же длина, другое содержимое — другой отпечаток");

    await rm(file);
    const gone = await fingerprintOf([file]);
    assert.notEqual(gone, after);
    assert.match(gone, /absent$/, "пропавший файл назван пропавшим, а не пропущен");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("the fingerprint says which of the files is the missing one", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "voice-fingerprint-"));
  const [one, two] = [path.join(dir, "one"), path.join(dir, "two")];
  try {
    await writeFile(one, "x");
    assert.notEqual(await fingerprintOf([one, two]), await fingerprintOf([two, one]));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
