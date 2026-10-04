import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, utimes, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { fingerprintOf, fit, MARKER, patchSource, TARGETS } from "./patches.server.ts";

/** The shape of the two functions this corrects, as Paseo 0.10.2 compiles them. */
const splicesOf = (id: string) => TARGETS.find((target) => target.id === id)!.splices;
const TTS = splicesOf("drain");
const MUTE = splicesOf("mute");

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

/**
 * Checked against the untouched originals the plugin keeps when it first patches, not
 * against whatever is in the archive right now — that one may already carry the patch.
 */
for (const [name, splices, what] of [
  ["tts-manager.js", TTS, "выдача звука"],
  ["voice-turn-controller.js", MUTE, "мьют"],
] as const) {
  test(`правка «${what}» ложится на настоящий файл установленного Paseo`, async (t) => {
    const file = path.join(homedir(), ".paseo-voice", "patches", `${name}.original.js`);
    let source: string;
    try {
      source = await readFile(file, "utf8");
    } catch {
      t.skip(`нет сохранённого оригинала ${name}`);
      return;
    }
    const outcome = patchSource(source, splices);
    assert.equal(outcome.ok, true, "якоря обязаны совпасть с установленной версией");
    const fitted = fit(outcome.ok ? outcome.text : "", Buffer.byteLength(source));
    assert.notEqual(fitted, null, "правка обязана влезть в исходный размер");
    assert.equal(Buffer.byteLength(fitted ?? ""), Buffer.byteLength(source));
  });
}

test("the mute correction adds the watchdog, the flush and the chunk timestamp", () => {
  const vtc = `
    let state = { status: "idle" };
    async function start() {
            await detector.connect();
    }
    async function stop() {
                detector.close();
    }
    async function append(input) {
                const pcm16 = Buffer.from(input.audioBase64, "base64");
    }
`;
  const outcome = patchSource(vtc, MUTE);
  assert.equal(outcome.ok, true);
  const text = outcome.ok ? outcome.text : "";
  assert.ok(text.includes("voice_turn.client_audio_stalled"), "сторож обязан логировать, когда сработал");
  assert.ok(text.includes("detector.flush()"), "и звать flush, который в демоне не зовёт никто");
  assert.ok(text.includes("startStallWatch();"), "запускаться вместе с детектором");
  assert.ok(text.includes("stopStallWatch();"), "и останавливаться вместе с ним");
  assert.ok(text.includes("lastChunkAt = Date.now();"), "и видеть каждый приходящий кусок звука");
});

test("the cue correction makes the desktop ask the plugin for the sound", () => {
  // The source Paseo plays the cue from, as Metro minifies it.
  const bundle =
    `C=Uint8Array.from(Buffer.from(s.THINKING_TONE_NATIVE_PCM_BASE64,"base64")),` +
    `T={size:C.byteLength,type:"audio/pcm;rate=16000;bits=16",` +
    `arrayBuffer:async()=>C.buffer.slice(C.byteOffset,C.byteOffset+C.byteLength)};` +
    `const zz=600,u=350,p=1500,q=7;`;
  const outcome = patchSource(bundle, splicesOf("cue"));

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
