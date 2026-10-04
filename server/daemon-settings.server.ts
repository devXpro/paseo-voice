import { execFile } from "node:child_process";
import { readFile, rename, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";

/**
 * Two settings in the daemon's own config decide whether voice mode can answer at all.
 * Neither is reachable from Paseo's interface, and the first is off by default — which
 * is why a fresh install hears you perfectly and then says nothing.
 *
 * Editing JSON rather than code: it survives a Paseo update, leaves the signature
 * alone, and needs no restart — `paseo reload` is enough.
 */

/**
 * Appended to every agent's system prompt, and editable in the panel. Paseo's own voice
 * prompt already asks for progress updates, but models honour it unevenly — one
 * paragraph spoken, the next typed. This states the rule in full, and draws the line at
 * machinery: commands and code stay on screen rather than being read out.
 */
export const DEFAULT_PROMPT = [
  "When Paseo voice mode is active — that is, when a <paseo_voice_mode> block appears in",
  "this prompt — everything you say TO THE PERSON goes through the speak tool: the",
  "acknowledgement of what you heard, progress notes while a long task runs, and the whole",
  "of the final answer. Never leave part of what you are telling them as chat text only; a",
  "long answer goes out as several speak calls rather than one spoken paragraph followed by",
  "typed ones.",
  "",
  "Speak prose, not machinery. Shell commands, code, file paths, identifiers, tool output,",
  "tables and log lines are never spoken aloud — say what they mean in a sentence instead",
  '("запускаю тесты", "три из сорока упали") and leave the literal text in the chat where it',
  "can be read. Outside voice mode this instruction does not apply and the speak tool is absent.",
].join(" ");

export type DaemonSettings = {
  /** Whether the daemon gives agents its MCP server, where `speak` lives. */
  mcpInjected: boolean;
  /** Whether the prompt currently in the config is the one this plugin manages. */
  promptSet: boolean;
  /** Someone else's appended prompt is present and would be preserved. */
  foreignPrompt: boolean;
  configPath: string;
  error: string;
};

type Json = Record<string, unknown>;

const configPath = () => path.join(process.env.PASEO_HOME || path.join(homedir(), ".paseo"), "config.json");

function object(value: unknown): Json {
  return value && typeof value === "object" && !Array.isArray(value) ? { ...(value as Json) } : {};
}

async function read(): Promise<Json> {
  try {
    return JSON.parse(await readFile(configPath(), "utf8")) as Json;
  } catch {
    return {};
  }
}

async function write(config: Json): Promise<void> {
  const target = configPath();
  const staged = `${target}.voice-plugin.tmp`;
  await writeFile(staged, `${JSON.stringify(config, null, 2)}\n`, { mode: 0o600 });
  await rename(staged, target);
}

const appendedOf = (config: Json): string => {
  const value = object(config.daemon).appendSystemPrompt;
  return typeof value === "string" ? value : "";
};

/** Takes `ours` out of a larger prompt without disturbing whatever else is in there. */
const without = (appended: string, ours: string): string =>
  ours && appended.includes(ours) ? appended.split(ours).join("").trim() : appended.trim();

/**
 * Asks the daemon to re-read its config. Both settings are watched, so this takes
 * effect without a restart; agents pick it up when their session next opens.
 */
export function reloadDaemon(): Promise<string> {
  const cli = process.env.PASEO_CLI;
  if (!cli) {
    return Promise.reject(new Error("PASEO_CLI не задан — не могу попросить демон перечитать конфиг"));
  }
  return new Promise((resolve, reject) => {
    execFile(cli, ["reload"], { timeout: 20_000 }, (error, stdout, stderr) =>
      error ? reject(new Error(stderr.trim() || error.message)) : resolve(stdout.trim()),
    );
  });
}

/** `ours` is the text the plugin last wrote, which is what makes it recognisable. */
export async function inspect(ours: string): Promise<DaemonSettings> {
  try {
    const config = await read();
    const appended = appendedOf(config);
    const mine = ours !== "" && appended.includes(ours);
    return {
      mcpInjected: object(object(config.daemon).mcp).injectIntoAgents === true,
      promptSet: mine,
      foreignPrompt: without(appended, ours).length > 0,
      configPath: configPath(),
      error: "",
    };
  } catch (failure) {
    return {
      mcpInjected: false,
      promptSet: false,
      foreignPrompt: false,
      configPath: configPath(),
      error: failure instanceof Error ? failure.message : String(failure),
    };
  }
}

/**
 * Turns both settings on. `previous` is the text written last time, removed first so
 * an edited prompt replaces its predecessor instead of piling up beside it.
 */
export async function enable(ours: string, previous = ours): Promise<void> {
  const config = await read();
  const daemon = object(config.daemon);
  daemon.mcp = { ...object(daemon.mcp), injectIntoAgents: true };

  // Appended rather than replacing: somebody may have their own instruction in there,
  // and losing it silently would be worse than not helping at all.
  const rest = without(appendedOf(config), previous);
  daemon.appendSystemPrompt = rest ? `${rest}\n\n${ours}` : ours;

  config.daemon = daemon;
  await write(config);
}

export async function disable(ours: string): Promise<void> {
  const config = await read();
  const daemon = object(config.daemon);
  daemon.mcp = { ...object(daemon.mcp), injectIntoAgents: false };
  daemon.appendSystemPrompt = without(appendedOf(config), ours);
  config.daemon = daemon;
  await write(config);
}

/**
 * Swaps one prompt for another while leaving the switch as it is. Doing nothing when
 * the plugin's prompt is not in the config is deliberate: the new text is still saved
 * on our side, and turning the switch on later writes it.
 */
export async function replacePrompt(previous: string, next: string): Promise<void> {
  const config = await read();
  const appended = appendedOf(config);
  if (!previous || !appended.includes(previous)) {
    return;
  }
  const daemon = object(config.daemon);
  const rest = without(appended, previous);
  daemon.appendSystemPrompt = rest ? `${rest}\n\n${next}` : next;
  config.daemon = daemon;
  await write(config);
}
