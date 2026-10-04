import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import { test } from "node:test";
import type { Engine } from "./engine.server.ts";
import { createProxy } from "./proxy.server.ts";

/** A stand-in engine process: whatever the handler writes is what the proxy reads. */
async function fakeEngine(
  handler: (body: Record<string, unknown>, response: import("node:http").ServerResponse) => void,
): Promise<{ port: number; close(): Promise<void> }> {
  const server: Server = createServer((request, response) => {
    const chunks: Buffer[] = [];
    request.on("data", (chunk: Buffer) => chunks.push(chunk));
    request.on("end", () => handler(JSON.parse(Buffer.concat(chunks).toString("utf8")) as Record<string, unknown>, response));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as { port: number }).port;
  return { port, close: () => new Promise<void>((resolve) => server.close(() => resolve())) };
}

function stubEngine(port: number): Engine {
  return {
    ensure: async () => {},
    stop: () => {},
    running: () => true,
    model: () => "1.7b-customvoice",
    lastError: () => "",
    touch: () => {},
    port,
  };
}

async function withProxy(
  handler: (body: Record<string, unknown>, response: import("node:http").ServerResponse) => void,
  work: (url: string, seen: Record<string, unknown>[], lines: string[]) => Promise<void>,
  rate = 1,
  steady = false,
): Promise<void> {
  const seen: Record<string, unknown>[] = [];
  const lines: string[] = [];
  const engine = await fakeEngine((body, response) => {
    seen.push(body);
    handler(body, response);
  });
  const proxy = createProxy({
    port: 0,
    engine: stubEngine(engine.port),
    // The local path, which is the one a fake engine can stand in for. Google's is
    // covered by its own tests, against its own shapes.
    choice: () => ({
      provider: "local",
      voice: "aiden",
      model: "1.7b-customvoice",
      language: "russian",
      rate,
      steady,
      // Off in these tests: the filter is verified on its own, and leaving it on
      // would change the byte counts these assertions are about.
      cue: "lobby-time",
      cueVolume: 1,
      phoneSafe: false,
      googleKey: "",
      pronunciations: [],
    }),
    log: (line) => lines.push(line),
  });
  // Port 0 means the OS picks; the proxy reports where it actually landed.
  await proxy.start();
  try {
    await work(`http://127.0.0.1:${proxy.port}`, seen, lines);
  } finally {
    await proxy.stop();
    await engine.close();
  }
}

const speak = (url: string, input = "Проверка связи.") =>
  fetch(`${url}/v1/audio/speech`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ model: "tts-1", voice: "alloy", input, response_format: "pcm" }),
  });

const pcm = (samples: number[]) => {
  const buffer = Buffer.alloc(samples.length * 2);
  samples.forEach((value, index) => buffer.writeInt16LE(value, index * 2));
  return buffer;
};

test("a good render comes back whole, with a length", async () => {
  await withProxy(
    (_body, response) => {
      response.writeHead(200, { "content-type": "audio/pcm" });
      response.end(pcm([...new Array(24 * 80).fill(0), ...new Array(24 * 200).fill(5000)]));
    },
    async (url) => {
      const reply = await speak(url);
      assert.equal(reply.status, 200);
      const audio = Buffer.from(await reply.arrayBuffer());
      // A length is what lets the caller tell a short body from a finished one.
      assert.equal(reply.headers.get("content-length"), String(audio.length));
      // 200 ms of speech plus a 10 ms cushion; the 80 ms of padding is gone.
      assert.equal(Math.round(audio.length / 2 / 24), 210);
    },
  );
});

test("a stream that dies mid-body is an error, never a short 200", async () => {
  // This is the whole reason the body is buffered. Streaming it through meant the
  // caller got `200` and a few hundred bytes, and Paseo plays a short segment and
  // moves on — one sentence of an answer silently missing, with nothing in any log.
  await withProxy(
    (_body, response) => {
      response.writeHead(200, { "content-type": "audio/pcm" });
      response.write(pcm(new Array(24 * 50).fill(5000)));
      response.destroy();
    },
    async (url, _seen, lines) => {
      const reply = await speak(url);
      assert.notEqual(reply.status, 200);
      assert.equal(reply.status, 502);
      assert.ok(
        lines.some((line) => line.includes("failed")),
        `the failure has to be in the log, got: ${JSON.stringify(lines)}`,
      );
    },
  );
});

test("an engine that refuses is passed on as an error", async () => {
  await withProxy(
    (_body, response) => {
      response.writeHead(503, { "content-type": "text/plain" });
      response.end("queue full");
    },
    async (url) => {
      const reply = await speak(url);
      assert.equal(reply.status, 502);
      assert.match(JSON.stringify(await reply.json()), /queue full/);
    },
  );
});

test("a render with no audio at all is an error rather than silence", async () => {
  await withProxy(
    (_body, response) => {
      response.writeHead(200, { "content-type": "audio/pcm" });
      response.end(Buffer.alloc(0));
    },
    async (url) => {
      assert.equal((await speak(url)).status, 502);
    },
  );
});

test("the chosen speaker and rate reach the engine", async () => {
  await withProxy(
    (_body, response) => {
      response.writeHead(200, { "content-type": "audio/pcm" });
      response.end(pcm(new Array(24 * 100).fill(5000)));
    },
    async (url, seen) => {
      await speak(url, "Привет.");
      assert.equal(seen[0]?.speaker, "aiden");
      assert.equal(seen[0]?.language, "russian");
      assert.equal(seen[0]?.text, "Привет.");
      // Paseo can only ever send `alloy`; the point of this proxy is that it does not
      // reach the engine, which would answer `unknown speaker`.
      assert.notEqual(seen[0]?.speaker, "alloy");
      assert.equal(seen[0]?.rate, 1.25);
      // Off here, so the engine is left to its own sampling.
      assert.equal(seen[0]?.seed, undefined);
      assert.equal(seen[0]?.top_k, undefined);
    },
    1.25,
  );
});

test("steady tone pins the seed and drops sampling", async () => {
  // Paseo sends one request per sentence and the engine seeds itself from the clock,
  // so without this each sentence of one answer was a different take — measurably so:
  // 26 Hz of wander in average pitch across four sentences, which is what made an
  // answer sound like a performance rather than a person.
  await withProxy(
    (_body, response) => {
      response.writeHead(200, { "content-type": "audio/pcm" });
      response.end(pcm(new Array(24 * 100).fill(5000)));
    },
    async (url, seen) => {
      await speak(url, "Первое предложение.");
      await speak(url, "Второе предложение.");
      assert.equal(seen[0]?.seed, seen[1]?.seed, "two sentences must get the same take");
      assert.equal(seen[0]?.top_k, 1);
    },
    1,
    true,
  );
});

test("empty input is refused before the engine is touched", async () => {
  await withProxy(
    (_body, response) => {
      response.writeHead(200);
      response.end(pcm([1]));
    },
    async (url, seen) => {
      const reply = await fetch(`${url}/v1/audio/speech`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ input: "   " }),
      });
      assert.equal(reply.status, 400);
      assert.equal(seen.length, 0);
    },
  );
});
