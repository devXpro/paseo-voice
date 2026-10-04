# The local engine

A fallback, kept deliberately small. Google is the main path; this is for no key and
no network.

**macOS on Apple silicon only.** Upstream publishes `qwen_tts-macos-arm64` and nothing
else. The panel hides the section on anything else rather than offering something that
cannot work.

## What it is

[`gabriele-mastrapasqua/qwen3-tts`](https://github.com/gabriele-mastrapasqua/qwen3-tts)
at `v0.23.0` — a pure-C Qwen3-TTS runtime, one binary. **Локальный движок** fetches it
from that release into `~/.paseo-voice/bin/qwen_tts` and checksums it.

The model that matters is **Qwen3-TTS-12Hz-1.7B-CustomVoice**, about 4.5 GB. It read
Russian cleanly where the 0.6B did not.

Weights are **not** downloaded by the plugin. Put a model from Hugging Face into
`~/.paseo-voice/models/<id>/` and the engine picks it up. Four and a half gigabytes is
not something to start in the background behind somebody's back.

## How it runs

Started on demand, on `127.0.0.1:8124`, and stopped after ten idle minutes. Choosing
Google as the provider stops it immediately — nothing is listening to it then.

The proxy on `:8123` talks to it over `/v1/tts/stream` and passes the chosen speaker,
the language, the tempo, and — when **Ровный тон** is on — a pinned seed and
`top_k: 1`.

## Why it lost to Google

**Speed.** The local engine synthesises slower than it speaks on this hardware, so
every sentence boundary is a pause while the next one renders. Google synthesises about
four times faster than real time, and the gaps disappear.

**Voices.** Google has actual Russian speakers. The local model's Russian is
understandable and clearly not native.

It is still worth keeping for a flight, a dead key, or a month where the allowance ran
out.

## Dictation is a separate thing

**Диктовка** only reports whether `ggml-large-v3-turbo.bin` is where `paseo-whisper`
looks for it — `~/.config/paseo-whisper/models/`. It reports and does nothing else:
that service has its own configuration and its own restart, and this plugin does not
reach into them.

Recognition is not what this plugin does. Speech is.
