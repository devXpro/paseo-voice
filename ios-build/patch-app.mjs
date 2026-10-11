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

/**
 * Replaces one exact string, and complains rather than guessing when it is not there.
 *
 * "Already applied" is decided by the replacement being present, not by the anchor
 * being absent. Several of these keep their anchor and add around it, and the older
 * test said such a patch had not been applied yet — so running the patcher twice over
 * one checkout inserted them twice, which the compiler then rejected as a duplicate
 * key. `build.sh` resets the tree first and never saw it; running by hand does.
 */
async function splice(file, find, replace, what) {
  const source = await readFile(file, "utf8");
  if (source.includes(replace)) {
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

// 2b. The wait before the first play. Upstream's second and a half is a guess at
//     "longer than the pause between two spoken sentences", so the cue would not fire
//     inside a reply. Those pauses are real — the daemon sends the next sentence only
//     once the phone has confirmed the last, a round trip through the relay — but
//     correction 7 below knows when a reply is in progress instead of guessing, which
//     leaves this wait to mean only how soon the music starts once the agent thinks.
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

/**
 * 5. Looping, rather than one play and a silence as long as the track.
 *
 * The next play is scheduled after the previous one *finishes* — `engine.play` resolves
 * on completion, not on queueing — and the delay was the track's own length on top of
 * that. For upstream's three-second ding that gave ding, pause, ding, which is what a
 * notification tone should do. For a minute of music it gives a minute of music and
 * then a minute of silence, which reads as the cue having stopped.
 *
 * The length term goes. What is left is the gap, which this plugin already sets to
 * zero, so the track runs continuously.
 */
await splice(
  app("src/voice/voice-runtime.ts"),
  `          cue.timeout = setTimeout(
            playNext,
            THINKING_TONE_NATIVE_PCM_DURATION_MS + THINKING_TONE_REPEAT_GAP_MS,
          );`,
  `          cue.timeout = setTimeout(playNext, THINKING_TONE_REPEAT_GAP_MS);`,
  "the cue loops instead of pausing for its own length",
);

// The constant above was its only use, and an unused import fails the build.
await splice(
  app("src/voice/voice-runtime.ts"),
  `import {
  THINKING_TONE_NATIVE_PCM_BASE64,
  THINKING_TONE_NATIVE_PCM_DURATION_MS,
} from "@/utils/thinking-tone.native-pcm";`,
  `import { THINKING_TONE_NATIVE_PCM_BASE64 } from "@/utils/thinking-tone.native-pcm";`,
  "the now-unused duration import",
);

/**
 * 6. The audio engine, lent to plugin surfaces.
 *
 * A plugin has no way to make a sound. The host gives client bundles react,
 * react-native, zod and react-query, and the plugin API itself offers `copyText` and
 * nothing else of the device — so the audition buttons in this plugin's panel say, on
 * a phone, that there is nothing here to play with. On a desktop they work, because
 * that surface is a browser and a browser has `Audio`.
 *
 * But the app has an engine, the one playing the waiting music and the agent's voice,
 * and plugin bundles are evaluated in this same JavaScript world. So it can simply be
 * handed over. It even reads the sample rate off the source's type and resamples
 * itself, so speech at 24 kHz needs no conversion on the way in.
 *
 * Two edits: the provider publishes the engine it already made, and the module table
 * passes it on. Nothing new is declared external — it rides the react-native module
 * the plugin already imports, so the daemon's bundler needs no changes and an
 * unpatched app simply does not have the field. The panel tests for it and keeps
 * quiet when it is missing, which is what the App Store build will do.
 */
await splice(
  app("src/contexts/voice-context.tsx"),
  `    engineRef.current = engine;`,
  `    // paseo-voice: lent to plugin surfaces, which have no sound of their own.
    (globalThis as { __paseoVoiceEngine?: unknown }).__paseoVoiceEngine = engine;
    engineRef.current = engine;`,
  "the audio engine is published",
);

await splice(
  app("src/plugins/evaluate.ts"),
  `    if (name === "@getpaseo/plugin/client/react-native") {
      return pluginReactNativeRuntime;
    }`,
  `    if (name === "@getpaseo/plugin/client/react-native") {
      // paseo-voice: a plugin cannot otherwise make a sound on a phone. Added to this
      // module rather than a new one so nothing has to become external in the
      // daemon's bundler; a plugin feature-tests the field and does without it.
      const engine = (globalThis as { __paseoVoiceEngine?: unknown }).__paseoVoiceEngine;
      return engine ? { ...pluginReactNativeRuntime, audioEngine: engine } : pluginReactNativeRuntime;
    }`,
  "plugins can reach the audio engine",
);

/**
 * 7. The cue knows when the agent is speaking.
 *
 * The rule is music while the agent thinks, and only then. But a spoken reply arrives
 * as separate sentences, each sent once the phone has confirmed the one before, and the
 * runtime saw only that — a pause, so the cue came in between sentences and again after
 * the last one, in the second the model takes to end its turn. Upstream guessed its way
 * around the first with a 1.5 s wait; neither guess covers the second.
 *
 * The daemon already says when the agent is speaking: `speak` is a tool call, and its
 * `running` and `completed` reach the phone in the agent's stream, before the first
 * sentence and after the last. Nothing passed them to the runtime. Now the session
 * context does, the runtime keeps the cue out while any call is in flight, and for a
 * few seconds after the last one ends — long enough for a turn to close quietly, short
 * enough that an agent which says "running the tests" and gets on with it has its
 * music back.
 *
 * Proved in `e2e/`: red before, green after, and "the cue comes back while the agent
 * works on after saying something" guards against a fix that only silences.
 */
await splice(
  app("src/voice/voice-runtime.ts"),
  "const THINKING_TONE_MIN_SILENCE_MS = 250;",
  `const THINKING_TONE_MIN_SILENCE_MS = 250;
/** paseo-voice: how long the cue stays away once the agent has stopped speaking. */
const THINKING_TONE_AFTER_SPEECH_MS = 3000;`,
  "how long the cue waits after the agent speaks",
);

await splice(
  app("src/voice/voice-runtime.ts"),
  `  onTurnEvent(serverId: string, agentId: string, eventType: TurnEventType): void;
}`,
  `  onTurnEvent(serverId: string, agentId: string, eventType: TurnEventType): void;
  /** paseo-voice: a \`speak\` tool call of the agent started (\`running\`) or ended. */
  onSpeakToolCall(serverId: string, agentId: string, callId: string, status: string): void;
}`,
  "the runtime can be told about speak calls",
);

await splice(
  app("src/voice/voice-runtime.ts"),
  `  const cue: CueState = {
    controller: null,
    timeout: null,
  };`,
  `  const cue: CueState = {
    controller: null,
    timeout: null,
  };
  // paseo-voice: the agent's speak calls in flight, and when the last one ended.
  const speaking = { calls: new Set<string>(), endedAt: 0 };`,
  "the runtime keeps track of speak calls",
);

await splice(
  app("src/voice/voice-runtime.ts"),
  `      state.snapshot.phase === "waiting" &&
      !state.telemetry.isSpeaking
    );`,
  `      state.snapshot.phase === "waiting" &&
      !state.telemetry.isSpeaking &&
      speaking.calls.size === 0
    );`,
  "no cue while the agent is speaking",
);

await splice(
  app("src/voice/voice-runtime.ts"),
  "    cue.timeout = setTimeout(playNext, THINKING_TONE_MIN_SILENCE_MS);",
  `    const sinceSpeech = Date.now() - speaking.endedAt;
    cue.timeout = setTimeout(
      playNext,
      Math.max(THINKING_TONE_MIN_SILENCE_MS, THINKING_TONE_AFTER_SPEECH_MS - sinceSpeech),
    );`,
  "a longer wait right after the agent spoke",
);

await splice(
  app("src/voice/voice-runtime.ts"),
  `      if (eventType === "turn_started") {
        state.turnInProgress = true;`,
  `      // paseo-voice: no speak call outlives a turn boundary.
      speaking.calls.clear();
      if (eventType === "turn_started") {
        speaking.endedAt = 0;
        state.turnInProgress = true;`,
  "a turn boundary clears speak calls",
);

await splice(
  app("src/voice/voice-runtime.ts"),
  `      stopCue();
    },
  };

  return api;`,
  `      stopCue();
    },

    onSpeakToolCall(serverId, agentId, callId, status) {
      if (
        !state.snapshot.isVoiceMode ||
        state.snapshot.activeServerId !== serverId ||
        state.snapshot.activeAgentId !== agentId
      ) {
        return;
      }
      if (status === "running") {
        speaking.calls.add(callId);
      } else if (speaking.calls.delete(callId) && speaking.calls.size === 0) {
        speaking.endedAt = Date.now();
      }
      reconcileCue();
    },
  };

  return api;`,
  "the runtime hears about speak calls",
);

await splice(
  app("src/contexts/session-context.tsx"),
  `import { parseServerInfoStatusPayload } from "@getpaseo/protocol/messages";`,
  `import { parseServerInfoStatusPayload } from "@getpaseo/protocol/messages";
import { isSpeakToolName } from "@getpaseo/protocol/tool-name-normalization";`,
  "the session context can recognise speak",
);

await splice(
  app("src/contexts/session-context.tsx"),
  `        voiceRuntime?.onTurnEvent(serverId, agentId, event.type);
      }`,
  `        voiceRuntime?.onTurnEvent(serverId, agentId, event.type);
      }
      // paseo-voice: a speak call in flight means the agent is talking, not thinking —
      // the runtime holds the waiting music back for its whole length.
      if (event.type === "timeline" && event.item.type === "tool_call" && isSpeakToolName(event.item.name)) {
        voiceRuntime?.onSpeakToolCall(serverId, agentId, event.item.callId, event.item.status);
      }`,
  "speak calls reach the runtime",
);

/**
 * 8. The microphone goes up as Opus, in voice mode and in dictation.
 *
 * The microphone streams to the daemon for as long as voice mode is on and unmuted, and
 * for the whole of a dictation: 16 kHz PCM, about 340 kbit/s once it is base64 — more
 * than a weak mobile uplink carries, and then nothing said gets through. Opus at 24
 * kbit/s is a tenth of it, and iOS encodes it itself (AudioToolbox), so nothing is linked
 * into the app.
 *
 * One module does it for both, `src/audio/opus-uplink.ts`, written here from
 * `ios-build/opus/`: it asks this plugin whether the daemon can take Opus — yes only when
 * the plugin's corrections that decode it are loaded in the daemon running now — and
 * packs the microphone's PCM accordingly. Anything else, and it is PCM, as upstream sends
 * it. Around it: the encoder in the native module, one per stream, with its bindings; and
 * the two places that send the microphone, which now go through the module.
 */
const twoWayAudio = (...parts) => path.join(checkout, "packages/expo-two-way-audio", ...parts);
await writeFile(
  twoWayAudio("ios/VoiceOpusEncoder.swift"),
  await readFile(new URL("./opus/VoiceOpusEncoder.swift", import.meta.url), "utf8"),
);
console.log("  ✓ the Opus encoder is in the native module");
await writeFile(app("src/audio/opus-uplink.ts"), await readFile(new URL("./opus/opus-uplink.ts", import.meta.url), "utf8"));
console.log("  ✓ the app has the shared Opus uplink");

await splice(
  twoWayAudio("ios/ExpoTwoWayAudioModule.swift"),
  `    private var audioEngine: AudioEngine?`,
  `    private var audioEngine: AudioEngine?
    // paseo-voice: one Opus stream per use of the microphone; see VoiceOpusEncoder.
    private var voiceEncoders: [String: VoiceOpusEncoder] = [:]`,
  "the native module keeps Opus encoders",
);

await splice(
  twoWayAudio("ios/ExpoTwoWayAudioModule.swift"),
  `        Function("playPCMData") { (pcmData: Data) in
            self.audioEngine?.playPCMData(pcmData)
        }`,
  `        Function("playPCMData") { (pcmData: Data) in
            self.audioEngine?.playPCMData(pcmData)
        }

        // paseo-voice: the microphone's PCM as Opus for the daemon; nil when this phone
        // cannot encode it, and PCM goes instead.
        Function("encodeOpus") { (stream: String, pcm: Data) -> Data? in
            if self.voiceEncoders[stream] == nil {
                self.voiceEncoders[stream] = VoiceOpusEncoder()
            }
            return self.voiceEncoders[stream]?.encode(pcm)
        }

        Function("resetOpusEncoder") { (stream: String) in
            self.voiceEncoders[stream] = nil
        }`,
  "the native module can encode Opus",
);

await splice(
  twoWayAudio("src/core.ts"),
  `export function playPCMData(audioData: Uint8Array) {
  return ExpoTwoWayAudioModule.playPCMData(audioData);
}`,
  `export function playPCMData(audioData: Uint8Array) {
  return ExpoTwoWayAudioModule.playPCMData(audioData);
}

/** paseo-voice: 16 kHz PCM16 in, length-prefixed Opus packets out — empty while less than
 *  one packet has built up, null when the encoder failed. One encoder per stream. */
export function encodeOpus(stream: string, pcm: Uint8Array): Uint8Array | null {
  return ExpoTwoWayAudioModule.encodeOpus(stream, pcm);
}

/** paseo-voice: the stream's next packet starts a new Opus stream. */
export function resetOpusEncoder(stream: string): void {
  ExpoTwoWayAudioModule.resetOpusEncoder(stream);
}`,
  "the Opus encoder has JS bindings",
);

await splice(
  app("src/voice/voice-runtime.ts"),
  `import type { AudioEngine } from "@/audio";`,
  `import type { AudioEngine } from "@/audio";
import { createOpusUplink } from "@/audio/opus-uplink";`,
  "the runtime has the Opus uplink",
);

await splice(
  app("src/voice/voice-runtime.ts"),
  `  fetchCue?(have: string): Promise<{ tag: string; unchanged: boolean; pcmBase64: string } | null>;
}`,
  `  fetchCue?(have: string): Promise<{ tag: string; unchanged: boolean; pcmBase64: string } | null>;
  /** paseo-voice: whether the daemon takes the microphone as Opus; null when it cannot say. */
  fetchVoiceCodec?(): Promise<{ opus: boolean } | null>;
}`,
  "the adapter can be asked about Opus",
);

await splice(
  app("src/voice/voice-runtime.ts"),
  `  const uploader: ContinuousVoiceUploader = {`,
  `  // paseo-voice: the microphone goes as Opus once the daemon says it takes it — asked at
  // every voice start and reconnect, PCM until then.
  const voiceUplink = createOpusUplink("voice");
  let voiceCodecAsked = 0;
  function refreshVoiceCodec(): void {
    voiceUplink.reset(false);
    const asked = ++voiceCodecAsked;
    const ask = getActiveSession()?.adapter.fetchVoiceCodec;
    if (!ask) {
      return;
    }
    void Promise.resolve(ask())
      .then((answer) => {
        if (asked === voiceCodecAsked && answer?.opus) {
          voiceUplink.reset(true);
        }
      })
      .catch(() => {
        // No plugin, or an older one: PCM, as upstream sends it.
      });
  }

  const uploader: ContinuousVoiceUploader = {`,
  "the runtime asks whether to send Opus",
);

await splice(
  app("src/voice/voice-runtime.ts"),
  `      const base64 = Buffer.from(chunk).toString("base64");

      void activeSession.adapter.sendVoiceAudioChunk(base64, PCM_MIME_TYPE).catch((error) => {`,
  `      // paseo-voice: Opus when the daemon takes it; nothing yet while under one packet.
      const packed = voiceUplink.pack(chunk);
      if (packed.audio.byteLength === 0) {
        return;
      }
      const base64 = Buffer.from(packed.audio).toString("base64");

      void activeSession.adapter.sendVoiceAudioChunk(base64, packed.format).catch((error) => {`,
  "the microphone goes up as Opus when it may",
);

await splice(
  app("src/voice/voice-runtime.ts"),
  `        state.transportReady = true;
        state.turnInProgress = false;
        uploader.reset();`,
  `        state.transportReady = true;
        state.turnInProgress = false;
        uploader.reset();
        refreshVoiceCodec();`,
  "a voice start asks about Opus",
);

await splice(
  app("src/voice/voice-runtime.ts"),
  `      await activeSession.adapter.setVoiceMode(true, state.snapshot.activeAgentId);
      state.transportReady = true;`,
  `      await activeSession.adapter.setVoiceMode(true, state.snapshot.activeAgentId);
      state.transportReady = true;
      // paseo-voice: a reconnect may be to a daemon that has since been restarted.
      refreshVoiceCodec();`,
  "a reconnect asks about Opus again",
);

await splice(
  app("src/contexts/session-context.tsx"),
  `import { isSpeakToolName } from "@getpaseo/protocol/tool-name-normalization";`,
  `import { isSpeakToolName } from "@getpaseo/protocol/tool-name-normalization";
import { daemonTakesOpus } from "@/audio/opus-uplink";`,
  "the session context can ask about Opus",
);

await splice(
  app("src/contexts/session-context.tsx"),
  `        return { tag: answer.tag, unchanged: answer.unchanged === true, pcmBase64: answer.pcmBase64 ?? "" };
      },`,
  `        return { tag: answer.tag, unchanged: answer.unchanged === true, pcmBase64: answer.pcmBase64 ?? "" };
      },
      // paseo-voice: whether the daemon takes the microphone as Opus; see opus-uplink.ts.
      fetchVoiceCodec: async () => ({ opus: await daemonTakesOpus(client) }),`,
  "the phone asks the plugin about Opus",
);

await splice(
  app("src/dictation/dictation-stream-sender.ts"),
  `import { i18n } from "@/i18n/i18next";`,
  `import { i18n } from "@/i18n/i18next";
import { Buffer } from "buffer";
import { createOpusUplink, daemonTakesOpus, OPUS_FORMAT } from "@/audio/opus-uplink";`,
  "dictation has the Opus uplink",
);

await splice(
  app("src/dictation/dictation-stream-sender.ts"),
  `  private readonly createDictationId: () => string;`,
  `  private readonly createDictationId: () => string;
  // paseo-voice: the microphone as Opus when the daemon takes it, decided per stream.
  private readonly uplink = createOpusUplink("dictation");`,
  "a dictation keeps its Opus uplink",
);

await splice(
  app("src/dictation/dictation-stream-sender.ts"),
  `    const start = (async () => {
      await client.startDictationStream(dictationId, this.format);`,
  `    const start = (async () => {
      // paseo-voice: every stream starts the encoder afresh, as the daemon starts a decoder;
      // a stream replayed after a reconnect is encoded again from its first segment.
      this.uplink.reset(await daemonTakesOpus(client as Parameters<typeof daemonTakesOpus>[0]));
      await client.startDictationStream(dictationId, this.format);`,
  "a dictation stream asks about Opus",
);

await splice(
  app("src/dictation/dictation-stream-sender.ts"),
  `      const audio = this.segments[seq];
      try {
        client.sendDictationStreamChunk(dictationId, seq, audio, this.format);`,
  `      // paseo-voice: Opus when the daemon takes it. A segment under one packet still goes,
      // empty, so that every sequence number arrives.
      const packed = this.uplink.pack(Buffer.from(this.segments[seq], "base64"));
      const audio = Buffer.from(packed.audio).toString("base64");
      const format = packed.format === OPUS_FORMAT ? OPUS_FORMAT : this.format;
      try {
        client.sendDictationStreamChunk(dictationId, seq, audio, format);`,
  "dictation goes up as Opus when it may",
);

// 3. The test that pins the old tone's length, which would now fail the build.
await splice(
  app("src/utils/thinking-tone.test.ts"),
  "describe(",
  "describe.skip(",
  "the test pinning the old tone's length",
).catch((failure) => console.log(`  — ${failure.message}`));

console.log("Done.");
