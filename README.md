# paseo-voice

Russian speech for [Paseo](https://getpaseo.com), through Google Cloud Text-to-Speech,
with a local neural engine kept behind it for when there is no key or no network.

A Paseo plugin: it picks the voice, meters the free allowance, replaces the waiting
beep with music, and corrects three things in Paseo itself that cannot be reached any
other way.

The settings panel is in Russian, deliberately — so is the audience.

## Why it exists

Paseo's voice mode defaults to a local English-only stack — Parakeet for recognition,
Kokoro for speech — so speaking Russian to it produces silence. The only seam for a
different engine is the OpenAI provider: point `providers.openai.tts.baseUrl` somewhere
local and Paseo will read through it. This plugin is that somewhere.

It began as a local-only plugin and still carries that engine. Google won on the two
things that matter for an assistant reading answers aloud: it has actual Russian
speakers, and it synthesises four times faster than it speaks, so the gaps between
sentences disappear.

## Install

```sh
paseo plugin add devXpro/paseo-voice
```

No build step and no `npm install`: the daemon supplies `@getpaseo/plugin`, `zod`,
`react`, `react-native` and `@tanstack/react-query` to plugin bundles, and everything
else here is a `node:` builtin.

Then open **Голос** in the sidebar, paste a Google API key, pick a voice, and press
**Прописать** under Подключение. Paseo resolves speech providers once at startup, so
restart the app afterwards. Getting a key, and what it costs, is in
[docs/google.md](docs/google.md).

**macOS on Apple silicon** for the local fallback — upstream publishes
`qwen_tts-macos-arm64` and nothing else. The Google path has no such limit.

## What the panel does

| Section | |
|---|---|
| **Голос** | Provider, billing family, voice — each with a play button. Tempo and delivery. [docs/voices.md](docs/voices.md) |
| **Лимиты** | A bar per billing family: characters spent this month, hours of speech left, what any overspend cost. [docs/google.md](docs/google.md) |
| **Звук ожидания** | What loops while the agent thinks: four shipped tracks, your own files, or silence. [docs/music.md](docs/music.md) |
| **Патч Paseo** | Three corrections to Paseo's own code, each applied and reverted on its own. [docs/patches.md](docs/patches.md) |
| **Локальный движок** | The fallback: binary, model, state. [docs/local-engine.md](docs/local-engine.md) |
| **Речь агента** | The two daemon settings voice mode cannot work without. [docs/patches.md](docs/patches.md#the-two-daemon-settings) |
| **Диктовка** | Reports whether the Whisper model is where `paseo-whisper` looks for it. |
| **Подключение** | Points `~/.paseo/config.json` at this plugin's proxy. |

## Documentation

- [docs/google.md](docs/google.md) — the key, billing, families, free allowances, real costs
- [docs/voices.md](docs/voices.md) — choosing a voice, tempo, flat delivery, stress, the phone filter
- [docs/music.md](docs/music.md) — the waiting cue, your own tracks, licensing
- [docs/patches.md](docs/patches.md) — what is changed inside Paseo, why, and how to undo it
- [docs/ios.md](docs/ios.md) — building Paseo's iOS app with the cue in it
- [docs/local-engine.md](docs/local-engine.md) — the Qwen3-TTS fallback
- [docs/architecture.md](docs/architecture.md) — how the pieces fit, and where files live
- [docs/development.md](docs/development.md) — tests, typecheck, conventions
- [docs/troubleshooting.md](docs/troubleshooting.md) — failure modes, each one met in practice

## Three things that were measured, not assumed

**Russian `Standard` and `Wavenet` are the same voices.** `ru-RU-Standard-A` and
`ru-RU-Wavenet-A` return byte-identical audio. Same price per million, but Standard
carries four times the free allowance — so Standard is the one to ask for.

**Stress is set through `customPronunciations`, not through the text.** A combining
acute (`за́мок`) is read aloud as a character and mangles the word. The right way is a
field on the request carrying IPA, where `ˈ` precedes the stressed syllable — and it
works on Chirp 3 HD, which otherwise reads SSML tags out loud.

**A fresh take per sentence is what made it sound theatrical.** Paseo sends each
sentence as its own request, and the local engine seeds itself from the clock, so every
sentence came out as a different performance — average pitch wandered 26 Hz across four
sentences of one answer. Pinning the seed halves that; `top_k: 1` removes sampling
altogether.

## Not for sale

A personal hobby project, given away for free. No payment is asked for it, no donations
are accepted, no service is offered around it, and it is not connected to the author's
employer. Use it, fork it, sell your fork if you like — the licence allows it. The
author's own involvement is unpaid and stays that way.

## Licence

[MIT](LICENSE).

Music by **Kevin MacLeod** ([incompetech.com](https://incompetech.com)), licensed under
[CC BY 4.0](https://creativecommons.org/licenses/by/4.0/): *Lobby Time*, *Spy Glass*,
*Samba Isobel*, *Mining by Moonlight*. Downloaded on first run, not committed.
