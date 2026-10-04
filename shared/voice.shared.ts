import { defineRpc } from "@getpaseo/plugin";
import { z } from "zod";

/**
 * The local engine: a pure-C Qwen3-TTS runtime, one binary per platform. It is the
 * fallback now rather than the main event — kept for when there is no key or no
 * network, and deliberately given the smaller half of the surface.
 */
export const ENGINE_REPO = "gabriele-mastrapasqua/qwen3-tts";
export const ENGINE_RELEASE = "v0.23.0";
export const ENGINE_ASSET = "qwen_tts-macos-arm64";

/** The one local model worth keeping: it read Russian cleanly where the small one did not. */
export const LOCAL_MODEL = {
  id: "1.7b-customvoice",
  repo: "Qwen/Qwen3-TTS-12Hz-1.7B-CustomVoice",
  label: "1.7B CustomVoice",
  bytes: 4_520_000_000,
} as const;

export const modelId = z.enum(["1.7b-customvoice", "0.6b-customvoice"]);

export const localModel = z.object({
  id: z.string(),
  label: z.string(),
  installed: z.boolean(),
  onDisk: z.number().int().nonnegative().default(0),
});

/** A Google voice, grouped by the tier that bills it. */
export const cloudVoice = z.object({
  name: z.string(),
  /** `chirp3-hd`, `standard` or `wavenet`. */
  tier: z.string(),
  gender: z.string(),
});

/** One billing family: what it costs, what is free, and how much of that is gone. */
export const tierUsage = z.object({
  id: z.string(),
  label: z.string(),
  note: z.string(),
  used: z.number().nonnegative(),
  free: z.number().nonnegative(),
  dollarsPerMillion: z.number().nonnegative(),
  owed: z.number().nonnegative(),
});

export const engineState = z.object({
  running: z.boolean(),
  port: z.number().int().positive(),
  model: z.string().default(""),
  error: z.string().default(""),
});

export const whisperState = z.object({
  name: z.string(),
  bytes: z.number().int().nonnegative(),
  onDisk: z.number().int().nonnegative().default(0),
  installed: z.boolean(),
  directory: z.string(),
});

/**
 * Two daemon settings decide whether voice mode can answer. `injectIntoAgents` is off
 * by default and withholds the MCP server that carries `speak`; the appended prompt is
 * what keeps a model from speaking one paragraph and typing the next.
 */
export const daemonSettings = z.object({
  mcpInjected: z.boolean(),
  promptSet: z.boolean(),
  foreignPrompt: z.boolean().default(false),
  configPath: z.string().default(""),
  error: z.string().default(""),
});

/**
 * The state of the two corrections written into Paseo's own archive: one that stops
 * sentences being dropped unread, one that stops the gaps between them.
 */
/** The appended prompt as it stands, plus whether it is still the built-in text. */
export const promptState = z.object({
  text: z.string(),
  isDefault: z.boolean(),
  /** Carried to the surface so "revert" has something to send back. */
  defaultText: z.string(),
});

/** One correction: what it fixes and whether it is in place. */
export const patchTarget = z.object({
  id: z.string(),
  title: z.string(),
  note: z.string(),
  applied: z.boolean(),
  unknownVersion: z.boolean().default(false),
});

/** One option for the sound that loops while the agent is thinking. */
export const cueOption = z.object({
  id: z.string(),
  title: z.string(),
  kind: z.enum(["builtin", "own", "silence"]),
  seconds: z.number().nonnegative(),
});

export const ttsPatch = z.object({
  available: z.boolean(),
  /** Every correction is in place. */
  applied: z.boolean(),
  targets: z.array(patchTarget).default([]),
  /** The file is there but its shape changed — a Paseo this plugin does not know. */
  unknownVersion: z.boolean().default(false),
  archivePath: z.string().default(""),
  /** The daemon already has the old code in memory, so this needs a full restart. */
  restartRequired: z.boolean().default(false),
  error: z.string().default(""),
});

export const status = z.object({
  /** Where speech comes from right now. */
  provider: z.enum(["google", "local"]),

  /** Google — the main path. */
  keyPresent: z.boolean().default(false),
  /** `AIzaSy…Hk4` — enough to recognise the key, never the key. */
  keyHint: z.string().default(""),
  keyPath: z.string().default(""),
  cloudVoices: z.array(cloudVoice).default([]),
  cloudVoice: z.string().default(""),
  cloudError: z.string().default(""),
  usage: z.array(tierUsage).default([]),
  /** When the free allowances start over, as an ISO date. */
  usageResetsAt: z.string().default(""),

  /** The local engine — the fallback, with the smaller half of the surface. */
  localSupported: z.boolean(),
  binaryInstalled: z.boolean(),
  localModels: z.array(localModel).default([]),
  activeModel: z.string().default(""),
  engine: engineState,
  localVoices: z.array(z.string()).default([]),
  localVoice: z.string().default(""),

  /** Shared between both providers: both take tempo per request. */
  rate: z.number().positive().default(1),
  rateMin: z.number().positive().default(0.7),
  rateMax: z.number().positive().default(1.6),
  steady: z.boolean().default(true),
  /** Whether speech is low-passed so a phone does not turn the top end into grit. */
  phoneSafe: z.boolean().default(true),
  language: z.string().default("russian"),

  /**
   * The local HTTP server everything speaks through. It can fail to come up while the
   * rest of the plugin is perfectly alive — a port still held by a daemon that is
   * shutting down — and then speech simply stops with nothing on screen to explain it.
   */
  proxy: z.object({
    listening: z.boolean().default(false),
    port: z.number().int().positive().default(8123),
    error: z.string().default(""),
  }),

  wired: z.boolean().default(false),
  restartRequired: z.boolean().default(false),
  settings: daemonSettings,
  prompt: promptState,
  cues: z.array(cueOption).default([]),
  cue: z.string().default("lobby-time"),
  cueVolume: z.number().nonnegative().default(1),
  cueVolumeMax: z.number().positive().default(2),
  /** Where to drop an audio file for it to show up in the list. */
  cueFolder: z.string().default(""),
  patch: ttsPatch,
  whisper: whisperState,
  error: z.string().default(""),
});

export const getStatus = defineRpc({ name: "voice.status", input: z.object({}), output: status });

export const setProvider = defineRpc({
  name: "voice.set-provider",
  input: z.object({ provider: z.enum(["google", "local"]) }),
  output: status,
});

/** Picks a Google voice. The billing tier is read from the name, never stored apart. */
export const setCloudVoice = defineRpc({
  name: "voice.set-cloud-voice",
  input: z.object({ voice: z.string().min(1) }),
  output: status,
});

export const setLocalVoice = defineRpc({
  name: "voice.set-local-voice",
  input: z.object({ voice: z.string().min(1) }),
  output: status,
});

export const setActiveModel = defineRpc({ name: "voice.set-model", input: z.object({ id: modelId }), output: status });

export const setRate = defineRpc({
  name: "voice.set-rate",
  input: z.object({ rate: z.number().positive() }),
  output: status,
});

export const setSteady = defineRpc({ name: "voice.set-steady", input: z.object({ steady: z.boolean() }), output: status });

/** Turns the low-pass on or off; heard on the next sentence, nothing to restart. */
export const setPhoneSafe = defineRpc({
  name: "voice.set-phone-safe",
  input: z.object({ phoneSafe: z.boolean() }),
  output: status,
});

/**
 * Keeps a Google key, or forgets it when given an empty string.
 *
 * Only ever travels in this direction. The key is checked against Google before it is
 * stored, so a typo cannot silently replace a working one, and the reply carries the
 * masked hint rather than the key — nothing hands it back out.
 */
export const setKey = defineRpc({
  name: "voice.set-key",
  input: z.object({ key: z.string().max(200) }),
  output: status,
});

/** Brings the local server back up after it failed to bind. */
export const restartProxy = defineRpc({ name: "voice.restart-proxy", input: z.object({}), output: status });

/** Re-reads the key file and asks Google for its catalogue again. */
export const refreshCloud = defineRpc({ name: "voice.refresh-cloud", input: z.object({}), output: status });

export const installBinary = defineRpc({ name: "voice.install-binary", input: z.object({}), output: status });

/** Points `~/.paseo/config.json` at this plugin's proxy, leaving dictation untouched. */
export const applyToPaseo = defineRpc({ name: "voice.apply", input: z.object({}), output: status });

/** Chooses the waiting cue the next build of the app will carry. */
export const setCueVolume = defineRpc({
  name: "voice.set-cue-volume",
  input: z.object({ volume: z.number().nonnegative() }),
  output: status,
});

export const setCue = defineRpc({ name: "voice.set-cue", input: z.object({ cue: z.string().min(1) }), output: status });

/**
 * The waiting cue as the phone needs it: raw 16 kHz PCM, base64.
 *
 * The desktop fetches this over loopback, which a phone cannot do — it is a different
 * device, usually on a different network, reaching the daemon through a relay. But it
 * is already holding that connection, and a plugin RPC rides it, so this is the same
 * trick by the only road available.
 *
 * `have` is whatever the caller played last. Matching it answers `unchanged` with no
 * audio attached, which is the normal case on every pause after the first: two
 * megabytes per pause over somebody's uplink would be its own bug.
 */
export const fetchCue = defineRpc({
  name: "voice.cue",
  input: z.object({ have: z.string().default("") }),
  output: z.object({
    /** Identifies track, volume and cap together — changing any of them changes it. */
    tag: z.string(),
    unchanged: z.boolean(),
    pcmBase64: z.string().default(""),
    rate: z.number().int().positive().default(16000),
    seconds: z.number().nonnegative().default(0),
    error: z.string().default(""),
  }),
});

/** Renders one cue so it can be auditioned before a build is spent on it. */
export const previewCue = defineRpc({
  name: "voice.preview-cue",
  input: z.object({
    cue: z.string().min(1),
    /**
     * How much of the track to send, or 0 for all of it.
     *
     * The desktop asks for the whole thing: it fetches over loopback and the size
     * costs nothing. A phone asks for twenty seconds, because its copy crosses a
     * relay — a four-minute track is nine megabytes, and nobody needs four minutes to
     * decide whether they like it. Compressing instead is not open: the phone's
     * engine takes raw samples and a plugin has no decoder to offer it.
     */
    capSeconds: z.number().nonnegative().default(0),
  }),
  output: z.object({ wavBase64: z.string(), seconds: z.number().nonnegative(), error: z.string().default("") }),
});

/** Replaces the appended prompt, in our state and in the daemon's config together. */
export const setPrompt = defineRpc({
  name: "voice.set-prompt",
  input: z.object({ text: z.string().min(1).max(8000) }),
  output: status,
});

/** Writes both corrections into `app.asar`, keeping the original bytes for the undo. */
export const applyPatch = defineRpc({ name: "voice.apply-patch", input: z.object({}), output: status });

/** Puts the stored original back. Refuses if Paseo has been updated since. */
export const revertPatch = defineRpc({ name: "voice.revert-patch", input: z.object({}), output: status });

/** Turns on MCP injection and appends the speak-everything instruction, then reloads. */
export const enableSpeech = defineRpc({ name: "voice.enable-speech", input: z.object({}), output: status });
export const disableSpeech = defineRpc({ name: "voice.disable-speech", input: z.object({}), output: status });

/**
 * Renders one line and hands back the bytes.
 *
 * Only the desktop client can play them: it is a browser and takes a data URL. The
 * phone is React Native on Hermes, and the host supplies plugin bundles with react,
 * react-native, zod and react-query — there is no audio among them, and no audio in
 * the plugin API either. So on a phone this is offered as unavailable rather than
 * sending somebody out of the app to a system player.
 */
export const preview = defineRpc({
  name: "voice.preview",
  input: z.object({ text: z.string().min(1).max(600), voice: z.string().min(1).optional() }),
  output: z.object({
    wavBase64: z.string(),
    seconds: z.number().nonnegative(),
    error: z.string().default(""),
  }),
});
