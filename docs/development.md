# Development

```sh
npm install        # only for typecheck and tests; nothing is needed at runtime
npm run typecheck
npm test
```

`node_modules` exists so `tsc` and `node --test` have the SDK, zod and react to look
at. The daemon supplies all of those to the plugin itself and runs no package manager
— plugins are source only.

## Reloading after a change

Nothing is hot-reloaded, and **both halves must be reloaded**: the daemon and the
client hold separate bundles, so reloading only the daemon leaves the old interface
running against new handlers.

```sh
/Applications/Paseo.app/Contents/Resources/bin/paseo plugin reload voice
```

then reload the Paseo client itself.

The CLI is not on `PATH`; it lives inside the application bundle. The subcommand is
`plugin ls`, not `plugin list`.

**Whether it actually loaded is in the daemon log**, not in the CLI's output, which
reports `running` either way:

```sh
grep -a '"pluginId":"voice"' ~/.paseo/daemon.log | tail -3
```

A good load prints `Loaded plugin` with the list of registered RPC methods, then
`Plugin ready`. A failure prints a stack trace there and shows as an error card in the
interface — and that card is sticky: it can survive a fix and a reload. Trust the log
over the screen.

A changed `paseo-plugin.json` needs `plugin remove voice` then `plugin add` with an
**absolute** path. The daemon caches the manifest from install time and a reload will
not re-read it.

## Conventions

**Files are named by where they run.** `.server.ts` runs in the daemon subprocess,
`.client.tsx` in the panel, `.shared.ts` in both. That is how the bundler decides what
goes where, and it is not optional.

**Both `contribute()` functions must be synchronous.** Anything async is started inside
and allowed to settle later.

**Code, comments and documentation are in English. The interface is in Russian** — so
is the audience for a plugin about Russian speech. Error messages that surface in the
panel are Russian for the same reason; messages that only ever reach a log are English.

**Tests state what is true, not what is called.** `the fingerprint catches an edit that
kept the file's size` rather than `test fingerprintOf`. A test name is the one piece of
documentation that cannot go stale without going red.

## What the tests cover

75 of them, all `node:test`, no framework and no mocking library.

The ones worth knowing about:

- `asar.test.ts` builds an archive by hand, byte by byte. The header is two nested
  pickles and reading the JSON four bytes early yields a parse error on what looks like
  valid data — this test is what pins that down.
- `patches.test.ts` carries the real shape of the functions being corrected, as Paseo
  compiles them, and proves that a missing anchor and a doubled anchor are both
  refusals rather than guesses.
- `pcm.test.ts` measures the low-pass rather than trusting it.
- `usage.test.ts` covers the billing arithmetic, including the month boundary.

There is no test that needs a Google key or a network.

## Things known and not done

- **A stress dictionary has no interface.** The `customPronunciations` plumbing is in
  `google.server.ts` and the list is always sent empty. See
  [voices.md](voices.md#stress).
- **Issues worth filing upstream**, each reproduced: the silently dropped TTS segments
  (a forty-line repro exists), mute never ending a turn, and
  `daemon.mcp.injectIntoAgents` being off by default when voice mode cannot work
  without it.
