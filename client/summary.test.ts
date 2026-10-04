import assert from "node:assert/strict";
import { test } from "node:test";
import { type Status, summarise, tierOfVoice } from "./summary.ts";

const base: Status = {
  provider: "google",
  keyPresent: true,
  keyHint: "AIzaSy…abc",
  keyPath: "/tmp/key",
  cloudVoices: [],
  cloudVoice: "ru-RU-Chirp3-HD-Orus",
  cloudError: "",
  usage: [
    { id: "chirp3-hd", label: "Chirp 3 HD", note: "", used: 0, free: 1_000_000, dollarsPerMillion: 30, owed: 0 },
    { id: "standard", label: "Standard", note: "", used: 0, free: 4_000_000, dollarsPerMillion: 4, owed: 0 },
  ],
  usageResetsAt: "2026-11-01T00:00:00.000Z",
  localSupported: true,
  binaryInstalled: true,
  localModels: [{ id: "1.7b-customvoice", label: "1.7B", installed: true, onDisk: 1 }],
  activeModel: "1.7b-customvoice",
  engine: { running: false, port: 8124, model: "", error: "" },
  localVoices: [],
  localVoice: "dylan",
  rate: 1,
  rateMin: 0.7,
  rateMax: 1.6,
  steady: true,
  phoneSafe: false,
  language: "russian",
  proxy: { listening: true, port: 8123, error: "" },
  wired: true,
  restartRequired: false,
  settings: { mcpInjected: true, promptSet: true, foreignPrompt: false, configPath: "", error: "" },
  prompt: { text: "Говори всё вслух.", isDefault: true, defaultText: "Говори всё вслух." },
  cues: [],
  cue: "lobby-time",
  cueVolume: 1,
  cueVolumeMax: 2,
  cueFolder: "/tmp/music",
  patch: { available: true, applied: true, targets: [], unknownVersion: false, archivePath: "/x", restartRequired: false, error: "" },
  whisper: { name: "w", bytes: 1, onDisk: 1, installed: true, directory: "" },
  error: "",
};

const with_ = (patch: Partial<Status>): Status => ({ ...base, ...patch });

test("the family is read from the voice name, not stored apart", () => {
  assert.equal(tierOfVoice("ru-RU-Chirp3-HD-Orus"), "chirp3-hd");
  assert.equal(tierOfVoice("ru-RU-Wavenet-D"), "wavenet");
  assert.equal(tierOfVoice("ru-RU-Standard-D"), "standard");
  assert.equal(tierOfVoice("aiden"), "");
});

test("the voice line shows the short name, without the locale", () => {
  assert.deepEqual(summarise("voice", base), { text: "Orus", tone: "ok" });
});

test("no key is a warning, even with a voice chosen", () => {
  assert.deepEqual(summarise("voice", with_({ keyPresent: false })), { text: "нет ключа", tone: "warn" });
});

test("on the local provider the line says so", () => {
  assert.deepEqual(summarise("voice", with_({ provider: "local" })), { text: "dylan · локально", tone: "ok" });
});

test("the limit shown is the family actually being spoken with", () => {
  const usage = [
    { id: "chirp3-hd", label: "", note: "", used: 250_000, free: 1_000_000, dollarsPerMillion: 30, owed: 0 },
    { id: "standard", label: "", note: "", used: 3_900_000, free: 4_000_000, dollarsPerMillion: 4, owed: 0 },
  ];
  // Standard is nearly spent, but Chirp is what is speaking — so Chirp is reported.
  assert.deepEqual(summarise("limits", with_({ usage })), { text: "25%", tone: "ok" });
});

test("a nearly spent allowance turns the line into a warning", () => {
  const usage = [{ id: "chirp3-hd", label: "", note: "", used: 950_000, free: 1_000_000, dollarsPerMillion: 30, owed: 0 }];
  assert.deepEqual(summarise("limits", with_({ usage })), { text: "95%", tone: "warn" });
});

test("a missing engine is reported before a missing model", () => {
  assert.deepEqual(summarise("local", with_({ binaryInstalled: false })), { text: "движка нет", tone: "warn" });
});

test("speech without MCP injection is the warning that matters", () => {
  const settings = { ...base.settings, mcpInjected: false };
  assert.deepEqual(summarise("speech", with_({ settings })), { text: "выключено", tone: "warn" });
});

test("an unpatched Paseo is a warning, a patched one is not", () => {
  assert.deepEqual(summarise("patch", base), { text: "наложен", tone: "ok" });
  const patch = { ...base.patch, applied: false };
  assert.deepEqual(summarise("patch", with_({ patch })), { text: "не наложен", tone: "warn" });
});

test("a Paseo whose shape changed is reported as such, not as unpatched", () => {
  // Refusing is the version check: an upstream rewrite must not be patched blind.
  const patch = { ...base.patch, applied: false, unknownVersion: true };
  assert.deepEqual(summarise("patch", with_({ patch })), { text: "другая версия", tone: "warn" });
});

test("a written config the daemon has not re-read yet is not done", () => {
  assert.deepEqual(summarise("paseo", with_({ restartRequired: true })), { text: "нужен перезапуск", tone: "warn" });
});
