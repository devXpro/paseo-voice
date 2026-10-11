import http from "node:http";
import { setTimeout as sleep } from "node:timers/promises";
import { openLiveSession, type TurnOutcome } from "../harness/live-daemon.ts";
import { startTestDaemon } from "../harness/test-daemon.ts";
import { createTimeline } from "../harness/timeline.ts";

/**
 * A live voice conversation driven by hand, one utterance at a time — for what a
 * scripted test would not think to try. One session is held open (the real daemon, the
 * relay, a test agent) and takes orders over a local port:
 *
 *   POST /say          body: the words      said into the phone's microphone
 *   POST /type         body: the words      typed into the chat, voice mode still on
 *   GET  /turn?waitMs=N                     how that turn ended, and what happened in it;
 *                                           answers "running" after N ms if it has not
 *   GET  /log?since=MS                      the timeline from that moment on
 *   POST /allow        body: request id      granted, as a tap on Allow
 *   POST /close                             voice off, agent gone, process out
 *
 *   node --env-file-if-exists=.env.e2e --import ./e2e/harness/register.ts e2e/tools/dialogue.ts
 *
 * With `DIALOGUE_DAEMON=isolated` it talks to a daemon of its own; see `test-daemon.ts`.
 */

const PORT = Number(process.env.DIALOGUE_PORT || 8139);
/** After a turn ends, how long to keep listening for anything that should not be there. */
const LISTEN_ON_MS = 4000;

const timeline = createTimeline();
const daemon = process.env.DIALOGUE_DAEMON === "isolated" ? await startTestDaemon() : undefined;
const session = await openLiveSession({ timeline, model: process.env.DIALOGUE_MODEL, daemon });

type Turn = { outcome: TurnOutcome; endedAt: number };
let current: { said: string; since: number; spokenBefore: number; done: Promise<Turn> } | null = null;

function lines(since: number): string[] {
  return timeline
    .render()
    .split("\n")
    .filter((line) => Number(line.trim().split(" ")[0]) >= since);
}

function phaseNow(): string {
  return timeline.moments.filter((one) => one.what === "phone.phase").at(-1)?.detail ?? "?";
}

async function body(request: http.IncomingMessage): Promise<string> {
  let text = "";
  for await (const chunk of request) {
    text += chunk;
  }
  return text.trim();
}

function answer(response: http.ServerResponse, status: number, value: unknown): void {
  response.writeHead(status, { "content-type": "application/json; charset=utf-8" });
  response.end(`${JSON.stringify(value, null, 2)}\n`);
}

const server = http.createServer((request, response) => {
  void (async () => {
    const url = new URL(request.url ?? "/", "http://local");
    if (request.method === "POST" && url.pathname === "/say") {
      const said = await body(request);
      const since = timeline.now();
      const spokenBefore = session.spoken.length;
      const done = (async (): Promise<Turn> => {
        await session.say(said);
        const outcome = await session.turnEnd(180_000);
        const endedAt = timeline.now();
        await sleep(LISTEN_ON_MS);
        return { outcome, endedAt };
      })();
      current = { said, since, spokenBefore, done };
      answer(response, 202, { saying: said, since });
      return;
    }
    if (request.method === "GET" && url.pathname === "/turn") {
      if (!current) {
        answer(response, 409, { error: "nothing has been said yet" });
        return;
      }
      const { since, spokenBefore, done, said } = current;
      const waitMs = Number(url.searchParams.get("waitMs") ?? 120_000);
      const turn = await Promise.race([done, sleep(waitMs).then(() => null)]);
      const report = {
        said,
        agentSaid: session.spoken.slice(spokenBefore),
        phase: phaseNow(),
        waitingOn: session.pendingPermissions(),
        unconfirmed: session.audioIds.filter((id) => !session.confirmed.has(id)),
        lines: lines(since),
      };
      if (!turn) {
        answer(response, 200, { state: "running", ...report });
        return;
      }
      answer(response, 200, {
        state: turn.outcome,
        heardAfterTheEnd: timeline.heardAfter(turn.endedAt + 1000),
        ...report,
      });
      return;
    }
    if (request.method === "GET" && url.pathname === "/log") {
      answer(response, 200, { now: timeline.now(), lines: lines(Number(url.searchParams.get("since") ?? 0)) });
      return;
    }
    if (request.method === "POST" && url.pathname === "/type") {
      const typed = await body(request);
      await session.type(typed);
      answer(response, 202, { typing: typed, since: timeline.now() });
      return;
    }
    if (request.method === "POST" && url.pathname === "/allow") {
      const id = await body(request);
      const ids = id === "all" ? session.pendingPermissions().map((one) => one.id) : [id];
      for (const one of ids) {
        await session.allow(one);
      }
      answer(response, 200, { allowed: ids });
      return;
    }
    if (request.method === "POST" && url.pathname === "/close") {
      answer(response, 200, { closing: true });
      await session.close();
      await daemon?.stop();
      server.close();
      process.exit(0);
    }
    answer(response, 404, { error: "no such command" });
  })().catch((failure: unknown) => answer(response, 500, { error: String(failure) }));
});

server.listen(PORT, "127.0.0.1", () => {
  console.log(`dialogue on 127.0.0.1:${PORT}, agent ${session.agentId}`);
});
