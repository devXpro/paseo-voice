import { type ChildProcess, spawn } from "node:child_process";
import { paths } from "./paths.server.ts";

export type EngineOptions = {
  port: number;
  /** How long the engine may sit unused before it is shut down. 0 keeps it forever. */
  idleMs?: number;
  log?: (line: string) => void;
};

export type Engine = {
  /** Brings the engine up on `model` if it is not already serving it, and waits for health. */
  ensure(model: string): Promise<void>;
  stop(): void;
  running(): boolean;
  /** The model currently being served, or "" when down. */
  model(): string;
  lastError(): string;
  /** Call on every proxied request so the idle timer measures real silence. */
  touch(): void;
  port: number;
};

/** How many utterance fragments may wait their turn. A long answer is a handful of
 *  sentences, and they arrive faster than they are spoken. */
const QUEUE_DEPTH = 16;
/** Long enough to outlast a cold first synthesis, short enough not to hang a turn. */
const QUEUE_TIMEOUT_MS = 60_000;

/** The engine mmaps its weights, so "ready" arrives in well under a second. */
const READY_TIMEOUT_MS = 30_000;
const READY_POLL_MS = 150;

export function createEngine(options: EngineOptions): Engine {
  const { port, idleMs = 10 * 60_000, log = () => {} } = options;

  let child: ChildProcess | null = null;
  let serving = "";
  let starting: Promise<void> | null = null;
  let error = "";
  let idleTimer: NodeJS.Timeout | null = null;

  function armIdleTimer() {
    if (idleTimer) {
      clearTimeout(idleTimer);
      idleTimer = null;
    }
    if (idleMs > 0 && child) {
      // Unreferenced: a plugin holding an idle timer must not be the reason the daemon's
      // event loop stays alive.
      idleTimer = setTimeout(() => {
        log(`voice: engine idle for ${Math.round(idleMs / 1000)}s, stopping`);
        stop();
      }, idleMs);
      idleTimer.unref?.();
    }
  }

  async function healthy(): Promise<boolean> {
    try {
      const response = await fetch(`http://127.0.0.1:${port}/v1/health`, {
        signal: AbortSignal.timeout(1500),
      });
      return response.ok;
    } catch {
      return false;
    }
  }

  async function waitForHealth(): Promise<void> {
    const deadline = Date.now() + READY_TIMEOUT_MS;
    while (Date.now() < deadline) {
      if (!child) {
        throw new Error(error || "engine exited before it answered");
      }
      if (await healthy()) {
        return;
      }
      await new Promise((resolve) => setTimeout(resolve, READY_POLL_MS));
    }
    throw new Error(`engine did not answer on ${port} within ${READY_TIMEOUT_MS / 1000}s`);
  }

  function spawnFor(model: string) {
    error = "";
    // The queue is the whole reason these flags exist. Paseo splits an utterance into
    // sentences and synthesises them with read-ahead, so several requests land at once —
    // and the engine defaults to `queue_max: 0`, which rejects everything beyond the one
    // it is already working on. The caller then sees `fetch failed`, and the utterance
    // dies halfway through with the first sentence spoken and the rest silent.
    const proc = spawn(
      paths.binary,
      [
        "-d",
        paths.model(model),
        "--serve",
        String(port),
        "--max-queue",
        String(QUEUE_DEPTH),
        "--queue-timeout-ms",
        String(QUEUE_TIMEOUT_MS),
      ],
      { stdio: ["ignore", "pipe", "pipe"] },
    );
    child = proc;
    serving = model;

    // The engine is chatty on stdout while loading; only its failures are worth keeping,
    // and the last line of stderr is what a surface can actually show somebody.
    proc.stderr?.on("data", (chunk: Buffer) => {
      const line = chunk.toString().trim();
      if (line) {
        error = line.split("\n").at(-1) ?? line;
        log(`voice: engine: ${line}`);
      }
    });
    proc.once("error", (spawnError) => {
      error = spawnError.message;
      child = null;
      serving = "";
    });
    proc.once("exit", (code, signal) => {
      if (code !== 0 && code !== null) {
        error ||= `engine exited with code ${code}`;
      } else if (signal && signal !== "SIGTERM") {
        error ||= `engine killed by ${signal}`;
      }
      child = null;
      serving = "";
      starting = null;
    });
  }

  function stop() {
    if (idleTimer) {
      clearTimeout(idleTimer);
      idleTimer = null;
    }
    const proc = child;
    child = null;
    serving = "";
    starting = null;
    proc?.kill("SIGTERM");
  }

  async function ensure(model: string): Promise<void> {
    if (!model) {
      throw new Error("no model selected");
    }
    // A different model means a different process: the engine loads one set of weights
    // for its lifetime, so switching is a restart rather than a request parameter.
    if (child && serving !== model) {
      log(`voice: switching model ${serving} -> ${model}`);
      stop();
    }
    // Checked before `child`, and this order is the whole point: `spawnFor` sets `child`
    // immediately, but the process needs seconds before it answers. A second caller that
    // only looked at `child` would sail past and fetch against a port with nothing behind
    // it yet — which is exactly how an utterance lost three of its four sentences, each
    // failing in two milliseconds.
    if (starting) {
      await starting;
      armIdleTimer();
      return;
    }
    if (child) {
      armIdleTimer();
      return;
    }
    starting ??= (async () => {
      spawnFor(model);
      try {
        await waitForHealth();
        log(`voice: engine ready on ${port} with ${model}`);
        armIdleTimer();
      } catch (failure) {
        stop();
        error = failure instanceof Error ? failure.message : String(failure);
        throw failure;
      } finally {
        starting = null;
      }
    })();
    return starting;
  }

  return {
    ensure,
    stop,
    running: () => child !== null,
    model: () => serving,
    lastError: () => error,
    touch: armIdleTimer,
    port,
  };
}
