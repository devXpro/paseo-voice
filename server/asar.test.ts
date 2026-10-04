import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { locate, readArchive, readEntry, writeEntry } from "./asar.server.ts";

/**
 * Builds a miniature asar by hand, in the layout Electron actually writes: an outer
 * pickle holding the size of an inner one, and inside that a string length before the
 * JSON. Getting this wrong by four bytes is what made the first version of the reader
 * fail on a real archive with a parse error, so the fixture is written out the long way
 * rather than borrowed from the code under test.
 */
async function buildArchive(files: Record<string, string>): Promise<string> {
  const header = { files: {} as Record<string, { size: number; offset: string }> };
  const bodies: Buffer[] = [];
  let at = 0;
  for (const [name, text] of Object.entries(files)) {
    const bytes = Buffer.from(text, "utf8");
    header.files[name] = { size: bytes.length, offset: String(at) };
    bodies.push(bytes);
    at += bytes.length;
  }
  const json = Buffer.from(JSON.stringify(header), "utf8");

  // The inner pickle: [payload length][string length][string], padded to 4 bytes.
  const padding = (4 - (json.length % 4)) % 4;
  const inner = Buffer.alloc(8 + json.length + padding);
  inner.writeUInt32LE(4 + json.length + padding, 0);
  inner.writeUInt32LE(json.length, 4);
  json.copy(inner, 8);

  // The outer pickle: [payload length = 4][size of the inner one].
  const outer = Buffer.alloc(8);
  outer.writeUInt32LE(4, 0);
  outer.writeUInt32LE(inner.length, 4);

  const file = path.join(await mkdtemp(path.join(tmpdir(), "paseo-voice-asar-")), "app.asar");
  await writeFile(file, Buffer.concat([outer, inner, ...bodies]));
  return file;
}

test("a file is found at the right place in the archive", async () => {
  const file = await buildArchive({ "one.js": "console.log(1)", "two.js": "console.log(22)" });
  const archive = await readArchive(file);

  const one = locate(archive, "one.js");
  const two = locate(archive, "two.js");
  assert.equal(one?.size, 14);
  assert.equal(two?.size, 15);
  assert.equal((await readEntry(file, one!)).toString("utf8"), "console.log(1)");
  assert.equal((await readEntry(file, two!)).toString("utf8"), "console.log(22)");
});

test("a missing path is null rather than a throw", async () => {
  const archive = await readArchive(await buildArchive({ "one.js": "x" }));
  assert.equal(locate(archive, "nope.js"), null);
  assert.equal(locate(archive, "one.js/deeper"), null);
});

test("a replacement of the same length lands, and its neighbour is untouched", async () => {
  const file = await buildArchive({ "one.js": "console.log(1)", "two.js": "console.log(22)" });
  const archive = await readArchive(file);
  const one = locate(archive, "one.js")!;

  await writeEntry(file, one, Buffer.from("console.log(9)", "utf8"));

  assert.equal((await readEntry(file, one)).toString("utf8"), "console.log(9)");
  // The whole point of equal lengths: everything after it still sits where the header says.
  assert.equal((await readEntry(file, locate(archive, "two.js")!)).toString("utf8"), "console.log(22)");
});

test("a replacement of a different length is refused, not written", async () => {
  const file = await buildArchive({ "one.js": "console.log(1)", "two.js": "console.log(22)" });
  const before = await readFile(file);
  const archive = await readArchive(file);

  await assert.rejects(() => writeEntry(file, locate(archive, "one.js")!, Buffer.from("short")), /не совпадает/);
  // Writing it would shift every following file under a header that still points at the
  // old places — a corrupt archive with no error message.
  assert.deepEqual(await readFile(file), before);
});

test("something that is not an archive is rejected", async () => {
  const file = path.join(await mkdtemp(path.join(tmpdir(), "paseo-voice-asar-")), "nope.asar");
  await writeFile(file, Buffer.alloc(64, 0));
  await assert.rejects(() => readArchive(file));
});
