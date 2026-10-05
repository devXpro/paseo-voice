import { execFile, spawn, type ChildProcess } from "node:child_process";
import { createWriteStream, existsSync } from "node:fs";
import { mkdir, rename, rm, stat } from "node:fs/promises";
import path from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { paths } from "./paths.server.ts";

/**
 * Dictation, run by this plugin rather than reported on.
 *
 * Paseo's built-in recogniser is Parakeet, which is English-only, so dictating Russian
 * produces confident nonsense. The seam is the same one the speech side uses: point
 * `providers.openai.stt.baseUrl` at something local and Paseo will transcribe through
 * it. This is that something.
 *
 * The recognition itself is `whisper-server` from whisper.cpp — a neural network with
 * Metal kernels, which is the one piece of this that cannot be written in the language
 * the rest of the plugin is written in. Everything around it is here: finding it,
 * installing it, fetching the weights, starting it, and speaking OpenAI's shape at the
 * front.
 */

/** Where the binary lives once Homebrew has it, and the usual Intel location too. */
const CANDIDATES = ["/opt/homebrew/bin/whisper-server", "/usr/local/bin/whisper-server"];

/**
 * The weights, in three sizes.
 *
 * Quantised ones are the same model with less precision per weight. `q8_0` is half the
 * size of the full one and the difference is not audible in dictation, which is why it
 * is the default rather than the largest.
 */
export const MODELS = [
  {
    id: "large-v3-turbo-q8_0",
    title: "Large v3 Turbo · q8",
    note: "лучшее соотношение: вдвое легче полной, качество то же",
    file: "ggml-large-v3-turbo-q8_0.bin",
    bytes: 874_188_075,
  },
  {
    id: "large-v3-turbo-q5_0",
    title: "Large v3 Turbo · q5",
    note: "вдвое легче предыдущей, на технических терминах чуть слабее",
    file: "ggml-large-v3-turbo-q5_0.bin",
    bytes: 573_849_419,
  },
  {
    id: "large-v3-turbo",
    title: "Large v3 Turbo",
    note: "полная, без потерь — берите, если места не жалко",
    file: "ggml-large-v3-turbo.bin",
    bytes: 1_624_555_275,
  },
] as const;

export type ModelId = (typeof MODELS)[number]["id"];

export const modelOf = (id: string) => MODELS.find((one) => one.id === id);

/** Hugging Face serves these directly; no token and no API in the way. */
const sourceOf = (file: string) =>
  `https://huggingface.co/ggerganov/whisper.cpp/resolve/main/${file}?download=true`;

export const modelDir = path.join(paths.root, "models", "whisper");
export const modelPath = (file: string) => path.join(modelDir, file);

/** Bytes on disk, or 0 when it is absent or too short to be the whole thing. */
export async function installedBytes(id: string): Promise<number> {
  const model = modelOf(id);
  if (!model) {
    return 0;
  }
  try {
    const info = await stat(modelPath(model.file));
    // A partial left by an interrupted run is smaller; call it absent so the surface
    // offers to fetch it rather than starting an engine that cannot load.
    return info.size > model.bytes * 0.98 ? info.size : 0;
  } catch {
    return 0;
  }
}

/** The binary's path, or "" when it is not installed. */
export async function enginePath(): Promise<string> {
  for (const candidate of CANDIDATES) {
    try {
      await stat(candidate);
      return candidate;
    } catch {
      // Not here; try the next.
    }
  }
  return await new Promise((resolve) => {
    execFile("/usr/bin/which", ["whisper-server"], (error, out) =>
      resolve(error ? "" : out.trim()),
    );
  });
}

/**
 * Installs the engine through Homebrew.
 *
 * Done by the plugin because the alternative is a README step, and a plugin that needs
 * a README step is not self-sufficient. It is slow — minutes, and it wants the network
 * — so the surface shows it running rather than appearing to hang.
 *
 * On a managed machine this can be refused outright. The error is passed through
 * untouched for that reason: "brew is not installed" and "your administrator has
 * disabled this" need different answers from the person reading it.
 */
export function installEngine(log: (line: string) => void = () => {}): Promise<void> {
  return new Promise((resolve, reject) => {
    const brew = ["/opt/homebrew/bin/brew", "/usr/local/bin/brew"].find((one) => existsSync(one));
    if (!brew) {
      reject(new Error("Homebrew не найден. Поставь его с brew.sh, потом нажми ещё раз."));
      return;
    }
    log("voice: brew install whisper-cpp");
    execFile(brew, ["install", "whisper-cpp"], { timeout: 15 * 60_000 }, (error, _out, stderr) => {
      if (error) {
        reject(new Error(stderr.trim().split("\n").slice(-3).join(" ") || error.message));
        return;
      }
      resolve();
    });
  });
}

/**
 * Fetches a model, reporting progress as it goes.
 *
 * Staged beside the target and renamed, so an interrupted download is never mistaken
 * for a finished one — these are hundreds of megabytes and an interruption is likely.
 */
export async function fetchModel(
  id: string,
  onProgress: (done: number, total: number) => void = () => {},
): Promise<void> {
  const model = modelOf(id);
  if (!model) {
    throw new Error(`неизвестная модель ${id}`);
  }
  await mkdir(modelDir, { recursive: true });
  const target = modelPath(model.file);
  const staged = `${target}.partial`;

  const response = await fetch(sourceOf(model.file), { signal: AbortSignal.timeout(60 * 60_000) });
  if (!response.ok || !response.body) {
    throw new Error(`не скачалось: ${response.status}`);
  }
  const total = Number(response.headers.get("content-length")) || model.bytes;
  let done = 0;
  const source = Readable.fromWeb(response.body as Parameters<typeof Readable.fromWeb>[0]);
  source.on("data", (chunk: Buffer) => {
    done += chunk.length;
    onProgress(done, total);
  });
  await pipeline(source, createWriteStream(staged));
  await rename(staged, target);
}

export async function forgetModel(id: string): Promise<void> {
  const model = modelOf(id);
  if (model) {
    await rm(modelPath(model.file), { force: true });
  }
}

export type Recogniser = {
  /** Brings the engine up on `port` with `model` loaded, if it is not already. */
  ensure(id: string, language: string, prompt: string): Promise<void>;
  stop(): void;
  running(): boolean;
  loaded(): string;
  lastError(): string;
  port: number;
};

/**
 * The `whisper-server` process.
 *
 * Kept warm once started: loading the weights takes seconds and a cold start on every
 * dictated sentence would be worse than the English-only recogniser this replaces.
 */
export function createRecogniser(options: { port: number; log?: (line: string) => void }): Recogniser {
  const { port, log = () => {} } = options;
  let child: ChildProcess | null = null;
  let loaded = "";
  let hint = "";
  let failure = "";

  async function alive(): Promise<boolean> {
    try {
      const response = await fetch(`http://127.0.0.1:${port}/`, { signal: AbortSignal.timeout(1_000) });
      return response.status < 500;
    } catch {
      return false;
    }
  }

  return {
    port,
    running: () => child !== null && !child.killed,
    loaded: () => loaded,
    lastError: () => failure,
    stop() {
      child?.kill();
      child = null;
      loaded = "";
    },
    async ensure(id, language, prompt) {
      // The vocabulary hint is given at startup rather than per request: whisper-server
      // takes it either way, but injecting a field means rebuilding the multipart body
      // of every dictated sentence, and the engine comes back in under a second.
      if (child && loaded === id && hint === prompt && !child.killed) {
        return;
      }
      this.stop();
      const model = modelOf(id);
      if (!model) {
        throw new Error(`неизвестная модель ${id}`);
      }
      if ((await installedBytes(id)) === 0) {
        throw new Error("модель не скачана");
      }
      const binary = await enginePath();
      if (!binary) {
        throw new Error("whisper-server не установлен");
      }
      failure = "";
      child = spawn(
        binary,
        [
          "--model", modelPath(model.file),
          "--host", "127.0.0.1",
          "--port", String(port),
          "--language", language,
          // Two fewer than the cores, so dictating does not make everything else stutter.
          "--threads", String(Math.max(2, (await cores()) - 2)),
          // Words it should expect to hear. Whisper leans on this when a sound could
          // be either of two words, which is most of what goes wrong with jargon.
          ...(prompt.trim() ? ["--prompt", prompt.trim()] : []),
        ],
        { stdio: ["ignore", "pipe", "pipe"] },
      );
      child.stderr?.on("data", (chunk: Buffer) => {
        const line = chunk.toString("utf8").trim();
        if (line) {
          failure = line.split("\n").slice(-1)[0] ?? "";
        }
      });
      child.once("exit", (code) => {
        if (code !== 0 && code !== null) {
          failure ||= `движок вышел с кодом ${code}`;
        }
        child = null;
        loaded = "";
      });

      // Loading the weights takes a few seconds; the first request must not race it.
      const deadline = Date.now() + 90_000;
      while (Date.now() < deadline) {
        if (await alive()) {
          loaded = id;
          hint = prompt;
          log(`voice: whisper on 127.0.0.1:${port}, ${model.title}`);
          return;
        }
        if (!child) {
          throw new Error(failure || "движок не поднялся");
        }
        await new Promise((wake) => setTimeout(wake, 400));
      }
      this.stop();
      throw new Error("движок не ответил за 90 секунд");
    },
  };
}

async function cores(): Promise<number> {
  const { availableParallelism } = await import("node:os");
  return availableParallelism?.() ?? 4;
}
