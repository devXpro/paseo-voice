import { createServer, type Server } from "node:http";
import type { Engine } from "./engine.server.ts";
import { type Pronunciation, speak as speakWithGoogle, tierOf } from "./google.server.ts";
import { render as renderCue } from "./cue.server.ts";
import { durationSeconds, lowPass, trimPadding } from "./pcm.server.ts";
import { record } from "./usage.server.ts";
import { STEADY_SEED } from "./state.server.ts";

export type Choice = {
  provider: "google" | "local";
  /** Google voice name, or the local engine's speaker, depending on `provider`. */
  voice: string;
  model: string;
  language: string;
  rate: number;
  steady: boolean;
  /** The waiting cue the patched desktop client asks for, and how loud. */
  cue: string;
  cueVolume: number;
  /** Low-pass before sending, so the phone's resampler has nothing to alias. */
  phoneSafe: boolean;
  googleKey: string;
  pronunciations: Pronunciation[];
};

export type ProxyOptions = {
  port: number;
  engine: Engine;
  /** Read per request, so a change in the surface takes effect on the next sentence. */
  choice: () => Choice;
  log?: (line: string) => void;
  patience?: BindPatience;
};

export type Proxy = {
  start(): Promise<void>;
  stop(): Promise<void>;
  port: number;
  /** Whether it is listening, and why not when it is not. For the panel to show. */
  state(): { listening: boolean; error: string };
};

/**
 * How long to keep trying when the port is taken.
 *
 * Taken is almost always temporary and almost always Paseo itself: the daemon is
 * replaced, the new one loads this plugin within a second, and the old one is still
 * finishing the sentence it was speaking — still holding the port. It let go two
 * seconds later. The old code tried once, logged, and gave up for good, which is how
 * speech went silent in the middle of a conversation with nothing on screen to say so.
 *
 * Killing whatever holds the port was considered and rejected. Here it would have
 * meant killing the daemon mid-sentence, and in general it means firing at a process
 * this plugin cannot identify. Waiting solves the real case and risks nothing.
 */
const BIND_ATTEMPTS = 10;
const BIND_BACKOFF_MS = 1_500;

/** Overridable so a test can prove the giving-up path without sitting through it. */
export type BindPatience = { attempts?: number; backoffMs?: number };

function readBody(request: import("node:http").IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    request.on("data", (chunk: Buffer) => chunks.push(chunk));
    request.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    request.on("error", reject);
  });
}

/**
 * Stands between Paseo and whatever is doing the speaking.
 *
 * It exists because Paseo's TTS client is an OpenAI SDK with a hard-coded voice enum —
 * it can only ever send `alloy`, `echo`, `fable`, `onyx`, `nova` or `shimmer` — and
 * neither Google nor the local engine knows those names. So the chosen voice is
 * substituted here, and the reply is turned into the headerless 24 kHz samples Paseo
 * expects of `response_format: "pcm"`.
 */
export function createProxy(options: ProxyOptions): Proxy {
  const { port, engine, choice, log = () => {} } = options;
  const attempts = options.patience?.attempts ?? BIND_ATTEMPTS;
  const backoffMs = options.patience?.backoffMs ?? BIND_BACKOFF_MS;
  let server: Server | null = null;
  let lastError = "";

  function refuse(response: import("node:http").ServerResponse, status: number, message: string) {
    response.writeHead(status, { "content-type": "application/json" });
    response.end(JSON.stringify({ error: { message } }));
  }

  /** The local engine, kept as a fallback for when there is no key or no network. */
  async function fromEngine(text: string, at: Choice): Promise<Buffer> {
    await engine.ensure(at.model);
    engine.touch();
    const upstream = await fetch(`http://127.0.0.1:${engine.port}/v1/tts/stream`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        speaker: at.voice,
        text,
        language: at.language,
        rate: at.rate,
        // Pinning these is what keeps one answer sounding like one person: Paseo sends
        // each sentence separately and the engine otherwise seeds itself from the clock.
        ...(at.steady ? { seed: STEADY_SEED, top_k: 1 } : {}),
      }),
    });
    if (!upstream.ok || !upstream.body) {
      throw new Error(`движок: ${upstream.status} ${(await upstream.text().catch(() => "")).slice(0, 200)}`.trim());
    }
    const chunks: Buffer[] = [];
    const reader = upstream.body.getReader();
    for (;;) {
      const { done, value } = await reader.read();
      if (done) {
        break;
      }
      chunks.push(Buffer.from(value));
    }
    return Buffer.concat(chunks);
  }

  async function render(text: string, at: Choice): Promise<Buffer> {
    if (at.provider !== "google") {
      return fromEngine(text, at);
    }
    const pcm = await speakWithGoogle({
      key: at.googleKey,
      voice: at.voice,
      text,
      rate: at.rate,
      pronunciations: at.pronunciations,
    });
    const tier = tierOf(at.voice);
    if (tier) {
      // Recorded on the way out, not awaited: the bar on the screen must not be in the
      // path of somebody waiting to hear a sentence.
      // Code points, not UTF-16 units: Google bills one character per character
      // whatever it costs in bytes, so Cyrillic counts the same as Latin — but an
      // emoji is one character to them and two to `.length`.
      void record(tier, [...text].length).catch((failure: unknown) => log(`voice: usage: ${String(failure)}`));
    }
    return pcm;
  }

  async function handleSpeak(
    request: import("node:http").IncomingMessage,
    response: import("node:http").ServerResponse,
  ) {
    let input = "";
    try {
      const body = JSON.parse(await readBody(request)) as { input?: string; text?: string };
      input = (body.input ?? body.text ?? "").trim();
    } catch {
      refuse(response, 400, "body is not JSON");
      return;
    }
    if (!input) {
      refuse(response, 400, "input is empty");
      return;
    }

    const at = choice();
    if (!at.voice) {
      refuse(response, 503, "голос не выбран в плагине");
      return;
    }
    if (at.provider === "google" && !at.googleKey) {
      refuse(response, 503, "нет ключа Google");
      return;
    }

    /**
     * Collected in full before a single byte goes back, and that is the point. Paseo
     * reads a sentence's body only once the previous one has finished playing, so a
     * streamed reply can sit half-read for seconds; if it then breaks, what the caller
     * has is a `200` with a short body — and Paseo cannot tell that from a sentence
     * meant to be silent, so it drops it without a word. A complete body is either
     * right or an honest error, and it costs no latency: Paseo concatenates the whole
     * sentence before playing it anyway.
     */
    const started = Date.now();
    let pcm: Buffer;
    try {
      pcm = trimPadding(await render(input, at));
      if (at.phoneSafe) {
        pcm = lowPass(pcm);
      }
    } catch (failure) {
      const message = failure instanceof Error ? failure.message : String(failure);
      log(`voice: ${at.provider}: ${input.length} chars failed after ${Date.now() - started}ms: ${message}`);
      refuse(response, 502, message);
      return;
    }
    if (pcm.length === 0) {
      log(`voice: ${at.provider} returned no audio for ${input.length} chars`);
      refuse(response, 502, "синтез вернул пустой звук");
      return;
    }

    response.writeHead(200, {
      "content-type": "audio/pcm",
      "content-length": String(pcm.length),
      "cache-control": "no-store",
      /**
       * No keep-alive, deliberately. Paseo reads a sentence's body only when the
       * previous one has finished playing, so a reply can sit whole-but-unread for
       * five or ten seconds. On a pooled connection the client wants that socket back
       * and may drop the body to get it — which is how a sentence in the middle of an
       * answer arrives empty and is skipped in silence. A connection that belongs to
       * one reply has nothing to reclaim.
       */
      connection: "close",
    });
    response.end(pcm);
    // One line per sentence. When an answer goes quiet halfway, this is what says
    // whether the audio was ever produced or only ever lost.
    log(
      `voice: ${at.provider} spoke ${input.length} chars → ${durationSeconds(pcm).toFixed(2)}s in ${Date.now() - started}ms`,
    );
  }

  return {
    // The bound port once listening, which is the configured one in every real run.
    // They differ only in a test, where port 0 lets the OS pick a free one.
    get port() {
      const bound = server?.address();
      return bound && typeof bound === "object" ? bound.port : port;
    },
    state() {
      return { listening: server !== null, error: lastError };
    },
    async start() {
      for (let attempt = 1; ; attempt += 1) {
        try {
          await listenOnce();
          lastError = "";
          return;
        } catch (failure) {
          const busy = (failure as { code?: string }).code === "EADDRINUSE";
          lastError = failure instanceof Error ? failure.message : String(failure);
          if (!busy || attempt >= attempts) {
            log(`voice: proxy could not start after ${attempt} attempt(s): ${lastError}`);
            throw failure;
          }
          log(`voice: port ${port} busy, retrying (${attempt}/${attempts})`);
          await new Promise((wake) => setTimeout(wake, attempt * backoffMs));
        }
      }
    },
    stop() {
      return new Promise((resolve) => {
        const instance = server;
        server = null;
        if (!instance) {
          resolve();
          return;
        }
        instance.close(() => resolve());
      });
    },
  };

  function listenOnce(): Promise<void> {
      return new Promise((resolve, reject) => {
        const instance = createServer((request, response) => {
          const url = request.url ?? "";
          if (request.method === "POST" && url.startsWith("/v1/audio/speech")) {
            void handleSpeak(request, response).catch((failure: unknown) => {
              log(`voice: proxy failed: ${String(failure)}`);
              if (!response.headersSent) {
                refuse(response, 500, String(failure));
              } else {
                response.end();
              }
            });
            return;
          }
          /**
           * What the patched desktop client plays while the agent thinks. Asked for on
           * every repeat, so a change of track or volume is heard on the next one —
           * which is the whole reason the patch fetches instead of carrying the audio.
           */
          if (request.method === "GET" && url.startsWith("/v1/cue")) {
            const at = choice();
            void renderCue(at.cue, at.cueVolume)
              .then((track) => {
                response.writeHead(200, {
                  "content-type": "audio/pcm",
                  "content-length": String(track.pcm.length),
                  "cache-control": "no-store",
                  // The bundle is served from a file:// origin in the desktop client.
                  "access-control-allow-origin": "*",
                });
                response.end(track.pcm);
              })
              .catch((failure: unknown) => {
                log(`voice: cue failed: ${String(failure)}`);
                // An empty body makes the client fall back to its own tone rather than
                // play nothing, which is what the patch is written to do.
                refuse(response, 503, String(failure));
              });
            return;
          }
          if (request.method === "GET" && url.startsWith("/v1/health")) {
            response.writeHead(200, { "content-type": "application/json" });
            response.end(JSON.stringify({ status: "ok", provider: choice().provider }));
            return;
          }
          refuse(response, 404, "not found");
        });
        // Loopback only. This endpoint takes arbitrary text and spends money on it; it
        // has no business being reachable from the network.
        instance.listen(port, "127.0.0.1", () => {
          server = instance;
          log(`voice: proxy listening on 127.0.0.1:${port}`);
          resolve();
        });
        instance.once("error", reject);
      });
  }
}
