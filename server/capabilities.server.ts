import { defineRpc, type PluginRpcContract } from "@getpaseo/plugin";
import { type ZodType, z } from "zod";
import { SPEECH_LOCALES } from "../shared/languages.shared.ts";
import {
  getStatus,
  setCloudVoice,
  setCueVolume,
  setLocalVoice,
  setPhoneSafe,
  setProvider,
  setRate,
  setSpeechLocale,
  setSteady,
} from "../shared/voice.shared.ts";
import { RATE_MAX, RATE_MIN, VOLUME_MAX } from "./state.server.ts";

/**
 * What an assistant outside Paseo may do with this plugin, such as God Mode, which drives
 * Paseo from ChatGPT over the relay. Paseo hands a remote client only plugin ids and a blind
 * `invokePluginRpc`: no list of methods, no schemas. So the plugin says it itself, under a
 * method every plugin can answer the same way, in the `paseo.capabilities/1` shape.
 *
 * Only the everyday settings of how speech sounds are offered. Everything that installs,
 * writes into Paseo's files, restarts something or handles the Google key stays in the panel.
 *
 * Every operation points at a real RPC of this plugin, and the arguments it advertises are
 * rendered from zod contracts that the handler's own contract accepts, so the description
 * cannot promise an argument the handler would refuse.
 */

export const CAPABILITIES_SCHEMA = "paseo.capabilities/1";

const operation = z.object({
  id: z.string(),
  kind: z.enum(["read", "action"]),
  method: z.string(),
  title: z.string(),
  description: z.string(),
  /** JSON Schema of the arguments the caller supplies; never the fixed ones. */
  input: z.record(z.string(), z.unknown()),
  fixed: z.record(z.string(), z.unknown()).optional(),
  /** Reads only: what "show me Voice" means. */
  default: z.boolean().optional(),
  /** The fields of the answer worth reading out; the rest is noise to a listener. */
  output: z.object({ fields: z.array(z.string()) }).optional(),
  /** Actions only. Everything offered here is `low`: local, and undone with one more call. */
  risk: z.enum(["low", "outward", "disruptive", "destructive"]).optional(),
  confirm: z.enum(["none", "always"]).optional(),
  confirmText: z.string().optional(),
});

export const capabilities = z.object({
  schema: z.literal(CAPABILITIES_SCHEMA),
  title: z.string(),
  summary: z.string(),
  aliases: z.array(z.string()),
  operations: z.array(operation),
});

export type Capabilities = z.output<typeof capabilities>;

export const describeRpc = defineRpc({
  name: "meta.describe",
  input: z.object({}),
  output: capabilities,
});

export interface VoiceOperation {
  id: string;
  kind: "read" | "action";
  contract: PluginRpcContract;
  title: string;
  description: string;
  /** What the caller supplies; merged under `fixed` it must satisfy the contract's input. */
  input: ZodType;
  fixed?: Record<string, unknown>;
  default?: true;
  fields: string[];
  risk?: "low";
}

const none = z.object({});

// Every setter answers with the whole status, and the whole status carries the key's masked
// hint and the file it is read from, the daemon's settings and the appended prompt. None of
// that is for a listener, so every answer is trimmed to the same list, which is only the
// status fields a person asks about.
export const SAFE_STATUS = [
  "provider",
  "keyPresent",
  "cloudVoice",
  "cloudError",
  "usage",
  "usageResetsAt",
  "localSupported",
  "binaryInstalled",
  "activeModel",
  "engine",
  "localVoice",
  "rate",
  "rateMin",
  "rateMax",
  "steady",
  "phoneSafe",
  "speechLocale",
  "uiLanguage",
  "cueVolume",
  "cueVolumeMax",
  "proxy",
  "wired",
  "restartRequired",
  "error",
];

export const VOICE_LISTS = ["speechLocale", "provider", "cloudVoice", "cloudVoices", "localVoice", "localVoices"];

/** Narrower than the contract's string: the accents this plugin knows how to speak. */
const localeIds = SPEECH_LOCALES.map((locale) => locale.id) as [string, ...string[]];

export const OPERATIONS: VoiceOperation[] = [
  {
    id: "status",
    kind: "read",
    contract: getStatus,
    default: true,
    title: "Voice status",
    description:
      "How Paseo speaks now. provider: google (Google Cloud voices) or local (on-device); cloudVoice and localVoice: the voice in use for each; keyPresent: a Google key is set, cloudError: why Google is not answering; usage: characters spent this month against the free allowance. rate: speed, 1 is normal;steady: every sentence read the same way; phoneSafe: sound softened for a phone; speechLocale: language and accent of speech and dictation; cueVolume: waiting music loudness, up to cueVolumeMax. restartRequired: Paseo must restart to pick up a change; error: the last problem.",
    input: none,
    fields: SAFE_STATUS,
  },
  {
    id: "voices",
    kind: "read",
    contract: getStatus,
    title: "Available voices",
    description:
      "The voices for the current language (speechLocale). cloudVoices are Google voices, each with a name, tier and gender: pass a name to set_cloud_voice. localVoices are the on-device engine's speakers, listed only while the local engine runs: pass a name to set_local_voice. cloudVoice and localVoice are the ones in use now.",
    input: none,
    fields: VOICE_LISTS,
  },
  {
    id: "set_rate",
    kind: "action",
    contract: setRate,
    title: "Set the speaking speed",
    description: `How fast the voice speaks, from ${RATE_MIN} to ${RATE_MAX}; 1 is normal speed. Pitch is kept.`,
    input: z.object({
      rate: z.number().min(RATE_MIN).max(RATE_MAX).describe(`Speaking speed, ${RATE_MIN} to ${RATE_MAX}; 1 is normal`),
    }),
    fields: SAFE_STATUS,
    risk: "low",
  },
  {
    id: "set_provider",
    kind: "action",
    contract: setProvider,
    title: "Choose where speech comes from",
    description:
      "google = Google Cloud voices, which need the key the user set in the Voice panel; local = the on-device engine, which needs to be installed.",
    input: z.object({ provider: setProvider.input.shape.provider.describe("google or local") }),
    fields: SAFE_STATUS,
    risk: "low",
  },
  {
    id: "set_cloud_voice",
    kind: "action",
    contract: setCloudVoice,
    title: "Choose the Google voice",
    description: "Use this Google voice for the current language. The name comes from the voices operation, in cloudVoices.",
    input: z.object({ voice: z.string().min(1).describe("A name from cloudVoices") }),
    fields: SAFE_STATUS,
    risk: "low",
  },
  {
    id: "set_local_voice",
    kind: "action",
    contract: setLocalVoice,
    title: "Choose the local voice",
    description: "Use this speaker of the on-device engine. The name comes from the voices operation, in localVoices.",
    input: z.object({ voice: z.string().min(1).describe("A name from localVoices") }),
    fields: SAFE_STATUS,
    risk: "low",
  },
  {
    id: "set_speech_locale",
    kind: "action",
    contract: setSpeechLocale,
    title: "Choose the language and accent",
    description:
      "The language and accent that speech and dictation use. Each accent remembers its own Google voice. An accent the local engine cannot speak moves speech to Google when a key is set.",
    input: z.object({ locale: z.enum(localeIds).describe("Language and accent, as Google names it, such as pt-BR") }),
    fields: SAFE_STATUS,
    risk: "low",
  },
  {
    id: "set_steady",
    kind: "action",
    contract: setSteady,
    title: "Steady delivery on or off",
    description:
      "true reads every sentence of an answer the same way; false lets each sentence come out with its own delivery, which is livelier but uneven.",
    input: z.object({ steady: z.boolean().describe("true for the same delivery throughout") }),
    fields: SAFE_STATUS,
    risk: "low",
  },
  {
    id: "set_phone_safe",
    kind: "action",
    contract: setPhoneSafe,
    title: "Phone-safe sound on or off",
    description:
      "true softens the top of the sound before it is sent, because a phone's audio path would turn that band into grit; false sends it whole. Heard from the next sentence.",
    input: z.object({ phoneSafe: z.boolean().describe("true to soften the top of the sound") }),
    fields: SAFE_STATUS,
    risk: "low",
  },
  {
    id: "set_cue_volume",
    kind: "action",
    contract: setCueVolume,
    title: "Set the waiting music volume",
    description: `How loud the music is while the agent thinks, from 0 (silent) to ${VOLUME_MAX}; 1 is the normal level.`,
    input: z.object({
      volume: z.number().min(0).max(VOLUME_MAX).describe(`Waiting music volume, 0 to ${VOLUME_MAX}; 1 is normal`),
    }),
    fields: SAFE_STATUS,
    risk: "low",
  },
];

function jsonSchema(schema: ZodType): Record<string, unknown> {
  // `io: "input"` so a default reads as optional, the way a caller may leave it out.
  const { $schema: _, ...rest } = z.toJSONSchema(schema, { io: "input" }) as Record<string, unknown>;
  return rest;
}

function render(): Capabilities {
  return {
    schema: CAPABILITIES_SCHEMA,
    title: "Voice",
    summary:
      "Paseo's spoken voice and dictation: which engine and voice speak, how fast, in which language, and how loud the waiting music is.",
    aliases: ["voice", "speech", "tts", "voice mode", "text to speech"],
    operations: OPERATIONS.map((op) => ({
      id: op.id,
      kind: op.kind,
      method: op.contract.name,
      title: op.title,
      description: op.description,
      input: jsonSchema(op.input),
      ...(op.fixed ? { fixed: op.fixed } : {}),
      ...(op.default ? { default: true } : {}),
      output: { fields: op.fields },
      ...(op.risk ? { risk: op.risk, confirm: "none" as const } : {}),
    })),
  };
}

let rendered: Capabilities | null = null;

/**
 * Rendered on the first call rather than at load: `contribute()` must not be able to fail
 * because of a schema that will not render. A broken description costs this one method,
 * never the plugin.
 */
export function describeVoice(): Capabilities {
  rendered ??= render();
  return rendered;
}
