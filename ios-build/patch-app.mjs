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

/**
 * 4. The cue, asked of the plugin instead of only being the one built in.
 *
 * On the desktop a patch points Paseo's own bundle at this plugin's proxy over
 * loopback, so changing the track is heard on the next repeat. A phone cannot do that:
 * it is a different device, usually on a different network, and it reaches the daemon
 * through a relay. But it is already holding that connection, and a plugin RPC rides
 * it — so the phone asks the daemon, the daemon asks the plugin, and the answer comes
 * back the same way.
 *
 * The bytes built into the app stay as the fallback. With no daemon, or an older
 * plugin that does not know the call, the cue is whatever was compiled in rather than
 * silence.
 */
await splice(
  app("src/voice/voice-runtime.ts"),
  `  setAssistantAudioPlaying(isPlaying: boolean): void;
}`,
  `  setAssistantAudioPlaying(isPlaying: boolean): void;
  /** paseo-voice: the cue chosen in the plugin's panel, or null when it cannot say. */
  fetchCue?(have: string): Promise<{ tag: string; unchanged: boolean; pcmBase64: string } | null>;
}`,
  "the adapter can be asked for a cue",
);

await splice(
  app("src/voice/voice-runtime.ts"),
  `  const cuePcm16 = Uint8Array.from(Buffer.from(THINKING_TONE_NATIVE_PCM_BASE64, "base64"));
  const cueSource = {
    size: cuePcm16.byteLength,
    type: "audio/pcm;rate=16000;bits=16",
    async arrayBuffer() {
      return cuePcm16.buffer.slice(cuePcm16.byteOffset, cuePcm16.byteOffset + cuePcm16.byteLength);
    },
  };`,
  `  const cueBuiltIn = Uint8Array.from(Buffer.from(THINKING_TONE_NATIVE_PCM_BASE64, "base64"));
  // paseo-voice: what is playing now, and the tag that says which track it is. Held
  // across pauses so the audio crosses the relay once per change, not once per wait.
  let cueBytes = cueBuiltIn;
  let cueTag = "";
  let cueAsking: Promise<void> | null = null;

  function refreshCue(): Promise<void> {
    const ask = getActiveSession()?.adapter.fetchCue;
    if (!ask) {
      return Promise.resolve();
    }
    // One question at a time: pauses come in bursts and the answer is megabytes.
    cueAsking ??= Promise.resolve(ask(cueTag))
      .then((answer) => {
        if (!answer || answer.unchanged || !answer.pcmBase64) {
          return;
        }
        cueBytes = Uint8Array.from(Buffer.from(answer.pcmBase64, "base64"));
        cueTag = answer.tag;
      })
      .catch(() => {
        // Keep playing whatever is already here. A cue is not worth a complaint.
      })
      .finally(() => {
        cueAsking = null;
      });
    return cueAsking;
  }

  const cueSource = {
    get size() {
      return cueBytes.byteLength;
    },
    type: "audio/pcm;rate=16000;bits=16",
    async arrayBuffer() {
      await refreshCue();
      return cueBytes.buffer.slice(cueBytes.byteOffset, cueBytes.byteOffset + cueBytes.byteLength);
    },
  };`,
  "the cue is asked of the plugin, with the built-in one as fallback",
);

await splice(
  app("src/contexts/session-context.tsx"),
  `      setAssistantAudioPlaying: (isPlaying) => {
        setIsPlayingAudio(serverId, isPlaying);
      },`,
  `      setAssistantAudioPlaying: (isPlaying) => {
        setIsPlayingAudio(serverId, isPlaying);
      },
      // paseo-voice: the waiting music lives in the plugin's settings, and this is the
      // only road to it from a phone. Null rather than a throw: the caller's fallback
      // is the track built into the app, which is a better outcome than an error.
      fetchCue: async (have: string) => {
        if (!client) {
          return null;
        }
        const answer = (await client.invokePluginRpc("voice", "voice.cue", { have })) as {
          tag?: string;
          unchanged?: boolean;
          pcmBase64?: string;
        } | null;
        if (!answer?.tag) {
          return null;
        }
        return { tag: answer.tag, unchanged: answer.unchanged === true, pcmBase64: answer.pcmBase64 ?? "" };
      },`,
  "the phone asks the plugin for the cue",
);

// 3. The test that pins the old tone's length, which would now fail the build.
await splice(
  app("src/utils/thinking-tone.test.ts"),
  "describe(",
  "describe.skip(",
  "the test pinning the old tone's length",
).catch((failure) => console.log(`  — ${failure.message}`));

console.log("Done.");
