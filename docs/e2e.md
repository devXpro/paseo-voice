# Testing end to end

Unit tests here prove that a correction lands on the right lines. They cannot prove what
a person hears: whether the second sentence of an answer plays, whether the music stops
when the agent starts to speak, whether anything is still sounding after the turn is
over. Those depend on timing — a sentence crossing the relay while a fetch is still in
flight — across code that is not this plugin's.

The harness in `e2e/` answers those questions by running **the phone's own voice code**
— Paseo's voice runtime and its native audio engine, from the checkout
`ios-build/build.sh` patches — against a daemon, and listening to what comes out of the
speaker.

```sh
npm run e2e         # a simulated daemon and relay: about three minutes, free
npm run e2e:live    # the real daemon, through the real relay: about two minutes
```

Neither is part of `npm test` — the files are `*.e2e.ts` and `*.live.ts`, which the
default run never picks up — because both need things a unit test must not: the
patched Paseo checkout, and for the live run a daemon, a relay and a Claude login.

## What it needs

- **The patched checkout** at `~/.paseo-voice/ios-build/paseo`. `ios-build/build.sh`
  makes it; to make it without building, run its first steps by hand (see
  [Trying a fix before it ships](#trying-a-fix-before-it-ships)). `PASEO_SRC` points the
  harness at another one.
- **For the live run**, that checkout's packages built — `npm ci && npm run
  build:app-deps` inside it, which `build.sh` does — so the harness connects with the
  same client the phone build will carry.
- **For the live run**, a directory where `claude` is logged in, for the test agent to
  work in. See [The live run](#the-live-run).

## How it is put together

**Paseo's code is imported from the checkout, never copied in.** Paseo is not
MIT-licensed and this repository is, so the harness reaches into the checkout at run
time instead — which has the second advantage that it always tests exactly the tree
that will be built. `e2e/harness/register.ts` is loaded with `--import` before any test
and does three things:

- **Resolution the app normally gets from Metro** (`hooks.ts`): the `@/` alias and
  relative imports written without an extension, for the app's own files only. Expo
  modules the audio engine imports for encoded files — a path voice never takes — get
  stand-ins from `harness/stubs/`.
- **The native audio module** the engine `require`s is replaced by `native-audio.ts`.
  That is the only part of the phone that is not real.
- **Variants without a rebuild**: the runtime's timing constants can be overridden per
  import through the query string, applied as the module loads — `?minSilenceMs=1500`.
  A different query is a different module instance, so variants never leak.

| File | What it is |
|---|---|
| `harness/phone.ts` | The phone: the real runtime and engine, wired the way the app wires them. Every event it takes in and every confirmation it sends goes into the timeline. |
| `harness/native-audio.ts` | The stand-in for the native module: a speaker that queues PCM and plays it at the real rate, a microphone the harness talks into. |
| `harness/simulated-daemon.ts` | The daemon and the relay, after `tts-manager.js`: one group per sentence, the next sent only once the last is confirmed, `speak` running before the audio and completed after it, and one ordered connection with a latency and a throughput. |
| `harness/live-daemon.ts` | The real daemon, through the relay, end-to-end encrypted, with a test agent. |
| `harness/tts.ts` | What the person says: synthesised by this plugin's proxy, fed to the microphone at the speed of speech. |
| `harness/speech.ts` | Telling sounds apart. |
| `harness/timeline.ts` | Everything, in order. |
| `harness/scenario.ts` | Ready-made simulated exchanges. |

### The timeline

Every test owns one. It holds **moments** — what each side did and when, in
milliseconds since the start — and **heard**: every stretch of sound the speaker put
out, cut short where playback was stopped. Every failing assertion prints the whole of
it, because in a race the order of events is the explanation:

```
 27220 ms  phone.confirms  2abfcada…:0
 27220 ms  phone.phase  waiting
 27592 ms  phone.audio_output  dffb991c…:0
 27597 ms  speaker.queued  speech, 11181 ms
 27597 ms  ♪ speech audible until 38778
```

Prefixes say whose event it is: `phone.` for the runtime and its adapter, `daemon.` for
the daemon side, `speaker.` for the native module, `agent.` for what the live agent did
with its turn, `person.` for what was said into the microphone.

### Telling sounds apart

The speaker names each sound it plays. **The cue is known by its own bytes**: Paseo's
built-in one and every track the plugin hands out are remembered as they appear, and
the engine passes a cue through untouched. **Simulated speech is a flat level** that
says which sentence it is — `segment 0`, `segment 1` — because a constant survives the
engine's resampling exactly. Anything else is `speech`, which is what real answers are.

## Writing a simulated test

Start from `scenario.ts`. `runReply` is the common exchange — the person has spoken,
the agent thinks, answers in sentences of the given lengths, ends its turn — and returns
the timeline with the questions most tests ask already worked out:

```ts
import assert from "node:assert/strict";
import { test } from "node:test";
import { RELAY, runReply } from "./harness/scenario.ts";

test("the cue stops the moment the agent starts to speak", async () => {
  const run = await runReply({ network: RELAY, segmentsMs: [600, 600], pluginCue: true });
  // ...assert on run.cueBeforeTheReply, run.cueWithinTheReply,
  // run.cueAfterTheLastWords, run.heardAfterTheEnd, run.spoken
  assert.deepEqual(run.cueWithinTheReply, [], run.timeline.render());
});
```

Pass `run.timeline.render()` as the message of every assertion — a red test should
explain itself without being run again.

When the shape you need is not there, build it from the same parts `scenario.ts` uses:

```ts
const timeline = createTimeline();
const daemon = createSimulatedDaemon(timeline, RELAY);
const phone = await createPhone({
  timeline,
  audioPlayed: (id) => daemon.audioPlayed(id),
  fetchCue: (have) => daemon.fetchCue(have), // leave out for Paseo's built-in cue
});
daemon.attach(phone);

daemon.transcript("привет");           // what the daemon recognised
daemon.turn("turn_started");
await sleep(1500);                      // the agent thinking
await daemon.speak([800, 800]);         // one speak call, two sentences
daemon.turn("turn_completed");
await sleep(2000);                      // listen on
await phone.hangUp();
```

`daemon.speak` behaves like the real one: the call shows as running, the first
sentence follows after synthesis, each next sentence only after the phone has confirmed
the last, and the call completes after the final confirmation. It returns
`{ confirmed, stuckAt }` — a sentence the phone never confirms ends the reply there.

**The network is part of the scenario.** `RELAY` is a decent connection;
`WEAK_RELAY` is one where a few seconds of speech take longer than 1.5 s to come down.
Everything from the daemon shares one ordered connection, so a large message holds up
the small one sent after it — which is how a fetch answer can arrive after the sentence
that should have cancelled it.

### Rules worth keeping

- **A test name states what should be true**, as everywhere in this repository: «the
  cue never sounds between two segments of one reply», not «test cue». Red means the
  statement is false.
- **Pair every "silence" test with a "sound" one.** Any fix that kills the cue
  altogether passes every test about silence. «The cue plays while the agent is
  thinking» and «the cue comes back while the agent works on after saying something»
  exist so that such a fix goes red.
- **Change one thing at a time.** When a test fails on the phone as built, add the same
  scenario with one difference — the cue's source, the wait before it, the link — and
  the failure says what it hangs on.
- **Time is real, so margins must be wide.** Nothing is mocked: a 600 ms sentence takes
  600 ms. Make the window that matters explicit — a latency, a throughput — and keep it
  far from the edge, rather than tuning a test until it passes.

## The live run

It connects to the daemon the way the phone does — through the relay, end-to-end
encrypted, as a client of its own — creates a test agent, and holds a real spoken
conversation: the question is synthesised by this plugin, said into the microphone at
the speed of speech, recognised by the daemon, answered by the agent through `speak`,
and played by the phone's own code.

**It never disturbs the real phone.** Its own stable client id, so the sessions stay
apart; its own agent, since voice mode belongs to one agent at a time; voice turned off
before it leaves, because the daemon would otherwise hold the session for ninety
seconds.

**The agent's directory decides its Claude login** wherever the config dir is picked
per directory. Put a directory where `claude` is logged in into a gitignored `.env.e2e`
at the repository root:

```sh
PASEO_VOICE_E2E_CWD=/path/to/a/folder/claude/is/logged/in/for
```

Without a working login the agent answers in text that authentication failed, ends its
turn within a second and never speaks — the timeline shows exactly that line.

### Writing a live test

One real conversation per block, several statements about it — a conversation costs a
Haiku turn and a few hundred characters of Google TTS, an assertion costs nothing:

```ts
describe("a question with a long answer", { timeout: 300_000 }, () => {
  let run: Exchange;
  before(async () => {
    run = await exchange("Расскажи пятью предложениями, зачем нужен голосовой режим.");
  });
  test("the cue never sounds between its sentences", () => {
    assert.deepEqual(run.cueWithinTheAnswer, [], run.timeline.render());
  });
});
```

`exchange` in `e2e/live/voice.live.ts` opens a session, says the question, waits for
the turn to end, listens on, and closes. To go further, `openLiveSession` gives the
parts: `say(text)`, `turnEnd(timeoutMs)`, `close()`, the phone and the timeline.

- **Ask what needs no tool.** An agent reaching for a tool waits for a permission
  nobody is there to grant; the timeline shows `agent.permission`.
- **A reply that hangs is caught in seconds, not minutes.** The daemon waits for each
  sentence's confirmation forever. The harness gives a sentence its own length plus
  eight seconds, then records `phone.stuck`, ends the exchange as `"stuck"`, and hangs
  up — turning voice off, which is also what releases the daemon.
- **What the agent did is in the timeline**: `agent.says` for its text, `agent.tool`
  for tools, `daemon.speak` for its speech, `agent.error` when it failed.
- A run leaves a workspace for the agent's directory in Paseo's sidebar.

## Trying a fix before it ships

This is how correction 7 in `ios-build/patch-app.mjs` was made, and the order matters:

1. **A test that is red** on the phone as built — and, beside it, the one that would
   go red if the fix went too far.
2. **The correction, written into `patch-app.mjs`**, as a splice with an anchor. Not
   into the checkout by hand: what is tested must be what the patcher produces.
3. **Reset the checkout and patch it from scratch**, so nothing done by hand survives:

   ```sh
   git -C ~/.paseo-voice/ios-build/paseo checkout -- .
   DEVELOPMENT_TEAM=<team> node ios-build/patch-app.mjs ~/.paseo-voice/ios-build/paseo
   ```

   Built dependencies are untracked and survive the reset. `DEVELOPMENT_TEAM` only
   names the bundle identifier; `build.sh` reads it from the signing certificate.
4. **Green in simulation, then green live**, the guarding test included.
5. **Then build**, with `ios-build/build.sh`, which fetches, resets and patches the
   same way before it builds.

For a question about timing alone, a variant is quicker than a correction:
`runtimeVariant: "?minSilenceMs=1500"` runs the same scenario with upstream's wait.

**After a Paseo release**, move the checkout to the new tag and run both suites before
anything else. Upstream may have fixed something — Paseo 0.11 rebuilt the playback
queue, and the engine tests that were red on 0.10.3 went green with no correction of
ours — or moved the code the harness imports.

## When the harness itself fails

- **«no patched Paseo checkout»** — run `ios-build/build.sh` once, or set `PASEO_SRC`.
- **A module cannot be found inside the checkout** — upstream moved or rebuilt it.
  Paseo 0.11 moved the audio engine from `voice/` to `audio/`; `paseo-source.ts` picks
  whichever exists. A new top-level import of a native-only module needs a stand-in in
  `harness/stubs/` and a line in `hooks.ts`.
- **The live run cannot connect** — the relay is read from `~/.paseo/config.json` and
  the daemon's public key from `~/.paseo/daemon-keypair.json`. Only the public half is
  read, and nothing from that file is ever printed.
- **The live run cannot speak** — synthesis goes through this plugin's proxy on
  `127.0.0.1:8123`, so the plugin has to be running with a voice chosen.
- **`Failed to authenticate` from the agent** — the directory in `.env.e2e` has no
  working Claude login.
