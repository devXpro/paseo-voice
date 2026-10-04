import { mkdir, readdir, readFile, rename, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { type Archive, type Entry, locate, readArchive, readEntry, writeEntry } from "./asar.server.ts";
import { paths } from "./paths.server.ts";

/**
 * Two corrections to Paseo's own speech manager, written into its archive.
 *
 * The first is a real bug, reproduced in forty lines with no part of this plugin
 * present: the manager asks for a sentence, leaves the reply's body unread until the
 * previous sentence has finished playing, and opens the next request meanwhile. An
 * HTTP client reclaims a finished-but-unread body to get its connection back, so the
 * body arrives empty — and empty is indistinguishable from "this sentence is meant to
 * be silent", so the sentence is dropped without a word in any log. Draining the body
 * at the moment it arrives removes the window entirely.
 *
 * The second is the long gaps. The manager splits on every full stop and never merges,
 * so "Окей, слушай." becomes its own request, its own round trip to the phone, and its
 * own second of silence. Merging up to the limit it already defines turns a seven-part
 * answer into two.
 *
 * Patched in place and byte-for-byte: the replacement is squeezed back into the space
 * the original occupied, so the archive's header stays true and 112 MB need not be
 * rebuilt. Anything else means reproducing the unpacked-file flags by hand.
 */

/** Grepped for to tell a patched file from a clean one. */
export const MARKER = "paseo-voice:";

/** Where the desktop bundle asks for the cue; the plugin's proxy answers there. */
const CUE_PORT = 8123;

/**
 * Either an exact string to swap, or a shape to match. Minified code has no stable
 * identifiers, so a correction there can only be anchored by what it looks like.
 */
type Splice = { find: string; replace: string } | { pattern: RegExp; replace: string };

export type Target = {
  id: string;
  title: string;
  /** What it fixes, in one line, for the panel. */
  note: string;
  /**
   * Inside the archive, or a plain file beside it. The archive demands the replacement
   * keep its exact length; a plain file does not, which is the only difference in how
   * the two are written.
   */
  kind: "asar" | "file";
  /** A path inside the archive, or a glob under the app's resources for a plain file. */
  entry: string;
  splices: readonly Splice[];
};

const ttsSplices: readonly Splice[] = [
  {
    // Drain the body the moment it exists, rather than holding the stream.
    find: `        return {
            ...segment,
            stream,
            format,
        };`,
    replace: `        // paseo-voice: read the body now, not when this segment's turn to play comes.
        // A finished reply left unread is reclaimed by the HTTP client to free its
        // connection, and what reaches the player is nothing at all.
        const collected = [];
        for await (const chunk of stream) {
            collected.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
        }
        const whole = Buffer.concat(collected);
        return {
            ...segment,
            format,
            stream: { async *[Symbol.asyncIterator]() { if (whole.length > 0) yield whole; } },
        };`,
  },
  {
    // Merge short sentences up to the limit the file already defines.
    find: `    const sentences = normalized.split(/(?<=[.!?])\\s+/);`,
    replace: `    const sentences = normalized.split(/(?<=[.!?])\\s+/);
    // paseo-voice: every extra segment is another round trip to the client and another
    // second of silence between sentences. Group them up to the same limit.
    const grouped = [];
    for (const one of sentences) {
        const last = grouped.length > 0 ? grouped[grouped.length - 1] : null;
        if (last !== null && last.length + 1 + one.length <= MAX_TTS_SEGMENT_CHARS) {
            grouped[grouped.length - 1] = last + " " + one;
        }
        else {
            grouped.push(one);
        }
    }`,
  },
  { find: `    for (const sentence of sentences) {`, replace: `    for (const sentence of grouped) {` },
];

/**
 * Muting stops the client sending audio outright, and the server's voice-activity
 * detector only advances its clock on audio it receives — so the turn never ends and
 * what was said sits there unsent. The detector already has a `flush` that forces the
 * end of a turn; nothing in the daemon ever calls it. A watchdog does, once the stream
 * has been quiet for longer than any jitter could explain.
 */
const muteSplices: readonly Splice[] = [
  {
    find: `    let state = { status: "idle" };`,
    replace: `    let state = { status: "idle" };
    // paseo-voice: a muted client sends nothing at all, and nothing is what the
    // detector needs to notice the turn has ended. Close it by force instead.
    const STALL_MS = 600, STALL_TICK_MS = 150;
    let lastChunkAt = 0, stallTimer = null;
    function stopStallWatch() {
        if (stallTimer) { clearInterval(stallTimer); stallTimer = null; }
    }
    function startStallWatch() {
        stopStallWatch();
        stallTimer = setInterval(() => {
            if (state.status !== "capturing" || lastChunkAt === 0) return;
            if (Date.now() - lastChunkAt < STALL_MS) return;
            lastChunkAt = 0;
            if (typeof detector.flush !== "function") return;
            params.logger.info({ stallMs: STALL_MS }, "voice_turn.client_audio_stalled");
            void runSerial(async () => { detector.flush(); });
        }, STALL_TICK_MS);
        if (typeof stallTimer.unref === "function") stallTimer.unref();
    }`,
  },
  {
    find: `            await detector.connect();`,
    replace: `            await detector.connect();
            startStallWatch();`,
  },
  { find: `                detector.close();`, replace: `                stopStallWatch();
                detector.close();` },
  {
    find: `                const pcm16 = Buffer.from(input.audioBase64, "base64");`,
    replace: `                lastChunkAt = Date.now();
                const pcm16 = Buffer.from(input.audioBase64, "base64");`,
  },
];

/**
 * Makes the desktop client ask this plugin for its waiting cue instead of playing the
 * one baked into its bundle.
 *
 * Baking the chosen sound in directly was the obvious thing and the wrong one: every
 * change of track or volume meant rewriting a 21 MB bundle and restarting the app. The
 * source for the cue is already an async `arrayBuffer()`, so it can simply fetch — and
 * then the choice lives in this plugin, takes effect on the next play, and needs no
 * patch at all after the first.
 *
 * The bundle's own bytes stay as the fallback: with the plugin stopped the cue is
 * Paseo's original tone rather than silence.
 */
const cueSplices: readonly Splice[] = [
  {
    // `{size:C.byteLength,type:"audio/pcm;rate=16000;bits=16",arrayBuffer:async()=>C.buffer.slice(…)}`
    // Matched by shape: minified identifiers change between builds.
    pattern:
      /\{size:(\w+)\.byteLength,type:"audio\/pcm;rate=16000;bits=16",arrayBuffer:async\(\)=>\1\.buffer\.slice\(\1\.byteOffset,\1\.byteOffset\+\1\.byteLength\)\}/,
    replace:
      `{size:$1.byteLength,type:"audio/pcm;rate=16000;bits=16",arrayBuffer:async()=>{/*${MARKER}live*/` +
      `try{const r=await fetch("http://127.0.0.1:${CUE_PORT}/v1/cue",{cache:"no-store"});` +
      `if(r.ok){const b=await r.arrayBuffer();if(b.byteLength>0)return b}}catch(e){}` +
      `return $1.buffer.slice($1.byteOffset,$1.byteOffset+$1.byteLength)}}`,
  },
  {
    /**
     * Two numbers: the gap between repeats and the silence before the first play.
     * The gap reads as a stutter once the cue is music, and the 1500 ms wait is what
     * upstream added so the cue would not fire in the pauses between spoken sentences
     * — pauses the other two corrections here already removed.
     */
    pattern: /(\w+)=350,(\w+)=1500/,
    replace: "$1=0,$2=250",
  },
];

export const TARGETS: readonly Target[] = [
  {
    id: "drain",
    title: "Читать звук сразу",
    note: "Убирает пропажу предложений посреди ответа",
    kind: "asar",
    entry: "node_modules/@getpaseo/server/dist/server/server/agent/tts-manager.js",
    splices: ttsSplices,
  },
  {
    id: "mute",
    title: "Мьют отправляет фразу",
    note: "Сейчас мьют обрывает поток, и сказанное висит неотправленным",
    kind: "asar",
    entry: "node_modules/@getpaseo/server/dist/server/server/session/voice/voice-turn-controller.js",
    splices: muteSplices,
  },
  {
    id: "cue",
    title: "Своя музыка ожидания",
    note: "Ставит в десктопный Paseo звук, выбранный в разделе «Звук ожидания»",
    kind: "file",
    entry: "app-dist/_expo/static/js/web/index-*.js",
    splices: cueSplices,
  },
];

export type Outcome = { ok: true; text: string } | { ok: false; reason: "already-patched" | "unknown-version" };

/**
 * Applies the corrections to the original source.
 *
 * Refuses on an anchor that is missing or occurs twice rather than guessing, which is
 * the whole version check: an upstream rewrite of these functions will not match, and
 * not matching is the safe answer.
 */
export function patchSource(original: string, splices: readonly Splice[]): Outcome {
  if (original.includes(MARKER)) {
    return { ok: false, reason: "already-patched" };
  }
  let text = original;
  for (const splice of splices) {
    if ("pattern" in splice) {
      // Global copy so a second occurrence can be counted: an ambiguous shape is as
      // unsafe to patch as a missing one.
      const all = new RegExp(splice.pattern.source, `${splice.pattern.flags.replace("g", "")}g`);
      if ([...text.matchAll(all)].length !== 1) {
        return { ok: false, reason: "unknown-version" };
      }
      text = text.replace(splice.pattern, splice.replace);
      continue;
    }
    const first = text.indexOf(splice.find);
    if (first === -1 || text.indexOf(splice.find, first + splice.find.length) !== -1) {
      return { ok: false, reason: "unknown-version" };
    }
    text = text.slice(0, first) + splice.replace + text.slice(first + splice.find.length);
  }
  // The source map no longer describes these lines, and a wrong map is worse than none.
  return { ok: true, text: text.replace(/\n\/\/# sourceMappingURL=.*\n?$/, "\n") };
}

/**
 * Squeezes the patched source back into the original's exact byte length, then pads.
 * Only leading indentation is touched; this file is compiled TypeScript with no
 * template literals spanning lines, so whitespace at the start of a line carries nothing.
 */
export function fit(source: string, target: number): string | null {
  let text = source;
  const halve = (line: string) => line.replace(/^ +/, (indent) => " ".repeat(indent.length >> 1));
  if (Buffer.byteLength(text) > target) {
    text = text.split("\n").map(halve).join("\n");
  }
  if (Buffer.byteLength(text) > target) {
    text = text.split("\n").map((line) => line.replace(/^ +/, "")).join("\n");
  }
  const slack = target - Buffer.byteLength(text);
  return slack < 0 ? null : text + " ".repeat(slack);
}

export type TargetState = {
  id: string;
  title: string;
  note: string;
  applied: boolean;
  /** The file is there but its shape has changed — a Paseo this plugin does not know. */
  unknownVersion: boolean;
};

export type PatchState = {
  /** Paseo's archive was found and still carries the files these correct. */
  available: boolean;
  /** Every correction is in place. */
  applied: boolean;
  unknownVersion: boolean;
  archivePath: string;
  /** Set after applying or reverting: the daemon already has the old code in memory. */
  restartRequired: boolean;
  targets: TargetState[];
  error: string;
};

/** Electron sets `resourcesPath`; plain Node does not, hence the fixed fallback. */
const resourcesPath = (process as { resourcesPath?: string }).resourcesPath;

const CANDIDATES = [
  () => (resourcesPath ? path.join(resourcesPath, "app.asar") : ""),
  () => "/Applications/Paseo.app/Contents/Resources/app.asar",
];

async function located(): Promise<Archive | null> {
  for (const candidate of CANDIDATES) {
    const file = candidate();
    if (!file) {
      continue;
    }
    try {
      const archive = await readArchive(file);
      // The right archive is the one that actually carries the files; a helper bundle
      // beside it does not, and that is how an earlier version picked the wrong one.
      // Only the archive targets are asked for: a `file` target lives beside it.
      if (TARGETS.filter((target) => target.kind === "asar").every((target) => locate(archive, target.entry))) {
        return archive;
      }
    } catch {
      // Not an archive, or not readable. Try the next.
    }
  }
  return null;
}

/** The plain file a `file` target points at; its name carries a content hash. */
async function fileOf(target: Target): Promise<string> {
  const [dir, mask] = [path.dirname(target.entry), path.basename(target.entry)];
  const [prefix, suffix] = mask.split("*");
  for (const candidate of CANDIDATES) {
    const archive = candidate();
    if (!archive) {
      continue;
    }
    const root = path.join(path.dirname(archive), dir);
    try {
      const found = (await readdir(root)).find(
        (name) => name.startsWith(prefix ?? "") && name.endsWith(suffix ?? ""),
      );
      if (found) {
        return path.join(root, found);
      }
    } catch {
      // Not where this one looked. Try the next.
    }
  }
  return "";
}

/** Named after the file it holds, so an upstream rename leaves nothing to restore. */
async function backupOf(target: Target): Promise<string> {
  const name = target.kind === "file" ? path.basename(await fileOf(target)) : (target.entry.split("/").pop() ?? target.id);
  return path.join(paths.root, "patches", `${name || target.id}.original`);
}

/** Reads a target's current text, wherever it lives. */
async function textOf(archive: Archive, target: Target): Promise<{ text: string; size: number } | null> {
  if (target.kind === "file") {
    const file = await fileOf(target);
    if (!file) {
      return null;
    }
    const text = await readFile(file, "utf8");
    return { text, size: Buffer.byteLength(text) };
  }
  const entry = locate(archive, target.entry);
  if (!entry) {
    return null;
  }
  return { text: (await readEntry(archive.path, entry)).toString("utf8"), size: entry.size };
}

let restartRequired = false;

/**
 * What `inspect` may remember between calls.
 *
 * The panel asks for the status every few seconds, and answering means reading several
 * megabytes out of the archive and searching them. But the answer only changes when
 * Paseo is replaced or when this plugin writes to it, and both move a file's mtime. So
 * the reading is done once per version of the files on disk and replayed after that.
 */
let remembered: { of: string; state: PatchState } | null = null;

/**
 * The identity of everything `inspect` reads: path, mtime and size of each, with
 * absence spelled out rather than left as a gap. Stat only, so it stays cheap enough
 * to recompute on every call — which is the point, since it is what decides whether
 * the expensive part runs.
 */
export async function fingerprintOf(files: string[]): Promise<string> {
  const parts = await Promise.all(
    files.map(async (file) => {
      try {
        const { mtimeMs, size } = await stat(file);
        return `${file}:${mtimeMs}:${size}`;
      } catch {
        return `${file}:absent`;
      }
    }),
  );
  return parts.join("|");
}

/** The files behind the current answer: every place the archive could be, plus the
 *  loose bundle beside it, whose name carries a content hash of its own. */
async function fingerprint(): Promise<string> {
  const files = CANDIDATES.map((candidate) => candidate()).filter((file) => file !== "");
  for (const target of TARGETS) {
    if (target.kind === "file") {
      files.push((await fileOf(target)) || `${target.id}:unresolved`);
    }
  }
  return fingerprintOf(files);
}

export async function inspect(): Promise<PatchState> {
  const blank: PatchState = {
    available: false,
    applied: false,
    unknownVersion: false,
    archivePath: "",
    restartRequired,
    targets: [],
    error: "",
  };
  const of = await fingerprint();
  // `restartRequired` is this plugin's own flag, not something read off the disk, so it
  // is laid over the remembered answer rather than remembered with it.
  if (remembered?.of === of) {
    return { ...remembered.state, restartRequired };
  }
  try {
    const archive = await located();
    if (!archive) {
      return { ...blank, error: "не нашёл app.asar — Paseo стоит не там, где ожидалось" };
    }
    const targets: TargetState[] = [];
    for (const target of TARGETS) {
      const source = await textOf(archive, target);
      if (!source) {
        targets.push({ id: target.id, title: target.title, note: target.note, applied: false, unknownVersion: true });
        continue;
      }
      const outcome = patchSource(source.text, target.splices);
      targets.push({
        id: target.id,
        title: target.title,
        note: target.note,
        applied: !outcome.ok && outcome.reason === "already-patched",
        unknownVersion: !outcome.ok && outcome.reason === "unknown-version",
      });
    }
    const state: PatchState = {
      ...blank,
      available: true,
      applied: targets.every((one) => one.applied),
      unknownVersion: targets.some((one) => one.unknownVersion),
      archivePath: archive.path,
      targets,
    };
    // Only a complete answer is kept. A failure can be a half-written file during a
    // Paseo update, and remembering that would outlast the update.
    remembered = { of, state };
    return state;
  } catch (failure) {
    return { ...blank, error: failure instanceof Error ? failure.message : String(failure) };
  }
}

/**
 * Writes every correction that is not in place yet, keeping each original first.
 *
 * An archive entry has to keep its exact length so the header stays true; a plain file
 * beside it has no such constraint and is simply rewritten.
 */
export async function apply(): Promise<void> {
  const archive = await located();
  if (!archive) {
    throw new Error("не нашёл app.asar");
  }
  for (const target of TARGETS) {
    const source = await textOf(archive, target);
    if (!source) {
      throw new Error(`${target.title}: файл не найден — Paseo обновился`);
    }
    const outcome = patchSource(source.text, target.splices);
    if (!outcome.ok) {
      if (outcome.reason === "already-patched") {
        continue;
      }
      throw new Error(`${target.title}: незнакомая версия Paseo — якоря не совпали`);
    }

    // Kept before the first write only: a backup taken over a patched file is useless,
    // which is a mistake this plugin has already made once.
    const backup = await backupOf(target);
    await mkdir(path.dirname(backup), { recursive: true });
    try {
      await readFile(backup);
    } catch {
      await writeFile(backup, source.text, { mode: 0o600 });
    }

    if (target.kind === "file") {
      const file = await fileOf(target);
      // Staged and renamed: a half-written bundle is a client that will not start.
      const staged = `${file}.voice-plugin.tmp`;
      await writeFile(staged, outcome.text);
      await rename(staged, file);
      continue;
    }

    const fitted = fit(outcome.text, source.size);
    if (fitted === null) {
      throw new Error(`${target.title}: правка не влезает в исходный размер`);
    }
    await writeEntry(archive.path, locate(archive, target.entry)!, Buffer.from(fitted, "utf8"));
  }
  remembered = null;
  restartRequired = true;
}

export async function revert(): Promise<void> {
  const archive = await located();
  if (!archive) {
    throw new Error("не нашёл app.asar");
  }
  for (const target of TARGETS) {
    let original: string;
    try {
      original = await readFile(await backupOf(target), "utf8");
    } catch {
      // Nothing kept for this one, or Paseo renamed the file it lived in.
      continue;
    }
    if (target.kind === "file") {
      const file = await fileOf(target);
      if (!file) {
        continue;
      }
      const staged = `${file}.voice-plugin.tmp`;
      await writeFile(staged, original);
      await rename(staged, file);
      continue;
    }
    const entry = locate(archive, target.entry);
    if (!entry) {
      continue;
    }
    if (Buffer.byteLength(original) !== entry.size) {
      throw new Error(`${target.title}: сохранённый оригинал другого размера — Paseo обновился`);
    }
    await writeEntry(archive.path, entry, Buffer.from(original, "utf8"));
  }
  remembered = null;
  restartRequired = true;
}
