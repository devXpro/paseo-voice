import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { test } from "node:test";
import type { Builtin } from "./catalogue.server.ts";
import { fetchBuiltin } from "./cue.server.ts";

const BYTES = Buffer.from("pretend this is eight megabytes of samba");
const ENTRY: Builtin = {
  id: "test",
  title: "Тестовый трек",
  note: "",
  url: "https://example.invalid/track.mp3",
  sha256: createHash("sha256").update(BYTES).digest("hex"),
  fromSeconds: 0,
};

/** Replaces `fetch` for one test and puts the real one back afterwards. */
async function withFetch<T>(stub: typeof fetch, work: () => Promise<T>): Promise<T> {
  const real = globalThis.fetch;
  globalThis.fetch = stub;
  try {
    return await work();
  } finally {
    globalThis.fetch = real;
  }
}

const ok = () => new Response(BYTES, { status: 200 });

test("a dropped connection is tried again rather than left as a missing track", async () => {
  let calls = 0;
  const bytes = await withFetch(
    (async () => {
      calls += 1;
      if (calls < 3) {
        throw new TypeError("fetch failed");
      }
      return ok();
    }) as typeof fetch,
    () => fetchBuiltin(ENTRY, 0),
  );
  assert.equal(calls, 3);
  assert.deepEqual(bytes, BYTES);
});

test("a truncated body fails the hash and is also tried again", async () => {
  let calls = 0;
  const bytes = await withFetch(
    (async () => {
      calls += 1;
      // Half a file is a 200 with the wrong hash, which is the case worth retrying.
      return calls === 1 ? new Response(BYTES.subarray(0, 10), { status: 200 }) : ok();
    }) as typeof fetch,
    () => fetchBuiltin(ENTRY, 0),
  );
  assert.equal(calls, 2);
  assert.deepEqual(bytes, BYTES);
});

test("giving up says which track it was and what the last failure said", async () => {
  await assert.rejects(
    () =>
      withFetch(
        (async () => new Response("nope", { status: 503 })) as typeof fetch,
        () => fetchBuiltin(ENTRY, 0),
      ),
    (failure: Error) => {
      assert.match(failure.message, /Тестовый трек/);
      assert.match(failure.message, /503/);
      return true;
    },
  );
});

test("bytes that are simply the wrong file are still refused in the end", async () => {
  await assert.rejects(
    () =>
      withFetch(
        (async () => new Response(Buffer.from("a different song entirely"), { status: 200 })) as typeof fetch,
        () => fetchBuiltin(ENTRY, 0),
      ),
    /контрольная сумма/,
  );
});
