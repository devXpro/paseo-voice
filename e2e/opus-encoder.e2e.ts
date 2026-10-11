import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, before, describe, test } from "node:test";
import { pathToFileURL } from "node:url";
import { CODEC_ENTRY, ensureCodec } from "../server/codec.server.ts";
import { stripWavHeader } from "../server/google.server.ts";

/**
 * The phone's Opus encoder, `ios-build/opus/VoiceOpusEncoder.swift`, compiled for this Mac
 * exactly as it is — AudioToolbox encodes Opus the same way on both — and fed the way the
 * phone feeds it: 128 ms of microphone at a time, chunks that never line up with its
 * 20 ms packets. What it makes is decoded by the decoder the daemon uses, the one this
 * plugin keeps in `~/.paseo-voice/codec`, through `decodeOpusChunk`, the daemon's own call.
 */

const SWIFT = path.join(import.meta.dirname, "..", "ios-build", "opus", "VoiceOpusEncoder.swift");
/** The iOS tap's buffer: 2048 samples at 16 kHz. */
const CHUNK_BYTES = 4096;

const MAIN = `import Foundation

// Encodes argv[1] (16 kHz PCM16) chunk by chunk and writes each chunk's output, as the
// phone would send it, to argv[2]: a u32 length and the bytes, per chunk.
let pcm = try! Data(contentsOf: URL(fileURLWithPath: CommandLine.arguments[1]))
guard let encoder = VoiceOpusEncoder() else { print("no encoder"); exit(1) }
var out = Data()
var at = 0
while at < pcm.count {
  let chunk = pcm[at..<min(at + ${CHUNK_BYTES}, pcm.count)]
  guard let packed = encoder.encode(Data(chunk)) else { print("encoder failed"); exit(1) }
  var length = UInt32(packed.count).littleEndian
  out.append(Data(bytes: &length, count: 4))
  out.append(packed)
  at += ${CHUNK_BYTES}
}
try! out.write(to: URL(fileURLWithPath: CommandLine.arguments[2]))
`;

/**
 * Speech from this Mac's own voice, at the phone's 16 kHz — offline, and real speech: a
 * waveform made up to look like it correlates worse through any perceptual codec, which
 * would be testing the signal rather than the encoder.
 */
function speech(file: string): Buffer {
  execFileSync(
    "say",
    ["-o", file, "--file-format=WAVE", "--data-format=LEI16@16000", "Six slippery snails slid slowly seaward. She sells sea shells by the sea shore."],
    { stdio: "pipe" },
  );
  return stripWavHeader(readFileSync(file));
}

/** Needs Xcode's compiler and macOS's `say`; anywhere else there is nothing to compile. */
const tools = (() => {
  try {
    execFileSync("xcrun", ["--find", "swiftc"], { stdio: "pipe" });
    execFileSync("which", ["say"], { stdio: "pipe" });
    return true;
  } catch {
    return false;
  }
})();

function correlation(a: Int16Array, b: Int16Array, lag: number): number {
  let ab = 0;
  let aa = 0;
  let bb = 0;
  for (let at = 0; at < a.length; at++) {
    const other = at + lag;
    if (other < 0 || other >= b.length) continue;
    ab += (a[at] ?? 0) * (b[other] ?? 0);
    aa += (a[at] ?? 0) ** 2;
    bb += (b[other] ?? 0) ** 2;
  }
  return ab / Math.sqrt(aa * bb);
}

describe("the phone's Opus encoder, against the daemon's decoder", { timeout: 300_000, skip: !tools }, () => {
  let dir = "";
  let original: Buffer;
  let chunks: Buffer[] = [];
  let decoded: Buffer;

  before(async () => {
    dir = mkdtempSync(path.join(tmpdir(), "voice-opus-"));
    writeFileSync(path.join(dir, "main.swift"), MAIN);
    execFileSync("xcrun", ["swiftc", "-O", "-o", path.join(dir, "encode"), SWIFT, path.join(dir, "main.swift")], {
      stdio: "pipe",
    });
    original = speech(path.join(dir, "speech.wav"));
    writeFileSync(path.join(dir, "in.pcm"), original);
    execFileSync(path.join(dir, "encode"), [path.join(dir, "in.pcm"), path.join(dir, "out.bin")], { stdio: "pipe" });
    const out = readFileSync(path.join(dir, "out.bin"));
    for (let at = 0; at < out.length; ) {
      const length = out.readUInt32LE(at);
      chunks.push(out.subarray(at + 4, at + 4 + length));
      at += 4 + length;
    }

    await ensureCodec();
    const codec = (await import(pathToFileURL(CODEC_ENTRY).href)) as {
      decodeOpusChunk(owner: object, audioBase64: string): Promise<string>;
      freeOpus(owner: object): void;
    };
    const stream = {};
    const parts: Buffer[] = [];
    for (const chunk of chunks) {
      parts.push(Buffer.from(await codec.decodeOpusChunk(stream, chunk.toString("base64")), "base64"));
    }
    codec.freeOpus(stream);
    decoded = Buffer.concat(parts);
  });

  after(() => {
    if (dir) rmSync(dir, { recursive: true, force: true });
  });

  test("gives one chunk out for every chunk in, as the phone sends them", () => {
    assert.equal(chunks.length, Math.ceil(original.length / CHUNK_BYTES));
  });

  test("is about a tenth of the PCM", () => {
    const sent = chunks.reduce((sum, chunk) => sum + chunk.length, 0);
    assert.ok(sent <= original.length / 8, `${sent} bytes of Opus for ${original.length} of PCM`);
  });

  test("decodes back to the same sound, give or take the codec's delay", () => {
    const a = new Int16Array(original.buffer, original.byteOffset, original.length / 2);
    const b = new Int16Array(decoded.buffer, decoded.byteOffset, Math.floor(decoded.length / 2));
    // Everything but the last packet's worth comes back; the encoder keeps the tail.
    assert.ok(b.length >= a.length - 640, `${b.length} samples back of ${a.length}`);
    let best = -1;
    for (let lag = -400; lag <= 400; lag += 2) {
      best = Math.max(best, correlation(a, b, lag));
    }
    assert.ok(best > 0.9, `correlation ${best.toFixed(3)}`);
  });
});
