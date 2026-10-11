import { Buffer } from "node:buffer";
import { createNativeAudio } from "./native-audio.ts";
import { engineSpecifier } from "./paseo-source.ts";
import { labelOf, rememberCue } from "./speech.ts";
import type { Timeline } from "./timeline.ts";

/**
 * The phone, as far as voice goes: Paseo's own voice runtime and native audio engine, from
 * the patched checkout, with only the native module swapped for a speaker that keeps time
 * and a microphone the harness can talk into. Everything between "a frame came off the
 * microphone" and "send it", and between "a chunk of speech arrived" and "tell the daemon
 * it has played", is the phone's real code.
 */

export type TurnEvent = "turn_started" | "turn_completed" | "turn_failed" | "turn_canceled";

/** `audio_output`, as the daemon sends it. */
export type AudioOutput = {
  id: string;
  groupId?: string;
  chunkIndex?: number;
  isLastChunk?: boolean;
  audio: string;
  format: string;
  isVoiceMode: boolean;
};

export type CueAnswer = { tag: string; unchanged: boolean; pcmBase64: string } | null;

/** The slice of Paseo's voice runtime driven here — typed locally, since the runtime
 *  itself is loaded from the checkout and this repository's typecheck never sees it. */
type VoiceRuntime = {
  subscribe(listener: () => void): () => void;
  getSnapshot(): { phase: string };
  registerSession(adapter: unknown): () => void;
  startVoice(serverId: string, agentId: string): Promise<void>;
  handleCapturePcm(chunk: Uint8Array): void;
  handleCaptureVolume(level: number): void;
  handleAudioOutput(serverId: string, payload: AudioOutput): void;
  onTranscriptionResult(serverId: string, text: string): void;
  onServerSpeechStateChanged(serverId: string, isSpeaking: boolean): void;
  onTurnEvent(serverId: string, agentId: string, event: TurnEvent): void;
  /** Only in a build carrying paseo-voice's correction for it; see `ios-build/patch-app.mjs`. */
  onSpeakToolCall?(serverId: string, agentId: string, callId: string, status: string): void;
  destroy(): Promise<void>;
};

export type PhoneOptions = {
  timeline: Timeline;
  /** Appended to the runtime's import, e.g. `?minSilenceMs=1500`; see `hooks.ts`. */
  runtimeVariant?: string;
  /** Which daemon and agent the runtime believes it is talking to. */
  serverId?: string;
  agentId?: string;
  /** The daemon's `server_info`, which decides whether voice is available at all. */
  getServerInfo?(): unknown;
  /** Where playback confirmations go: the daemon's side of the link. */
  audioPlayed(chunkId: string): void;
  /** Where microphone audio goes. Left out, it goes nowhere. */
  sendVoiceAudioChunk?(audio: string, mimeType: string): void;
  /** Turning voice mode on and off at the daemon. Left out, nothing is told. */
  setVoiceMode?(enabled: boolean, agentId?: string): Promise<void>;
  /** The patched phone asks the plugin for its cue. Leave out for Paseo's built-in tone. */
  fetchCue?(have: string): Promise<CueAnswer>;
};

const SERVER_INFO = (serverId: string) => ({
  serverId,
  hostname: "harness",
  version: "0.0.0",
  capabilities: {
    voice: { dictation: { enabled: true, reason: "" }, voice: { enabled: true, reason: "" } },
  },
});

// In variables, so that TypeScript leaves them alone: they resolve through the harness's
// hooks into the Paseo checkout.
const ENGINE = engineSpecifier;
const RUNTIME = "@/voice/voice-runtime";
const BUILT_IN_CUE = "@/utils/thinking-tone.native-pcm";

export type Phone = Awaited<ReturnType<typeof createPhone>>;

export async function createPhone(options: PhoneOptions) {
  const { timeline } = options;
  const serverId = options.serverId ?? "harness";
  const agentId = options.agentId ?? "agent";
  const native = createNativeAudio(timeline, labelOf);
  const { createAudioEngine } = await import(ENGINE);
  const { createVoiceRuntime } = await import(RUNTIME + (options.runtimeVariant ?? ""));
  // So the speaker knows the cue when it hears it — the build's own track first.
  const { THINKING_TONE_NATIVE_PCM_BASE64 } = await import(BUILT_IN_CUE);
  rememberCue(Buffer.from(THINKING_TONE_NATIVE_PCM_BASE64 as string, "base64"));

  // Wired the way the app wires them: the engine is built first, the runtime it feeds after.
  let fed: VoiceRuntime | null = null;
  const engine = createAudioEngine({
    onCaptureData: (pcm: Uint8Array) => fed?.handleCapturePcm(pcm),
    onVolumeLevel: (level: number) => fed?.handleCaptureVolume(level),
  });
  const runtime: VoiceRuntime = createVoiceRuntime({
    engine,
    getServerInfo: () => (options.getServerInfo ? options.getServerInfo() : SERVER_INFO(serverId)),
    activateKeepAwake: async () => {},
    deactivateKeepAwake: async () => {},
  });
  fed = runtime;

  let phase = "";
  runtime.subscribe(() => {
    const next = runtime.getSnapshot().phase;
    if (next !== phase) {
      phase = next;
      timeline.note("phone.phase", next);
    }
  });

  let microphoneBytes = 0;
  const fetchCue = options.fetchCue;
  runtime.registerSession({
    serverId,
    async setVoiceMode(enabled: boolean, agent?: string) {
      timeline.note("phone.voice-mode", enabled ? "on" : "off");
      await options.setVoiceMode?.(enabled, agent);
    },
    async sendVoiceAudioChunk(audio: string, mimeType: string) {
      microphoneBytes += (audio.length * 3) / 4;
      options.sendVoiceAudioChunk?.(audio, mimeType);
    },
    async abortRequest() {
      timeline.note("phone.abort");
    },
    setAssistantAudioPlaying(playing: boolean) {
      timeline.note("phone.assistant-audio", playing ? "on" : "off");
    },
    async audioPlayed(chunkId: string) {
      timeline.note("phone.confirms", chunkId);
      options.audioPlayed(chunkId);
    },
    ...(fetchCue
      ? {
          async fetchCue(have: string) {
            timeline.note("phone.cue.ask", have || "(has none yet)");
            const answer = await fetchCue(have);
            if (answer && !answer.unchanged && answer.pcmBase64) {
              rememberCue(Buffer.from(answer.pcmBase64, "base64"));
            }
            timeline.note(
              "phone.cue.answer",
              !answer ? "none" : answer.unchanged ? "unchanged" : `new track, ${answer.pcmBase64.length} base64 chars`,
            );
            return answer;
          },
        }
      : {}),
  });
  await runtime.startVoice(serverId, agentId);

  return {
    native,
    /** Milliseconds of microphone audio the runtime has sent so far. */
    microphoneMs(): number {
      return Math.round(microphoneBytes / 32);
    },
    receiveAudio(payload: AudioOutput): void {
      timeline.note("phone.audio_output", payload.id);
      runtime.handleAudioOutput(serverId, payload);
    },
    receiveTranscript(text: string): void {
      timeline.note("phone.transcript", text);
      runtime.onTranscriptionResult(serverId, text);
    },
    receiveServerSpeech(isSpeaking: boolean): void {
      timeline.note("phone.server-hears-speech", isSpeaking ? "yes" : "no");
      runtime.onServerSpeechStateChanged(serverId, isSpeaking);
    },
    receiveTurn(event: TurnEvent): void {
      timeline.note("phone.turn", event);
      runtime.onTurnEvent(serverId, agentId, event);
    },
    /** A `speak` tool call of the agent, as the patched `session-context.tsx` routes it. */
    receiveSpeakCall(callId: string, status: string): void {
      if (runtime.onSpeakToolCall) {
        timeline.note("phone.speak-call", status);
        runtime.onSpeakToolCall(serverId, agentId, callId, status);
      } else {
        timeline.note("phone.speak-call", `${status} — not routed: this build has no onSpeakToolCall`);
      }
    },
    async hangUp(): Promise<void> {
      await runtime.destroy();
    },
  };
}
