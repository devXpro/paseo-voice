import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";

async function withHome(initial: unknown | null): Promise<string> {
  const home = await mkdtemp(path.join(tmpdir(), "paseo-voice-settings-"));
  if (initial !== null) {
    await writeFile(path.join(home, "config.json"), JSON.stringify(initial, null, 2));
  }
  process.env.PASEO_HOME = home;
  return home;
}

const readConfig = async (home: string) =>
  JSON.parse(await readFile(path.join(home, "config.json"), "utf8")) as Record<string, any>;

const OURS = "Говори всё вслух, команды оставляй на экране.";
const EDITED = "Говори всё вслух, но покороче.";

test("enabling sets the one option that unblocks the speak tool", async () => {
  const home = await withHome({ daemon: { listen: "127.0.0.1:6767" } });
  const { enable, inspect } = await import("./daemon-settings.server.ts");

  assert.equal((await inspect(OURS)).mcpInjected, false);
  await enable(OURS);

  const config = await readConfig(home);
  // Without this the daemon never attaches its MCP server, and `speak` lives in it.
  assert.equal(config.daemon.mcp.injectIntoAgents, true);
  // The key belongs inside `daemon`; at the root the config is rejected outright.
  assert.equal(config.mcp, undefined);
  assert.equal((await inspect(OURS)).mcpInjected, true);
});

test("enabling keeps the rest of the daemon block intact", async () => {
  const home = await withHome({
    daemon: { listen: "127.0.0.1:6767", cors: { allowedOrigins: ["https://app.paseo.sh"] }, relay: { enabled: true } },
    plugins: { voice: { source: "directory", path: "/x", enabled: true } },
  });
  const { enable } = await import("./daemon-settings.server.ts");
  await enable(OURS);

  const config = await readConfig(home);
  assert.equal(config.daemon.listen, "127.0.0.1:6767");
  assert.deepEqual(config.daemon.cors, { allowedOrigins: ["https://app.paseo.sh"] });
  assert.deepEqual(config.daemon.relay, { enabled: true });
  assert.deepEqual(config.plugins.voice, { source: "directory", path: "/x", enabled: true });
});

test("a prompt written by hand is kept, ours is appended after it", async () => {
  const home = await withHome({ daemon: { appendSystemPrompt: "Всегда отвечай по-русски." } });
  const { enable, inspect } = await import("./daemon-settings.server.ts");
  await enable(OURS);

  const appended = (await readConfig(home)).daemon.appendSystemPrompt as string;
  assert.ok(appended.startsWith("Всегда отвечай по-русски."), "the existing instruction must survive");
  assert.ok(appended.includes(OURS), "ours must be there too");
  const state = await inspect(OURS);
  assert.equal(state.promptSet, true);
  assert.equal(state.foreignPrompt, true);
});

test("enabling twice does not duplicate the instruction", async () => {
  const home = await withHome({});
  const { enable } = await import("./daemon-settings.server.ts");
  await enable(OURS);
  await enable(OURS);

  const appended = (await readConfig(home)).daemon.appendSystemPrompt as string;
  assert.equal(appended.split(OURS).length - 1, 1);
});

test("disabling removes only our paragraph", async () => {
  const home = await withHome({ daemon: { appendSystemPrompt: "Всегда отвечай по-русски." } });
  const { disable, enable } = await import("./daemon-settings.server.ts");
  await enable(OURS);
  await disable(OURS);

  const config = await readConfig(home);
  assert.equal(config.daemon.appendSystemPrompt, "Всегда отвечай по-русски.");
  assert.equal(config.daemon.mcp.injectIntoAgents, false);
});

test("an edited prompt replaces its predecessor rather than piling up beside it", async () => {
  const home = await withHome({ daemon: { appendSystemPrompt: "Всегда отвечай по-русски." } });
  const { enable, inspect, replacePrompt } = await import("./daemon-settings.server.ts");
  await enable(OURS);
  await replacePrompt(OURS, EDITED);

  const appended = (await readConfig(home)).daemon.appendSystemPrompt as string;
  assert.ok(appended.includes(EDITED), "the new text has to be in there");
  assert.ok(!appended.includes(OURS), "and the old one gone");
  assert.ok(appended.startsWith("Всегда отвечай по-русски."), "somebody else's text is still untouched");
  assert.equal((await inspect(EDITED)).promptSet, true);
  // Asked about the superseded wording it still says yes, and that is the point: the
  // block is marked as ours, so recognising it no longer depends on guessing which
  // version of the text a running plugin happens to be carrying.
  assert.equal((await inspect(OURS)).promptSet, true);
});

test("editing while switched off touches nothing in the config", async () => {
  const home = await withHome({ daemon: { appendSystemPrompt: "Чужая инструкция." } });
  const { replacePrompt } = await import("./daemon-settings.server.ts");
  await replacePrompt(OURS, EDITED);
  // Ours was never written, so there is nothing to swap — and the config is left alone.
  assert.equal((await readConfig(home)).daemon.appendSystemPrompt, "Чужая инструкция.");
});

test("a foreign prompt is reported so the surface can say whose it is", async () => {
  await withHome({ daemon: { appendSystemPrompt: "Чужая инструкция." } });
  const { inspect } = await import("./daemon-settings.server.ts");
  const state = await inspect(OURS);
  assert.equal(state.foreignPrompt, true);
  assert.equal(state.promptSet, false);
});

test("a missing config file is not an error, just everything off", async () => {
  await withHome(null);
  const { enable, inspect } = await import("./daemon-settings.server.ts");
  const before = await inspect(OURS);
  assert.equal(before.mcpInjected, false);
  assert.equal(before.error, "");

  await enable(OURS);
  assert.equal((await inspect(OURS)).mcpInjected, true);
});

/**
 * The bug these cover, found in a live config holding two copies of the same
 * paragraph: `enable` looked for the text it was about to write, which after a plugin
 * update is not what is in the config — the previous wording is. So the old copy was
 * never found, the new one went in beside it, and the prompt grew on every release.
 */
const SHIPPED_BEFORE = "When Paseo voice mode is active, speak everything aloud.";
const SHIPPED_NOW = "When Paseo voice mode is active, speak everything aloud, briefly.";

test("an update whose wording changed replaces the old copy instead of joining it", async () => {
  const home = await withHome({});
  const { enable } = await import("./daemon-settings.server.ts");
  // The version that shipped last month, then the one that ships today. The plugin
  // knows only its own current text, which is exactly the situation that broke.
  await enable(SHIPPED_BEFORE);
  await enable(SHIPPED_NOW);

  const appended = (await readConfig(home)).daemon.appendSystemPrompt as string;
  assert.equal(appended.split(SHIPPED_BEFORE).length - 1, 0, "старая редакция должна уйти");
  assert.equal(appended.split(SHIPPED_NOW).length - 1, 1, "новая должна быть ровно одна");
});

test("a config that already piled up copies is cleaned on the next enable", async () => {
  const piled = `${SHIPPED_BEFORE}\n\n${SHIPPED_BEFORE}\n\n${SHIPPED_NOW}`;
  const home = await withHome({ daemon: { appendSystemPrompt: piled } });
  const { enable } = await import("./daemon-settings.server.ts");
  await enable(SHIPPED_NOW);

  const appended = (await readConfig(home)).daemon.appendSystemPrompt as string;
  assert.equal(appended.split("When Paseo voice mode is active").length - 1, 1);
});

test("somebody else's paragraph survives all of that", async () => {
  const theirs = "Всегда отвечай по-русски.";
  const home = await withHome({ daemon: { appendSystemPrompt: `${theirs}\n\n${SHIPPED_BEFORE}` } });
  const { enable } = await import("./daemon-settings.server.ts");
  await enable(SHIPPED_NOW);

  const appended = (await readConfig(home)).daemon.appendSystemPrompt as string;
  assert.ok(appended.includes(theirs), "чужой текст трогать нельзя");
  assert.equal(appended.split(SHIPPED_BEFORE).length - 1, 0);
});

test("ours is recognised after an update, before anything is rewritten", async () => {
  const home = await withHome({});
  const { enable, inspect } = await import("./daemon-settings.server.ts");
  await enable(SHIPPED_BEFORE);
  // The plugin restarts carrying new text and asks whether the config is still its own.
  const state = await inspect(SHIPPED_NOW);
  assert.equal(state.promptSet, true);
  assert.equal(state.foreignPrompt, false);
  void home;
});
