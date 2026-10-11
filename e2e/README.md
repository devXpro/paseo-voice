# End-to-end harness

The phone's own voice code — Paseo's voice runtime and native audio engine, from the
checkout `ios-build/build.sh` patches — run against a daemon, with a speaker that
records what was heard and when.

```sh
npm run e2e         # simulated daemon and relay
npm run e2e:live    # the real daemon, through the real relay, with a test agent
```

How it is put together, how to write tests on it, and how to try a fix before it ships:
**[docs/e2e.md](../docs/e2e.md)**.

| | |
|---|---|
| `harness/` | The phone, the speaker, the simulated and the live daemon, the timeline |
| `engine.e2e.ts` | Paseo's audio engine on its own |
| `microphone.e2e.ts` | What is said reaches the daemon, in real time |
| `reply.e2e.ts` | A spoken reply, end to end, and the waiting music's rule |
| `live/voice.live.ts` | Real conversations through the relay |
