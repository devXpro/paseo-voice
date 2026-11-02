import assert from "node:assert/strict";
import { mkdir, mkdtemp, open, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, before, test } from "node:test";

/**
 * The recogniser's process bookkeeping, against a stand-in \`whisper-server\`: a script
 * that takes a moment to load, as the real one does, and a moment to go when told to —
 * which is what turned a restart into a lost process. The plugin's paths are read from
 * the home directory at import, so the module is imported once, after HOME points
 * somewhere of the tests' own, with a sparse file standing in for the weights.
 *
 * Every stand-in writes down its pid and the end of the file kills whatever is left. A
 * process the recogniser lost track of is exactly what these tests look for, and one left
 * running would keep this file from ever finishing instead of failing it. A stand-in that
 * finds its port taken writes that down too: two at once is the race itself, whichever of
 * the two happens to win the port.
 */
let home = "";
let engine = "";
/** The build before whisper.cpp 1.8.3: it lists `--no-context` in its help and takes it. */
let legacy = "";
/** One whose weights will not load: it says so on stderr, as the real one does, and goes. */
let broken = "";
/** One that refuses an argument: the complaint first, then the whole usage, then exit code 0. */
let refusing = "";
let createRecogniser: typeof import("./whisper.server.ts").createRecogniser;

const MODEL = "large-v3-turbo-q8_0";
const ledger = () => path.join(home, "ledger");

/**
 * A stand-in `whisper-server` that reads its arguments as the real one does: one it does
 * not know ends it, with the complaint and then the whole usage on stderr and an exit code
 * of 0. That is what happened when whisper.cpp 1.8.3 dropped `--no-context` and the plugin
 * went on passing it — a stand-in that took any argument never saw it.
 */
const standIn = (older: boolean) => `#!/usr/bin/env node
import { appendFileSync, writeSync } from "node:fs";
import { createServer } from "node:http";
const OLDER = ${older};
const args = process.argv.slice(2);
const value = (name) => args[args.indexOf(name) + 1];
const note = (what) => appendFileSync(${JSON.stringify(ledger())}, [process.pid, value("--port"), what].join(" ") + "\\n");
const usage = () => writeSync(2, [
  "usage: whisper-server [options]",
  "options:",
  "  -h,  --help       show this help message and exit",
  ...(OLDER ? ["  -nc, --no-context [false  ] do not use previous audio context"] : []),
  "  -vm FNAME, --vad-model FNAME  VAD model path",
  "",
].join("\\n"));
const TAKE_A_VALUE = ["--model", "--host", "--port", "--language", "--threads", "--prompt"];
for (let at = 0; at < args.length; at += 1) {
  if (args[at] === "--help" || args[at] === "-h") {
    usage();
    process.exit(0);
  }
  if (TAKE_A_VALUE.includes(args[at])) {
    at += 1;
  } else if (!(OLDER && args[at] === "--no-context")) {
    writeSync(2, "error: unknown argument: " + args[at] + "\\n");
    usage();
    process.exit(0);
  }
}
note("started");
if (args.includes("--no-context")) {
  note("no-context");
}
// Its whole log goes to stderr, as the real one's does.
writeSync(2, "whisper_init_state: compute buffer (decode) =  100.03 MB\\n");
const server = createServer((request, response) => {
  // The real one prints to stdout for every request, and a pipe nobody reads fills up.
  if (request.headers["x-chatty"]) {
    writeSync(1, "x".repeat(300_000) + "\\n");
  }
  response.writeHead(200, { "content-type": "application/json" });
  response.end(JSON.stringify({ text: "language=" + value("--language") }));
});
server.on("error", () => {
  note("clashed");
  process.exit(1);
});
// Loading the weights: the port is only taken after a while.
setTimeout(() => server.listen(Number(value("--port")), "127.0.0.1"), 150);
// Going: the port is held a little after being told, as a process shutting down does.
process.on("SIGTERM", () => setTimeout(() => process.exit(0), 300));
`;

before(async () => {
  home = await mkdtemp(path.join(tmpdir(), "paseo-voice-whisper-"));
  process.env.HOME = home;
  const models = path.join(home, ".paseo-voice", "models", "whisper");
  await mkdir(models, { recursive: true });
  // Sparse: the size the check wants, none of the disk.
  const weights = await open(path.join(models, "ggml-large-v3-turbo-q8_0.bin"), "w");
  await weights.truncate(874_188_075);
  await weights.close();
  engine = path.join(home, "fake-whisper-server.mjs");
  await writeFile(engine, standIn(false), { mode: 0o755 });
  legacy = path.join(home, "legacy-whisper-server.mjs");
  await writeFile(legacy, standIn(true), { mode: 0o755 });
  broken = path.join(home, "broken-whisper-server.mjs");
  await writeFile(
    broken,
    `#!/usr/bin/env node
import { writeSync } from "node:fs";
writeSync(2, "whisper_init_from_file: loading model\\n");
setTimeout(() => {
  writeSync(2, "error: failed to load the model\\n");
  process.exit(1);
}, 100);
`,
    { mode: 0o755 },
  );
  refusing = path.join(home, "refusing-whisper-server.mjs");
  await writeFile(
    refusing,
    `#!/usr/bin/env node
import { writeSync } from "node:fs";
writeSync(2, "error: unknown argument: --frobnicate\\n");
writeSync(2, "usage: whisper-server [options]\\noptions:\\n  -h,  --help       show this help message and exit\\n  -vm FNAME, --vad-model FNAME  VAD model path\\n");
process.exit(0);
`,
    { mode: 0o755 },
  );
  ({ createRecogniser } = await import("./whisper.server.ts"));
});

after(async () => {
  for (const pid of await living()) {
    process.kill(pid, "SIGKILL");
  }
  await rm(home, { recursive: true, force: true });
});

/** What the stand-ins wrote down — on one port, or anywhere. */
async function entries(port?: number): Promise<{ pid: number; what: string }[]> {
  const lines = (await readFile(ledger(), "utf8").catch(() => "")).split("\n").filter(Boolean);
  return lines
    .map((line) => line.split(" "))
    .filter(([, on]) => port === undefined || Number(on) === port)
    .map(([pid, , what]) => ({ pid: Number(pid), what: what ?? "" }));
}

/** The stand-ins still running, whoever started them. */
async function living(port?: number): Promise<number[]> {
  return (await entries(port))
    .filter(({ what }) => what === "started")
    .map(({ pid }) => pid)
    .filter((pid) => {
      try {
        process.kill(pid, 0);
        return true;
      } catch {
        return false;
      }
    });
}

/** How often a stand-in found another one on its port. */
const clashes = async (port: number) => (await entries(port)).filter(({ what }) => what === "clashed").length;

const settle = () => new Promise((wake) => setTimeout(wake, 600));

const heard = async (port: number) =>
  ((await (await fetch(`http://127.0.0.1:${port}/inference`, { method: "POST" })).json()) as { text: string }).text;

test("a restart in another language leaves one engine running, in the new language", { timeout: 10_000 }, async () => {
  const port = 18_000 + Math.floor(Math.random() * 1000);
  const recogniser = createRecogniser({ port, engine: async () => engine });
  try {
    await recogniser.ensure(MODEL, "en", "");
    assert.equal(await heard(port), "language=en");
    await recogniser.ensure(MODEL, "ru", "");
    // The first one ending late must not take the second one's place in the books.
    await settle();
    assert.equal(recogniser.running(), true);
    assert.equal(await heard(port), "language=ru");
    assert.equal((await living(port)).length, 1);
    assert.equal(await clashes(port), 0);
  } finally {
    recogniser.stop();
  }
});

test("two changes in a row, the second before the first is up, end in the second", { timeout: 10_000 }, async () => {
  const port = 19_000 + Math.floor(Math.random() * 1000);
  const recogniser = createRecogniser({ port, engine: async () => engine });
  try {
    await recogniser.ensure(MODEL, "ru", "");
    await Promise.all([
      recogniser.ensure(MODEL, "en", ""),
      new Promise((wake) => setTimeout(wake, 50)).then(() => recogniser.ensure(MODEL, "uk", "")),
    ]);
    await settle();
    assert.equal(recogniser.running(), true);
    assert.equal(await heard(port), "language=uk");
    assert.equal((await living(port)).length, 1);
    assert.equal(await clashes(port), 0);
  } finally {
    recogniser.stop();
  }
});

test("a stop while the engine is on its way leaves nothing running", { timeout: 10_000 }, async () => {
  const port = 20_000 + Math.floor(Math.random() * 1000);
  const recogniser = createRecogniser({ port, engine: async () => engine });
  try {
    // What a plugin reload does to a start still checking its files: the start must not
    // carry on into a process nobody will ever stop, holding the port the next one needs.
    const starting = recogniser.ensure(MODEL, "en", "");
    recogniser.stop();
    await starting;
    await settle();
    assert.equal(recogniser.running(), false);
    assert.deepEqual(await living(port), []);
  } finally {
    recogniser.stop();
  }
});

test("a running engine's own log is not taken for a failure", { timeout: 10_000 }, async () => {
  const port = 21_000 + Math.floor(Math.random() * 1000);
  const recogniser = createRecogniser({ port, engine: async () => engine });
  try {
    await recogniser.ensure(MODEL, "en", "");
    await settle();
    assert.equal(recogniser.running(), true);
    assert.equal(recogniser.lastError(), "");
  } finally {
    recogniser.stop();
  }
});

test("an engine that dies while loading fails the start, and says why", { timeout: 10_000 }, async () => {
  const port = 22_000 + Math.floor(Math.random() * 1000);
  const recogniser = createRecogniser({ port, engine: async () => broken });
  try {
    await assert.rejects(recogniser.ensure(MODEL, "en", ""), /failed to load the model/);
    assert.equal(recogniser.running(), false);
    assert.equal(recogniser.lastError(), "error: failed to load the model");
  } finally {
    recogniser.stop();
  }
});

test("an engine that no longer takes --no-context is not given it, an older one that lists it is", { timeout: 10_000 }, async () => {
  const newerPort = 23_000 + Math.floor(Math.random() * 1000);
  const olderPort = 24_000 + Math.floor(Math.random() * 1000);
  const newer = createRecogniser({ port: newerPort, engine: async () => engine });
  const older = createRecogniser({ port: olderPort, engine: async () => legacy });
  try {
    await newer.ensure(MODEL, "en", "");
    await older.ensure(MODEL, "en", "");
    assert.equal(newer.running(), true);
    assert.equal(older.running(), true);
    // Whisper carries on in the language of the sentences before it unless it is told not
    // to, so the build that has the flag must be given it.
    assert.deepEqual((await entries(newerPort)).map(({ what }) => what), ["started"]);
    assert.deepEqual((await entries(olderPort)).map(({ what }) => what).sort(), ["no-context", "started"]);
  } finally {
    newer.stop();
    older.stop();
  }
});

test("an engine that refuses an argument fails the start with the refusal, not the end of its help", { timeout: 10_000 }, async () => {
  const port = 25_000 + Math.floor(Math.random() * 1000);
  const lines: string[] = [];
  const recogniser = createRecogniser({ port, engine: async () => refusing, log: (line) => lines.push(line) });
  try {
    await assert.rejects(recogniser.ensure(MODEL, "en", ""), /error: unknown argument: --frobnicate/);
    assert.equal(recogniser.lastError(), "error: unknown argument: --frobnicate");
    // Its going is in the daemon's log too, with the reason.
    assert.ok(
      lines.some((line) => line.includes("whisper-server exited") && line.includes("--frobnicate")),
      lines.join("\n"),
    );
  } finally {
    recogniser.stop();
  }
});

test("an engine's output on stdout, which nobody reads, never stops it answering", { timeout: 10_000 }, async () => {
  const port = 26_000 + Math.floor(Math.random() * 1000);
  const recogniser = createRecogniser({ port, engine: async () => engine });
  try {
    await recogniser.ensure(MODEL, "en", "");
    // The real one prints three lines for every request. A pipe that is never read fills
    // up after a few of them and holds the whole server.
    for (let request = 0; request < 3; request += 1) {
      const answer = await fetch(`http://127.0.0.1:${port}/inference`, {
        method: "POST",
        headers: { "x-chatty": "1" },
        signal: AbortSignal.timeout(2_000),
      });
      assert.equal(answer.status, 200);
    }
  } finally {
    recogniser.stop();
  }
});
