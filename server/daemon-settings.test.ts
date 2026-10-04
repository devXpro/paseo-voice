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
  assert.equal((await inspect(OURS)).promptSet, false);
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
