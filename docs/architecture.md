# How it fits together

```
Paseo daemon  ──▶  plugin proxy :8123  ──┬──▶  Google Cloud TTS
                   /v1/audio/speech      └──▶  qwen_tts --serve :8124   (fallback)
                   /v1/cue
                   /v1/health
```

## Why there is a proxy at all

Paseo's TTS client is an OpenAI SDK with a hard-coded voice enum — it can only ever
send `alloy`, `echo`, `fable`, `onyx`, `nova` or `shimmer` — and neither backend knows
those names. The only seam for a different engine is
`providers.openai.tts.baseUrl`.

So the proxy speaks OpenAI's shape and does four things: substitutes the chosen voice
for whatever Paseo asked for, counts the characters against the monthly allowance,
applies the low-pass when it is on, and answers with the headerless 24 kHz samples
Paseo expects of `response_format: "pcm"`.

**Подключение** writes that `baseUrl` into `~/.paseo/config.json`, leaving dictation
alone. Paseo resolves speech providers once at startup, so it needs a restart.

### It buffers, and that is the point

The proxy replies with the whole utterance and a `Content-Length` rather than
streaming.

Paseo reads a sentence's body only once the previous one has finished playing, so a
streamed reply can sit half-read for seconds. If it then breaks, what arrives is a
`200` with a short body — and Paseo's TTS manager cannot tell that from a sentence
meant to be silent. It drops it and moves on, leaving a hole in the middle of an
answer and nothing in any log. See [patches.md](patches.md).

A complete body is either right or an honest error, and it costs no latency: the
manager concatenates the whole sentence before playing it anyway.

### /v1/cue

The desktop client fetches its waiting music here, because of the correction in
[patches.md](patches.md). Rendered once per track-and-volume and held in memory.

## The two halves

A Paseo plugin is two bundles with two entry points, both of which must be
synchronous:

- `index.server.ts` — runs as a subprocess of the daemon, holds the proxy, the engine
  and all state. Unsandboxed, with full access to the machine.
- `index.client.tsx` — renders the panel, in the desktop browser or in React Native on
  a phone. Talks to the server half only through typed RPC.
- `shared/voice.shared.ts` — the contracts between them, defined once with zod. The
  status object is the single thing every mutation returns, so the panel never has to
  ask twice.

The daemon supplies `@getpaseo/plugin`, `zod`, `react`, `react-native` and
`@tanstack/react-query` to plugin bundles. There is no audio module among them, which
is why previewing is desktop-only. Everything else here is a `node:` builtin —
nothing is installed at runtime.

## Server modules

| | |
|---|---|
| `controller.server.ts` | The one object the RPC handlers call. Owns the status snapshot. |
| `proxy.server.ts` | The HTTP server on `:8123`. |
| `google.server.ts` | Google's API: voices, synthesis, billing families, the key. |
| `engine.server.ts` | Starting, stopping and health-checking the local binary. |
| `patches.server.ts` | The three corrections, and applying and reverting them. |
| `asar.server.ts` | Just enough of the asar format to read and overwrite one entry. |
| `cue.server.ts` | Rendering the waiting music; decoding, levelling, caching. |
| `catalogue.server.ts` | The four CC BY tracks: URLs, hashes, attribution. |
| `pcm.server.ts` | Trimming, WAV headers, the low-pass filter. |
| `usage.server.ts` | Characters per family per month, and what they cost. |
| `state.server.ts` | The stored choice, with its defaults and its clamps. |
| `config.server.ts` | Reading and writing `~/.paseo/config.json`. |
| `daemon-settings.server.ts` | The two daemon settings and the appended prompt. |
| `whisper.server.ts` | Reports on the dictation model. Reports only. |
| `paths.server.ts` | Every path in one place. |
| `binary.server.ts` | Fetching the local engine from its release. |
| `music.server.ts` | The `Track` shape, and the module the iOS build generates. |

Files are named by where they run — `.server.ts`, `.client.tsx`, `.shared.ts` — which
is how the bundler knows what goes where.

## Where things live

Outside the plugin directory, so `paseo plugin remove` does not take four gigabytes of
weights with it.

```
~/.paseo-voice/
  google-key.txt      the API key, mode 600
  state.json          chosen provider, voice, tempo, cue, volume, prompt
  usage.json          characters sent per family per month
  bin/qwen_tts        the local engine, fetched from a release and checksummed
  models/<id>/        local weights, one directory per model
  music/              your own tracks; .builtin/ holds the four shipped ones
  patches/            the untouched originals, for reverting
  ios-build/          the Paseo checkout and build output
```
