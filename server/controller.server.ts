import { readdir, stat } from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import { LOCAL_MODEL, type status as statusSchema } from "../shared/voice.shared.ts";
import { installedRelease } from "./binary.server.ts";
import { isDictationWired, isWired, wire, wireDictation as writeDictation } from "./config.server.ts";
import {
  DEFAULT_PROMPT,
  disable as disableDaemonSpeech,
  enable as enableDaemonSpeech,
  inspect as inspectSettings,
  reloadDaemon,
  replacePrompt,
} from "./daemon-settings.server.ts";
import type { Engine } from "./engine.server.ts";
import { folder as cueFolder, list as listCues } from "./cue.server.ts";
import { type GoogleVoice, hintOf, listVoices, readKey, writeKey } from "./google.server.ts";
import { paths } from "./paths.server.ts";
import { asPrompt, mine } from "./vocabulary.server.ts";
import { apply as applyPatches, inspect as inspectPatches, revert as revertPatches } from "./patches.server.ts";
import { clampVolume, clampRate, RATE_MAX, VOLUME_MAX, RATE_MIN, readStored, type Stored, writeStored } from "./state.server.ts";
import { resetsAt, summary } from "./usage.server.ts";
import {
  createRecogniser,
  enginePath,
  fetchModel,
  forgetModel,
  installedBytes,
  installEngine,
  modelDir,
  MODELS,
  modelOf,
  type Recogniser,
} from "./whisper.server.ts";

export type Status = z.infer<typeof statusSchema>;

export type Controller = {
  status(): Promise<Status>;
  setProvider(provider: "google" | "local"): Promise<Status>;
  setCloudVoice(voice: string): Promise<Status>;
  setLocalVoice(voice: string): Promise<Status>;
  setActiveModel(id: string): Promise<Status>;
  setRate(rate: number): Promise<Status>;
  setSteady(steady: boolean): Promise<Status>;
  setPhoneSafe(phoneSafe: boolean): Promise<Status>;
  setCue(cue: string): Promise<Status>;
  setCueVolume(volume: number): Promise<Status>;
  setKey(key: string): Promise<Status>;
  installRecogniser(): Promise<Status>;
  fetchRecogniserModel(id: string): Promise<Status>;
  forgetRecogniserModel(id: string): Promise<Status>;
  setRecogniserModel(id: string): Promise<Status>;
  wireDictation(on: boolean): Promise<Status>;
  setDictionary(text: string): Promise<Status>;
  mineDictionary(): Promise<Status>;
  refreshCloud(): Promise<Status>;
  setPrompt(text: string): Promise<Status>;
  applyPatch(): Promise<Status>;
  revertPatch(): Promise<Status>;
  applyToPaseo(): Promise<Status>;
  enableSpeech(): Promise<Status>;
  disableSpeech(): Promise<Status>;
  markBinaryChanged(): void;
  /** Where the dictation engine is, for the proxy to forward to. */
  recogniserState(): { port: number; running: boolean };
  /** Brings the engine back if the config says dictation goes through this plugin. */
  resumeDictation(): Promise<void>;
  /** The live choice the proxy reads on every sentence. */
  choice(): Promise<Stored & { googleKey: string }>;
};

/** The local engine binary published for this platform is macOS on Apple silicon only. */
const localSupported = process.platform === "darwin" && process.arch === "arm64";

async function installedModels(): Promise<{ id: string; label: string; installed: boolean; onDisk: number }[]> {
  const known = [LOCAL_MODEL, { id: "0.6b-customvoice", label: "0.6B CustomVoice" }];
  const rows = [];
  for (const model of known) {
    let onDisk = 0;
    try {
      const entries = await readdir(paths.model(model.id), { withFileTypes: true });
      for (const entry of entries) {
        if (entry.isFile()) {
          onDisk += (await stat(path.join(paths.model(model.id), entry.name))).size;
        }
      }
    } catch {
      onDisk = 0;
    }
    rows.push({ id: model.id, label: model.label, installed: onDisk > 0, onDisk });
  }
  return rows;
}

async function engineSpeakers(port: number): Promise<string[]> {
  try {
    const response = await fetch(`http://127.0.0.1:${port}/v1/speakers`, { signal: AbortSignal.timeout(2000) });
    if (!response.ok) {
      return [];
    }
    const body = (await response.json()) as { speakers?: { name: string }[] };
    return (body.speakers ?? []).map((speaker) => speaker.name);
  } catch {
    return [];
  }
}

export function createController(options: {
  engine: Engine;
  log?: (line: string) => void;
  dictationPort?: number;
  /** Read at snapshot time: the proxy is owned by the entry point, not by this. */
  proxy?: () => { listening: boolean; port: number; error: string };
}): Controller {
  const { engine, log = () => {}, proxy = () => ({ listening: false, port: 0, error: "" }) } = options;
  // Set after a config write: the daemon resolves speech providers once, at startup.
  let restartRequired = false;
  let binaryRelease: string | null = null;
  // The catalogue is asked of Google once and held: it changes when Google ships a
  // voice, not between two taps on a screen.
  let catalogue: GoogleVoice[] | null = null;
  let cloudError = "";

  // Dictation. The engine is a child process kept warm between sentences; the rest is
  // what the panel needs to show while something slow is happening.
  const recogniser = createRecogniser({ port: options.dictationPort ?? 8125, log });
  let downloading = "";
  let downloaded = 0;
  let downloadTotal = 0;
  let dictationBusy = "";
  let dictationError = "";

  async function cloudVoices(key: string): Promise<GoogleVoice[]> {
    if (!key) {
      catalogue = null;
      cloudError = "";
      return [];
    }
    if (catalogue) {
      return catalogue;
    }
    try {
      catalogue = await listVoices(key);
      cloudError = "";
    } catch (failure) {
      catalogue = null;
      cloudError = failure instanceof Error ? failure.message : String(failure);
    }
    return catalogue ?? [];
  }

  /** Everything the dictation section needs, gathered in one pass. */
  async function dictationState(port: number) {
    const [engine, wired, ...sizes] = await Promise.all([
      enginePath(),
      isDictationWired(port),
      ...MODELS.map((one) => installedBytes(one.id)),
    ]);
    return {
      engine,
      wired,
      models: MODELS.map((one, at) => ({
        id: one.id,
        title: one.title,
        note: one.note,
        bytes: one.bytes,
        onDisk: sizes[at] ?? 0,
        installed: (sizes[at] ?? 0) > 0,
      })),
    };
  }

  async function snapshot(stored: Stored): Promise<Status> {
    const key = await readKey();
    const [voices, models, usage, whisperSize, patch, cues, music] = await Promise.all([
      cloudVoices(key),
      installedModels(),
      summary(),
      dictationState(stored.port),
      inspectPatches(),
      listCues(),
      cueFolder(),
    ]);
    const release = (binaryRelease ??= await installedRelease());

    return {
      provider: stored.provider,

      keyPresent: key !== "",
      keyHint: hintOf(key),
      keyPath: paths.googleKey,
      cloudVoices: voices,
      cloudVoice: stored.googleVoice,
      cloudError,
      usage,
      usageResetsAt: resetsAt().toISOString(),

      localSupported,
      binaryInstalled: release !== "",
      localModels: models,
      activeModel: stored.activeModel,
      engine: { running: engine.running(), port: engine.port, model: engine.model(), error: engine.lastError() },
      localVoices: engine.running() ? await engineSpeakers(engine.port) : [],
      localVoice: stored.voice,

      rate: stored.rate,
      rateMin: RATE_MIN,
      rateMax: RATE_MAX,
      steady: stored.steady,
      phoneSafe: stored.phoneSafe,
      language: stored.language,

      proxy: proxy(),
      wired: await isWired(stored.port),
      restartRequired,
      settings: await inspectSettings(stored.prompt),
      cues,
      cue: stored.cue,
      cueVolume: stored.cueVolume,
      cueVolumeMax: VOLUME_MAX,
      cueFolder: music,
      prompt: { text: stored.prompt, isDefault: stored.prompt === DEFAULT_PROMPT, defaultText: DEFAULT_PROMPT },
      patch,
      whisper: {
        enginePath: whisperSize.engine,
        engineInstalled: whisperSize.engine !== "",
        models: whisperSize.models,
        model: stored.dictationModel,
        wired: whisperSize.wired,
        running: recogniser.running(),
        directory: modelDir,
        downloading,
        downloadedBytes: downloaded,
        downloadTotal,
        busy: dictationBusy,
        dictionary: stored.dictionary,
        error: dictationError || recogniser.lastError(),
      },
      error: "",
    };
  }

  /**
   * Fills in a choice nobody has made yet, so a fresh install speaks rather than
   * refusing. The default voice is the steadiest male Chirp measured by ear and by
   * pitch wobble; the local fallback takes whatever model is actually on disk.
   */
  async function resolved(): Promise<Stored> {
    const stored = await readStored();
    let next = stored;

    if (!next.googleVoice) {
      const voices = await cloudVoices(await readKey());
      const preferred =
        voices.find((voice) => voice.name.endsWith("Chirp3-HD-Orus")) ??
        voices.find((voice) => voice.tier === "chirp3-hd" && voice.gender === "male") ??
        voices[0];
      if (preferred) {
        next = { ...next, googleVoice: preferred.name };
      }
    }
    if (!next.activeModel) {
      const installed = (await installedModels()).find((model) => model.installed);
      if (installed) {
        next = { ...next, activeModel: installed.id };
      }
    }
    if (next !== stored) {
      await writeStored(next);
    }
    return next;
  }

  return {
    async status() {
      return snapshot(await resolved());
    },

    async choice() {
      return { ...(await resolved()), googleKey: await readKey() };
    },

    async setProvider(provider) {
      const stored = await resolved();
      const next = { ...stored, provider };
      await writeStored(next);
      // Nothing is listening to the local engine once Google is speaking.
      if (provider === "google" && engine.running()) {
        engine.stop();
      }
      log(`voice: provider ${provider}`);
      return snapshot(next);
    },

    async setCloudVoice(voice) {
      const stored = await resolved();
      const next = { ...stored, googleVoice: voice };
      await writeStored(next);
      log(`voice: cloud voice ${voice}`);
      return snapshot(next);
    },

    async setLocalVoice(voice) {
      const stored = await resolved();
      const next = { ...stored, voice };
      await writeStored(next);
      return snapshot(next);
    },

    async setActiveModel(id) {
      const stored = await resolved();
      const next = { ...stored, activeModel: id };
      await writeStored(next);
      // The running process is serving the old weights; drop it so the next utterance
      // brings up the new ones rather than quietly using what was already loaded.
      if (engine.running() && engine.model() !== id) {
        engine.stop();
      }
      return snapshot(next);
    },

    async setRate(rate) {
      const stored = await resolved();
      const next = { ...stored, rate: clampRate(rate) };
      await writeStored(next);
      return snapshot(next);
    },

    async setSteady(steady) {
      const stored = await resolved();
      const next = { ...stored, steady };
      await writeStored(next);
      return snapshot(next);
    },

    async setPhoneSafe(phoneSafe) {
      const stored = await resolved();
      const next = { ...stored, phoneSafe };
      await writeStored(next);
      return snapshot(next);
    },

    async setCue(cue) {
      const stored = await resolved();
      const next = { ...stored, cue };
      await writeStored(next);
      log(`voice: waiting cue ${cue}`);
      return snapshot(next);
    },

    async setCueVolume(volume) {
      const stored = await resolved();
      const next = { ...stored, cueVolume: clampVolume(volume) };
      await writeStored(next);
      return snapshot(next);
    },

    /**
     * The failure is reported through the panel rather than thrown: a rejected RPC
     * shows as a toast that says nothing, and "the key Google refused" is the one
     * thing somebody typing a key needs to read.
     */
    async setKey(key) {
      try {
        await writeKey(key);
        cloudError = "";
      } catch (failure) {
        cloudError = failure instanceof Error ? failure.message : String(failure);
        return snapshot(await resolved());
      }
      catalogue = null;
      return snapshot(await resolved());
    },

    /**
     * Installs the engine. Minutes, and it wants the network, so the panel is told it
     * is running rather than being left to look frozen.
     */
    async installRecogniser() {
      dictationBusy = "Ставлю движок через Homebrew…";
      dictationError = "";
      try {
        await installEngine(log);
      } catch (failure) {
        dictationError = failure instanceof Error ? failure.message : String(failure);
      } finally {
        dictationBusy = "";
      }
      return snapshot(await resolved());
    },

    /** Hundreds of megabytes; progress is published through the status. */
    async fetchRecogniserModel(id) {
      if (downloading) {
        return snapshot(await resolved());
      }
      downloading = id;
      downloaded = 0;
      downloadTotal = modelOf(id)?.bytes ?? 0;
      dictationError = "";
      try {
        await fetchModel(id, (done, total) => {
          downloaded = done;
          downloadTotal = total;
        });
      } catch (failure) {
        dictationError = failure instanceof Error ? failure.message : String(failure);
      } finally {
        downloading = "";
      }
      return snapshot(await resolved());
    },

    async forgetRecogniserModel(id) {
      const stored = await resolved();
      if (recogniser.loaded() === id) {
        recogniser.stop();
      }
      await forgetModel(id);
      return snapshot(stored);
    },

    async setRecogniserModel(id) {
      const stored = await resolved();
      const next = { ...stored, dictationModel: id };
      await writeStored(next);
      // The running engine has the old weights in memory; let the next sentence load
      // the new ones rather than leaving a quiet mismatch.
      if (recogniser.loaded() !== id) {
        recogniser.stop();
      }
      return snapshot(next);
    },

    /**
     * Hands dictation to this plugin, or gives it back.
     *
     * The engine is started here rather than on the first dictated word: loading the
     * weights takes seconds, and the first sentence of a session should not be the one
     * that waits for them.
     */
    async wireDictation(on) {
      const stored = await resolved();
      dictationError = "";
      if (on) {
        if ((await installedBytes(stored.dictationModel)) === 0) {
          dictationError = "сначала скачай модель";
          return snapshot(stored);
        }
        dictationBusy = "Поднимаю движок…";
        try {
          await recogniser.ensure(stored.dictationModel, stored.language === "russian" ? "ru" : "en", stored.dictionary);
        } catch (failure) {
          dictationError = failure instanceof Error ? failure.message : String(failure);
          dictationBusy = "";
          return snapshot(stored);
        }
        dictationBusy = "";
      } else {
        recogniser.stop();
      }
      const changed = await writeDictation(stored.port, on, stored.dictationModel, stored.language === "russian" ? "ru" : "en");
      if (changed) {
        restartRequired = true;
        log(`voice: dictation ${on ? "wired to" : "returned from"} 127.0.0.1:${stored.port}`);
      }
      return snapshot(stored);
    },

    /** The engine takes this at startup, so a change costs it a restart — about a second. */
    async setDictionary(text) {
      const stored = await resolved();
      const next = { ...stored, dictionary: text.trim() };
      await writeStored(next);
      if (recogniser.running()) {
        dictationBusy = "Перезапускаю движок со словарём…";
        try {
          await recogniser.ensure(next.dictationModel, next.language === "russian" ? "ru" : "en", next.dictionary);
        } catch (failure) {
          dictationError = failure instanceof Error ? failure.message : String(failure);
        } finally {
          dictationBusy = "";
        }
      }
      return snapshot(next);
    },

    /** Reads this person's own dictated turns and keeps the words they actually use. */
    async mineDictionary() {
      dictationBusy = "Читаю переписки…";
      dictationError = "";
      try {
        const terms = await mine();
        return await this.setDictionary(asPrompt(terms));
      } catch (failure) {
        dictationError = failure instanceof Error ? failure.message : String(failure);
        return snapshot(await resolved());
      } finally {
        dictationBusy = "";
      }
    },

    async refreshCloud() {
      catalogue = null;
      cloudError = "";
      return snapshot(await resolved());
    },

    async setPrompt(text) {
      const stored = await resolved();
      const next = { ...stored, prompt: text.trim() };
      // The config is only touched when our paragraph is actually in it; otherwise the
      // new text just waits in our state until the switch is turned on.
      await replacePrompt(stored.prompt, next.prompt);
      await writeStored(next);
      await reloadDaemon().catch((failure: unknown) => log(`voice: reload failed: ${String(failure)}`));
      log(`voice: prompt replaced (${next.prompt.length} chars)`);
      return snapshot(next);
    },

    async applyPatch() {
      await applyPatches();
      log("voice: tts-manager patched");
      return snapshot(await resolved());
    },

    async revertPatch() {
      await revertPatches();
      log("voice: tts-manager restored");
      return snapshot(await resolved());
    },

    async applyToPaseo() {
      const stored = await resolved();
      const changed = await wire(stored.port, stored.language === "russian" ? "ru" : "en");
      if (!changed) {
        log("voice: already wired, config left alone");
        return snapshot(stored);
      }
      // Only now: a restart is what writing costs, and nothing was written.
      restartRequired = true;
      log(`voice: wired Paseo voice mode to 127.0.0.1:${stored.port}`);
      return snapshot(stored);
    },

    async enableSpeech() {
      const stored = await resolved();
      await enableDaemonSpeech(stored.prompt);
      await reloadDaemon().catch((failure: unknown) => log(`voice: reload failed: ${String(failure)}`));
      return snapshot(await resolved());
    },

    async disableSpeech() {
      const stored = await resolved();
      await disableDaemonSpeech(stored.prompt);
      await reloadDaemon().catch((failure: unknown) => log(`voice: reload failed: ${String(failure)}`));
      return snapshot(await resolved());
    },

    recogniserState() {
      return { port: recogniser.port, running: recogniser.running() };
    },

    /**
     * Called on start, because the config outlives the process.
     *
     * Reloading the plugin kills the engine but leaves `~/.paseo/config.json` pointing
     * dictation here, so Paseo keeps sending audio to a proxy with nothing behind it
     * and every dictated word comes back as "движок распознавания не запущен". The
     * switch in the panel is for turning the feature on, not for surviving a restart.
     */
    async resumeDictation() {
      const stored = await resolved();
      if (!(await isDictationWired(stored.port))) {
        return;
      }
      if ((await installedBytes(stored.dictationModel)) === 0) {
        dictationError = "модель не скачана, а диктовка прописана на плагин";
        return;
      }
      try {
        await recogniser.ensure(stored.dictationModel, stored.language === "russian" ? "ru" : "en", stored.dictionary);
      } catch (failure) {
        dictationError = failure instanceof Error ? failure.message : String(failure);
        log(`voice: dictation did not resume: ${dictationError}`);
      }
    },

    markBinaryChanged() {
      binaryRelease = null;
    },
  };
}
