# What is changed inside Paseo

Three corrections, written into Paseo's own code. **Патч Paseo** applies and reverts
each on its own, and shows which are in place.

They exist because there is no seam for them. Two are bugs with no setting behind them,
and the third is a sound with no setting behind it. Everything this plugin could do
through the published plugin API, it does through the published plugin API.

## How it is done safely

**Byte-for-byte, in place.** An asar archive is a JSON header followed by every file's
bytes concatenated, and each entry's offset is recorded in that header. A replacement
of exactly the same length can be written straight over the old bytes and the header
stays true. Anything else means rebuilding 112 MB and reproducing the unpacked-file
flags by hand. So the patched source is squeezed back into the original's length —
leading indentation is halved, then dropped, then the remainder is padded with spaces.

**It refuses rather than guesses.** Every correction is anchored to an exact string or
a shape. An anchor that is missing, or that occurs twice, is a refusal — reported as
«незнакомая версия Paseo». An upstream rewrite therefore cannot be half-applied.

**The original is kept first.** Before the first write, the untouched source goes to
`~/.paseo-voice/patches/<name>.original`. Taking a backup over an already-patched file
is a mistake this plugin made once; now the backup is only ever taken from a clean
source. Revert refuses if the stored original is a different size, which means Paseo
has been updated and the backup no longer fits.

**Applying needs a restart.** The daemon already has the old code in memory. The panel
says so when it matters.

## Читать звук сразу

`@getpaseo/server/.../agent/tts-manager.js`

A real bug, reproduced in forty lines with no part of this plugin present.

The TTS manager asks for a sentence, leaves the reply's body unread until the previous
sentence has finished playing, and opens the next request meanwhile. An HTTP client
reclaims a finished-but-unread body to get its connection back, so the body arrives
empty — and empty is indistinguishable from "this sentence is meant to be silent", so
the sentence is dropped without a word in any log.

The symptom is the middle of an answer simply missing: the beginning and the end are
read, and nothing says why.

Draining the body at the moment it arrives removes the window entirely. The same
correction also merges sentences up to the 260-character limit the manager already
defines, which turns a seven-part answer into one or two — each part was its own
request, its own round trip, and its own second of silence.

## Мьют отправляет фразу

`@getpaseo/server/.../session/voice/voice-turn-controller.js`

Pressing mute should end the turn and send what was said. Instead the audio stream
stops, the silence detector never sees the silence it is waiting for, and what was
dictated sits there unsent until something else wakes it.

The detector already has a `flush()` that forces a turn to end. Nothing in the daemon
ever calls it. This adds a watchdog: every 150 ms, if the stream has been quiet for
600 ms while capturing, call `flush()`. Six hundred milliseconds is longer than any
network jitter and shorter than a pause anybody would notice.

The timer is `unref`'d, so it cannot hold the process open.

## Своя музыка ожидания

`app-dist/_expo/static/js/web/index-*.js` — the desktop client's bundle, a plain file
beside the archive rather than inside it.

The first attempt baked the chosen sound directly into the bundle, which meant a 21 MB
rewrite and an app restart for every change of track or volume. That was the wrong
shape and was thrown away.

The source of the cue is already an async `arrayBuffer()`, so it can simply fetch. The
correction makes it ask `http://127.0.0.1:8123/v1/cue` — this plugin's proxy — and fall
back to the bundle's own bytes if that fails. So:

- the choice lives in the plugin, not in the patch
- a new track or volume is heard on the next repeat, with no rebuild and no restart
- the patch is applied once and never again
- with the plugin stopped, the cue is Paseo's original tone rather than silence

It also sets two numbers: the gap between repeats, 350 ms, to zero — it reads as a
stutter once the cue is music — and the 1500 ms wait before the first play down to
250 ms. That wait was added upstream so the cue would not fire in the pauses between
spoken sentences, and the other two corrections here already removed those pauses.

This one is matched by shape rather than by exact text, because the bundle is minified
and its identifiers change between builds.

## The two daemon settings

Separate from the patches, and reachable through configuration rather than code.
**Речь агента** turns both on and calls `paseo reload`, so no restart is needed.

- **`daemon.mcp.injectIntoAgents`** — off by default. Without it the daemon never
  attaches its MCP server to an agent, and `speak` lives inside that server. The
  symptom is a voice mode that transcribes you perfectly and then says nothing at all.
- **`daemon.appendSystemPrompt`** — carries an instruction to speak every user-facing
  sentence, and to keep commands, code and tool output on screen rather than reading
  them out. Editable in the panel.

A hand-written `appendSystemPrompt` is preserved: this plugin's paragraph is appended
after it and removed on its own when switched off.
