# Voices and delivery

Everything under **Voice**, and what each control actually changes.

## Languages and accents

Seven languages, chosen with their accent under **Language**, apart from the language the
panel itself is in:

| Language | Google accents | Chirp 3 HD voices | Local engine | Characters per hour |
|---|---|---|---|---|
| English | en-US, en-GB, en-AU, en-IN | 30 per accent | ✅ | 65 000 |
| Español | es-ES, es-US | 30 per accent | ✅ | 61 000 |
| Français | fr-FR, fr-CA | 30 per accent | ✅ | 69 000 |
| Português | pt-BR, pt-PT | 30 for pt-BR; pt-PT has Standard and WaveNet only | ✅ | 53 000 |
| Deutsch | de-DE | 30 | ✅ | 63 000 |
| Русский | ru-RU | 8 | ✅ | 51 000 |
| Українська | uk-UA | 30 | — | 51 000 |

**One choice drives everything.** The voice switches to the one last chosen for that
accent, or the first time to the accent's default — Orus, which every accent with
Chirp 3 HD has. Dictation listens for the language with that language's own dictionary,
and the allowance estimate uses its speaking rate. Paseo's own recogniser in voice mode,
Parakeet v3, needs no telling: it detects the language of what it hears among
twenty-five European ones.

**Changing it never restarts Paseo.** Nothing in Paseo's config depends on it; only
the plugin's own dictation engine restarts, which takes a second. One engine at a time:
the new one waits for the old one to let go of the port, and a change made before the
last one is up takes its place rather than starting beside it.

**Each dictated sentence is heard on its own.** The engine runs with `--no-context`:
given the sentences before as context, Whisper carries on in their language whatever
it is told — after one English sentence, Spanish, French, German and Russian all came
back translated into English. The dictionary still goes with every sentence.

**An accent's voices are its own.** Asked for `fr-CA`, Google also lists `fr-FR` voices
that can read it — with a French accent. The list here keeps only the accent's own.

**Characters per hour** is measured: the same paragraph in each language, read by two
Chirp 3 HD voices, Orus and Aoede, at tempo 1, averaged. One voice runs as much as a
fifth faster than another, so it is an estimate, and it is what the hours-left figure
under **Limits** divides by.

## Choosing

Three steps, in order: **provider**, then **family**, then **voice** — all of them in
the accent chosen under **Language**.

The family is read from the voice's own name rather than stored beside it —
`ru-RU-Chirp3-HD-Orus` is Chirp 3 HD because it says so. Nothing can drift out of sync
with the billing that way.

The catalogue is asked of Google rather than written down here. The Chirp line is new
and its naming has already moved once; a stale list fails in a way that reads like a
credentials problem.

Each voice has a play button. Auditioning costs one short sentence against the
allowance and is never cached, so repeated presses are repeated charges — small ones.

### The play buttons are desktop-only

The desktop surface is a browser and takes a data URL. The phone is React Native on
Hermes, and the host hands plugin bundles `react`, `react-native`, `zod` and
`@tanstack/react-query` — there is no audio among them, and none in the plugin API
either. The panel says so rather than pretending.

An earlier build served each render over the local network and opened it in the system
player. It worked, and it was hated: it threw you out of the app every time.

## Speaking rate

0.7× to 1.6×, applied per request. Google takes it as `speakingRate`, the local engine
as `rate`. Neither changes pitch — the voice does not go up as it speeds up.

1.0 is the voice as designed. It is not sent at all when it is 1.0, so the default
path carries no tempo field.

## Steady tone

**Local engine only.** The switch disappears when Google is the provider, because
Google has no seed to pin and does not vary between takes.

Paseo sends each sentence as its own request, and the local engine seeds itself from
the clock — so every sentence came out as a different performance. Measured across
four sentences of one answer, average pitch wandered 26.2 Hz. Pinning the seed to a
constant brings that to 13.1 Hz; `top_k: 1` removes sampling altogether, so the same
text produces the same audio every time.

This is the difference between an answer that sounds like one person talking and one
that sounds like a set of takes spliced together.

## Clean sound on the phone

A low-pass filter at 7.5 kHz, applied to the 24 kHz output before it is sent. On by
default.

The mobile app's native audio engine only does 16 kHz, so it downsamples every chunk
from 24 kHz with plain linear interpolation and no anti-aliasing filter. Everything
above 8 kHz folds back into the audible band, which is the harsh, gritty character of
speech on a phone. Upstream has this as
[#4981](https://github.com/getpaseo/paseo/issues/4981) — open, and the reporter found
that sending 16 kHz does not help, because the app hardcodes the incoming rate to
24 kHz.

Filtering first leaves the app's decimation nothing to alias with. The band being
removed was being destroyed anyway; the choice is between losing it quietly and losing
it with a rattle. Measured at −90.2 dB above 8.5 kHz after filtering.

The desktop plays at the declared rate and sounds clean, so this costs a little
brightness there. Turn it off if you mostly listen at the computer.

Implemented as a Blackman-windowed sinc, 127 taps, in `server/pcm.server.ts`.

## Stress

Stress is set through `customPronunciations` on the request — a field carrying
IPA, where `ˈ` precedes the stressed syllable and `.` marks syllable boundaries. It
works on Chirp 3 HD, which otherwise reads SSML tags out loud.

A combining acute in the text (`за́мок`) does not work: it is read aloud as a character
and mangles the word.

The plumbing is in `server/google.server.ts` and takes a list of
`{ phrase, phoneticEncoding, pronunciation }`. **There is no interface for it yet** —
the list is always sent empty. A stress dictionary is the obvious next thing to build
here.

Useful ru-RU phonemes: vowels `a e i o u ɨ`, palatalised consonants written with `ʲ`.
