import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm, utimes, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { type Archive, locate, readArchive, readEntry } from "./asar.server.ts";
import { asarIntegrityOn, fingerprintOf, fit, judge, MARKER, patchSource, TARGETS } from "./patches.server.ts";

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

test("a correction already in place is left as it is", () => {
  const once = patchSource(ORIGINAL, TTS);
  assert.deepEqual(judge(REVIEWED, sized(once.ok ? once.text : ""), true), { kind: "in-place" });
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
    assert.equal(
      judge(target, { text: source, size: Buffer.byteLength(source) }, true).kind,
      "write",
      `Paseo изменил ${name}: сравни с оригиналом, поправь правку и добавь в verified ${sha256(source)}`,
    );
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
