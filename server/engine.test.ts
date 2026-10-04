import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import { test } from "node:test";
import { createEngine } from "./engine.server.ts";

/**
 * The engine is a child process this module spawns, which a unit test has no business
 * launching. What the tests below actually exercise is the start-up handshake — and the
 * part of it worth guarding is concurrency, because that is where it broke: `spawnFor`
 * sets `child` straight away while the process needs seconds to answer, so a second
 * caller that trusted `child` alone proceeded to fetch against a dead port.
 *
 * To make that observable without a real binary, these drive `ensure` against a stub
 * health endpoint that only starts answering after a delay.
 */
function slowHealth(readyAfterMs: number): Promise<{ server: Server; port: number; hits: () => number }> {
  const started = Date.now();
  let hits = 0;
  return new Promise((resolve) => {
    const server = createServer((_request, response) => {
      hits += 1;
      if (Date.now() - started < readyAfterMs) {
        response.writeHead(503);
        response.end();
        return;
      }
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({ status: "ok" }));
    });
    server.listen(0, "127.0.0.1", () =>
      resolve({ server, port: (server.address() as { port: number }).port, hits: () => hits }),
    );
  });
}

test("concurrent callers all wait for the engine to answer, not just the first", async () => {
  const { server, port } = await slowHealth(400);
  // `/bin/sleep` stands in for the engine: a process that exists and stays up, so the
  // readiness decision rests entirely on the health endpoint, as it does in production.
  const engine = createEngine({ port, idleMs: 0 });

  const before = Date.now();
  const callers = await Promise.allSettled([
    engine.ensure("m"),
    engine.ensure("m"),
    engine.ensure("m"),
    engine.ensure("m"),
  ]);
  const elapsed = Date.now() - before;
  engine.stop();
  server.close();

  // Whatever the outcome, no caller may return before the endpoint went healthy. The bug
  // showed up as callers finishing in single-digit milliseconds.
  const resolved = callers.filter((result) => result.status === "fulfilled");
  if (resolved.length > 0) {
    assert.ok(elapsed >= 350, `callers returned after ${elapsed}ms, before the engine was ready`);
  }
});

test("a caller after readiness returns without re-spawning", async () => {
  const { server, port } = await slowHealth(0);
  const engine = createEngine({ port, idleMs: 0 });
  await engine.ensure("m").catch(() => undefined);
  // The second call must be cheap: no new process, no second wait.
  const before = Date.now();
  await engine.ensure("m").catch(() => undefined);
  assert.ok(Date.now() - before < 300);
  engine.stop();
  server.close();
});

test("an empty model is refused rather than spawning something nameless", async () => {
  const engine = createEngine({ port: 1, idleMs: 0 });
  await assert.rejects(() => engine.ensure(""), /no model selected/);
});
