import assert from "node:assert/strict";
import { mkdtemp, rm, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { daemonLoadedArchive, untar } from "./codec.server.ts";

/** A ustar header and its data, padded to whole blocks: what `npm pack` writes. */
function entry(name: string, data: string): Buffer {
  const header = Buffer.alloc(512);
  header.write(name, 0, "utf8");
  header.write(`${data.length.toString(8).padStart(11, "0")}\0`, 124, "utf8");
  header.write("0", 156, "utf8");
  header.write("ustar\0", 257, "utf8");
  const body = Buffer.alloc(Math.ceil(data.length / 512) * 512);
  body.write(data, 0, "utf8");
  return Buffer.concat([header, body]);
}

test("one file comes out of a tarball, the others are stepped over", () => {
  const tar = Buffer.concat([
    entry("package/package.json", '{"name":"x"}'),
    entry("package/dist/opus-decoder.min.js", "decoder".repeat(100)),
    Buffer.alloc(1024),
  ]);
  assert.equal(untar(tar, "package/dist/opus-decoder.min.js")?.toString("utf8"), "decoder".repeat(100));
  assert.equal(untar(tar, "package/missing.js"), null);
});

test("an archive written after the daemon started is not loaded in it", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "voice-codec-"));
  const archive = path.join(dir, "app.asar");
  try {
    await writeFile(archive, "x");
    // Written a minute ago; a daemon up for two minutes started before that.
    const minuteAgo = new Date(Date.now() - 60_000);
    await utimes(archive, minuteAgo, minuteAgo);
    assert.equal(await daemonLoadedArchive(archive, 120), false);
    // One up for thirty seconds started after it, and has what is on disk.
    assert.equal(await daemonLoadedArchive(archive, 30), true);
    // Nothing known about the daemon: no.
    assert.equal(await daemonLoadedArchive(archive, null), false);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
