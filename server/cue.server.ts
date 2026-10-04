import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, readdir, readFile, rename, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { ATTRIBUTION, BUILTIN, builtinOf } from "./catalogue.server.ts";
import { type Track } from "./music.server.ts";
import { paths } from "./paths.server.ts";

/**
 * The loop that plays on the phone while the agent is thinking.
 *
 * Chosen here, applied by a rebuild: the sound is compiled into Paseo's own app and
 * nothing at runtime can reach it, so this holds the choice and `ios-build/` carries
 * it into the next build. See the plugin README for why there is no way around that.
 */

/** Anything macOS can decode can be a cue; `afconvert` does the rest. */
const READABLE = new Set([".wav", ".mp3", ".m4a", ".aac", ".aiff", ".aif", ".caf", ".flac"]);

/** What the app's audio engine takes, and therefore what everything is converted to. */
const RATE = 16_000;

/**
 * How much of a track to use. Nothing, by default: the desktop fetches the cue over
 * loopback and plays it whole, so a three-minute piece loops every three minutes
 * instead of every twenty seconds. The iOS build passes a cap, because there the audio
 * is base64 inside the JS bundle and a full track would add megabytes to the app.
 */
const NO_CAP = 0;

export type Cue = {
  id: string;
  title: string;
  /** "builtin" is generated here; "own" came from the folder somebody drops files in. */
  kind: "builtin" | "own" | "silence";
  seconds: number;
};

const cacheDir = path.join(paths.musicDir, ".converted");

/** Whatever is in the folder right now, plus the ones this plugin can synthesise. */
export async function list(): Promise<Cue[]> {
  const downloaded = new Set<string>();
  for (const one of BUILTIN) {
    try {
      await stat(sourceOf(one.id));
      downloaded.add(one.id);
    } catch {
      // Not fetched yet; it will be on first use.
    }
  }
  const builtin: Cue[] = BUILTIN.map((one) => ({
    id: one.id,
    title: one.title,
    kind: "builtin",
    seconds: downloaded.has(one.id) ? 1 : 0,
  }));

  const own: Cue[] = [];
  try {
    for (const entry of await readdir(paths.musicDir, { withFileTypes: true })) {
      if (!entry.isFile() || entry.name.startsWith(".")) {
        continue;
      }
      if (!READABLE.has(path.extname(entry.name).toLowerCase())) {
        continue;
      }
      own.push({
        id: `own:${entry.name}`,
        title: path.basename(entry.name, path.extname(entry.name)),
        kind: "own",
        seconds: 0,
      });
    }
  } catch {
    // No folder yet; it is created the first time somebody needs it.
  }

  return [...builtin, ...own.sort((a, b) => a.title.localeCompare(b.title, "ru")),
    { id: "silence", title: "Без звука", kind: "silence", seconds: 0 }];
}

/** Where a shipped track lives once fetched; the name is the id, so it is stable. */
const sourceOf = (id: string) => path.join(paths.musicDir, ".builtin", `${id}.mp3`);

/**
 * Fetches a shipped track if it is not here yet, and refuses anything whose bytes do
 * not hash to what the catalogue says: a cue is audio this plugin hands to the client,
 * and a silent swap upstream should not become a silent swap here.
 */
async function ensureBuiltin(id: string): Promise<string> {
  const entry = builtinOf(id);
  if (!entry) {
    throw new Error(`неизвестный звук ${id}`);
  }
  const target = sourceOf(id);
  try {
    await stat(target);
    return target;
  } catch {
    // Not fetched yet.
  }

  const response = await fetch(entry.url, { signal: AbortSignal.timeout(120_000) });
  if (!response.ok) {
    throw new Error(`не скачалось: ${response.status}`);
  }
  const bytes = Buffer.from(await response.arrayBuffer());
  const got = createHash("sha256").update(bytes).digest("hex");
  if (got !== entry.sha256) {
    throw new Error(`контрольная сумма ${entry.title} не сошлась`);
  }
  await mkdir(path.dirname(target), { recursive: true });
  // Staged and renamed, so an interrupted download never looks like a finished one.
  await writeFile(`${target}.partial`, bytes);
  await rename(`${target}.partial`, target);
  return target;
}

export { ATTRIBUTION };

function convert(from: string, to: string): Promise<void> {
  return new Promise((resolve, reject) => {
    execFile(
      "/usr/bin/afconvert",
      // Little-endian 16-bit, one channel, 16 kHz — the one shape the app plays.
      ["-f", "WAVE", "-d", `LEI16@${RATE}`, "-c", "1", from, to],
      { timeout: 60_000 },
      (error, _out, stderr) => (error ? reject(new Error(stderr.trim() || error.message)) : resolve()),
    );
  });
}

/** Strips the RIFF header off a file `afconvert` just wrote. */
async function samplesOf(wav: string): Promise<Buffer> {
  const bytes = await readFile(wav);
  let at = 12;
  while (at + 8 <= bytes.length) {
    const id = bytes.toString("ascii", at, at + 4);
    const size = bytes.readUInt32LE(at + 4);
    if (id === "data") {
      return bytes.subarray(at + 8, Math.min(bytes.length, at + 8 + size));
    }
    at += 8 + size + (size % 2);
  }
  throw new Error("в файле нет звуковых данных");
}

/**
 * The chosen cue as raw 16 kHz PCM, ready to be written into the app.
 *
 * Converted files are cached beside the original and reused until it changes, because
 * `afconvert` on a five-minute track is not something to do on every repaint.
 */
/**
 * Brings every cue to the same quiet reference, then applies the chosen volume. Without
 * the first step a slider means something different for each track: the generated ones
 * are already quiet, a downloaded one is mastered loud.
 */
function level(pcm: Buffer, volume: number): Buffer {
  const samples = pcm.length >> 1;
  let peak = 0;
  for (let i = 0; i < samples; i += 1) {
    peak = Math.max(peak, Math.abs(pcm.readInt16LE(i << 1)));
  }
  if (peak === 0) {
    return pcm;
  }
  const gain = ((0.22 * 32767) / peak) * volume;
  const out = Buffer.alloc(pcm.length);
  for (let i = 0; i < samples; i += 1) {
    out.writeInt16LE(Math.max(-32768, Math.min(32767, Math.round(pcm.readInt16LE(i << 1) * gain))), i << 1);
  }
  return out;
}

/** Rendering walks every sample twice, and a full track is megabytes of them. */
const rendered = new Map<string, Track>();

export async function render(id: string, volume = 1, capSeconds = NO_CAP): Promise<Track> {
  const memo = `${id}:${volume}:${capSeconds}`;
  const ready = rendered.get(memo);
  if (ready) {
    return ready;
  }
  const track = await build(id, volume, capSeconds);
  rendered.set(memo, track);
  return track;
}

async function build(id: string, volume: number, capSeconds: number): Promise<Track> {
  if (id === "silence") {
    // A second of nothing: the app's cue logic is left alone and simply plays silence.
    return { pcm: Buffer.alloc(RATE * 2), durationMs: 1000, rate: RATE };
  }
  const entry = builtinOf(id);
  const source = entry ? await ensureBuiltin(id) : path.join(paths.musicDir, id.slice(4));
  const info = await stat(source);
  const cached = path.join(cacheDir, `${path.basename(source)}.${info.mtimeMs.toFixed(0)}.wav`);

  await mkdir(cacheDir, { recursive: true });
  try {
    await stat(cached);
  } catch {
    await convert(source, cached);
  }

  let pcm = await samplesOf(cached);
  // Every shipped track opens with an intro; the loop starts after it.
  const from = Math.min((entry?.fromSeconds ?? 0) * RATE * 2, Math.max(0, pcm.length - RATE * 2));
  pcm = capSeconds > 0 ? pcm.subarray(from, from + capSeconds * RATE * 2) : pcm.subarray(from);
  // Fades at both ends, or a loop clicks on every repeat.
  const edge = Math.min(Math.round(0.02 * RATE), pcm.length >> 2);
  const faded = Buffer.from(pcm);
  for (let i = 0; i < edge; i += 1) {
    const gain = i / edge;
    faded.writeInt16LE(Math.round(faded.readInt16LE(i * 2) * gain), i * 2);
    const tail = (faded.length >> 1) - 1 - i;
    faded.writeInt16LE(Math.round(faded.readInt16LE(tail * 2) * gain), tail * 2);
  }
  return { pcm: level(faded, volume), durationMs: (faded.length / 2 / RATE) * 1000, rate: RATE };
}

/**
 * Fetches a shipped track before anything needs it.
 *
 * Without this the first fetch happens when the cue is first asked for — which is the
 * moment it should already be playing, so the first silence of a session would be
 * silent indeed. Failures are swallowed: with no network the patched client falls back
 * to Paseo's own tone, which is the right outcome and not worth an error anybody sees.
 */
export async function warmUp(id: string): Promise<void> {
  if (!builtinOf(id)) {
    return;
  }
  await ensureBuiltin(id).catch(() => {});
}

/** Makes the folder and says where it is, so the surface can tell somebody. */
export async function folder(): Promise<string> {
  await mkdir(paths.musicDir, { recursive: true }).catch(() => {});
  return paths.musicDir;
}
