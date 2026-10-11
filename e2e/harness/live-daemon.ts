import { mkdirSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { paseoSource } from "./paseo-source.ts";
import { type AudioOutput, createPhone, type Phone, type TurnEvent } from "./phone.ts";
import type { Timeline } from "./timeline.ts";
import { say, synthesize } from "./tts.ts";

/**
 * The real daemon, reached the way the phone reaches it: through the relay, end-to-end
 * encrypted, as a client of its own. The phone side is the harness's phone — Paseo's
 * voice runtime and engine from the patched checkout — wired to this client exactly as
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

/**
 * How long past a segment's own length the phone may take to confirm it before the
 * reply counts as stuck. The daemon waits forever; this is how long the harness waits
 * before saying so and moving on.
 */
const STUCK_AFTER_MS = 8000;

export type TurnOutcome = TurnEvent | "stuck" | "timeout";

export type LiveSession = Awaited<ReturnType<typeof openLiveSession>>;

export async function openLiveSession(options: {
  timeline: Timeline;
  model?: string;
  runtimeVariant?: string;
  /** As the patched phone does: ask the plugin for the cue. */
  pluginCue?: boolean;
}) {
  const { timeline } = options;
  const offer = relayOffer();
  const client = new DaemonClient({
    url: buildRelayWebSocketUrl({ endpoint: offer.endpoint, useTls: offer.useTls, serverId: offer.serverId, role: "client" }),
    // Its own and stable. The phone's would merge the two sessions into one; a new one
    // every run would leave sessions behind for the daemon's 90 s of grace.
    clientId: "paseo-voice-e2e",
    clientType: "mobile",
    appVersion: "paseo-voice-e2e",
    suppressSendErrors: true,
    e2ee: { enabled: true, daemonPublicKeyB64: offer.daemonPublicKeyB64 },
    reconnect: { enabled: false },
  });
  await client.connect();
  timeline.note("link.connected", "through the relay");

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
  const confirmed = new Set<string>();
  const watchdogs: ReturnType<typeof setTimeout>[] = [];

  // As `session-context.tsx` routes them into the voice runtime.
  const stop = [
    client.on("audio_output", (message) => {
      const payload = message.payload as AudioOutput;
      if (!payload.isVoiceMode) {
        return;
      }
      audioIds.push(payload.id);
      // 24 kHz PCM16 is 48 bytes a millisecond; anything else gets a generous guess.
      const speechMs = payload.format === "pcm" ? (payload.audio.length * 3) / 4 / 48 : 30_000;
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
        } else if (item.type === "tool_call") {
          timeline.note("agent.tool", `${item.name} ${item.status}`);
        } else if (item.type === "assistant_message") {
          timeline.note("agent.says", item.text.slice(0, 160));
        } else if (item.type === "error") {
          timeline.note("agent.error", item.message);
        }
        return;
      }
      if (event.type === "permission_requested") {
        timeline.note("agent.permission", "requested — nobody is here to grant it");
      }
    }),
  ];

  phone = await createPhone({
    timeline,
    runtimeVariant: options.runtimeVariant,
    serverId: offer.serverId,
    agentId: agent.id,
    getServerInfo: () => client.getLastServerInfoMessage(),
    setVoiceMode: async (enabled, id) => {
      await client.setVoiceMode(enabled, id);
    },
    sendVoiceAudioChunk: (audio, mimeType) => void client.sendVoiceAudioChunk(audio, mimeType),
    audioPlayed: (chunkId) => {
      confirmed.add(chunkId);
      void client.audioPlayed(chunkId);
    },
    fetchCue:
      options.pluginCue === false
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

  // A phone's microphone does not stop while voice mode is on: the silence goes up as
  // well, buffer after buffer, and what is said is just part of that stream.
  let saying = false;
  const roomTone = new Uint8Array(32 * 128);
  const microphone = setInterval(() => {
    if (!saying) {
      ready.native.hear(roomTone);
    }
  }, 128);

  return {
    timeline,
    agentId: agent.id,
    phone: ready,
    /** Every `audio_output` the daemon sent for this agent's voice, in order. */
    audioIds,

    /** Says `text` into the phone's microphone, in the plugin's voice, at speaking speed. */
    async say(text: string): Promise<void> {
      const speech = await synthesize(text);
      timeline.note("person.says", text);
      saying = true;
      try {
        // 128 ms frames: the buffer the iOS tap delivers at 16 kHz.
        await say(ready.native, speech, { frameMs: 128 });
      } finally {
        saying = false;
      }
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
