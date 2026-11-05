import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import { paths } from "./paths.server.ts";

/**
 * Pushes for a phone built by `ios-build/`, sent straight to Apple.
 *
 * Paseo's daemon sends every push through Expo's push service, which forwards it to Apple
 * with a key kept in Paseo's own Expo project. That project holds no key for the bundle id
 * such a build carries, `sh.paseo.debug.<team>`, so Expo refuses those pushes and the
 * daemon drops the token. The patched phone registers its own APNs token instead, marked
 * `apns:`, and the correction in `push-service.js` hands those to the module below, which
 * signs with the team's own APNs key and posts to Apple. Every other token goes to Expo
 * as before.
 *
 * The daemon cannot import anything from this plugin, so the module lives in
 * `~/.paseo-voice/push`, where the correction finds it by path, as the Opus decoder does.
 * The key itself never passes through here: `push.json` names the file it is in.
 */

export const PUSH_DIR = path.join(paths.root, "push");
/** What the daemon imports; the correction spells the same path out. */
export const PUSH_ENTRY = path.join(PUSH_DIR, "apns.mjs");

/**
 * The sender. A token is `apns:<environment>:<topic>:<device token>`, as the patched phone
 * registers it; the payload is the one Paseo hands Expo, laid out as Expo lays it out for
 * Apple, so the app reads it the same way.
 */
export const ENTRY = `// Written by paseo-voice: pushes for the phones it builds, straight to Apple.
import { Buffer } from "node:buffer";
import { createPrivateKey, sign } from "node:crypto";
import { readFileSync } from "node:fs";
import http2 from "node:http2";
import { homedir } from "node:os";

/** Written by hand: { "keyId": "…", "teamId": "…", "keyFile": "/path/to/AuthKey_….p8" }. */
const CONFIG = \`\${homedir()}/.paseo-voice/push.json\`;
const ORIGINS = { development: "https://api.sandbox.push.apple.com", production: "https://api.push.apple.com" };
/** Apple takes a provider token for an hour and refuses one renewed more often than every twenty minutes. */
const TOKEN_LIFE_S = 50 * 60;

let provider = null;

export function parseToken(token) {
  const [scheme, environment, topic, device, ...rest] = String(token).split(":");
  if (scheme !== "apns" || rest.length > 0 || !Object.hasOwn(ORIGINS, environment ?? "")) {
    return null;
  }
  if (!topic || !/^[0-9a-f]{16,}$/i.test(device ?? "")) {
    return null;
  }
  return { environment, topic, device };
}

/** As Expo hands it to Apple: the data under \`body\`, which is where the app reads it. */
export function apnsPayload(payload) {
  return {
    aps: { alert: { title: payload.title, body: payload.body }, sound: "default" },
    body: payload.data ?? {},
  };
}

/** An ES256 provider token, kept for as long as Apple allows one to live. */
export function providerToken(config, now = Date.now()) {
  const at = Math.floor(now / 1000);
  const of = \`\${config.keyId}/\${config.teamId}/\${config.keyFile}\`;
  if (provider && provider.of === of && at - provider.at < TOKEN_LIFE_S) {
    return provider.value;
  }
  const part = (value) => Buffer.from(JSON.stringify(value)).toString("base64url");
  const unsigned = \`\${part({ alg: "ES256", kid: config.keyId })}.\${part({ iss: config.teamId, iat: at })}\`;
  const key = createPrivateKey(readFileSync(config.keyFile));
  const signature = sign("sha256", Buffer.from(unsigned), { key, dsaEncoding: "ieee-p1363" });
  provider = { of, at, value: \`\${unsigned}.\${signature.toString("base64url")}\` };
  return provider.value;
}

function post(origin, path, headers, body) {
  return new Promise((resolve, reject) => {
    const session = http2.connect(origin);
    session.on("error", reject);
    const request = session.request({ ":method": "POST", ":path": path, ...headers });
    let status = 0;
    let text = "";
    request.setEncoding("utf8");
    request.on("response", (head) => {
      status = Number(head[":status"]);
    });
    request.on("data", (chunk) => {
      text += chunk;
    });
    request.on("end", () => {
      session.close();
      resolve({ status, text });
    });
    request.on("error", (error) => {
      session.destroy();
      reject(error);
    });
    request.setTimeout(15_000, () => {
      session.destroy();
      reject(new Error("APNs did not answer in 15 s"));
    });
    request.end(JSON.stringify(body));
  });
}

/**
 * One push to every token given. Never throws: what goes wrong is logged with the
 * daemon's own logger, and a token Apple calls dead is revoked, as the daemon does with
 * one Expo calls dead.
 */
export async function sendApns(tokens, payload, logger, revoke, options = {}) {
  const file = options.configFile ?? CONFIG;
  let bearer;
  try {
    const config = JSON.parse(readFileSync(file, "utf8"));
    bearer = providerToken(config);
  } catch (error) {
    logger.error({ err: error, file }, "paseo-voice: no usable APNs key, push not sent");
    return;
  }
  for (const token of tokens) {
    const target = parseToken(token);
    if (!target) {
      logger.error({ token }, "paseo-voice: not an APNs token, revoked");
      revoke(token);
      continue;
    }
    try {
      const { status, text } = await post(
        options.origin ?? ORIGINS[target.environment],
        \`/3/device/\${target.device}\`,
        {
          authorization: \`bearer \${bearer}\`,
          "apns-topic": target.topic,
          "apns-push-type": "alert",
          "apns-priority": "10",
          "content-type": "application/json",
        },
        apnsPayload(payload),
      );
      if (status === 200) {
        logger.info({ topic: target.topic, environment: target.environment }, "paseo-voice: push handed to APNs");
        continue;
      }
      let reason = "";
      try {
        reason = String(JSON.parse(text).reason ?? "");
      } catch {
        // Not JSON; the status says enough.
      }
      logger.error({ status, reason, topic: target.topic }, "paseo-voice: APNs refused a push");
      if (status === 410 || reason === "BadDeviceToken" || reason === "DeviceTokenNotForTopic") {
        revoke(token);
      }
    } catch (error) {
      logger.error({ err: error }, "paseo-voice: APNs could not be reached");
    }
  }
}

/**
 * What the correction in the daemon's push service calls with every token it is about to
 * send to: the marked ones are sent from here, and the rest are handed back for Expo.
 */
export async function route(tokens, payload, service, options = {}) {
  const direct = tokens.filter((token) => token.startsWith("apns:"));
  await sendApns(direct, payload, service.logger, service.revokeToken, options);
  return tokens.filter((token) => !token.startsWith("apns:"));
}
`;

/** Puts the sender in place if it is missing or not this version's. */
export async function ensurePush(): Promise<void> {
  await mkdir(PUSH_DIR, { recursive: true });
  if ((await readFile(PUSH_ENTRY, "utf8").catch(() => "")) !== ENTRY) {
    const staged = `${PUSH_ENTRY}.tmp`;
    await writeFile(staged, ENTRY);
    await rename(staged, PUSH_ENTRY);
  }
}
