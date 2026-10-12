<div align="center">

<a href="https://paseo.sh">
  <img src="https://github.com/getpaseo.png?size=160" width="80" alt="Paseo" />
</a>

# 🎙️ paseo-voice

### Your agents, out loud in seven languages — with lounge music while they think

Natural voices for [Paseo](https://paseo.sh)'s voice mode and dictation in English,
Spanish, French, Portuguese, German, Russian and Ukrainian: Google Cloud Text-to-Speech,
a local neural engine behind it for when there is no key or no network, and corrections
for the things in Paseo that no setting reaches.

[![Release](https://img.shields.io/github/v/release/devXpro/paseo-voice?style=flat-square&color=111111&labelColor=111111&label=release)](https://github.com/devXpro/paseo-voice/releases)
[![Paseo](https://img.shields.io/badge/Paseo-%E2%89%A5%200.10-111111?style=flat-square&labelColor=111111)](https://paseo.sh)
[![Licence](https://img.shields.io/github/license/devXpro/paseo-voice?style=flat-square&color=111111&labelColor=111111&label=licence)](LICENSE)
[![Tests](https://img.shields.io/badge/tests-162%20passing-111111?style=flat-square&labelColor=111111)](docs/development.md)

🗣️ **Seven languages, thirteen accents** · 🎶 **Music instead of the beep** · 📊 **Spend metered live** · 🩹 **Six bugs fixed in Paseo itself** · 📶 **Voice in a sixth of the traffic, both ways**

</div>

---

The settings panel speaks the same seven languages — English by default, chosen apart
from the language you talk to your agents in.

## 🤔 Why it exists

Paseo's voice mode defaults to a local English-only stack — Parakeet v2 for
recognition, Kokoro for speech — so speaking anything else to it produces silence or
nonsense, and even in English the voices are a step behind. The only seam for a
different engine is the OpenAI provider: point `providers.openai.tts.baseUrl` somewhere
local and Paseo will read through it. This plugin is that somewhere.

It began as a local-only plugin for Russian and still carries that engine. Google won on
the two things that matter for an assistant reading answers aloud: it has native
speakers of every language here, and it synthesises four times faster than it speaks,
so the gaps between sentences disappear.

## 🗣️ Languages

| Language | Accents | Voice mode | Dictation | Local engine |
|---|---|---|---|---|
| English | en-US, en-GB, en-AU, en-IN | ✅ | ✅ | ✅ |
| Español | es-ES, es-US | ✅ | ✅ | ✅ |
| Français | fr-FR, fr-CA | ✅ | ✅ | ✅ |
| Português | pt-BR, pt-PT | ✅ | ✅ | ✅ |
| Deutsch | de-DE | ✅ | ✅ | ✅ |
| Русский | ru-RU | ✅ | ✅ | ✅ |
| Українська | uk-UA | ✅ | ✅ | — |

One choice under **Language** drives the voice, dictation and the allowance estimate,
and changing it never restarts Paseo. Every language is tested end to end: a question
asked aloud, answered aloud, and the answer listened back to check which language the
speaker actually spoke. [docs/voices.md](docs/voices.md#languages-and-accents) has the
details.

## 📦 Install

```sh
paseo plugin add devXpro/paseo-voice
```

No build step and no `npm install`: the daemon supplies `@getpaseo/plugin`, `zod`,
`react`, `react-native` and `@tanstack/react-query` to plugin bundles, and everything
else here is a `node:` builtin.

Then open **Voice** in the sidebar, choose your language under **Language**, paste a
Google API key under **Voice**, pick a voice, and press **Write it in** under
**Connection**. Paseo resolves speech providers once at startup, so restart the app
afterwards. Getting a key, and what it costs, is in [docs/google.md](docs/google.md).

**macOS on Apple silicon** for the local fallback — upstream publishes
`qwen_tts-macos-arm64` and nothing else. The Google path has no such limit.

## 🎛️ What the panel does

| Section | |
|---|---|
| 🌐 **Language** | The panel's own language, and the language and accent of voice and dictation. [docs/voices.md](docs/voices.md#languages-and-accents) |
| 🎙️ **Voice** | Provider, billing family, voice — each with a play button. Tempo and delivery. [docs/voices.md](docs/voices.md) |
| 📊 **Limits** | A bar per billing family: characters spent this month, hours of speech left, what any overspend cost. [docs/google.md](docs/google.md) |
| 🎶 **Waiting sound** | What loops while the agent thinks: four shipped tracks, your own files, or silence. [docs/music.md](docs/music.md) |
| 🩹 **Paseo patch** | One patch, one button: fixes in Paseo's own code, and its audio compressed both ways — the agent's voice as MP3, the phone's microphone as Opus. Put back after a Paseo update when the files are ones it was reviewed against. [docs/patches.md](docs/patches.md) |
| 🖥️ **Local engine** | The fallback: binary, model, state. [docs/local-engine.md](docs/local-engine.md) |
| ⌨️ **Dictation** | Whisper Large v3 Turbo through `whisper-server`: the engine, its weights, a dictionary per language, and handing Paseo's dictation to it. |
| ⚙️ **Agent speech** | The two daemon settings voice mode cannot work without. [docs/patches.md](docs/patches.md#the-two-daemon-settings) |
| 🔗 **Connection** | Points `~/.paseo/config.json` at this plugin's proxy. |

## 📚 Documentation

- 💳 [docs/google.md](docs/google.md) — the key, billing, families, free allowances, real costs
- 🎙️ [docs/voices.md](docs/voices.md) — choosing a voice, tempo, flat delivery, stress, the phone filter
- 🎶 [docs/music.md](docs/music.md) — the waiting cue, your own tracks, licensing
- 🩹 [docs/patches.md](docs/patches.md) — what is changed inside Paseo, why, how it comes back after an update, and how to undo it
- 📱 [docs/ios.md](docs/ios.md) — building Paseo's iOS app with the cue in it
- 🖥️ [docs/local-engine.md](docs/local-engine.md) — the Qwen3-TTS fallback
- 🧩 [docs/architecture.md](docs/architecture.md) — how the pieces fit, and where files live
- 🛠️ [docs/development.md](docs/development.md) — tests, typecheck, conventions
- 🧪 [docs/e2e.md](docs/e2e.md) — the end-to-end harness: the phone's own code against a daemon, and how to write tests on it
- 🚑 [docs/troubleshooting.md](docs/troubleshooting.md) — failure modes, each one met in practice

## 🔬 Three things that were measured, not assumed

**`Standard` and `Wavenet` are the same voices.** Across all thirteen accents the same
sentence came out the same length from Standard and WaveNet voices of the same letter
in 54 pairs of 55 — the odd one out is pt-BR's letter A. Same price per million, but
Standard carries four times the free allowance — so Standard is the one to ask for.

**Russian stress is set through `customPronunciations`, not through the text.** A combining
acute (`за́мок`) is read aloud as a character and mangles the word. The right way is a
field on the request carrying IPA, where `ˈ` precedes the stressed syllable — and it
works on Chirp 3 HD, which otherwise reads SSML tags out loud.

**A fresh take per sentence is what made it sound theatrical.** Paseo sends each
sentence as its own request, and the local engine seeds itself from the clock, so every
sentence came out as a different performance — average pitch wandered 26 Hz across four
sentences of one answer. Pinning the seed halves that; `top_k: 1` removes sampling
altogether.

## 🎁 Not for sale

A personal hobby project, given away for free. No payment is asked for it, no donations
are accepted, no service is offered around it, and it is not connected to the author's
employer. Use it, fork it, sell your fork if you like — the licence allows it. The
author's own involvement is unpaid and stays that way.

## ⚖️ Licence

[MIT](LICENSE).

Music by **Kevin MacLeod** ([incompetech.com](https://incompetech.com)), licensed under
[CC BY 4.0](https://creativecommons.org/licenses/by/4.0/): *Lobby Time*, *Spy Glass*,
*Samba Isobel*, *Mining by Moonlight*. Downloaded on first run, not committed.
