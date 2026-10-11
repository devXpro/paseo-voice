# What is changed inside Paseo

One patch, written into Paseo's own code: **Патч Paseo** applies all of it with one
button and reverts all of it with the same one, and lists what it changes in plain words.
Underneath it is a correction per file, each checked and kept on its own — that is what
the sections below describe.

They exist because there is no seam for them: bugs with no setting behind them, the
audio Paseo sends both ways uncompressed, and a sound with no setting behind it.
Everything this plugin could do through the published plugin API, it does through the
published plugin API.

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

**A correction already in place is checked, not assumed.** Every patched file carries
the marker `paseo-voice:`, but the marker only says that some version of a correction is
in there. So a patched file counts as current only if it is exactly what the correction
makes now of the original kept beside it (below). When a plugin update changes a
correction, the two differ, and it is made again from that original — through every
check a clean file goes through, the `verified` hash included. A patched file with no
original beside it is refused: there is nothing to make it again from, and nothing to
tell whether it is current.

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

## Голосовой ввод

`@getpaseo/server/.../session/voice/voice-turn-controller.js`

Three bugs in the part of the daemon that listens. One file, so one correction: the
archive keeps one original per file.

**Mute sends the phrase.** Pressing mute should end the turn and send what was said.
Instead the audio stream stops, the silence detector never sees the silence it is
waiting for, and what was dictated sits there unsent until something else wakes it.

The detector already has a `flush()` that forces a turn to end. Nothing in the daemon
ever calls it. This adds a watchdog: every 150 ms, if the stream has been quiet for
600 ms while capturing, call `flush()`. Six hundred milliseconds is longer than any
network jitter and shorter than a pause anybody would notice. The timer is `unref`'d,
so it cannot hold the process open.

**The recogniser hears phrases, not the room.** The phone's microphone stays open for as
long as voice mode is on and mute is off, and the daemon handed every chunk of it to the
recogniser. The local Parakeet session keeps all of it until a phrase is committed, and
decodes the whole of it again every 350 ms — so everything between two phrases piled
up there: the agent thinking, the agent talking, the person listening. Measured live:

| Since the previous phrase | What became of the next one |
|---|---|
| 25 s | heard |
| 53 s | the start lost: «Тогда запусти пинг… девяносто раз» arrived as «90 раз» |
| 85 s | the speech worker died (SIGTRAP inside onnxruntime); ten seconds later, an empty transcript |

Now the recogniser is given a phrase only, from the moment the detector confirms it,
together with the three seconds before. The detector confirms speech after 800 ms of it
unbroken, and a short first word with a pause after it — «Так, …», «Слушай, …», «Стоп,
хватит» — breaks that count: the phrase is confirmed only on the next word, over two
seconds in. Kept for two seconds, «Стоп» was lost; three cover it. Between phrases
nothing is decoded at all.

What it still cannot do is a single phrase longer than about fifty seconds with no
second-long pause in it — that is the recogniser's own limit, and the detector ends a
phrase at every pause of a second.

**A detector that dies is replaced.** The voice-activity detector lives in the same
speech worker as the recogniser. When the worker died, the recogniser was reconnected
and the detector never was: its session went with the old worker, every chunk after that
went nowhere, and voice mode heard nothing more until it was switched off and on. Now a
new detector takes its place, and a phrase the old one was in the middle of is closed,
since its end would never be heard.

## Голосовая сессия

`@getpaseo/server/.../session/voice/voice-session.js`

Two things in one file, so one correction.

**The agent does not go mute.** Speech that cuts into the agent aborts whatever is
playing. The abort was lifted only when a transcript with words in it arrived. A turn
that ended empty — a cough, a noise the detector took for speech, a phrase lost to a
crash — left it standing, and every reply the agent spoke after that was dropped in
0 ms: no audio sent, no error, the agent sure it had said it. Until a phrase was
recognised again, which after a crash, with the detector gone, never happened.

The abort is now lifted whenever the person's turn is over, whatever came of it. The log
line the correction follows — `Speech turn complete (…) – resuming TTS` — has always
said exactly that.

This one and the last two in [Голосовой ввод](#голосовой-ввод) were reproduced with the
live harness before they were corrected, and `e2e/live/listening.live.ts` keeps them
reproduced: it fails on a Paseo without the corrections. See [e2e.md](e2e.md).

**Speech from the phone is taken as Opus** — see [below](#голос-с-телефона-в-opus).

## Диктовка в Opus

`@getpaseo/server/.../dictation/dictation-stream-manager.js`

The same for dictation: a chunk that arrives as Opus becomes the PCM the stream was
started with, before anything else sees it — and a chunk that arrives twice is decoded
once, since Opus carries state from packet to packet. See
[below](#голос-с-телефона-в-opus).

## Голос агента в MP3

`@getpaseo/server/.../speech/providers/openai/config.js`

The agent's voice used to reach the phone as raw 24 kHz PCM, 48 KB for every second of
speech, one message per sentence — and the phone starts a sentence only once it holds
all of it. Measured on a phone: 0.8 s on the way for five and a half seconds of speech,
2 s for thirteen, on top of the synthesis. That is most of the wait between the text
appearing and the voice starting, and the whole of the pause between two sentences.

Paseo's speech client already knows MP3, and both clients already play it — the phone
through its file player, the desktop through Web Audio — but the daemon's config asks for
`pcm` and nothing else. The correction asks for `mp3`, and this plugin's proxy answers:
Google encodes MP3 itself, at 64 kbit/s — a sixth of the PCM, with no setting for
less — and the local engine's PCM is encoded by `lame`, or `ffmpeg`, whichever is there.
With neither, it goes as PCM: see [below](#локальный-движок-без-mp3).
Google returns MP3 no slower than PCM: 358 ms against 439 for 117 characters, 694
against 722 for 235.

The loss is audible only up close: on the phone's speaker nothing, in good headphones a
slight smear on sibilants. `PASEO_VOICE_TTS_FORMAT=pcm` in the daemon's environment
brings PCM back, which is how the tests compare the two.

## Локальный движок без MP3

`@getpaseo/server/.../speech/providers/openai/tts.js`

The daemon tells its clients each sentence's format from its own config, not from what
came back — so once it asks for MP3, everything is labelled MP3. The local engine's audio
is made into MP3 on this Mac, and on a Mac with neither `lame` nor `ffmpeg` the proxy had
nothing to answer with but an error: every sentence of the local engine was silent. 0.8.0
shipped with that.

Now each sentence is labelled by the reply's `content-type`, and the daemon says so in a
request header, `x-paseo-voice-format: from-response`. A proxy that sees it answers the
local engine's sentence as the PCM it already is, uncompressed as before 0.8.0, rather
than not at all; one that does not — a daemon not yet restarted onto the correction —
still gets the error, since it would tell the phone the PCM was MP3, and the phone would
play nothing. Google is untouched: it makes the MP3 itself, and the label stays `mp3`.
`brew install lame` makes the local engine's voice MP3 too.

The header is the only thing added to the request. A real OpenAI endpoint ignores headers
it does not know, and would refuse a body parameter it does not know.

## Голос с телефона в Opus

The other direction. While voice mode is on and unmuted, and for the whole of a
dictation, the phone streams its microphone to the daemon: 16 kHz PCM, 32 KB a second,
about 340 kbit/s once it is base64. A weak mobile uplink does not carry that, and then
what is said arrives late or not at all.

The patched phone sends Opus at 24 kbit/s instead: a tenth, measured end to end at
3 KB a second against 36–42. iOS encodes it itself, so nothing is linked into the app;
see [ios.md](ios.md#the-corrections-it-applies).

**Only to a daemon that can decode it.** Before every voice session and every dictation
the phone asks this plugin (`voice.codec`), and the answer is yes only when both
corrections that decode Opus are in the archive, the daemon running now was started
after they were written, and the decoder is in place. An App Store build never asks and
sends PCM; a patched build talking to an unpatched daemon is told no and sends PCM.

**One decoder, in one place.** The daemon cannot import from this plugin — the plugin
is bundled and runs in a process of its own — so the decoding lives in a module this
plugin writes to `~/.paseo-voice/codec/opus.mjs`, and both corrections only load it and
call `decodeOpusChunk`, one decoder per stream: a voice session, a dictation. The tests
decode with the same call.

**The decoder is fetched, not shipped.** It is `opus-decoder` 0.7.12 (MIT, Ethan
Halsall), libopus compiled to WebAssembly inside it (BSD-3-Clause, Xiph.Org): fetched
once from the npm registry on the plugin's first start, like the engine and the music,
and checked twice — the tarball against the registry's own sha512, and the file inside
against the sha256 of the one the tests ran. Without a network on that start the phone
is told no, and the next start fetches it.

**The wire format** is this plugin's own: each chunk is 20 ms Opus packets, each
prefixed with its length as a little-endian u16, under
`audio/opus;rate=16000;framing=u16le`. A chunk under one packet goes empty in dictation,
so that every sequence number arrives, and is not sent at all in voice mode.

**Switched off by hand** with an empty file, `~/.paseo-voice/opus-off`: the plugin
answers no, and every phone sends PCM from its next voice session or dictation — no
restart, no rebuild. The way out when a phone's build gets the encoding wrong.

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

- **The archive files** are written only if their sha256 is on the correction's
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
