import { type ChildProcess, execFile, spawn } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { chmod, mkdir, open, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { promisify } from "node:util";

/**
 * A daemon of its own, for the tests that break things on purpose: Paseo's daemon from
 * the installed app — so running whatever corrections are in its archive right now — but
 * from a home directory of its own, on its own port, with no plugins. It joins the relay
 * only when asked, as a server of its own: its home has its own id and keys.
 * Killing its speech worker, or restarting it to load a correction, touches nothing a
 * person is using: the daemon every session on this Mac runs under keeps the code it
 * started with until it is restarted itself.
 *
 * Its settings are the real daemon's — the same speech models, the same voice for the
 * agent, which still goes through this plugin's proxy on the real daemon — with only the
 * place it listens changed.
 */

const run = promisify(execFile);

const CLI = process.env.PASEO_CLI || "/Applications/Paseo.app/Contents/Resources/bin/paseo";
const MAIN_HOME = process.env.PASEO_HOME || path.join(homedir(), ".paseo");
export const TEST_HOME = process.env.PASEO_VOICE_E2E_DAEMON_HOME || path.join(homedir(), ".paseo-voice", "e2e-daemon");
const PORT = Number(process.env.PASEO_VOICE_E2E_DAEMON_PORT || 6768);
const LISTEN = `127.0.0.1:${PORT}`;
/** It loads its speech models and starts a worker; on this Mac that takes a few seconds. */
const READY_WITHIN_MS = 60_000;

export type TestDaemon = Awaited<ReturnType<typeof startTestDaemon>>;

/**
 * The real daemon's config with the parts that would collide taken out: the port and
 * the plugins, which would start a second copy of this one on the proxy's port. The relay
 * stays off unless `relay` — and then it is the same relay under this home's own server
 * id, which is how the phone's path is measured without being the real daemon. Written
 * mode 0600: it carries the provider settings, keys included, and nothing from it is ever
 * printed.
 */
type RelaySettings = { endpoint?: string; useTls?: boolean; publicEndpoint?: string; publicUseTls?: boolean };

async function writeConfig(relay: boolean): Promise<RelaySettings> {
  const main = JSON.parse(await readFile(path.join(MAIN_HOME, "config.json"), "utf8")) as {
    version?: unknown;
    daemon?: { mcp?: unknown; appendSystemPrompt?: unknown; relay?: RelaySettings };
    providers?: unknown;
    agents?: unknown;
    features?: Record<string, unknown>;
  };
  const config = {
    version: main.version,
    daemon: {
      listen: LISTEN,
      mcp: main.daemon?.mcp,
      appendSystemPrompt: main.daemon?.appendSystemPrompt,
      relay: relay ? { ...main.daemon?.relay, enabled: true } : { enabled: false },
    },
    providers: main.providers,
    pluginsEnabled: false,
    agents: main.agents,
    features: { ...main.features, webUi: { enabled: false } },
  };
  await mkdir(TEST_HOME, { recursive: true });
  await chmod(TEST_HOME, 0o700);
  await writeFile(path.join(TEST_HOME, "config.json"), `${JSON.stringify(config, null, 2)}\n`, { mode: 0o600 });
  // The speech models are 600 MB; a fresh home would download its own.
  const models = path.join(TEST_HOME, "models");
  if (!existsSync(models)) {
    await symlink(path.join(MAIN_HOME, "models"), models);
  }
  return main.daemon?.relay ?? {};
}

type LogLine = { msg?: string; workerPid?: number; [field: string]: unknown };

/** The JSON lines of the test daemon's log, skipping the few that are not JSON. */
function logLines(): LogLine[] {
  let text = "";
  try {
    text = readFileSync(path.join(TEST_HOME, "daemon.log"), "utf8");
  } catch {
    return [];
  }
  const lines: LogLine[] = [];
  for (const line of text.split("\n")) {
    try {
      lines.push(JSON.parse(line) as LogLine);
    } catch {
      // A plain line from the supervisor.
    }
  }
  return lines;
}

function listening(): boolean {
  try {
    const lock = JSON.parse(readFileSync(path.join(TEST_HOME, "paseo.pid"), "utf8")) as { listen?: unknown };
    return lock.listen === LISTEN && existsSync(path.join(TEST_HOME, "local-credential"));
  } catch {
    return false;
  }
}

/** Stops whatever runs from the test home — a test that died, or one started by hand. */
async function stopAny(): Promise<void> {
  await run(CLI, ["daemon", "stop", "--home", TEST_HOME, "--json"], { timeout: 30_000 }).catch(() => {});
}

export async function startTestDaemon(options: {
  /** Reachable through the relay as well, the way a phone reaches a daemon. */
  relay?: boolean;
  /** Added to the daemon's environment — `PASEO_VOICE_TTS_FORMAT`, say. */
  env?: Record<string, string>;
} = {}) {
  await stopAny();
  const relay = await writeConfig(options.relay === true);
  // A log per start, so a test reads only what this daemon did.
  await rm(path.join(TEST_HOME, "daemon.log"), { force: true });
  const output = await open(path.join(TEST_HOME, "run.out"), "w");
  const child: ChildProcess = spawn(CLI, ["daemon", "run", "--home", TEST_HOME], {
    stdio: ["ignore", output.fd, output.fd],
    env: { ...process.env, ...options.env },
  });
  let exited = false;
  child.once("exit", () => {
    exited = true;
  });
  const deadline = Date.now() + READY_WITHIN_MS;
  while (!listening()) {
    if (exited || Date.now() > deadline) {
      await output.close();
      throw new Error(
        `the test daemon did not start (${exited ? "it exited" : "timed out"}): see ${path.join(TEST_HOME, "run.out")} and daemon.log there`,
      );
    }
    await sleep(250);
  }
  await output.close();
  while (options.relay && !logLines().some((line) => line.msg === "relay_control_connected")) {
    if (exited || Date.now() > deadline) {
      throw new Error(`the test daemon never reached the relay: see daemon.log in ${TEST_HOME}`);
    }
    await sleep(250);
  }

  /** The speech worker running now: the last one the daemon says it spawned. */
  const workerPid = (): number | null =>
    logLines().filter((line) => line.msg === "Local speech worker spawned" && line.workerPid).at(-1)?.workerPid ?? null;

  return {
    home: TEST_HOME,
    url: `ws://${LISTEN}/ws`,
    serverId: readFileSync(path.join(TEST_HOME, "server-id"), "utf8").trim(),
    /** How to reach it the phone's way, when it was started with `relay`. Only the public
     *  half of its keys is read; the file also holds the secret one. */
    relay: options.relay
      ? {
          endpoint: relay.publicEndpoint ?? relay.endpoint ?? "",
          useTls: relay.publicUseTls ?? relay.useTls ?? true,
          daemonPublicKeyB64: (
            JSON.parse(readFileSync(path.join(TEST_HOME, "daemon-keypair.json"), "utf8")) as { publicKeyB64: string }
          ).publicKeyB64,
        }
      : null,
    /** Read when the connection is made, as the CLI does; it is a token, never printed. */
    credential: (): string => readFileSync(path.join(TEST_HOME, "local-credential"), "utf8").trim(),

    /** The daemon's log since it started. */
    log: logLines,

    workerPid,

    /**
     * Kills the speech worker the way it dies by itself — at once, with no chance to
     * answer what it was asked — and waits until the daemon has noticed.
     */
    async killWorker(): Promise<number> {
      const pid = workerPid();
      if (!pid) {
        throw new Error("the test daemon has no speech worker to kill yet");
      }
      process.kill(pid, "SIGKILL");
      const noticed = Date.now() + 10_000;
      while (!logLines().some((line) => line.msg === "Local speech worker exited" && line.workerPid === pid)) {
        if (Date.now() > noticed) {
          throw new Error(`the daemon did not notice its speech worker ${pid} die`);
        }
        await sleep(50);
      }
      return pid;
    },

    async stop(): Promise<void> {
      await stopAny();
      if (!exited) {
        child.kill("SIGTERM");
        await Promise.race([new Promise((resolve) => child.once("exit", resolve)), sleep(10_000)]);
      }
    },
  };
}
