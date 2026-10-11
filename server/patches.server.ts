import { createHash } from "node:crypto";
import { mkdir, open, readdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";
import vm from "node:vm";
import { type Archive, type Entry, locate, readArchive, readEntry, statOnDisk, writeEntry } from "./asar.server.ts";
import { paths } from "./paths.server.ts";

/**
 * Two corrections to Paseo's own speech manager, written into its archive.
 *
 * The first is a real bug, reproduced in forty lines with no part of this plugin
 * present: the manager asks for a sentence, leaves the reply's body unread until the
 * previous sentence has finished playing, and opens the next request meanwhile. An
 * HTTP client reclaims a finished-but-unread body to get its connection back, so the
 * body arrives empty — and empty is indistinguishable from "this sentence is meant to
 * be silent", so the sentence is dropped without a word in any log. Draining the body
 * at the moment it arrives removes the window entirely.
 *
 * The second is the long gaps. The manager splits on every full stop and never merges,
 * so "Окей, слушай." becomes its own request, its own round trip to the phone, and its
 * own second of silence. Merging up to the limit it already defines turns a seven-part
 * answer into two.
 *
 * Patched in place and byte-for-byte: the replacement is squeezed back into the space
 * the original occupied, so the archive's header stays true and 112 MB need not be
 * rebuilt. Anything else means reproducing the unpacked-file flags by hand.
 */

/** Grepped for to tell a patched file from a clean one. */
export const MARKER = "paseo-voice:";

/** Where the desktop bundle asks for the cue; the plugin's proxy answers there. */
const CUE_PORT = 8123;

/**
 * Either an exact string to swap, or a shape to match. Minified code has no stable
 * identifiers, so a correction there can only be anchored by what it looks like.
 */
type Splice = { find: string; replace: string } | { pattern: RegExp; replace: string };

export type Target = {
  id: string;
  title: string;
  /** What it fixes, in one line, for the panel. */
  note: string;
  /**
   * Inside the archive, or a plain file beside it. The archive demands the replacement
   * keep its exact length; a plain file does not, which is the only difference in how
   * the two are written.
   */
  kind: "asar" | "file";
  /** A path inside the archive, or a glob under the app's resources for a plain file. */
  entry: string;
  splices: readonly Splice[];
  /**
   * The sha256 of every upstream version of the file this correction has been reviewed
   * against. Only an archive target has one: the bundle is renamed and rehashed by every
   * build, so for it the shape is the whole check. The automatic run writes nothing into
   * a file that is not on this list; a person pressing the button still can.
   */
  verified?: readonly string[];
};

const ttsSplices: readonly Splice[] = [
  {
    // Drain the body the moment it exists, rather than holding the stream.
    find: `        return {
            ...segment,
            stream,
            format,
        };`,
    replace: `        // paseo-voice: read the body now, not when this segment's turn to play comes.
        // A finished reply left unread is reclaimed by the HTTP client to free its
        // connection, and what reaches the player is nothing at all.
        const collected = [];
        for await (const chunk of stream) {
            collected.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
        }
        const whole = Buffer.concat(collected);
        return {
            ...segment,
            format,
            stream: { async *[Symbol.asyncIterator]() { if (whole.length > 0) yield whole; } },
        };`,
  },
  {
    // Merge short sentences up to the limit the file already defines.
    find: `    const sentences = normalized.split(/(?<=[.!?])\\s+/);`,
    replace: `    const sentences = normalized.split(/(?<=[.!?])\\s+/);
    // paseo-voice: every extra segment is another round trip to the client and another
    // second of silence between sentences. Group them up to the same limit.
    const grouped = [];
    for (const one of sentences) {
        const last = grouped.length > 0 ? grouped[grouped.length - 1] : null;
        if (last !== null && last.length + 1 + one.length <= MAX_TTS_SEGMENT_CHARS) {
            grouped[grouped.length - 1] = last + " " + one;
        }
        else {
            grouped.push(one);
        }
    }`,
  },
  { find: `    for (const sentence of sentences) {`, replace: `    for (const sentence of grouped) {` },
];

/**
 * Muting stops the client sending audio outright, and the server's voice-activity
 * detector only advances its clock on audio it receives — so the turn never ends and
 * what was said sits there unsent. The detector already has a `flush` that forces the
 * end of a turn; nothing in the daemon ever calls it. A watchdog does, once the stream
 * has been quiet for longer than any jitter could explain.
 */
const muteSplices: readonly Splice[] = [
  {
    find: `    let state = { status: "idle" };`,
    replace: `    let state = { status: "idle" };
    // paseo-voice: a muted client sends nothing at all, and nothing is what the
    // detector needs to notice the turn has ended. Close it by force instead.
    const STALL_MS = 600, STALL_TICK_MS = 150;
    let lastChunkAt = 0, stallTimer = null;
    function stopStallWatch() {
        if (stallTimer) { clearInterval(stallTimer); stallTimer = null; }
    }
    function startStallWatch() {
        stopStallWatch();
        stallTimer = setInterval(() => {
            if (state.status !== "capturing" || lastChunkAt === 0) return;
            if (Date.now() - lastChunkAt < STALL_MS) return;
            lastChunkAt = 0;
            if (typeof detector.flush !== "function") return;
            params.logger.info({ stallMs: STALL_MS }, "voice_turn.client_audio_stalled");
            void runSerial(async () => { detector.flush(); });
        }, STALL_TICK_MS);
        if (typeof stallTimer.unref === "function") stallTimer.unref();
    }`,
  },
  {
    find: `            await detector.connect();`,
    replace: `            await detector.connect();
            startStallWatch();`,
  },
  { find: `                detector.close();`, replace: `                stopStallWatch();
                detector.close();` },
  {
    find: `                const pcm16 = Buffer.from(input.audioBase64, "base64");`,
    replace: `                lastChunkAt = Date.now();
                const pcm16 = Buffer.from(input.audioBase64, "base64");`,
  },
];

/**
 * The recogniser hears phrases, not the room. Upstream hands it every chunk the phone
 * sends while voice mode is on, and the local Parakeet session keeps all of it until a
 * phrase is committed — decoding the whole of it again every 350 ms. Everything between
 * two phrases piles up there: the agent thinking, the agent talking, the person listening.
 * Measured live: after 53 s of that the start of the next phrase was lost, after 85 s the
 * speech worker died (SIGTRAP inside onnxruntime), and the phrase ended empty ten seconds
 * later.
 *
 * Only a phrase goes in now, from the moment the detector confirms it, with the three
 * seconds before. The detector confirms speech after 800 ms of it unbroken, and a short
 * first word with a pause after it — «Так, …», «Слушай, …», «Стоп, хватит» — breaks the
 * count: the phrase is then confirmed only on the word after, over two seconds in, and
 * with two seconds kept «Стоп» was lost (measured live). Three cover it.
 */
const prerollSplices: readonly Splice[] = [
  {
    find: `    let currentFinalizingTurn = null;`,
    replace: `    let currentFinalizingTurn = null;
    // paseo-voice: between phrases the recogniser is given nothing; the last three
    // seconds wait here for the next one.
    const PREROLL_MS = 3000;
    let preroll = [];
    let prerollBytes = 0;
    function keepPreroll(pcm16, sampleRate) {
        preroll.push(pcm16);
        prerollBytes += pcm16.length;
        const limit = (PREROLL_MS * sampleRate * 2) / 1000;
        while (preroll.length > 1 && prerollBytes - preroll[0].length >= limit) {
            prerollBytes -= preroll.shift().length;
        }
    }
    function takePreroll() {
        const taken = preroll.length > 0 ? Buffer.concat(preroll) : null;
        preroll = [];
        prerollBytes = 0;
        return taken;
    }`,
  },
  {
    find: `        params.logger.info({
            utteranceId: state.utteranceId,
        }, "voice_turn.speech_started");`,
    replace: `        params.logger.info({
            utteranceId: state.utteranceId,
        }, "voice_turn.speech_started");
        // paseo-voice: the phrase as it began, before the detector was sure of it.
        const before = takePreroll();
        if (before && sttSession) {
            try {
                sttSession.appendPcm16(before);
            }
            catch (error) {
                handleSttError(error);
            }
        }`,
  },
  {
    find: `                if (sttPcm16 && sttPcm16.length > 0) {
                    try {`,
    replace: `                if (sttPcm16 && sttPcm16.length > 0 && state.status !== "capturing") {
                    keepPreroll(sttPcm16, currentSttSession.requiredSampleRate);
                }
                else if (sttPcm16 && sttPcm16.length > 0) {
                    try {`,
  },
];

/**
 * The voice-activity detector lives in the same speech worker as the recogniser. When the
 * worker dies, the recogniser is reconnected and the detector never is: its session went
 * with the old worker, every chunk after that goes nowhere, and voice mode hears nothing
 * more until it is switched off and on. A new detector takes its place now, and a phrase
 * the old one was in the middle of is closed — the end of that one would never be heard.
 */
const detectorSplices: readonly Splice[] = [
  {
    find: `    const detector = params.turnDetection.createSession({`,
    replace: `    let detector = params.turnDetection.createSession({`,
  },
  {
    find: `    detector.on("speech_started", () => {
        void runSerial(handleSpeechStarted);
    });
    detector.on("speech_stopped", () => {
        void runSerial(handleSpeechStopped);
    });
    detector.on("error", fail);`,
    replace: `    // paseo-voice: a detector that dies with its worker is replaced, not left deaf.
    let detectorRecovering = false;
    function watchDetector(session) {
        session.on("speech_started", () => {
            if (session === detector)
                void runSerial(handleSpeechStarted);
        });
        session.on("speech_stopped", () => {
            if (session === detector)
                void runSerial(handleSpeechStopped);
        });
        session.on("error", (error) => {
            fail(error);
            if (session !== detector || detectorRecovering || state.status === "idle")
                return;
            detectorRecovering = true;
            void runSerial(async () => {
                try {
                    const next = params.turnDetection.createSession({
                        logger: params.logger.child({ component: "turn-detection" }),
                    });
                    watchDetector(next);
                    await next.connect();
                    const previous = detector;
                    detector = next;
                    previous.close();
                    params.logger.info("voice_turn.detector_reconnected");
                    if (state.status === "capturing")
                        await handleSpeechStopped();
                }
                catch (failure) {
                    params.logger.warn({ err: failure }, "voice_turn.detector_reconnect_failed");
                }
                finally {
                    detectorRecovering = false;
                }
            });
        });
    }
    watchDetector(detector);`,
  },
];

/**
 * The agent's voice goes to the phone as MP3 instead of raw PCM.
 *
 * Each sentence crosses the relay as one message, and the phone starts playing only once
 * it holds all of it. Raw 24 kHz PCM is 48 KB a second of speech; measured on a phone, a
 * thirteen-second sentence waited two seconds on the way, on top of the synthesis. Google's
 * MP3 is 64 kbps, a sixth of it. Both clients already play MP3 — the phone through its file
 * player, the desktop through Web Audio — so only the daemon's request changes, and this
 * plugin's proxy answers it.
 *
 * `PASEO_VOICE_TTS_FORMAT=pcm` in the daemon's environment brings PCM back, which is how
 * the tests compare the two.
 */
const formatSplices: readonly Splice[] = [
  {
    find: `        model: options.ttsModel,
        responseFormat: "pcm",
    };`,
    replace: `        model: options.ttsModel,
        // paseo-voice: MP3 to the phone, a sixth of the PCM; the plugin's proxy answers it.
        responseFormat: process.env.PASEO_VOICE_TTS_FORMAT || "mp3",
    };`,
  },
];

/**
 * Speech that cuts into the agent aborts whatever is playing, and the abort is lifted only
 * when a transcript with words in it arrives. A turn that ends empty — a cough, a noise the
 * detector took for speech, a phrase lost to a crash — leaves it standing: every reply the
 * agent speaks after that is dropped in 0 ms, the agent none the wiser, until a phrase is
 * recognised again. Lifted now whenever the person's turn is over, which is what the log
 * line it follows has always said.
 */
const abortSplices: readonly Splice[] = [
  {
    find: "        this.sessionLogger.debug({ reason }, `Speech turn complete (${reason}) – resuming TTS`);",
    replace:
      "        this.sessionLogger.debug({ reason }, `Speech turn complete (${reason}) – resuming TTS`);\n" +
      "        // paseo-voice: and resume it — a turn that ended empty used to leave the abort standing.\n" +
      "        if (this.abortController.signal.aborted) {\n" +
      "            this.createAbortController();\n" +
      "        }",
  },
];

/**
 * A phone that compresses its microphone sends Opus, in voice mode and in dictation alike.
 *
 * The microphone streams to the daemon for as long as voice mode is on and unmuted, and
 * for the whole of a dictation: 16 kHz PCM is about 340 kbit/s on the wire, more than a
 * weak mobile uplink carries, and then nothing said gets through. The patched phone sends
 * 24 kbit/s Opus instead — but only after asking this plugin whether the daemon can take
 * it, so an unpatched daemon never sees a byte of it.
 *
 * The decoding itself lives in one place, the module this plugin keeps in
 * `~/.paseo-voice/codec` (see `codec.server.ts`); both corrections below only load it and
 * call it, one decoder per stream: a voice session, a dictation.
 */
const LOAD_CODEC = `// paseo-voice: the decoder this plugin keeps, loaded once a phone first sends Opus; a
// failed load is tried again on the next chunk.
let paseoVoiceCodec = null;
const loadPaseoVoiceCodec = () => (paseoVoiceCodec ??= Promise.all([import("node:os"), import("node:url")])
    .then(([os, url]) => import(url.pathToFileURL(\`\${os.homedir()}/.paseo-voice/codec/opus.mjs\`).href))
    .catch((error) => {
    paseoVoiceCodec = null;
    throw error;
}));`;

const voiceOpusSplices: readonly Splice[] = [
  {
    find: `import { toResolver } from "../../speech/provider-resolver.js";`,
    replace: `import { toResolver } from "../../speech/provider-resolver.js";
${LOAD_CODEC}`,
  },
  {
    find: `        await this.voiceTurnController.appendClientChunk({
            audioBase64: msg.audio,
            format: chunkFormat,
        });`,
    replace: `        // paseo-voice: Opus from a phone that compresses its microphone, as the PCM the
        // turn controller hears.
        let audioBase64 = msg.audio;
        let format = chunkFormat;
        if (chunkFormat.startsWith("audio/opus")) {
            try {
                audioBase64 = await (await loadPaseoVoiceCodec()).decodeOpusChunk(this, msg.audio);
                format = "audio/pcm;rate=16000;bits=16";
            }
            catch (error) {
                if (!this.paseoVoiceOpusFailed) {
                    this.paseoVoiceOpusFailed = true;
                    this.sessionLogger.error({ err: error }, "paseo-voice: the phone's Opus could not be decoded");
                }
                return;
            }
            if (!this.voiceTurnController) {
                return;
            }
        }
        await this.voiceTurnController.appendClientChunk({ audioBase64, format });`,
  },
  {
    find: `    async stopVoiceTurnController() {
        if (!this.voiceTurnController) {
            return;
        }`,
    replace: `    async stopVoiceTurnController() {
        // paseo-voice: the next voice session is a new Opus stream.
        this.paseoVoiceOpusFailed = false;
        void paseoVoiceCodec?.then((codec) => codec.freeOpus(this), () => { });
        if (!this.voiceTurnController) {
            return;
        }`,
  },
];

const dictationOpusSplices: readonly Splice[] = [
  {
    find: `import { parsePcmRateFromFormat, pcm16lePeakAbs } from "../speech/audio.js";`,
    replace: `import { parsePcmRateFromFormat, pcm16lePeakAbs } from "../speech/audio.js";
${LOAD_CODEC}`,
  },
  {
    find: `        if (params.format !== state.inputFormat) {`,
    replace: `        // paseo-voice: Opus from a phone that compresses its microphone, as the PCM this
        // stream was started with. A chunk already here is not decoded twice.
        if (params.format.startsWith("audio/opus")) {
            let audioBase64 = params.audioBase64;
            if (params.seq >= state.nextSeqToForward && !state.receivedChunks.has(params.seq)) {
                try {
                    audioBase64 = await (await loadPaseoVoiceCodec()).decodeOpusChunk(state, params.audioBase64);
                }
                catch (error) {
                    void this.failAndCleanupDictationStream(params.dictationId, \`paseo-voice: the phone's Opus could not be decoded: \${error instanceof Error ? error.message : String(error)}\`, false);
                    return;
                }
                if (this.streams.get(params.dictationId) !== state) {
                    return;
                }
            }
            params = { ...params, audioBase64, format: state.inputFormat };
        }
        if (params.format !== state.inputFormat) {`,
  },
  {
    find: `        this.streams.delete(dictationId);`,
    replace: `        this.streams.delete(dictationId);
        // paseo-voice: its Opus decoder goes with it.
        void paseoVoiceCodec?.then((codec) => codec.freeOpus(state), () => { });`,
  },
];

/**
 * Makes the desktop client ask this plugin for its waiting cue instead of playing the
 * one baked into its bundle.
 *
 * Baking the chosen sound in directly was the obvious thing and the wrong one: every
 * change of track or volume meant rewriting a 21 MB bundle and restarting the app. The
 * source for the cue is already an async `arrayBuffer()`, so it can simply fetch — and
 * then the choice lives in this plugin, takes effect on the next play, and needs no
 * patch at all after the first.
 *
 * The bundle's own bytes stay as the fallback: with the plugin stopped the cue is
 * Paseo's original tone rather than silence.
 */
const cueSplices: readonly Splice[] = [
  {
    // `{size:C.byteLength,type:"audio/pcm;rate=16000;bits=16",arrayBuffer:async()=>C.buffer.slice(…)}`
    // Matched by shape: minified identifiers change between builds.
    pattern:
      /\{size:(\w+)\.byteLength,type:"audio\/pcm;rate=16000;bits=16",arrayBuffer:async\(\)=>\1\.buffer\.slice\(\1\.byteOffset,\1\.byteOffset\+\1\.byteLength\)\}/,
    replace:
      `{size:$1.byteLength,type:"audio/pcm;rate=16000;bits=16",arrayBuffer:async()=>{/*${MARKER}live*/` +
      `try{const r=await fetch("http://127.0.0.1:${CUE_PORT}/v1/cue",{cache:"no-store"});` +
      `if(r.ok){const b=await r.arrayBuffer();if(b.byteLength>0)return b}}catch(e){}` +
      `return $1.buffer.slice($1.byteOffset,$1.byteOffset+$1.byteLength)}}`,
  },
  {
    /**
     * Two numbers: the gap between repeats and the silence before the first play.
     * The gap reads as a stutter once the cue is music, and the 1500 ms wait is what
     * upstream added so the cue would not fire in the pauses between spoken sentences
     * — pauses the other two corrections here already removed.
     */
    pattern: /(\w+)=350,(\w+)=1500/,
    replace: "$1=0,$2=250",
  },
];

export const TARGETS: readonly Target[] = [
  {
    id: "drain",
    title: "Читать звук сразу",
    note: "Убирает пропажу предложений посреди ответа",
    kind: "asar",
    entry: "node_modules/@getpaseo/server/dist/server/server/agent/tts-manager.js",
    splices: ttsSplices,
    // Paseo 0.10.3, 0.11.1 and 0.11.2, byte for byte the same file.
    verified: ["c0175e3a58b1b6076f7792e5480bd9f5a39d3e1b720427833d89e782d60b4508"],
  },
  {
    // One file, so one correction: the archive keeps one original per file.
    id: "listen",
    title: "Голосовой ввод",
    note: "Мьют отправляет фразу, распознавание не копит тишину между фразами, детектор речи поднимается после падения",
    kind: "asar",
    entry: "node_modules/@getpaseo/server/dist/server/server/session/voice/voice-turn-controller.js",
    splices: [...muteSplices, ...prerollSplices, ...detectorSplices],
    // Paseo 0.10.3, 0.11.1 and 0.11.2, byte for byte the same file.
    verified: ["143bec13ce0c86542ede7f943c543cb90e58179e88a56efeacdf2896a8000697"],
  },
  {
    id: "format",
    title: "Голос агента в MP3",
    note: "Голос агента идёт на телефон в MP3, в шесть раз легче: первое слово звучит раньше",
    kind: "asar",
    entry: "node_modules/@getpaseo/server/dist/server/server/speech/providers/openai/config.js",
    splices: formatSplices,
    // Paseo 0.11.2.
    verified: ["f936779bd4067b351eaaf127f098f9e7ece5458e50644e124ea8a4e0f2e09275"],
  },
  {
    // One file, so one correction, as above.
    id: "session",
    title: "Голосовая сессия",
    note: "Ответы агента снова звучат после нераспознанной фразы; голос с телефона принимается сжатым, в Opus",
    kind: "asar",
    entry: "node_modules/@getpaseo/server/dist/server/server/session/voice/voice-session.js",
    splices: [...abortSplices, ...voiceOpusSplices],
    // Paseo 0.11.1 and 0.11.2, byte for byte the same file.
    verified: ["0db7bd264ff2416b2ead22abdee4935f060ae1e341f9a2641c0f82a146e15fe3"],
  },
  {
    id: "dictation",
    title: "Диктовка в Opus",
    note: "Голос с телефона при диктовке принимается сжатым, в Opus",
    kind: "asar",
    entry: "node_modules/@getpaseo/server/dist/server/server/dictation/dictation-stream-manager.js",
    splices: dictationOpusSplices,
    // Paseo 0.11.2.
    verified: ["e188e9451878e610356af8ea75716b7a05963ae414d11bfa8f89bfe0f89bca90"],
  },
  {
    id: "cue",
    title: "Своя музыка ожидания",
    note: "Ставит в десктопный Paseo звук, выбранный в разделе «Звук ожидания»",
    kind: "file",
    entry: "app-dist/_expo/static/js/web/index-*.js",
    splices: cueSplices,
  },
];

export type Outcome = { ok: true; text: string } | { ok: false; reason: "already-patched" | "unknown-version" };

/**
 * Applies the corrections to the original source.
 *
 * Refuses on an anchor that is missing or occurs twice rather than guessing, which is
 * the whole version check: an upstream rewrite of these functions will not match, and
 * not matching is the safe answer.
 */
export function patchSource(original: string, splices: readonly Splice[]): Outcome {
  if (original.includes(MARKER)) {
    return { ok: false, reason: "already-patched" };
  }
  let text = original;
  for (const splice of splices) {
    if ("pattern" in splice) {
      // Global copy so a second occurrence can be counted: an ambiguous shape is as
      // unsafe to patch as a missing one.
      const all = new RegExp(splice.pattern.source, `${splice.pattern.flags.replace("g", "")}g`);
      if ([...text.matchAll(all)].length !== 1) {
        return { ok: false, reason: "unknown-version" };
      }
      text = text.replace(splice.pattern, splice.replace);
      continue;
    }
    const first = text.indexOf(splice.find);
    if (first === -1 || text.indexOf(splice.find, first + splice.find.length) !== -1) {
      return { ok: false, reason: "unknown-version" };
    }
    text = text.slice(0, first) + splice.replace + text.slice(first + splice.find.length);
  }
  // The source map no longer describes these lines, and a wrong map is worse than none.
  return { ok: true, text: text.replace(/\n\/\/# sourceMappingURL=.*\n?$/, "\n") };
}

/**
 * Squeezes the patched source back into the original's exact byte length, then pads.
 * Only leading indentation is touched; this file is compiled TypeScript with no
 * template literals spanning lines, so whitespace at the start of a line carries nothing.
 */
export function fit(source: string, target: number): string | null {
  let text = source;
  const halve = (line: string) => line.replace(/^ +/, (indent) => " ".repeat(indent.length >> 1));
  if (Buffer.byteLength(text) > target) {
    text = text.split("\n").map(halve).join("\n");
  }
  if (Buffer.byteLength(text) > target) {
    text = text.split("\n").map((line) => line.replace(/^ +/, "")).join("\n");
  }
  const slack = target - Buffer.byteLength(text);
  return slack < 0 ? null : text + " ".repeat(slack);
}

const sha256 = (text: string): string => createHash("sha256").update(text, "utf8").digest("hex");

/**
 * Compiles without running. A bundle that does not parse is a desktop client that does
 * not start, and the splices on minified code are the one place a stray brace could
 * come from; the check costs about a tenth of a second on the 21 MB file.
 */
function parses(text: string): boolean {
  try {
    new vm.Script(text);
    return true;
  } catch {
    return false;
  }
}

/** What one correction calls for, given the file it would go into. */
export type Verdict =
  | { kind: "in-place" }
  /** `original` is the clean file `text` was made from: the one to keep for a revert. */
  | { kind: "write"; text: string; original: string }
  | { kind: "unverified"; sha: string; anchorsFit: boolean }
  | { kind: "refused"; why: string };

/** What a correction makes of a clean file, exactly as `judge` would write it; null if it would not. */
function made(target: Target, original: string, size: number): string | null {
  const outcome = patchSource(original, target.splices);
  if (!outcome.ok) {
    return null;
  }
  return target.kind === "file" ? outcome.text : fit(outcome.text, size);
}

/**
 * The whole decision, pure so that it can be proved.
 *
 * `auto` adds the one check a person at the button does not need: the file must be an
 * upstream version this correction was reviewed against. Anchors only see the lines
 * being replaced, while the replacements lean on names around them —
 * `MAX_TTS_SEGMENT_CHARS`, `runSerial`, `params.logger`. Rename one upstream and every
 * anchor still matches, the patch still lands, and the daemon meets a ReferenceError at
 * the first sentence; in the mute correction's case inside a timer callback, with
 * nothing around it to catch the throw. A hash notices any change at all. The price is
 * an alarm about a change that turns out harmless, which costs one look at a diff.
 *
 * A file that already carries a correction is judged by the `original` kept beside it.
 * The marker only says that some version of the correction is in there: a plugin update
 * that changes one would otherwise find the marker, call it in place, and leave the old
 * version running for good.
 */
export function judge(
  target: Target,
  source: { text: string; size: number },
  auto: boolean,
  original?: string,
): Verdict {
  if (!source.text.includes(MARKER)) {
    return judgeClean(target, source, auto);
  }
  if (original === undefined) {
    return { kind: "refused", why: "правка уже наложена, а оригинала рядом нет — не проверить, та ли это версия" };
  }
  if (made(target, original, source.size) === source.text) {
    return { kind: "in-place" };
  }
  // An earlier version of the correction: made again from the original, through every
  // check a clean file goes through.
  return judgeClean(target, { text: original, size: source.size }, auto);
}

function judgeClean(target: Target, source: { text: string; size: number }, auto: boolean): Verdict {
  const outcome = patchSource(source.text, target.splices);
  if (auto && target.verified) {
    const sha = sha256(source.text);
    if (!target.verified.includes(sha)) {
      return { kind: "unverified", sha, anchorsFit: outcome.ok };
    }
  }
  if (!outcome.ok) {
    return {
      kind: "refused",
      why:
        outcome.reason === "already-patched"
          ? "сохранённый оригинал сам с правкой — переустанови Paseo"
          : "незнакомая версия Paseo — якоря не совпали",
    };
  }
  if (target.kind === "file") {
    return parses(outcome.text)
      ? { kind: "write", text: outcome.text, original: source.text }
      : { kind: "refused", why: "после правки бандл не разбирается — с ним Paseo не запустится" };
  }
  const fitted = fit(outcome.text, source.size);
  return fitted === null
    ? { kind: "refused", why: "правка не влезает в исходный размер" }
    : { kind: "write", text: fitted, original: source.text };
}

/**
 * Electron can check every file it reads out of the archive against hashes kept in its
 * header. Paseo ships with that fuse off, which is the only reason a patch written in
 * place works at all. With it on, the first read of a patched file kills the app at
 * launch — and an automatic run would do the same again after every reinstall.
 */
const FUSE_SENTINEL = Buffer.from("dL7pKGdnNz796PbbjQWNKmHXBZaB9tsX");
/** `EnableEmbeddedAsarIntegrityValidation`, by its place on the wire. */
const ASAR_INTEGRITY_FUSE = 4;

/**
 * Reads the fuse off the wire that follows the sentinel: a version byte, a length byte,
 * then one byte per fuse — "1" on, "0" off, "r" removed. Null when the window does not
 * hold the whole wire, so a wire cut by a read boundary is never mistaken for "off".
 */
export function asarIntegrityOn(window: Buffer): boolean | null {
  const at = window.indexOf(FUSE_SENTINEL);
  const wire = at + FUSE_SENTINEL.length + 2;
  if (at === -1 || wire + ASAR_INTEGRITY_FUSE >= window.length) {
    return null;
  }
  if ((window[wire - 1] ?? 0) <= ASAR_INTEGRITY_FUSE) {
    return null;
  }
  return window[wire + ASAR_INTEGRITY_FUSE] === "1".charCodeAt(0);
}

/** The framework binary is 190 MB, so it is searched in slices rather than read whole. */
async function asarIntegrityEnforced(archivePath: string): Promise<boolean> {
  const binary = path.join(
    path.dirname(archivePath),
    "..",
    "Frameworks",
    "Electron Framework.framework",
    "Electron Framework",
  );
  const handle = await open(binary, "r");
  try {
    const slice = Buffer.alloc(8 * 1024 * 1024);
    // Each slice repeats the end of the one before, so the sentinel and its wire are
    // whole in at least one of them.
    const overlap = 256;
    for (let position = 0; ; position += slice.length - overlap) {
      const { bytesRead } = await handle.read(slice, 0, slice.length, position);
      const on = asarIntegrityOn(slice.subarray(0, bytesRead));
      if (on !== null) {
        return on;
      }
      if (bytesRead < slice.length) {
        break;
      }
    }
  } finally {
    await handle.close();
  }
  throw new Error("не нашёл предохранители Electron — не могу проверить, что Paseo разрешает правки в app.asar");
}

export type TargetState = {
  id: string;
  title: string;
  note: string;
  applied: boolean;
  /** The file is there but its shape has changed — a Paseo this plugin does not know. */
  unknownVersion: boolean;
  /** What the last automatic run could not do with it, in a sentence; empty when nothing. */
  alert: string;
};

export type PatchState = {
  /** Paseo's archive was found and still carries the files these correct. */
  available: boolean;
  /** Every correction is in place. */
  applied: boolean;
  unknownVersion: boolean;
  /** Puts the corrections back by itself after an update; off until applied by hand. */
  auto: boolean;
  archivePath: string;
  /** Set after applying or reverting: the daemon already has the old code in memory. */
  restartRequired: boolean;
  targets: TargetState[];
  error: string;
};

/** Electron sets `resourcesPath`; plain Node does not, hence the fixed fallback. */
const resourcesPath = (process as { resourcesPath?: string }).resourcesPath;

const CANDIDATES = [
  () => (resourcesPath ? path.join(resourcesPath, "app.asar") : ""),
  () => "/Applications/Paseo.app/Contents/Resources/app.asar",
];

async function located(): Promise<Archive | null> {
  for (const candidate of CANDIDATES) {
    const file = candidate();
    if (!file) {
      continue;
    }
    try {
      const archive = await readArchive(file);
      // The right archive is the one that actually carries the files; a helper bundle
      // beside it does not, and that is how an earlier version picked the wrong one.
      // Only the archive targets are asked for: a `file` target lives beside it.
      if (TARGETS.filter((target) => target.kind === "asar").every((target) => locate(archive, target.entry))) {
        return archive;
      }
    } catch {
      // Not an archive, or not readable. Try the next.
    }
  }
  return null;
}

/** The plain file a `file` target points at; its name carries a content hash. */
async function fileOf(target: Target): Promise<string> {
  const [dir, mask] = [path.dirname(target.entry), path.basename(target.entry)];
  const [prefix, suffix] = mask.split("*");
  for (const candidate of CANDIDATES) {
    const archive = candidate();
    if (!archive) {
      continue;
    }
    const root = path.join(path.dirname(archive), dir);
    try {
      const found = (await readdir(root)).find(
        (name) => name.startsWith(prefix ?? "") && name.endsWith(suffix ?? ""),
      );
      if (found) {
        return path.join(root, found);
      }
    } catch {
      // Not where this one looked. Try the next.
    }
  }
  return "";
}

/** Named after the file it holds, so an upstream rename leaves nothing to restore. */
async function backupOf(target: Target): Promise<string> {
  const name = target.kind === "file" ? path.basename(await fileOf(target)) : (target.entry.split("/").pop() ?? target.id);
  return path.join(paths.root, "patches", `${name || target.id}.original`);
}

/**
 * The clean file kept beside a patched one. Undefined for a clean file, and for a patched
 * one with nothing kept — or with a backup of another size, which cannot be the original
 * of an archive entry that has to keep its size.
 */
async function originalOf(target: Target, source: { text: string; size: number }): Promise<string | undefined> {
  if (!source.text.includes(MARKER)) {
    return undefined;
  }
  try {
    const original = await readFile(await backupOf(target), "utf8");
    return target.kind === "asar" && Buffer.byteLength(original) !== source.size ? undefined : original;
  } catch {
    return undefined;
  }
}

/** Reads a target's current text, wherever it lives. */
async function textOf(archive: Archive, target: Target): Promise<{ text: string; size: number } | null> {
  if (target.kind === "file") {
    const file = await fileOf(target);
    if (!file) {
      return null;
    }
    const text = await readFile(file, "utf8");
    return { text, size: Buffer.byteLength(text) };
  }
  const entry = locate(archive, target.entry);
  if (!entry) {
    return null;
  }
  return { text: (await readEntry(archive.path, entry)).toString("utf8"), size: entry.size };
}

/** Where a changed upstream file is put, for a person to diff against the original. */
async function pendingOf(target: Target): Promise<string> {
  return (await backupOf(target)).replace(/\.original$/, ".pending");
}

/** Paseo's version, for messages; read from the archive so it is the one on disk. */
async function versionOf(archive: Archive): Promise<string> {
  const entry = locate(archive, "package.json");
  try {
    return entry ? String(JSON.parse((await readEntry(archive.path, entry)).toString("utf8")).version) : "?";
  } catch {
    return "?";
  }
}

/** Kept beside the backups the automatic run depends on. */
const autoFile = path.join(paths.root, "patches", "auto.json");

type AutoState = {
  /**
   * The last thing done by hand. Only "applied" lets the plugin write on its own: a
   * fresh install does not patch anybody's Paseo unasked, and a revert stays a revert
   * across updates.
   */
  intent: "applied" | "reverted" | null;
  /** What the last alert said, so the next start does not raise the same one again. */
  alerted: string;
  /**
   * The Paseo version a restart was last due for, whether or not the daemon was young
   * enough to take it. One per version, so corrections that somehow do not stick cannot
   * become a restart loop.
   */
  restarted: string;
};

const NO_AUTO: AutoState = { intent: null, alerted: "", restarted: "" };

async function readAuto(): Promise<AutoState> {
  try {
    return { ...NO_AUTO, ...(JSON.parse(await readFile(autoFile, "utf8")) as Partial<AutoState>) };
  } catch {
    return NO_AUTO;
  }
}

async function writeAuto(next: Partial<AutoState>): Promise<void> {
  const merged = { ...(await readAuto()), ...next };
  await mkdir(path.dirname(autoFile), { recursive: true });
  await writeFile(autoFile, `${JSON.stringify(merged, null, 2)}\n`, { mode: 0o600 });
}

/** Writes one correction a verdict allowed, keeping the original it replaces. */
async function write(archive: Archive, target: Target, original: string, text: string): Promise<void> {
  if (target.kind === "asar" && (await asarIntegrityEnforced(archive.path))) {
    throw new Error("Paseo включил проверку целостности app.asar — с правкой внутри он не запустится");
  }

  // Rewritten before every write rather than kept from the first: this only ever runs
  // on a clean source, since `patchSource` refuses a patched one, so what lands here is
  // always the original of the version being patched. Keeping the first backup ever
  // taken was the old rule, and after an update it left the previous version's file
  // here — which a revert would then have written into the new archive.
  const backup = await backupOf(target);
  const dir = path.dirname(backup);
  await mkdir(dir, { recursive: true });
  await writeFile(backup, original, { mode: 0o600 });
  await rm(await pendingOf(target), { force: true });

  if (target.kind === "file") {
    // The bundle is renamed by every build and so is its backup; the old ones belong to
    // bundles that no longer exist, at 21 MB apiece.
    const [prefix = "", suffix = ""] = path.basename(target.entry).split("*");
    for (const name of await readdir(dir)) {
      if (name.startsWith(prefix) && name.endsWith(`${suffix}.original`) && path.join(dir, name) !== backup) {
        await rm(path.join(dir, name), { force: true });
      }
    }
    const file = await fileOf(target);
    // Staged and renamed: a half-written bundle is a client that will not start.
    const staged = `${file}.voice-plugin.tmp`;
    await writeFile(staged, text);
    await rename(staged, file);
    return;
  }

  await writeEntry(archive.path, locate(archive, target.entry)!, Buffer.from(text, "utf8"));
}

let restartRequired = false;

/** What the last automatic run made of each correction, until something done by hand supersedes it. */
let lastAuto: AutoReport | null = null;

/**
 * What `inspect` may remember between calls.
 *
 * The panel asks for the status every few seconds, and answering means reading several
 * megabytes out of the archive and searching them. But the answer only changes when
 * Paseo is replaced or when this plugin writes to it, and both move a file's mtime. So
 * the reading is done once per version of the files on disk and replayed after that.
 */
let remembered: { of: string; state: PatchState } | null = null;

/**
 * The identity of everything `inspect` reads: path, mtime and size of each, with
 * absence spelled out rather than left as a gap. Stat only, so it stays cheap enough
 * to recompute on every call — which is the point, since it is what decides whether
 * the expensive part runs.
 */
export async function fingerprintOf(files: string[]): Promise<string> {
  const parts = files.map((file) => {
    try {
      // On disk, not as Electron shows an archive: there it is "written now" every time.
      const { mtimeMs, size } = statOnDisk(file);
      return `${file}:${mtimeMs}:${size}`;
    } catch {
      return `${file}:absent`;
    }
  });
  return parts.join("|");
}

/** The files behind the current answer: every place the archive could be, plus the
 *  loose bundle beside it, whose name carries a content hash of its own. */
async function fingerprint(): Promise<string> {
  const files = CANDIDATES.map((candidate) => candidate()).filter((file) => file !== "");
  for (const target of TARGETS) {
    if (target.kind === "file") {
      files.push((await fileOf(target)) || `${target.id}:unresolved`);
    }
  }
  return fingerprintOf(files);
}

/**
 * This plugin's own memory, laid over what was read off the disk rather than remembered
 * with it: the restart flag, the switch, and what the last automatic run had to say.
 */
async function overlaid(state: PatchState): Promise<PatchState> {
  const alerts = lastAuto?.alerts ?? [];
  return {
    ...state,
    restartRequired,
    auto: (await readAuto()).intent === "applied",
    targets: state.targets.map((one) => ({ ...one, alert: alerts.find((a) => a.id === one.id)?.text ?? "" })),
  };
}

export async function inspect(): Promise<PatchState> {
  const blank: PatchState = {
    available: false,
    applied: false,
    unknownVersion: false,
    auto: false,
    archivePath: "",
    restartRequired,
    targets: [],
    error: "",
  };
  const of = await fingerprint();
  if (remembered?.of === of) {
    return overlaid(remembered.state);
  }
  try {
    const archive = await located();
    if (!archive) {
      return { ...blank, error: "не нашёл app.asar — Paseo стоит не там, где ожидалось" };
    }
    const targets: TargetState[] = [];
    for (const target of TARGETS) {
      const source = await textOf(archive, target);
      if (!source) {
        targets.push({
          id: target.id,
          title: target.title,
          note: target.note,
          applied: false,
          unknownVersion: true,
          alert: "",
        });
        continue;
      }
      const original = await originalOf(target, source);
      // What the correction would be made from: the file itself when clean, the original
      // beside it when not, and nothing when a patched file has lost its original.
      const base = source.text.includes(MARKER) ? original : source.text;
      targets.push({
        id: target.id,
        title: target.title,
        note: target.note,
        applied: judge(target, source, false, original).kind === "in-place",
        unknownVersion: base !== undefined && !patchSource(base, target.splices).ok,
        alert: "",
      });
    }
    const state: PatchState = {
      ...blank,
      available: true,
      applied: targets.every((one) => one.applied),
      unknownVersion: targets.some((one) => one.unknownVersion),
      archivePath: archive.path,
      targets,
    };
    // Only a complete answer is kept. A failure can be a half-written file during a
    // Paseo update, and remembering that would outlast the update.
    remembered = { of, state };
    return overlaid(state);
  } catch (failure) {
    return { ...blank, error: failure instanceof Error ? failure.message : String(failure) };
  }
}

/**
 * Writes every correction that is not in place yet, keeping each original first.
 *
 * An archive entry has to keep its exact length so the header stays true; a plain file
 * beside it has no such constraint and is simply rewritten.
 */
export async function apply(): Promise<void> {
  const archive = await located();
  if (!archive) {
    throw new Error("не нашёл app.asar");
  }
  for (const target of TARGETS) {
    const source = await textOf(archive, target);
    if (!source) {
      throw new Error(`${target.title}: файл не найден — Paseo обновился`);
    }
    const verdict = judge(target, source, false, await originalOf(target, source));
    if (verdict.kind === "refused") {
      throw new Error(`${target.title}: ${verdict.why}`);
    }
    if (verdict.kind === "write") {
      await write(archive, target, verdict.original, verdict.text);
    }
  }
  // Done by hand, so it is what this person wants after the next update as well.
  await writeAuto({ intent: "applied" });
  lastAuto = null;
  remembered = null;
  restartRequired = true;
}

export async function revert(): Promise<void> {
  const archive = await located();
  if (!archive) {
    throw new Error("не нашёл app.asar");
  }
  for (const target of TARGETS) {
    let original: string;
    try {
      original = await readFile(await backupOf(target), "utf8");
    } catch {
      // Nothing kept for this one, or Paseo renamed the file it lived in.
      continue;
    }
    if (target.kind === "file") {
      const file = await fileOf(target);
      if (!file) {
        continue;
      }
      const staged = `${file}.voice-plugin.tmp`;
      await writeFile(staged, original);
      await rename(staged, file);
      continue;
    }
    const entry = locate(archive, target.entry);
    if (!entry) {
      continue;
    }
    if (Buffer.byteLength(original) !== entry.size) {
      throw new Error(`${target.title}: сохранённый оригинал другого размера — Paseo обновился`);
    }
    await writeEntry(archive.path, entry, Buffer.from(original, "utf8"));
  }
  // A revert by hand is a decision, and it has to outlast the next update.
  await writeAuto({ intent: "reverted" });
  lastAuto = null;
  remembered = null;
  restartRequired = true;
}

export type AutoReport = {
  version: string;
  /** The ids written on this run. */
  written: string[];
  /** Something went into the archive, which the daemon only reads at start. */
  archived: boolean;
  /** …and the daemon has not been restarted for this version yet. */
  restart: boolean;
  /** One sentence for each correction that needs a person. */
  alerts: { id: string; title: string; text: string }[];
  /** These alerts differ from the last ones raised, so they are worth a notification. */
  fresh: boolean;
};

/**
 * Run at every start of the plugin, which every Paseo update causes, since it ends in
 * a restart. An update replaces the files the corrections live in, so this is where
 * they come back: onto files they were reviewed against, and nowhere else. Anything
 * else is left as it is and reported, for a person to read the diff and then either
 * add the hash or rewrite the correction.
 *
 * Null when it is not this plugin's place to write at all; see `AutoState.intent`.
 */
export async function autoApply(): Promise<AutoReport | null> {
  const state = await readAuto();
  if (state.intent !== "applied") {
    return null;
  }
  const archive = await located();
  if (!archive) {
    // No archive carrying the corrected files is the loudest change there is — the code
    // moved — so it is reported like the rest rather than thrown into a log.
    const text = "не нашёл app.asar с файлами, которые правятся — Paseo переложил код или стоит не там";
    return settled(state, {
      version: "?",
      written: [],
      archived: false,
      restart: false,
      alerts: [{ id: "archive", title: "Архив Paseo", text }],
      fresh: false,
    });
  }
  const version = await versionOf(archive);
  const report: AutoReport = { version, written: [], archived: false, restart: false, alerts: [], fresh: false };
  const shown = (file: string) => file.replace(homedir(), "~");

  // Each on its own: a correction that cannot go in is no reason to leave out the ones
  // that can.
  for (const target of TARGETS) {
    const alert = (text: string) => report.alerts.push({ id: target.id, title: target.title, text });
    try {
      const source = await textOf(archive, target);
      if (!source) {
        alert(`в Paseo ${version} нет файла, в который она ложится`);
        continue;
      }
      const original = await originalOf(target, source);
      const verdict = judge(target, source, true, original);
      if (verdict.kind === "write") {
        await write(archive, target, verdict.original, verdict.text);
        report.written.push(target.id);
        report.archived ||= target.kind === "asar";
      } else if (verdict.kind === "refused") {
        alert(verdict.why);
      } else if (verdict.kind === "unverified") {
        const pending = await pendingOf(target);
        await writeFile(pending, original ?? source.text, { mode: 0o600 });
        const diff = `diff -u ${shown(await backupOf(target))} ${shown(pending)}`;
        alert(
          verdict.anchorsFit
            ? `Paseo ${version} изменил файл, якоря совпадают. Проверь: ${diff} — если правка по-прежнему верна, добавь в verified ${verdict.sha}`
            : `Paseo ${version} изменил файл, якоря не совпадают — правку надо переписать. Что поменялось: ${diff}`,
        );
      }
    } catch (failure) {
      alert(failure instanceof Error ? failure.message : String(failure));
    }
  }
  return settled(state, report);
}

/** Remembers what a run found, and decides whether it is news worth a notification. */
async function settled(state: AutoState, report: AutoReport): Promise<AutoReport> {
  if (report.written.length > 0) {
    remembered = null;
    restartRequired = true;
  }
  const said = report.alerts.map((one) => `${one.id}: ${one.text}`).join("\n");
  report.fresh = said !== "" && said !== state.alerted;
  report.restart = report.archived && state.restarted !== report.version;
  await writeAuto({ alerted: said, restarted: report.restart ? report.version : state.restarted });
  lastAuto = report;
  return report;
}
