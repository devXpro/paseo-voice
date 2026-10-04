import { createHash } from "node:crypto";
import { chmod, mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { ENGINE_ASSET, ENGINE_RELEASE, ENGINE_REPO } from "../shared/voice.shared.ts";
import { paths } from "./paths.server.ts";

const base = `https://github.com/${ENGINE_REPO}/releases/download/${ENGINE_RELEASE}`;

type Stamp = { release: string; asset: string; sha256: string };

async function readStamp(): Promise<Stamp | null> {
  try {
    return JSON.parse(await readFile(paths.binaryStamp, "utf8")) as Stamp;
  } catch {
    return null;
  }
}

/**
 * Whether the binary on disk is the release this build expects. A stamp that names an
 * older release counts as missing, so an upgrade of the plugin pulls the matching engine
 * instead of silently running whatever happened to be there.
 */
export async function installedRelease(): Promise<string> {
  const stamp = await readStamp();
  return stamp?.release === ENGINE_RELEASE ? stamp.release : "";
}

/** The expected digest for our asset, parsed out of the release's SHA256SUMS. */
async function expectedDigest(signal?: AbortSignal): Promise<string> {
  const response = await fetch(`${base}/SHA256SUMS`, { signal });
  if (!response.ok) {
    throw new Error(`SHA256SUMS: ${response.status} ${response.statusText}`);
  }
  for (const line of (await response.text()).split("\n")) {
    // `<hex>  <name>` — two spaces in the canonical output, but be lenient.
    const [hex, name] = line.trim().split(/\s+/);
    if (name === ENGINE_ASSET && hex) {
      return hex.toLowerCase();
    }
  }
  throw new Error(`SHA256SUMS has no entry for ${ENGINE_ASSET}`);
}

export type Progress = (downloaded: number, total: number) => void;

/**
 * Fetches the engine into place, verifying it against the release's own checksum before
 * it is made executable. Downloads to a temporary name and renames: a half-written file
 * that still had the executable bit would be worse than no file at all.
 */
export async function installBinary(onProgress?: Progress, signal?: AbortSignal): Promise<void> {
  const digest = await expectedDigest(signal);
  const response = await fetch(`${base}/${ENGINE_ASSET}`, { signal });
  if (!response.ok || !response.body) {
    throw new Error(`${ENGINE_ASSET}: ${response.status} ${response.statusText}`);
  }

  const total = Number(response.headers.get("content-length") ?? 0);
  const hash = createHash("sha256");
  const chunks: Buffer[] = [];
  let downloaded = 0;
  const reader = response.body.getReader();
  for (;;) {
    const { done, value } = await reader.read();
    if (done) {
      break;
    }
    const buffer = Buffer.from(value);
    hash.update(buffer);
    chunks.push(buffer);
    downloaded += buffer.length;
    onProgress?.(downloaded, total);
  }

  const actual = hash.digest("hex");
  if (actual !== digest) {
    throw new Error(`checksum mismatch: expected ${digest}, got ${actual}`);
  }

  await mkdir(paths.binaryDir, { recursive: true });
  const staged = path.join(paths.binaryDir, `.${ENGINE_ASSET}.partial`);
  await writeFile(staged, Buffer.concat(chunks));
  await chmod(staged, 0o755);
  await rename(staged, paths.binary);
  await writeFile(
    paths.binaryStamp,
    JSON.stringify({ release: ENGINE_RELEASE, asset: ENGINE_ASSET, sha256: actual } satisfies Stamp, null, 2),
  );
}

export async function removeBinary(): Promise<void> {
  await rm(paths.binary, { force: true });
  await rm(paths.binaryStamp, { force: true });
}
