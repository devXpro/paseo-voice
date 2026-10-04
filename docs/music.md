# The waiting cue

What loops while the agent is thinking, instead of Paseo's beep.

## Why it is here at all

Paseo plays a three-second tone on a loop while an agent works, and nothing in its
interface turns it off. [#5061](https://github.com/getpaseo/paseo/issues/5061) asked
for a setting and was closed with only the inter-segment debounce fixed.

On the desktop this plugin replaces it without rebuilding anything: a correction makes
Paseo ask the plugin for the sound over HTTP, so a change of track or volume is heard
on the next repeat. See [patches.md](patches.md).

On the phone the sound is compiled into the app, so changing it means building the app.
See [ios.md](ios.md).

## What is on offer

**Звук ожидания** lists four shipped tracks, everything you have put in
`~/.paseo-voice/music/`, and silence.

| | |
|---|---|
| Lobby Time | lobby jazz, calm |
| Spy Glass | retro lounge |
| Samba Isobel | samba, livelier than the rest |
| Mining by Moonlight | slow lounge |

All four are by **Kevin MacLeod** ([incompetech.com](https://incompetech.com)) under
[CC BY 4.0](https://creativecommons.org/licenses/by/4.0/). The licence requires
attribution, which is carried in this repository's README and in
`server/catalogue.server.ts`. Keep it if you redistribute.

They are **not committed**. Four tracks is fifteen megabytes, and a repository is a bad
place for audio that never changes. They are downloaded when the plugin first starts,
each checked against a SHA-256 in `server/catalogue.server.ts` before use, and written
through a staged rename so a broken download cannot leave half a file behind.

The download happens on plugin start rather than on first play — by the time the sound
is wanted it is too late, and the first pause of a session would be the one without
music in it.

Each track is taken from **30 seconds in**: all four open with an intro that does not
loop well.

## Your own music

Drop a file into `~/.paseo-voice/music/` and it appears in the list. The panel shows
the path.

Anything macOS can decode works — `.wav`, `.mp3`, `.m4a`, `.aac`, `.aiff`, `.caf`,
`.flac` — because the conversion is `afconvert`, not a bundled decoder.

Decoded audio is cached under `~/.paseo-voice/music/.cache`, keyed by the source file's
modification time. Running `afconvert` over a five-minute track is not something to do
on every repaint.

### Licensing is yours to deal with

A track you drop in is a track you chose. If you redistribute a built app or an `.ipa`
with it compiled in, the licence of that music is your problem — and most "elevator
music" from a library is commercial, not free. The four shipped tracks are CC BY
precisely so that the default is safe to pass around.

## Volume

A slider, 0 to 2×, applied when the track is rendered rather than when it is played.

Every track is first normalised to a peak of 0.22 and then scaled by the slider, so
switching tracks does not change how loud the pause is. This plays underneath a
conversation, not instead of one.

On the desktop the volume is read on each repeat, so moving the slider is heard
immediately with no rebuild and no restart. On the phone the level is baked into the
build.

## Length

On the desktop the whole track plays — there is no cap.

On the phone the cue is compiled into the app as base64 PCM, so it is capped at **60
seconds** (`CAP_SECONDS` in `ios-build/patch-app.mjs`). Longer would bloat the bundle
for a sound nobody listens to all the way through.
