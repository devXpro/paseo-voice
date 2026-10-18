import { test } from "node:test";
import assert from "node:assert/strict";
import { SPEECH_LOCALES } from "../shared/languages.shared.ts";
import * as contracts from "../shared/voice.shared.ts";
import { RATE_MAX, RATE_MIN, VOLUME_MAX } from "./state.server.ts";
import { capabilities, describeRpc, describeVoice, OPERATIONS, SAFE_STATUS } from "./capabilities.server.ts";

// What a caller would send for each operation; the ones left out take no arguments.
const EXAMPLES: Record<string, Record<string, unknown>> = {
  set_rate: { rate: 1.2 },
  set_provider: { provider: "local" },
  set_cloud_voice: { voice: "en-US-Chirp3-HD-Aoede" },
  set_local_voice: { voice: "Ryan" },
  set_speech_locale: { locale: "pt-BR" },
  set_steady: { steady: false },
  set_phone_safe: { phoneSafe: true },
  set_cue_volume: { volume: 0.5 },
};

// Everything this plugin can do that is not offered: it installs, writes into Paseo's files,
// restarts something, or touches the Google key or the prompt.
const NEVER_DESCRIBED = [
  "voice.set-key",
  "voice.apply-patch",
  "voice.revert-patch",
  "voice.enable-speech",
  "voice.disable-speech",
  "voice.apply",
  "voice.restart-proxy",
  "voice.install-binary",
  "voice.install-recogniser",
  "voice.fetch-model",
  "voice.forget-model",
  "voice.set-model",
  "voice.set-recogniser-model",
  "voice.wire-dictation",
  "voice.set-dictionary",
  "voice.mine-dictionary",
  "voice.set-prompt",
  "voice.preview",
  "voice.preview-cue",
  "voice.cue",
  "voice.codec",
  "voice.refresh-cloud",
  "voice.set-ui-language",
  "voice.ui-language",
  "voice.set-cue",
];

const operations = () => describeVoice().operations;
const byId = (id: string) => {
  const op = operations().find((one) => one.id === id);
  assert.ok(op, id);
  return op;
};

test("the description matches its own contract and travels as plain JSON", () => {
  const described = describeVoice();
  assert.deepEqual(capabilities.parse(described), described);
  assert.deepEqual(JSON.parse(JSON.stringify(described)), described);
  assert.equal(describeRpc.name, "meta.describe");
  assert.equal(described.title, "Voice");
  assert.ok(JSON.stringify(described).length < 12_000);
});

test("the texts stay inside the limits God Mode keeps", () => {
  const described = describeVoice();
  assert.ok(described.title.length <= 80);
  assert.ok(described.summary.length <= 300);
  assert.ok(described.aliases.length <= 20 && described.aliases.every((alias) => alias.length <= 60));
  for (const op of described.operations) {
    assert.match(op.id, /^[a-z][a-z0-9_]*$/);
    assert.match(op.method, /^[a-z][a-z0-9._-]*$/);
    assert.ok(op.title.length <= 80, `${op.id} title`);
    assert.ok(op.description.length <= 600, `${op.id} description is ${op.description.length}`);
    assert.equal(op.input.type, "object", op.id);
  }
});

test("every operation points at an RPC this plugin registers", () => {
  const registered = new Set(Object.values(contracts).flatMap((one) => (isContract(one) ? [one.name] : [])));
  assert.ok(registered.has("voice.status") && registered.has("voice.set-rate"));
  for (const op of operations()) {
    assert.ok(registered.has(op.method), `${op.id} → ${op.method}`);
    assert.ok(!op.method.startsWith("meta."), op.id);
  }
});

test("what an operation advertises, merged under its fixed arguments, is what the handler accepts", () => {
  for (const op of OPERATIONS) {
    const args = EXAMPLES[op.id] ?? {};
    assert.doesNotThrow(() => op.input.parse(args), `${op.id} accepts its example`);
    assert.doesNotThrow(() => op.contract.input.parse({ ...args, ...op.fixed }), `${op.id} reaches ${op.contract.name}`);
  }
});

test("fixed arguments are not offered to the caller", () => {
  for (const op of operations()) {
    const offered = Object.keys((op.input.properties as Record<string, unknown> | undefined) ?? {});
    for (const key of Object.keys(op.fixed ?? {})) assert.ok(!offered.includes(key), `${op.id} hides ${key}`);
  }
});

test("ids are unique, exactly one read is the default, and only low-risk actions are offered", () => {
  const ops = operations();
  assert.equal(new Set(ops.map((op) => op.id)).size, ops.length);
  assert.deepEqual(ops.filter((op) => op.default).map((op) => op.id), ["status"]);
  assert.deepEqual(ops.filter((op) => op.kind === "read").map((op) => op.id), ["status", "voices"]);
  for (const op of ops) {
    if (op.kind === "read") {
      assert.equal(op.risk, undefined, `${op.id} is a read`);
      assert.equal(op.confirm, undefined, `${op.id} is a read`);
      continue;
    }
    assert.equal(op.risk, "low", `${op.id} is low risk`);
    assert.equal(op.confirm, "none", op.id);
  }
});

test("the plugin's own secrets and settings are in no answer", () => {
  const forbidden = ["keyHint", "keyPath", "settings", "prompt"];
  for (const op of operations()) {
    const fields = op.output?.fields ?? [];
    assert.ok(fields.length > 0, `${op.id} lists its fields`);
    for (const name of forbidden) assert.ok(!fields.includes(name), `${op.id} leaves out ${name}`);
    if (op.id !== "voices") {
      assert.ok(!fields.includes("cloudVoices") && !fields.includes("localVoices"), `${op.id} leaves the voice lists out`);
    }
  }
  assert.ok(byId("voices").output?.fields.includes("cloudVoices"));
  assert.ok(byId("voices").output?.fields.includes("localVoices"));
});

test("every field offered is a real field of the status", () => {
  const known = Object.keys(contracts.status.shape);
  for (const op of operations()) {
    for (const name of op.output?.fields ?? []) assert.ok(known.includes(name), `${op.id}: ${name}`);
  }
  for (const op of operations().filter((one) => one.kind === "action")) {
    assert.deepEqual(op.output?.fields, SAFE_STATUS, op.id);
  }
});

test("the speed advertises exactly the bounds the plugin enforces", () => {
  const rate = (byId("set_rate").input.properties as Record<string, { minimum: number; maximum: number }>).rate;
  assert.equal(rate.minimum, RATE_MIN);
  assert.equal(rate.maximum, RATE_MAX);
  assert.deepEqual((byId("set_rate").input as { required: string[] }).required, ["rate"]);
  const op = OPERATIONS.find((one) => one.id === "set_rate");
  assert.throws(() => op?.input.parse({ rate: RATE_MIN - 0.1 }));
  assert.throws(() => op?.input.parse({ rate: RATE_MAX + 0.1 }));
  assert.doesNotThrow(() => op?.input.parse({ rate: RATE_MIN }));
  assert.doesNotThrow(() => op?.input.parse({ rate: RATE_MAX }));
});

test("the waiting music volume advertises silence up to the loudest the plugin allows", () => {
  const volume = (byId("set_cue_volume").input.properties as Record<string, { minimum: number; maximum: number }>).volume;
  assert.equal(volume.minimum, 0);
  assert.equal(volume.maximum, VOLUME_MAX);
});

test("the provider offers exactly the contract's two", () => {
  const provider = byId("set_provider").input.properties as Record<string, { enum: string[] }>;
  assert.deepEqual(provider.provider.enum, ["google", "local"]);
});

test("the accents offered are the ones the plugin speaks, and each passes the contract", () => {
  const locale = (byId("set_speech_locale").input.properties as Record<string, { enum: string[] }>).locale;
  assert.deepEqual(locale.enum, SPEECH_LOCALES.map((one) => one.id));
  const op = OPERATIONS.find((one) => one.id === "set_speech_locale");
  for (const id of locale.enum) {
    assert.doesNotThrow(() => op?.input.parse({ locale: id }), id);
    assert.doesNotThrow(() => contracts.setSpeechLocale.input.parse({ locale: id }), id);
  }
  assert.throws(() => op?.input.parse({ locale: "xx-XX" }));
});

test("nothing that installs, rewrites Paseo or touches the key is offered", () => {
  const methods = new Set(operations().map((op) => op.method));
  for (const method of NEVER_DESCRIBED) assert.ok(!methods.has(method), method);
  assert.deepEqual(
    [...methods].sort(),
    [
      "voice.set-cloud-voice",
      "voice.set-cue-volume",
      "voice.set-local-voice",
      "voice.set-phone-safe",
      "voice.set-provider",
      "voice.set-rate",
      "voice.set-speech-locale",
      "voice.set-steady",
      "voice.status",
    ],
  );
});

function isContract(value: unknown): value is { name: string } {
  return typeof value === "object" && value !== null && "name" in value && "input" in value && "output" in value;
}
