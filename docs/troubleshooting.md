# When it does not work

Every one of these was met in practice.

## Voice mode transcribes me perfectly and then says nothing

`daemon.mcp.injectIntoAgents` is off. It is off by default, and `speak` lives inside
the MCP server it withholds. Turn it on in **Agent speech**.

This is the single most common cause and it looks nothing like its reason.

## It reads the beginning and the end of an answer, and skips the middle

Paseo's TTS manager dropping segments. Apply **Read the sound at once** in **Paseo patch**
and restart Paseo. [patches.md](patches.md) explains the mechanism.

Nothing appears in any log when this happens — an empty body is indistinguishable from
a sentence meant to be silent, so it is dropped quietly.

## I press mute and nothing is sent

Apply **Voice input**. Without it the audio stream simply stops, the silence
detector never sees silence, and what you dictated waits.

## The first thing I say is heard, and later ones are not

Typically: a phrase or two work, then one comes out cut short — its beginning missing —
or nothing happens at all, and from then on nothing you say is heard. If you cut into
the agent at that moment, it stops working and never hears why.

Paseo's recogniser was given everything the microphone heard since your last phrase,
and decoded all of it again every 350 ms. A minute of the agent working while you
listen, and the start of your next phrase is lost; a minute and a half, and the speech
worker dies — taking the voice detector with it, which nothing brought back. Apply
**Voice input**; the details are in [patches.md](patches.md#voice-input).

Until then, listening with mute on keeps the pile from growing, and switching voice
mode off and on brings back a detector that died.

## The agent stops talking, though it still works

It answers in text, and `speak` calls finish at once with nothing heard — usually after
something you said was not recognised: a cough, a noise, a phrase lost to the bug above.
Your speech aborted its voice, and only a recognised phrase used to lift that. Apply
**Voice session**; until then, say anything it can recognise.

## I cut in, and the agent talks on to the end of its sentence

On the phone, with the agent's voice as MP3: the daemon hears you and stops sending the
rest of the answer, the waiting music goes quiet, but the segment already playing goes on
— up to a quarter of a minute. The phone played it through the system player and stopped
it with a call that, on iOS, does not stop it. Rebuild the app with `ios-build/build.sh`;
the correction **Stopping the agent's voice stops it** is in
[ios.md](ios.md#the-corrections-it-applies). The App Store app has the same flaw and
cannot be rebuilt: there it goes away only with the agent's voice back as PCM —
`PASEO_VOICE_TTS_FORMAT=pcm` in the daemon's environment, see
[patches.md](patches.md#the-agents-voice-in-mp3).

## On mobile internet voice mode crawls, or hears nothing

The phone streams its microphone uncompressed — about 340 kbit/s once it is base64 — and
a weak uplink does not carry it: what is said arrives late, or not at all, and dictation
the same. Apply **Paseo patch**, restart Paseo, and use an app built with `ios-build/`:
the microphone then goes as Opus, a tenth of it, in voice mode and in dictation. The App
Store app keeps sending PCM. [patches.md](patches.md#the-phones-voice-in-opus) has how
the phone and the daemon agree on it.

If a phone built with `ios-build/` fails to dictate or is not heard in voice mode, rule
the compression out first: `touch ~/.paseo-voice/opus-off`, and the next dictation goes
as PCM. The daemon log says which way each phone was told — «a phone asked about Opus».

## Long pauses between sentences

Three causes, and they stack.

The local engine synthesises slower than it speaks, so each sentence boundary is a
wait. Switch to Google, which runs about four times faster than real time.

And Paseo splits on every full stop without merging, so each fragment is its own
request and its own round trip. **Read the sound at once** merges up to the 260-character
limit Paseo already defines.

And each sentence crosses to the phone whole before it plays: uncompressed, a
thirteen-second one waited two seconds on the way. The patch sends it as MP3, a sixth
of that. See [patches.md](patches.md#the-agents-voice-in-mp3).

## An answer stops halfway, and music plays where the rest should be

A phone app built on Paseo 0.10 with this plugin's corrections. Its audio engine played
a cue that had been stopped while its bytes were still on their way — over the sentence
that came next, whose end it then lost track of — so that sentence was never confirmed
and the daemon waited for it with no limit. Paseo 0.11 rebuilt the engine and the bug
is gone with it: rebuild the app with `ios-build/build.sh` on 0.11 or later.
`npm run e2e:live` reproduced it on 0.10, and shows it gone; see [e2e.md](e2e.md).

## The music comes in between sentences, or after the last one

On the phone, an app built before the correction that holds the cue back while the
agent speaks — rebuild it. On the desktop it is still so: the desktop correction
shortens the wait before the cue, and holding it back for a whole `speak` call is, so
far, the phone build's alone. See [ios.md](ios.md#the-corrections-it-applies).

## On the local engine every sentence fails with “MP3 needs lame or ffmpeg”

With the patch in place the daemon asks for the agent's voice as MP3. Google encodes it
itself; the local engine's audio is encoded on this Mac, by `lame` or `ffmpeg`. With
neither, the local engine's sentences go as PCM instead — but only from a daemon started
after the correction **Local engine without MP3** was written: restart Paseo. Until then
nothing can be spoken; 0.8.0 had no way round it at all. `brew install lame` makes the
voice MP3, with no restart. See [patches.md](patches.md#local-engine-without-mp3).

## Every sentence sounds like a different person

**Steady tone**, on the local engine. The engine seeds itself from the clock and Paseo
sends each sentence separately, so each one is a fresh performance. Google does not
have this problem.

## Speech is harsh and gritty on the phone, fine on the desktop

The mobile app downsamples 24 kHz to 16 kHz with no anti-aliasing filter. Turn on
**Clean sound on the phone**. [voices.md](voices.md) has the measurements.

This is PCM only. With the patch in place the agent's voice arrives as MP3, which the
phone's own player decodes at its full 24 kHz, and the setting no longer matters.

## The voice list is empty

Look under the key field — the reason from Google is printed there. Usually the
Text-to-Speech API is not enabled on the project, or the key is restricted to other
APIs. [google.md](google.md#when-google-refuses) lists the specific errors.

## The agent answers in another language than the one chosen

The language under **Language** picks the voice and what dictation listens for; it does
not tell the agent what to say. An agent answers in the language it is spoken to,
unless its instructions say otherwise — and a CLAUDE.md that says "always answer in
German" wins over a Spanish question every time. Then the Spanish voice reads German
text. Change the instruction, or choose the language the agent actually speaks.

## Ukrainian is silent on the local engine

Qwen3-TTS knows ten languages and Ukrainian is not one of them. Choosing Ukrainian
switches the provider to Google when there is a key; without one, **Language** and
**Voice** both say so, and the daemon's log carries "the local engine cannot speak
Ukrainian" for every sentence. Add a Google key, or choose another language for the
local engine.

## Dictation comes back in English after another language

Whisper was given the sentences before as context, and it follows their language over
the one it is told: after one English sentence, Spanish, French, German and Russian all
came back translated into English. The plugin starts `whisper-server` with
`--no-context`, so each sentence is heard on its own. A recogniser that still does this
is not one the plugin started — see what holds the port, and whether it has the flag:

```sh
ps -o args= -p "$(lsof -tiTCP:8125 -sTCP:LISTEN)"
```

Without it, it is one left behind; the next entry replaces it.

## Dictation is on, and every dictated sentence fails

The panel says the engine is not running while a `whisper-server` still holds port 8125,
and the proxy refuses what it has nowhere to send: «the plugin's recogniser is not
running». The plugin has lost track of the process. Up to 0.8.1 saving the dictionary
could do this: the process being replaced ended after its successor had started, and its
exit cleared the books for both. Since 0.9.0 a restart waits for the old process to let
go of the port, and a later change — of the language, say — overtakes an earlier one
instead of starting beside it.

One left behind — by an older version, or by a daemon that was killed outright — holds
the port until it is stopped:

```sh
lsof -nP -iTCP:8125 -sTCP:LISTEN      # the one holding the port
kill <pid>
/Applications/Paseo.app/Contents/Resources/bin/paseo plugin reload voice
```

The daemon's log then says `voice: whisper on 127.0.0.1:8125`.

## “A version of Paseo this patch does not know” in Paseo patch

Paseo was updated and the code these corrections anchor to has changed shape. That is
the version check working: a half-applied patch would be worse.

Nothing is broken — the plugin still speaks. The corrections stay unavailable until
the anchors are updated.

## Revert says the stored original is a different size

Paseo was updated after the patch was applied. The kept original belongs to the old
version and writing it back would corrupt the archive, so it refuses. Reinstall Paseo
to get a clean copy.

## The corrections were not put back after a Paseo update

The panel says why, beside each correction, and a macOS notification said it once.
Usually the update changed a file a correction goes into, and it is left alone until
somebody looks: `diff -u` the original kept in `~/.paseo-voice/patches/` against the
`.pending` copy beside it, then add the hash or rewrite the correction —
[patches.md](patches.md#put-back-after-every-update) has the procedure.

A correction reverted by hand is never put back: the last thing done by hand wins.

## The phone pairs and then drops out after about ten seconds

A version mismatch between the app and the daemon, not a network problem. The client
completes `hello`, waits for something the older daemon never sends, and closes
itself — which reads as a pairing timeout.

Check both: `paseo --version` on the machine, and the app's own version. If you built
the app yourself, `ios-build/build.sh` matches the daemon by default. See
[ios.md](ios.md#which-version-it-builds).

## The app I built shows "No development servers found"

It was built as Debug, which produces a dev client that looks for a Metro server.
`build.sh` uses `-configuration Release`; if you built by hand in Xcode, pick Release.

## The app stopped launching after a week

A free Apple ID signs for seven days. Run `ios-build/build.sh` again. Installing a
build fails the same way — «This provisioning profile has expired» — when Xcode reused
a profile that ran out after the build; see [ios.md](ios.md#signing).

## The app I built closes the moment it opens

It was built with Xcode 27 by a `build.sh` older than 0.10.1. The crash report on the
phone — Settings → Privacy & Security → Analytics & Improvements → Analytics Data,
`PaseoDebug-…` — says `EXC_BREAKPOINT` in
`_UIApplicationEvaluateRuntimeIssueForNoSceneLifecycleAdoption`: iOS 27's SDK will not
start an app that has not adopted scenes, and Paseo has not yet. Update the plugin and
run the build again; see [ios.md](ios.md#xcode-27).

## The build stops on «The iOS deployment target 'IPHONEOS_DEPLOYMENT_TARGET' is set to …»

The rest of the line reads «…but the range of supported deployment target versions is
15.0 to 27.1.x», for SDWebImage, RNSVG or AsyncStorage: Xcode 27 with a `build.sh` older
than 0.10.1. Update the plugin and run it again; see [ios.md](ios.md#xcode-27).

## `build.sh` finds no phone at 7/7

The build succeeded — `BUILD SUCCEEDED` is in `~/.paseo-voice/ios-build/xcodebuild.log`,
and the app is under `~/.paseo-voice/ios-build/derived/Build/Products/Release-iphoneos/`.
Only the last step had nowhere to put it: it installs on a phone `devicectl` calls
"connected", and says «no phone connected» when there is none. Before 0.10.2 it ended
in an error there instead, without a word. A phone already paired with Xcode takes the
app over the network:

```sh
xcrun devicectl list devices
xcrun devicectl device install app --device <UDID> <path to PaseoDebug.app>
```

## The music is a twenty-second loop instead of the whole track

The app was built before the cue cap was raised. Run `ios-build/build.sh` again; it is
60 seconds now.

On the desktop there is no cap, and a change of track or volume takes effect on the
next repeat with no rebuild at all.

## A shipped track stays marked “download” and will not play

Its download failed. Press ▶ on it — that fetches it too — or reload the plugin, which
fetches whatever is currently chosen.

The reason is in the daemon log; it is deliberately not raised as an error card,
because with no network the right outcome is Paseo's own tone rather than a complaint:

```sh
grep -a '"pluginId":"voice"' ~/.paseo/daemon.log | grep -i 'not downloaded'
```

## A track plays at the wrong volume after I change it

On the desktop it should not: the volume is read on every repeat. On the phone the
level is compiled in, so it needs a rebuild.

## “Build from my conversations” finds hardly any words

It reads what you typed and dictated to Claude Code, from `projects/` under each Claude
config directory: `~/.claude`, and the one `CLAUDE_CONFIG_DIR` names — which is usually
set for your shell and not for the plugin, since Paseo starts it. List any other config
directories in `~/.paseo-voice/claude-dirs`, one per line.

In a language it has no list of ordinary words for, it is meant to find few: only what
cannot be ordinary speech counts — names, code-shaped words and words in another script.
So far Russian is the one with such a list. Add the rest by hand.

## Nothing in the panel reacts

Check the daemon log rather than the screen — the error card in the interface is
sticky and can survive a fix:

```sh
grep -a '"pluginId":"voice"' ~/.paseo/daemon.log | tail -5
```
