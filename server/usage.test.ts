import assert from "node:assert/strict";
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";

process.env.HOME = await mkdtemp(path.join(tmpdir(), "paseo-voice-usage-"));
const { monthOf, record, resetsAt, summary } = await import("./usage.server.ts");
const { paths } = await import("./paths.server.ts");

test("a month is the key, and it is UTC", () => {
  assert.equal(monthOf(new Date("2026-10-04T23:30:00Z")), "2026-10");
  assert.equal(monthOf(new Date("2026-01-01T00:00:00Z")), "2026-01");
});

test("the allowance starts over on the first of next month", () => {
  assert.equal(resetsAt(new Date("2026-10-04T10:00:00Z")).toISOString(), "2026-11-01T00:00:00.000Z");
  assert.equal(resetsAt(new Date("2026-12-20T10:00:00Z")).toISOString(), "2027-01-01T00:00:00.000Z");
});

test("characters add up per family and nothing leaks between them", async () => {
  await record("chirp3-hd", 1200);
  await record("chirp3-hd", 800);
  await record("standard", 500);

  const rows = await summary();
  const chirp = rows.find((row) => row.id === "chirp3-hd");
  const standard = rows.find((row) => row.id === "standard");
  const wavenet = rows.find((row) => row.id === "wavenet");

  assert.equal(chirp?.used, 2000);
  assert.equal(standard?.used, 500);
  assert.equal(wavenet?.used, 0);
  // Standard carries four times the free allowance for the very same voices.
  assert.equal(standard?.free, 4_000_000);
  assert.equal(chirp?.free, 1_000_000);
});

test("nothing is owed while inside the allowance", async () => {
  const rows = await summary();
  assert.equal(rows.every((row) => row.owed === 0), true);
});

test("past the allowance the overspend is priced, not the whole month", async () => {
  // A million and a half on Chirp: half a million over, at thirty dollars the million.
  await record("chirp3-hd", 1_500_000 - 2000);
  const chirp = (await summary()).find((row) => row.id === "chirp3-hd");
  assert.equal(chirp?.used, 1_500_000);
  assert.ok(Math.abs((chirp?.owed ?? 0) - 15) < 0.001, `ожидал $15, получил ${chirp?.owed}`);
});

test("an unwritten ledger reads as a clean month rather than an error", async () => {
  const rows = await summary("1999-01");
  assert.equal(rows.length, 3);
  assert.equal(rows.every((row) => row.used === 0), true);
});

test("the ledger is kept where the rest of the plugin's state lives", async () => {
  const raw = JSON.parse(await readFile(paths.usage, "utf8")) as Record<string, Record<string, number>>;
  assert.equal(raw[monthOf()]?.["chirp3-hd"], 1_500_000);
});

/**
 * Google bills per character, not per byte — a multi-byte script costs the same as
 * Latin. So the thing to get right is which "character" is meant: `.length` counts
 * UTF-16 units, and anything outside the basic plane takes two of those while Google
 * charges for one.
 */
test("Cyrillic costs what it looks like, and an emoji is one character not two", () => {
  const russian = "Проверка связи";
  assert.equal([...russian].length, 14, "кириллица — по одному символу, не по байтам");
  assert.equal([...russian].length, russian.length, "в основной плоскости расхождения нет");

  const withEmoji = "Готово 👍";
  assert.equal(withEmoji.length, 9, "UTF-16 насчитает лишний");
  assert.equal([...withEmoji].length, 8, "а Google берёт как за восемь");
});
