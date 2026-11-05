import assert from "node:assert/strict";
import { generateKeyPairSync, verify } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import http2 from "node:http2";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { pathToFileURL } from "node:url";
import { ENTRY } from "./push.server.ts";

type Logged = { level: "info" | "error"; fields: Record<string, unknown>; text: string };
type Payload = { title: string; body: string; data?: Record<string, unknown> };
type Sender = {
  parseToken(token: string): { environment: string; topic: string; device: string } | null;
  apnsPayload(payload: Payload): unknown;
  providerToken(config: Config, now?: number): string;
  sendApns(
    tokens: string[],
    payload: Payload,
    logger: ReturnType<typeof recorder>,
    revoke: (token: string) => void,
    options?: { configFile?: string; origin?: string },
  ): Promise<void>;
  route(
    tokens: string[],
    payload: Payload,
    service: { logger: ReturnType<typeof recorder>; revokeToken: (token: string) => void },
    options?: { configFile?: string; origin?: string },
  ): Promise<string[]>;
};
type Config = { keyId: string; teamId: string; keyFile: string };

const DEVICE = "a1".repeat(32);
const TOKEN = `apns:development:sh.paseo.debug.team:${DEVICE}`;
const PAYLOAD: Payload = {
  title: "Agent finished",
  body: "Open the agent",
  data: { serverId: "host", agentId: "agent", reason: "finished" },
};

function recorder() {
  const lines: Logged[] = [];
  return {
    lines,
    info: (fields: Record<string, unknown>, text: string) => lines.push({ level: "info", fields, text }),
    error: (fields: Record<string, unknown>, text: string) => lines.push({ level: "error", fields, text }),
  };
}

/** The module as the plugin writes it, a key of its own, and the file that names the key. */
async function setUp() {
  const dir = await mkdtemp(path.join(tmpdir(), "voice-push-"));
  const module = path.join(dir, "apns.mjs");
  await writeFile(module, ENTRY);
  const { privateKey, publicKey } = generateKeyPairSync("ec", { namedCurve: "P-256" });
  const keyFile = path.join(dir, "AuthKey_TESTKEY123.p8");
  await writeFile(keyFile, privateKey.export({ type: "pkcs8", format: "pem" }));
  const config: Config = { keyId: "TESTKEY123", teamId: "TEAM123456", keyFile };
  const configFile = path.join(dir, "push.json");
  await writeFile(configFile, JSON.stringify(config));
  const sender = (await import(pathToFileURL(module).href)) as Sender;
  return { dir, sender, config, configFile, publicKey, done: () => rm(dir, { recursive: true, force: true }) };
}

type Asked = { headers: http2.IncomingHttpHeaders; body: string };

/** Apple, as far as one request goes: answers each with the next status and reason. */
async function fakeApple(answers: Array<{ status: number; reason?: string }>) {
  const asked: Asked[] = [];
  const server = http2.createServer();
  server.on("stream", (stream, headers) => {
    let body = "";
    stream.setEncoding("utf8");
    stream.on("data", (chunk: string) => {
      body += chunk;
    });
    stream.on("end", () => {
      asked.push({ headers, body });
      const answer = answers[asked.length - 1] ?? { status: 200 };
      stream.respond({ ":status": answer.status, "content-type": "application/json" });
      stream.end(answer.reason ? JSON.stringify({ reason: answer.reason }) : "");
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  return {
    asked,
    origin: `http://127.0.0.1:${port}`,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}

test("a token the phone registers is read for its environment, topic and device", async () => {
  const { sender, done } = await setUp();
  try {
    assert.deepEqual(sender.parseToken(TOKEN), {
      environment: "development",
      topic: "sh.paseo.debug.team",
      device: DEVICE,
    });
    assert.equal(sender.parseToken(`apns:production:sh.paseo.debug.team:${DEVICE}`)?.environment, "production");
    assert.equal(sender.parseToken("ExponentPushToken[xxxxxxxxxxxxxxxxxxxxxx]"), null, "an Expo token is not ours");
    assert.equal(sender.parseToken(`apns:staging:sh.paseo.debug.team:${DEVICE}`), null, "only Apple's two environments");
    assert.equal(sender.parseToken(`apns:toString:sh.paseo.debug.team:${DEVICE}`), null, "not a key every object has");
    assert.equal(sender.parseToken("apns:development:sh.paseo.debug.team:not-hex"), null);
    assert.equal(sender.parseToken(`apns:development::${DEVICE}`), null, "a topic is needed");
    assert.equal(sender.parseToken(`${TOKEN}:extra`), null);
  } finally {
    await done();
  }
});

test("the push is laid out as Expo lays it out, with the data where the app reads it", async () => {
  const { sender, done } = await setUp();
  try {
    assert.deepEqual(sender.apnsPayload(PAYLOAD), {
      aps: { alert: { title: "Agent finished", body: "Open the agent" }, sound: "default" },
      body: { serverId: "host", agentId: "agent", reason: "finished" },
    });
    assert.deepEqual((sender.apnsPayload({ title: "t", body: "b" }) as { body: unknown }).body, {});
  } finally {
    await done();
  }
});

test("the provider token is an ES256 JWT for the team, signed with its key and kept under an hour", async () => {
  const { sender, config, publicKey, done } = await setUp();
  try {
    const at = Date.UTC(2026, 10, 6, 12, 0, 0);
    const first = sender.providerToken(config, at);
    const [header, claims, signature] = first.split(".");
    assert.deepEqual(JSON.parse(Buffer.from(header!, "base64url").toString()), { alg: "ES256", kid: "TESTKEY123" });
    assert.deepEqual(JSON.parse(Buffer.from(claims!, "base64url").toString()), { iss: "TEAM123456", iat: at / 1000 });
    const valid = verify(
      "sha256",
      Buffer.from(`${header}.${claims}`),
      { key: publicKey, dsaEncoding: "ieee-p1363" },
      Buffer.from(signature!, "base64url"),
    );
    assert.ok(valid, "Apple checks this signature with the key's public half");
    // Apple refuses a token renewed more often than every twenty minutes.
    assert.equal(sender.providerToken(config, at + 49 * 60_000), first);
    assert.notEqual(sender.providerToken(config, at + 51 * 60_000), first, "and an hour-old one");
  } finally {
    await done();
  }
});

test("a push goes to the device's path with the team's token, the app's topic and the alert type", async () => {
  const { sender, configFile, done } = await setUp();
  const apple = await fakeApple([{ status: 200 }]);
  try {
    const logger = recorder();
    const revoked: string[] = [];
    await sender.sendApns([TOKEN], PAYLOAD, logger, (token) => revoked.push(token), {
      configFile,
      origin: apple.origin,
    });
    assert.equal(apple.asked.length, 1);
    const [one] = apple.asked;
    assert.equal(one!.headers[":method"], "POST");
    assert.equal(one!.headers[":path"], `/3/device/${DEVICE}`);
    assert.match(String(one!.headers.authorization), /^bearer [\w-]+\.[\w-]+\.[\w-]+$/);
    assert.equal(one!.headers["apns-topic"], "sh.paseo.debug.team");
    assert.equal(one!.headers["apns-push-type"], "alert");
    assert.deepEqual(JSON.parse(one!.body), sender.apnsPayload(PAYLOAD));
    assert.deepEqual(revoked, []);
    assert.ok(logger.lines.some((line) => line.level === "info"), "a delivered push is logged");
  } finally {
    await apple.close();
    await done();
  }
});

test("a token Apple calls dead is revoked, and a refusal of the key is not the token's fault", async () => {
  const { sender, configFile, done } = await setUp();
  const second = TOKEN.replace(/a1/g, "b2");
  const third = TOKEN.replace(/a1/g, "c3");
  const apple = await fakeApple([
    { status: 410, reason: "Unregistered" },
    { status: 400, reason: "BadDeviceToken" },
    { status: 403, reason: "InvalidProviderToken" },
  ]);
  try {
    const logger = recorder();
    const revoked: string[] = [];
    await sender.sendApns([TOKEN, second, third], PAYLOAD, logger, (token) => revoked.push(token), {
      configFile,
      origin: apple.origin,
    });
    assert.deepEqual(revoked, [TOKEN, second]);
    const refusals = logger.lines.filter((line) => line.level === "error").map((line) => line.fields.reason);
    assert.deepEqual(refusals, ["Unregistered", "BadDeviceToken", "InvalidProviderToken"]);
  } finally {
    await apple.close();
    await done();
  }
});

test("without a key named in push.json nothing is sent, and the log says so", async () => {
  const { sender, dir, done } = await setUp();
  const apple = await fakeApple([]);
  try {
    const logger = recorder();
    const revoked: string[] = [];
    await sender.sendApns([TOKEN], PAYLOAD, logger, (token) => revoked.push(token), {
      configFile: path.join(dir, "absent.json"),
      origin: apple.origin,
    });
    assert.equal(apple.asked.length, 0);
    assert.deepEqual(revoked, [], "the token is kept for when the key is there");
    assert.match(logger.lines[0]?.text ?? "", /no usable APNs key/);
  } finally {
    await apple.close();
    await done();
  }
});

test("an unreachable Apple is logged, never thrown into the daemon", async () => {
  const { sender, configFile, done } = await setUp();
  try {
    const logger = recorder();
    await sender.sendApns([TOKEN], PAYLOAD, logger, () => {}, { configFile, origin: "http://127.0.0.1:9" });
    assert.match(logger.lines[0]?.text ?? "", /could not be reached/);
  } finally {
    await done();
  }
});

test("the daemon's service hands over every token and gets back only the ones for Expo", async () => {
  const { sender, configFile, done } = await setUp();
  const apple = await fakeApple([{ status: 200 }]);
  try {
    const logger = recorder();
    const expo = "ExponentPushToken[xxxxxxxxxxxxxxxxxxxxxx]";
    const rest = await sender.route([TOKEN, expo], PAYLOAD, { logger, revokeToken: () => {} }, {
      configFile,
      origin: apple.origin,
    });
    assert.deepEqual(rest, [expo]);
    assert.deepEqual(
      apple.asked.map((one) => one.headers[":path"]),
      [`/3/device/${DEVICE}`],
      "only the phone's own token goes to Apple",
    );
  } finally {
    await apple.close();
    await done();
  }
});
