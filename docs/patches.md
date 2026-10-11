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

**The original is kept first.** Before every write, the untouched source goes to
`~/.paseo-voice/patches/<name>.original`, replacing whatever was there. Writing only
ever happens onto a clean source, so the backup is always the original of the version
being patched. Keeping the first backup ever taken was the old rule, and after an
update it left the previous version's file behind for a revert to write into the new
archive. Revert still refuses if the stored original is a different size.

**It will not write into an archive Electron checks.** Electron can verify every file
it reads from `app.asar` against hashes in the header — the
`EnableEmbeddedAsarIntegrityValidation` fuse. Paseo ships with it off, which is the
only reason an in-place patch works. The fuse is read from Electron's framework binary
before every write; with it on, a patched file would stop Paseo from launching at all.

**A bundle that does not parse is not written.** The result is compiled, not run,
before it replaces the original: a broken bundle is a desktop client that will not
start.

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
spoken sentences. Those pauses are still there — the daemon sends the next sentence
only once the client confirms the last — so on the desktop the cue can sound briefly
between sentences. The phone build closes that properly, by holding the cue back for
as long as a `speak` call is in flight (see [ios.md](ios.md)); the desktop is next.

This one is matched by shape rather than by exact text, because the bundle is minified
and its identifiers change between builds.

## Put back after every update

Paseo updates itself, and an update replaces the files these corrections live in. So
on every start of the plugin — and every update ends in one — whatever is missing is
put back, each correction on its own:

- **The two archive files** are written only if their sha256 is on the correction's
  `verified` list in `server/patches.server.ts` — the upstream versions it was reviewed
  against. Anchors alone are not enough for this. They only see the lines being
  replaced, while the replacements lean on names around them: rename
  `MAX_TTS_SEGMENT_CHARS` or `runSerial` upstream and every anchor still matches, the
  patch lands, and the daemon throws at the first sentence.
- **The bundle** cannot have such a list, since every build renames and rehashes it.
  Its shape is the check, plus the parse above.
- **Nothing goes into the archive** while the integrity fuse is on.

It only does this if the last thing done by hand was **Наложить**. A fresh install
patches nothing unasked, and a revert stays a revert across updates.

**Then the daemon is restarted**, since it already holds the old code — but only a
young one. Under two minutes old, it was just started by the update or by a launch, and
nothing is running yet for a restart to cut off. An older daemon is somebody's working
session (a plugin reload after a review, say), so it is left alone and the
notification asks for a restart instead. At most one automatic restart per Paseo
version, so corrections that somehow do not stick cannot turn into a loop. Only the
daemon restarts: the window keeps the bundle it loaded at launch, so on the desktop the
waiting music comes back with the next launch of the app.

Whatever it will not write is left as it was and reported: in the panel, beside the
correction; in a macOS notification, once per new thing to say; and in the daemon log.
A changed archive file is also copied beside its backup as `<name>.pending`, so the
review is one command:

```sh
diff -u ~/.paseo-voice/patches/tts-manager.js.original ~/.paseo-voice/patches/tts-manager.js.pending
```

If the correction still holds, add the new hash to `verified`. If the anchors moved,
rewrite the splices first. Then `paseo plugin reload voice`, and the next start puts it
in — or press **Наложить**, which goes by the anchors and trusts you about the rest.

`npm test` says the same thing sooner: one test checks the installed Paseo against the
`verified` lists and names the hash to add.

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
