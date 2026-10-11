import { mkdirSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { paseoSource } from "./paseo-source.ts";
import { type AudioOutput, createPhone, type Phone, type TurnEvent } from "./phone.ts";
import type { TestDaemon } from "./test-daemon.ts";
import type { Timeline } from "./timeline.ts";
import { roomTone, say, synthesize } from "./tts.ts";
import { mp3Duration } from "../../server/mp3.server.ts";

/**
 * The real daemon, reached the way the phone reaches it: through the relay, end-to-end
 * encrypted, as a client of its own — or a daemon of the tests' own, over its local
 * socket; see `test-daemon.ts`. The phone side is the harness's phone — Paseo's voice
 * runtime and engine from the patched checkout — wired to this client exactly as
 * `session-context.tsx` wires the app's.
 */

const HOME = process.env.PASEO_HOME || path.join(homedir(), ".paseo");

/**
 * The phone's own client and protocol helpers, built from the same checkout as the
 * runtime under test — so the connection is the one the phone build will make, not the
 * older copy installed beside the plugin SDK. Typed from that copy, whose surface is
 * the same for everything used here.
 */
const built = (pkg: string, file: string) =>
  pathToFileURL(path.join(paseoSource, "packages", pkg, "dist", file)).href;
const { DaemonClient } = (await import(built("client", "daemon-client.js"))) as typeof import(
  "@getpaseo/client/internal/daemon-client"
);
const { buildRelayWebSocketUrl } = (await import(built("protocol", "daemon-endpoints.js"))) as typeof import(
  "@getpaseo/protocol/daemon-endpoints"
);
const { isSpeakToolName } = (await import(built("protocol", "tool-name-normalization.js"))) as {
  isSpeakToolName(name: string): boolean;
};

/**
 * Where the test agent works: a directory of its own, so it can touch nothing else. It
 * also decides which Claude login the agent runs under wherever the config dir is picked
 * per directory, so it has to be one where `claude` is logged in — see `.env.e2e`.
 */
export const AGENT_CWD = process.env.PASEO_VOICE_E2E_CWD || path.join(homedir(), ".paseo-voice", "e2e");

/**
 * The pairing offer, rebuilt from this Mac's own files — the public half only. The
 * keypair file also holds the daemon's secret key: exactly one field is read out of it,
 * and nothing from it is ever printed.
 */
export function relayOffer() {
  const serverId = readFileSync(path.join(HOME, "server-id"), "utf8").trim();
  const { publicKeyB64 } = JSON.parse(readFileSync(path.join(HOME, "daemon-keypair.json"), "utf8")) as {
    publicKeyB64: string;
  };
  const config = JSON.parse(readFileSync(path.join(HOME, "config.json"), "utf8")) as {
    daemon?: { relay?: { publicEndpoint?: string; endpoint?: string; publicUseTls?: boolean; useTls?: boolean } };
  };
  const relay = config.daemon?.relay ?? {};
  const endpoint = relay.publicEndpoint ?? relay.endpoint;
  if (!endpoint) {
    throw new Error(`no relay configured in ${path.join(HOME, "config.json")}`);
  }
  return { serverId, daemonPublicKeyB64: publicKeyB64, endpoint, useTls: relay.publicUseTls ?? relay.useTls ?? true };
}

const TURN_ENDS = new Set<TurnEvent>(["turn_completed", "turn_failed", "turn_canceled"]);

/** The text of a `speak` call, wherever the provider put it in the call's detail. */
function spokenText(detail: unknown): string {
  const shape = detail as { type?: string; text?: string; input?: { text?: unknown } } | undefined;
  if (shape?.type === "plain_text") {
    return shape.text ?? "";
  }
  if (shape?.type === "unknown" && typeof shape.input?.text === "string") {
    return shape.input.text;
  }
  return "";
}

/**
 * How long past a segment's own length the phone may take to confirm it before the
 * reply counts as stuck. The daemon waits forever; this is how long the harness waits
 * before saying so and moving on.
 */
const STUCK_AFTER_MS = 8000;

export type TurnOutcome = TurnEvent | "stuck" | "timeout";

export type LiveSession = Awaited<ReturnType<typeof openLiveSession>>;

/**
 * How the phone's microphone goes up. `plugin` asks this plugin, as the patched phone does
 * — the real daemon's way; a test daemon runs no plugins, so for it the answer is given
 * here. PCM by default, as upstream sends it; `PASEO_VOICE_E2E_CODEC` sets the default for
 * a whole run, so every suite can be run with the microphone as Opus.
 */
export type VoiceCodecChoice = "plugin" | "opus" | "pcm";

const DEFAULT_CODEC = ((): VoiceCodecChoice | undefined => {
  const chosen = process.env.PASEO_VOICE_E2E_CODEC;
  return chosen === "plugin" || chosen === "opus" || chosen === "pcm" ? chosen : undefined;
})();

/** A client of the daemon the way the phone is one: through the relay, or straight to a
 *  test daemon when it is not on the relay. */
export async function connectLive(timeline: Timeline, daemon?: TestDaemon) {
  // Its own and stable. The phone's would merge the two sessions into one; a new one
  // every run would leave sessions behind for the daemon's 90 s of grace.
  const identity = { clientId: "paseo-voice-e2e", clientType: "mobile", appVersion: "paseo-voice-e2e" } as const;
  let serverId: string;
  let client: InstanceType<typeof DaemonClient>;
  if (daemon?.relay) {
    serverId = daemon.serverId;
    client = new DaemonClient({
      url: buildRelayWebSocketUrl({ endpoint: daemon.relay.endpoint, useTls: daemon.relay.useTls, serverId, role: "client" }),
      ...identity,
      suppressSendErrors: true,
      e2ee: { enabled: true, daemonPublicKeyB64: daemon.relay.daemonPublicKeyB64 },
      reconnect: { enabled: false },
    });
  } else if (daemon) {
    serverId = daemon.serverId;
    client = new DaemonClient({
      url: daemon.url,
      ...identity,
      suppressSendErrors: true,
      localCredential: daemon.credential,
      reconnect: { enabled: false },
    });
  } else {
    const offer = relayOffer();
    serverId = offer.serverId;
    client = new DaemonClient({
      url: buildRelayWebSocketUrl({ endpoint: offer.endpoint, useTls: offer.useTls, serverId: offer.serverId, role: "client" }),
      ...identity,
      suppressSendErrors: true,
      e2ee: { enabled: true, daemonPublicKeyB64: offer.daemonPublicKeyB64 },
      reconnect: { enabled: false },
    });
  }
  await client.connect();
  timeline.note(
    "link.connected",
    daemon?.relay ? "to the test daemon, through the relay" : daemon ? `straight to the test daemon at ${daemon.url}` : "through the relay",
  );
  return { client, serverId };
}

/** The question the patched phone asks before it sends Opus, answered as `choice` says. */
export function codecAnswer(
  client: InstanceType<typeof DaemonClient>,
  choice: VoiceCodecChoice | undefined,
): (() => Promise<{ opus: boolean }>) | undefined {
  if (choice === "plugin") {
    return async () => {
      const answer = (await client.invokePluginRpc("voice", "voice.codec", {})) as { opus?: boolean } | null;
      return { opus: answer?.opus === true };
    };
  }
  return choice === "opus" ? async () => ({ opus: true }) : undefined;
}

export async function openLiveSession(options: {
  timeline: Timeline;
  model?: string;
  runtimeVariant?: string;
  /** As the patched phone does: ask the plugin for the cue. */
  pluginCue?: boolean;
  /** A daemon of the tests' own instead of the real one; it runs no plugins. */
  daemon?: TestDaemon;
  voiceCodec?: VoiceCodecChoice;
}) {
  const { timeline, daemon } = options;
  const { client, serverId } = await connectLive(timeline, daemon);

  mkdirSync(AGENT_CWD, { recursive: true });
  const agent = await client.createAgent({ provider: "claude", model: options.model ?? "claude-haiku-5-5", cwd: AGENT_CWD });
  timeline.note("daemon.agent", `${agent.id} on ${options.model ?? "claude-haiku-5-5"}`);
  const followed = client.observeTimeline([agent.id]);
  await followed.ready;

  let phone: Phone | null = null;
  const turnEnded: ((outcome: TurnOutcome) => void)[] = [];
  const endTurn = (outcome: TurnOutcome) => {
    for (const resolve of turnEnded.splice(0)) {
      resolve(outcome);
    }
  };
  const audioIds: string[] = [];
  const spoken: string[] = [];
  const heardCalls = new Set<string>();
  const pending = new Map<string, { id: string; name: string; title?: string }>();
  const confirmed = new Set<string>();
  const watchdogs: ReturnType<typeof setTimeout>[] = [];
  /** What crossed the link each way, as sent: base64 characters, which is what travels. */
  const traffic = {
    down: { chars: 0, speechMs: 0, formats: new Set<string>(), arrivals: [] as { at: number; speechMs: number }[] },
    up: { chars: 0, formats: new Set<string>(), firstAt: 0, lastAt: 0 },
  };

  // As `session-context.tsx` routes them into the voice runtime.
  const stop = [
    client.on("audio_output", (message) => {
      const payload = message.payload as AudioOutput;
      if (!payload.isVoiceMode) {
        return;
      }
      audioIds.push(payload.id);
      // 24 kHz PCM16 is 48 bytes a millisecond; an MP3 says how long it is in its frames.
      const speechMs =
        payload.format === "pcm"
          ? (payload.audio.length * 3) / 4 / 48
          : payload.format === "mp3"
            ? mp3Duration(Buffer.from(payload.audio, "base64")) * 1000
            : 30_000;
      traffic.down.chars += payload.audio.length;
      traffic.down.speechMs += speechMs;
      traffic.down.formats.add(payload.format);
      // Wall-clock time, to set against the daemon's own log of when it sent it.
      traffic.down.arrivals.push({ at: Date.now(), speechMs });
      timeline.note("link.audio", `${payload.format}, ${Math.round(payload.audio.length / 1024)} KB as sent, ${Math.round(speechMs)} ms of speech`);
      watchdogs.push(
        setTimeout(() => {
          if (!confirmed.has(payload.id)) {
            timeline.note(
              "phone.stuck",
              `${payload.id} unconfirmed ${Math.round(speechMs + STUCK_AFTER_MS)} ms after it arrived, for ${Math.round(speechMs)} ms of speech`,
            );
            endTurn("stuck");
          }
        }, speechMs + STUCK_AFTER_MS),
      );
      phone?.receiveAudio(payload);
    }),
    client.on("transcription_result", (message) => phone?.receiveTranscript(message.payload.text.trim())),
    client.on("voice_input_state", (message) => phone?.receiveServerSpeech(message.payload.isSpeaking)),
    client.on("agent_stream", (message) => {
      const { agentId, event } = message.payload;
      if (agentId !== agent.id) {
        return;
      }
      if (
        event.type === "turn_started" ||
        event.type === "turn_completed" ||
        event.type === "turn_failed" ||
        event.type === "turn_canceled"
      ) {
        phone?.receiveTurn(event.type);
        if (TURN_ENDS.has(event.type)) {
          endTurn(event.type);
        }
        return;
      }
      // What the agent did with the turn, for the timeline: the app routes none of this
      // into the voice runtime, but without it a silent turn cannot be told apart from a
      // broken one. `speak` gets its own label — it is the one signal that says "the agent
      // is speaking" for the whole length of a reply.
      if (event.type === "timeline") {
        const item = event.item;
        if (item.type === "tool_call" && isSpeakToolName(item.name)) {
          // Routed as the patched `session-context.tsx` routes it.
          timeline.note("daemon.speak", item.status);
          phone?.receiveSpeakCall(item.callId, item.status);
          // What it says, once per call — the closest thing to listening a log can do.
          const text = spokenText(item.detail);
          if (text && !heardCalls.has(item.callId)) {
            heardCalls.add(item.callId);
            spoken.push(text);
            timeline.note("agent.speaks", text);
          }
        } else if (item.type === "tool_call") {
          timeline.note("agent.tool", `${item.name} ${item.status}`);
        } else if (item.type === "assistant_message") {
          timeline.note("agent.says", item.text.slice(0, 160));
        } else if (item.type === "error") {
          timeline.note("agent.error", item.message);
        }
        return;
      }
      // A person on the phone answers these on the screen. The harness keeps them until it
      // is told — waiting with the agent is itself something worth watching.
      if (event.type === "permission_requested") {
        pending.set(event.request.id, event.request);
        timeline.note("agent.permission", `requested: ${event.request.name}${event.request.title ? ` — ${event.request.title}` : ""}`);
      } else if (event.type === "permission_resolved") {
        pending.delete(event.requestId);
        timeline.note("agent.permission", `resolved: ${event.resolution.behavior}`);
      }
    }),
  ];

  phone = await createPhone({
    timeline,
    runtimeVariant: options.runtimeVariant,
    serverId,
    agentId: agent.id,
    getServerInfo: () => client.getLastServerInfoMessage(),
    setVoiceMode: async (enabled, id) => {
      await client.setVoiceMode(enabled, id);
    },
    sendVoiceAudioChunk: (audio, mimeType) => {
      traffic.up.chars += audio.length;
      traffic.up.formats.add(mimeType);
      traffic.up.firstAt ||= timeline.now();
      traffic.up.lastAt = timeline.now();
      void client.sendVoiceAudioChunk(audio, mimeType);
    },
    audioPlayed: (chunkId) => {
      confirmed.add(chunkId);
      void client.audioPlayed(chunkId);
    },
    fetchVoiceCodec: codecAnswer(client, options.voiceCodec ?? DEFAULT_CODEC),
    // The test daemon runs no plugins, so there is nobody to ask.
    fetchCue:
      options.pluginCue === false || daemon
        ? undefined
        : async (have) => {
            const answer = (await client.invokePluginRpc("voice", "voice.cue", { have })) as {
              tag?: string;
              unchanged?: boolean;
              pcmBase64?: string;
            } | null;
            return answer?.tag
              ? { tag: answer.tag, unchanged: answer.unchanged === true, pcmBase64: answer.pcmBase64 ?? "" }
              : null;
          },
  });
  const ready = phone;

  // A phone's microphone does not stop while voice mode is on: the room's quiet goes up
  // as well, buffer after buffer, and what is said is just part of that stream. Set
  // `PASEO_VOICE_E2E_DIGITAL_SILENCE=1` to send exact zeros instead — which no real
  // microphone does, and which the daemon's speech worker has been seen to crash on.
  let saying = false;
  const digitalSilence = process.env.PASEO_VOICE_E2E_DIGITAL_SILENCE === "1";
  const microphone = setInterval(() => {
    if (!saying) {
      ready.native.hear(digitalSilence ? new Uint8Array(32 * 128) : roomTone(32 * 128));
    }
  }, 128);

  return {
    timeline,
    agentId: agent.id,
    phone: ready,
    /** Every `audio_output` the daemon sent for this agent's voice, in order. */
    audioIds,
    /** What the agent said through `speak`, one entry per call, in order. */
    spoken,
    /** Ids of the audio the phone has confirmed as played. */
    confirmed,
    /** Audio that crossed the link: down to the phone, and up from its microphone. */
    traffic,

    /** Permission requests the agent is waiting on. */
    pendingPermissions(): { id: string; name: string; title?: string }[] {
      return [...pending.values()];
    },

    /** Grants one, as the person would by tapping Allow. */
    async allow(requestId: string): Promise<void> {
      timeline.note("person.allows", pending.get(requestId)?.name ?? requestId);
      await client.respondToPermission(agent.id, requestId, { behavior: "allow" });
    },

    /** Says `text` into the phone's microphone, in the plugin's voice, at speaking speed.
     *  `onSpoken` runs as the last word leaves the speaker's mouth, before the quiet after it. */
    async say(text: string, options: { onSpoken?: () => void } = {}): Promise<void> {
      const speech = await synthesize(text);
      timeline.note("person.says", text);
      saying = true;
      try {
        // 128 ms frames: the buffer the iOS tap delivers at 16 kHz.
        await say(ready.native, speech, {
          frameMs: 128,
          onSpoken: () => {
            timeline.note("person.done", "the last word is out");
            options.onSpoken?.();
          },
        });
      } finally {
        saying = false;
      }
    },

    /** Types `text` into the chat instead, voice mode still on — what a person does when
     *  saying it did not work. */
    async type(text: string): Promise<void> {
      timeline.note("person.types", text);
      await client.sendAgentMessage(agent.id, text);
    },

    /** Resolves with how the turn ended: a turn event, "stuck" as soon as a segment goes
     *  unconfirmed for too long, or "timeout" if nothing at all comes. */
    turnEnd(timeoutMs: number): Promise<TurnOutcome> {
      return new Promise((resolve) => {
        const timer = setTimeout(() => resolve("timeout"), timeoutMs);
        turnEnded.push((outcome) => {
          clearTimeout(timer);
          resolve(outcome);
        });
      });
    },

    /** Voice off before leaving — the daemon would hold the session for 90 s — then the
     *  agent and the connection go. */
    async close(): Promise<void> {
      clearInterval(microphone);
      for (const timer of watchdogs) {
        clearTimeout(timer);
      }
      await ready.hangUp().catch(() => {});
      for (const off of stop) {
        off();
      }
      await client.deleteAgent(agent.id).catch(() => {});
      await followed.release().catch(() => {});
      await client.close();
    },
  };
}
