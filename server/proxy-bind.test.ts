import assert from "node:assert/strict";
import { createServer } from "node:http";
import { test } from "node:test";
import { createProxy } from "./proxy.server.ts";

const CHOICE = {
  provider: "google" as const,
  voice: "ru-RU-Standard-A",
  model: "",
  language: "russian",
  rate: 1,
  steady: true,
  cue: "silence",
  cueVolume: 1,
  phoneSafe: false,
  googleKey: "",
  pronunciations: [],
};

const ENGINE = {
  port: 0,
  running: () => false,
  model: () => "",
  lastError: () => "",
  ensure: async () => {},
  touch: () => {},
  stop: () => {},
} as unknown as Parameters<typeof createProxy>[0]["engine"];

/** A port nobody else is on, found by letting the OS pick one and giving it back. */
async function freePort(): Promise<number> {
  const probe = createServer();
  await new Promise<void>((done) => probe.listen(0, "127.0.0.1", done));
  const port = (probe.address() as { port: number }).port;
  await new Promise<void>((done) => probe.close(() => done()));
  return port;
}

/**
 * The case this exists for: the daemon is replaced, the new one loads this plugin
 * within a second, and the old one is still holding the port while it shuts down.
 * Trying once and giving up left speech dead with nothing on screen to say why.
 */
test("a port held by somebody on their way out is waited for, not given up on", async () => {
  const port = await freePort();
  const squatter = createServer();
  await new Promise<void>((done) => squatter.listen(port, "127.0.0.1", done));

  const proxy = createProxy({ port, engine: ENGINE, choice: () => CHOICE });
  const started = proxy.start();
  assert.equal(proxy.state().listening, false, "пока порт занят — не слушает");

  // Let go after the first attempt has already failed.
  setTimeout(() => squatter.close(), 300);
  await started;

  assert.equal(proxy.state().listening, true);
  assert.equal(proxy.state().error, "");
  await proxy.stop();
});

test("a port held for good is reported rather than retried forever", async () => {
  const port = await freePort();
  const squatter = createServer();
  await new Promise<void>((done) => squatter.listen(port, "127.0.0.1", done));
  try {
    // Two quick attempts, so the test proves the giving-up path without sitting
    // through the half minute the real one is given.
    const proxy = createProxy({
      port,
      engine: ENGINE,
      choice: () => CHOICE,
      patience: { attempts: 2, backoffMs: 10 },
    });
    await assert.rejects(() => proxy.start(), /EADDRINUSE/);
    assert.equal(proxy.state().listening, false);
    assert.match(proxy.state().error, /EADDRINUSE/, "панели есть что показать");
  } finally {
    squatter.close();
  }
});
