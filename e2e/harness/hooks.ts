import { existsSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

/**
 * Module hooks, run by Node in its loader thread.
 *
 * Resolution the app normally gets from Metro, and only for the app's own files: the
 * `@/` alias, and relative imports written without an extension.
 *
 * And one thing for experiments: the voice runtime's timing constants can be overridden
 * per import through the query string — `@/voice/voice-runtime?minSilenceMs=1500` — so a
 * single run can put the patched values and upstream's side by side. A different query
 * is a different module instance, so variants never leak into each other.
 */

let appSrc = "";

export function initialize(data: { appSrc: string }): void {
  appSrc = data.appSrc;
}

/**
 * Expo modules the app imports at the top of files the harness runs, for paths the
 * harness never takes — encoded-file playback, in Paseo 0.11's audio engine. They only
 * have to resolve.
 */
const STUBS: Record<string, string> = {
  "expo-audio": new URL("./stubs/expo-audio.ts", import.meta.url).href,
  "expo-file-system": new URL("./stubs/expo-file-system.ts", import.meta.url).href,
};

function fileFor(base: string): string | null {
  if (existsSync(base) && statSync(base).isFile()) {
    return base;
  }
  for (const suffix of [".ts", ".tsx", "/index.ts", "/index.tsx"]) {
    if (existsSync(base + suffix)) {
      return base + suffix;
    }
  }
  return null;
}

type Resolved = { url: string; format?: string; shortCircuit?: boolean };
type NextResolve = (specifier: string, context: { parentURL?: string }) => Promise<Resolved>;

export async function resolve(
  specifier: string,
  context: { parentURL?: string },
  next: NextResolve,
): Promise<Resolved> {
  const at = specifier.indexOf("?");
  const bare = at === -1 ? specifier : specifier.slice(0, at);
  const query = at === -1 ? "" : specifier.slice(at);

  const fromApp = context.parentURL?.startsWith("file:") && fileURLToPath(context.parentURL).startsWith(appSrc);
  const stub = STUBS[bare];
  if (stub && fromApp) {
    return { url: stub, shortCircuit: true };
  }

  let found: string | null = null;
  if (bare.startsWith("@/")) {
    found = fileFor(path.join(appSrc, bare.slice(2)));
  } else if (bare.startsWith(".") && context.parentURL?.startsWith("file:")) {
    const parent = fileURLToPath(context.parentURL);
    if (parent.startsWith(appSrc)) {
      found = fileFor(path.resolve(path.dirname(parent), bare));
    }
  }
  if (found) {
    // Said outright: the app's package.json declares no module type, and Node would
    // otherwise try CommonJS first and warn about every file.
    return { url: pathToFileURL(found).href + query, format: "module-typescript", shortCircuit: true };
  }
  return next(specifier, context);
}

/** Query parameter → the constant it replaces in the voice runtime. */
const OVERRIDES: Record<string, string> = {
  minSilenceMs: "THINKING_TONE_MIN_SILENCE_MS",
  repeatGapMs: "THINKING_TONE_REPEAT_GAP_MS",
};

type Loaded = { format: string; source?: string | ArrayBuffer | Uint8Array; shortCircuit?: boolean };
type NextLoad = (url: string, context: unknown) => Promise<Loaded>;

export async function load(url: string, context: unknown, next: NextLoad): Promise<Loaded> {
  const result = await next(url, context);
  const query = new URL(url).searchParams;
  const asked = Object.keys(OVERRIDES).filter((key) => query.has(key));
  if (asked.length === 0) {
    return result;
  }
  let source = typeof result.source === "string" ? result.source : new TextDecoder().decode(result.source);
  for (const key of asked) {
    const name = OVERRIDES[key];
    const pattern = new RegExp(`const ${name} = \\d+;`);
    // Refused rather than ignored: a renamed constant would otherwise make every
    // comparison silently compare a variant with itself.
    if (!pattern.test(source)) {
      throw new Error(`${name} is not in ${url} — the override has nothing to replace`);
    }
    source = source.replace(pattern, `const ${name} = ${Number(query.get(key))};`);
  }
  return { ...result, source };
}
