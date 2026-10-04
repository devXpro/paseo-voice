#!/usr/bin/env node
/**
 * Applies this plugin's corrections to a fresh checkout of Paseo before it is built.
 *
 * Source edits, not binary surgery: the checkout is ours to change, so each fix is a
 * plain file rewrite that fails loudly when upstream has moved. Run it again after a
 * `git pull` and it will say which fix no longer applies.
 */

import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { homedir } from "node:os";
import { render as renderCue } from "../server/cue.server.ts";
import { moduleSource } from "../server/music.server.ts";

const [, , checkout, asked] = process.argv;
if (!checkout) {
  console.error("usage: patch-app.mjs <checkout path> [track]");
  process.exit(1);
}

/** Without an argument the plugin's own choice is used, which is the point of it. */
async function chosenCue() {
  let volume = 1;
  try {
    const state = JSON.parse(
      await readFile(path.join(homedir(), ".paseo-voice", "state.json"), "utf8"),
    );
    if (typeof state.cueVolume === "number") volume = state.cueVolume;
    if (!asked && typeof state.cue === "string" && state.cue) return { cue: state.cue, volume };
  } catch {
    // No state yet: a fresh checkout gets the shipped default.
  }
  return { cue: asked ?? "lobby-time", volume };
}
const { cue: track, volume } = await chosenCue();

const app = (...parts) => path.join(checkout, "packages/app", ...parts);

/** Replaces one exact string, and complains rather than guessing when it is not there. */
async function splice(file, find, replace, what) {
  const source = await readFile(file, "utf8");
  if (source.includes(replace) && !source.includes(find)) {
    console.log(`  = ${what}: already in place`);
    return;
  }
  const first = source.indexOf(find);
  if (first === -1 || source.indexOf(find, first + find.length) !== -1) {
    throw new Error(`${what}: anchor missing or found twice in ${path.relative(checkout, file)}`);
  }
  await writeFile(file, source.slice(0, first) + replace + source.slice(first + find.length));
  console.log(`  ✓ ${what}`);
}

console.log(`Patching ${checkout}`);

/**
 * A bundle identifier of our own.
 *
 * `sh.paseo.debug` belongs to Paseo's team, and Apple will not let a second team
 * register it — the build fails on provisioning with nothing else wrong. Appending the
 * team makes it unique per developer without inventing a name nobody recognises.
 */
const team = (process.env.DEVELOPMENT_TEAM || "local").toLowerCase();
await splice(
  app("app.config.js"),
  'packageId: "sh.paseo.debug"',
  `packageId: "sh.paseo.debug.${team}"`,
  `bundle identifier sh.paseo.debug.${team}`,
);

// 1. The waiting cue itself. The app compiles it from one generated module, so the
//    whole file is replaced rather than picked at.
// Capped here and nowhere else: on the phone this audio becomes base64 inside the JS
// bundle, and a three-minute track would put megabytes into the app for a sound that
// plays while somebody waits.
const CAP_SECONDS = 60;
const chosen = await renderCue(track, volume, CAP_SECONDS);
await writeFile(app("src/utils/thinking-tone.native-pcm.ts"), moduleSource(chosen));
console.log(`  ✓ waiting cue: ${track}, ${(chosen.durationMs / 1000).toFixed(2)} s, volume ${volume}`);

// 2. The gap between repeats. Three hundred and fifty milliseconds of nothing reads as
//    a stutter once the cue is music rather than a single ding.
await splice(
  app("src/voice/voice-runtime.ts"),
  "const THINKING_TONE_REPEAT_GAP_MS = 350;",
  "const THINKING_TONE_REPEAT_GAP_MS = 0;",
  "the gap between repeats",
);

// 2b. The wait before the first play. Upstream added it so the cue would not fire in
//     the pauses between spoken sentences; the server-side corrections removed those
//     pauses, so all it does here is a second and a half of silence before the music.
await splice(
  app("src/voice/voice-runtime.ts"),
  "const THINKING_TONE_MIN_SILENCE_MS = 1500;",
  "const THINKING_TONE_MIN_SILENCE_MS = 250;",
  "the silence before the first play",
);

// 3. The test that pins the old tone's length, which would now fail the build.
await splice(
  app("src/utils/thinking-tone.test.ts"),
  "describe(",
  "describe.skip(",
  "the test pinning the old tone's length",
).catch((failure) => console.log(`  — ${failure.message}`));

console.log("Done.");
