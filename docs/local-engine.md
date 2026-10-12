# The local engine

A fallback, kept deliberately small. Google is the main path; this is for no key and
no network.

**macOS on Apple silicon only.** Upstream publishes `qwen_tts-macos-arm64` and nothing
else. The panel hides the section on anything else rather than offering something that
cannot work.

## What it is

[`gabriele-mastrapasqua/qwen3-tts`](https://github.com/gabriele-mastrapasqua/qwen3-tts)
at `v0.23.0` — a pure-C Qwen3-TTS runtime, one binary. **Local engine** fetches it
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
the language, the tempo, and — when **Steady tone** is on — a pinned seed and
`top_k: 1`.

## Why it lost to Google

**Speed.** The local engine synthesises slower than it speaks on this hardware, so
every sentence boundary is a pause while the next one renders. Google synthesises about
four times faster than real time, and the gaps disappear.

**Voices.** Google has native speakers in every language here. The local model's
Russian, measured first, is understandable and clearly not native.

## Languages

Qwen3-TTS knows ten languages: Chinese, English, French, German, Italian, Japanese,
Korean, Portuguese, Russian and Spanish. Of the seven this plugin offers, that is every
one but Ukrainian. Choosing Ukrainian while the local engine speaks switches to Google
and says so; without a Google key the panel warns that voice mode will stay silent.
The proxy refuses a Ukrainian sentence for the local engine with a reason rather than
have it read with another language's sounds.

It is still worth keeping for a flight, a dead key, or a month where the allowance ran
out.

## Dictation is a separate thing

Recognition is whisper.cpp's `whisper-server`, under **Dictation**, with weights of its
own in `~/.paseo-voice/models/whisper/`. Nothing here is shared with this engine.
