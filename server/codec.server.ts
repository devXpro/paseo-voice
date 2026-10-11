import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import { gunzipSync } from "node:zlib";
import { statOnDisk } from "./asar.server.ts";
import { paths } from "./paths.server.ts";

/**
 * The Opus decoder the daemon's voice session loads to hear a phone that compresses its
 * microphone.
 *
 * The daemon cannot import anything from this plugin — the plugin is bundled and runs in
 * a process of its own — so the decoder lives in `~/.paseo-voice/codec`, where the
 * correction in `voice-session.js` finds it by path. It is `opus-decoder`'s self-contained
 * build, the WebAssembly inline, fetched once from the npm registry like the engine and
 * the music are fetched: one pinned version, checked against the registry's own integrity
 * hash and against the hash of the file inside, which is the file the tests ran.
 */

/** opus-decoder 0.7.12, MIT, Ethan Halsall; libopus inside it, BSD-3-Clause, Xiph.Org. */
const PACKAGE = {
  tarball: "https://registry.npmjs.org/opus-decoder/-/opus-decoder-0.7.12.tgz",
  integrity: "sha512-6zpHFDi/MhYvMwyYiuJPqJ2lcRkfm7wHblSvT3lUtx/kLvHkunoe/rhTn1dLKxqVGLeQj3gQi7CnR0N2p3RuOg==",
  file: "package/dist/opus-decoder.min.js",
  sha256: "68a08546a23df78bc837808af82af5a7550899ed5e17e281826dc2b3320dccdf",
};

export const CODEC_DIR = path.join(paths.root, "codec");
const DECODER = path.join(CODEC_DIR, "opus-decoder.min.js");
/** What the daemon imports; the correction spells the same path out. */
export const CODEC_ENTRY = path.join(CODEC_DIR, "opus.mjs");

/**
 * The one place a phone's compressed microphone becomes PCM again. Both corrections that
 * take it — voice mode in `voice-session.js`, dictation in `dictation-stream-manager.js` —
 * only call `decodeOpusChunk` and `freeOpus`; the tests decode with it too.
 */
const ENTRY = `// Written by paseo-voice: how the daemon hears a phone that compresses its microphone.
// opus-decoder (MIT, Ethan Halsall) with libopus (BSD-3-Clause, Xiph.Org).
import { Buffer } from "node:buffer";
import { readFileSync } from "node:fs";
import vm from "node:vm";

const source = readFileSync(new URL("./opus-decoder.min.js", import.meta.url), "utf8");
const module = { exports: {} };
// A CommonJS shape, so the bundle hands over its exports instead of making a global; the
// Web Worker it asks for is only used off the main thread, which this never is.
vm.runInThisContext(\`(function (exports, require, module) {\${source}\\n})\`, { filename: "opus-decoder.min.js" })(
  module.exports,
  () => class Worker {},
  module,
);
export const { OpusDecoder } = module.exports;

/** One decoder per stream: a voice session, a dictation. Opus carries state between packets. */
const decoders = new WeakMap();

/**
 * A chunk as the phone sends it — 20 ms Opus packets, each prefixed with its length as a
 * little-endian u16, in base64 — as the 16 kHz PCM16 the daemon hears, in base64.
 */
export async function decodeOpusChunk(owner, audioBase64) {
  let ready = decoders.get(owner);
  if (!ready) {
    ready = (async () => {
      const decoder = new OpusDecoder({ sampleRate: 16000, channels: 1 });
      await decoder.ready;
      return decoder;
    })();
    decoders.set(owner, ready);
  }
  const decoder = await ready;
  const framed = Buffer.from(audioBase64, "base64");
  const parts = [];
  for (let at = 0; at + 2 <= framed.length; ) {
    const size = framed.readUInt16LE(at);
    const { channelData, samplesDecoded } = decoder.decodeFrame(framed.subarray(at + 2, at + 2 + size));
    at += 2 + size;
    const pcm = Buffer.alloc(samplesDecoded * 2);
    for (let index = 0; index < samplesDecoded; index += 1) {
      const sample = Math.round((channelData[0]?.[index] ?? 0) * 32768);
      pcm.writeInt16LE(Math.max(-32768, Math.min(32767, sample)), index * 2);
    }
    parts.push(pcm);
  }
  return Buffer.concat(parts).toString("base64");
}

/** The stream is over; the next one from the same owner starts a fresh decoder. */
export function freeOpus(owner) {
  const ready = decoders.get(owner);
  decoders.delete(owner);
  void ready?.then((decoder) => decoder.free(), () => {});
}
`;

const sha256 = (bytes: Uint8Array | string): string => createHash("sha256").update(bytes).digest("hex");

/** One file out of a tarball: ustar headers, 512-byte blocks, nothing more is needed. */
export function untar(tar: Buffer, wanted: string): Buffer | null {
  for (let at = 0; at + 512 <= tar.length; ) {
    const header = tar.subarray(at, at + 512);
    if (header.every((byte) => byte === 0)) {
      return null;
    }
    const field = (from: number, length: number) =>
      header.toString("utf8", from, from + length).replace(/\0.*$/s, "");
    const prefix = field(345, 155);
    const name = prefix ? `${prefix}/${field(0, 100)}` : field(0, 100);
    const size = Number.parseInt(field(124, 12).trim() || "0", 8);
    const type = field(156, 1);
    if (name === wanted && (type === "0" || type === "")) {
      return tar.subarray(at + 512, at + 512 + size);
    }
    at += 512 + Math.ceil(size / 512) * 512;
  }
  return null;
}

/** The decoder from the registry, checked twice; throws on anything else. */
async function download(): Promise<Buffer> {
  const response = await fetch(PACKAGE.tarball, { signal: AbortSignal.timeout(30_000) });
  if (!response.ok) {
    throw new Error(`npm: ${response.status} for ${PACKAGE.tarball}`);
  }
  const tarball = Buffer.from(await response.arrayBuffer());
  const integrity = `sha512-${createHash("sha512").update(tarball).digest("base64")}`;
  if (integrity !== PACKAGE.integrity) {
    throw new Error("opus-decoder: the tarball's hash is not the pinned one");
  }
  const file = untar(gunzipSync(tarball), PACKAGE.file);
  if (!file || sha256(file) !== PACKAGE.sha256) {
    throw new Error("opus-decoder: the decoder inside the tarball is not the pinned one");
  }
  return file;
}

async function writeAtomically(file: string, bytes: Uint8Array | string): Promise<void> {
  const staged = `${file}.tmp`;
  await writeFile(staged, bytes);
  await rename(staged, file);
}

/** Puts the decoder in place if it is missing or not the pinned one; fetched at most once. */
export async function ensureCodec(): Promise<void> {
  await mkdir(CODEC_DIR, { recursive: true });
  const present = await readFile(DECODER).catch(() => null);
  if (!present || sha256(present) !== PACKAGE.sha256) {
    await writeAtomically(DECODER, await download());
  }
  if ((await readFile(CODEC_ENTRY, "utf8").catch(() => "")) !== ENTRY) {
    await writeAtomically(CODEC_ENTRY, ENTRY);
  }
}

export function codecPresent(): boolean {
  return existsSync(CODEC_ENTRY) && existsSync(DECODER);
}

/**
 * Whether the daemon running now has the code that is in the archive on disk: it started
 * after the archive was last written. The plugin process is the daemon's child, so its
 * parent's uptime is the daemon's. A second of slack for `ps`, which counts whole seconds.
 */
export async function daemonLoadedArchive(archivePath: string, uptimeSeconds: number | null): Promise<boolean> {
  if (uptimeSeconds === null || !archivePath) {
    return false;
  }
  try {
    const written = statOnDisk(archivePath).mtimeMs;
    const started = Date.now() - uptimeSeconds * 1000;
    return started > written + 1000;
  } catch {
    return false;
  }
}
