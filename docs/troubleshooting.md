# When it does not work

Every one of these was met in practice.

## Voice mode transcribes me perfectly and then says nothing

`daemon.mcp.injectIntoAgents` is off. It is off by default, and `speak` lives inside
the MCP server it withholds. Turn it on in **Речь агента**.

This is the single most common cause and it looks nothing like its reason.

## It reads the beginning and the end of an answer, and skips the middle

Paseo's TTS manager dropping segments. Apply **Читать звук сразу** in **Патч Paseo**
and restart Paseo. [patches.md](patches.md) explains the mechanism.

Nothing appears in any log when this happens — an empty body is indistinguishable from
a sentence meant to be silent, so it is dropped quietly.

## I press mute and nothing is sent

Apply **Голосовой ввод**. Without it the audio stream simply stops, the silence
detector never sees silence, and what you dictated waits.

## The first thing I say is heard, and later ones are not

Typically: a phrase or two work, then one comes out cut short — its beginning missing —
or nothing happens at all, and from then on nothing you say is heard. If you cut into
the agent at that moment, it stops working and never hears why.

Paseo's recogniser was given everything the microphone heard since your last phrase,
and decoded all of it again every 350 ms. A minute of the agent working while you
listen, and the start of your next phrase is lost; a minute and a half, and the speech
worker dies — taking the voice detector with it, which nothing brought back. Apply
**Голосовой ввод**; the details are in [patches.md](patches.md#голосовой-ввод).

Until then, listening with mute on keeps the pile from growing, and switching voice
mode off and on brings back a detector that died.

## The agent stops talking, though it still works

It answers in text, and `speak` calls finish at once with nothing heard — usually after
something you said was not recognised: a cough, a noise, a phrase lost to the bug above.
Your speech aborted its voice, and only a recognised phrase used to lift that. Apply
**Агент не немеет**; until then, say anything it can recognise.

## On mobile internet voice mode crawls, or hears nothing

The phone streams its microphone uncompressed — about 340 kbit/s once it is base64 — and
a weak uplink does not carry it: what is said arrives late, or not at all, and dictation
the same. Apply **Патч Paseo**, restart Paseo, and use an app built with `ios-build/`:
the microphone then goes as Opus, a tenth of it, in voice mode and in dictation. The App
Store app keeps sending PCM. [patches.md](patches.md#голос-с-телефона-в-opus) has how
the phone and the daemon agree on it.

If a phone built with `ios-build/` fails to dictate or is not heard in voice mode, rule
the compression out first: `touch ~/.paseo-voice/opus-off`, and the next dictation goes
as PCM. The daemon log says which way each phone was told — «a phone asked about Opus».

## Long pauses between sentences

Three causes, and they stack.

The local engine synthesises slower than it speaks, so each sentence boundary is a
wait. Switch to Google, which runs about four times faster than real time.

And Paseo splits on every full stop without merging, so each fragment is its own
request and its own round trip. **Читать звук сразу** merges up to the 260-character
limit Paseo already defines.

And each sentence crosses to the phone whole before it plays: uncompressed, a
thirteen-second one waited two seconds on the way. The patch sends it as MP3, a sixth
of that. See [patches.md](patches.md#голос-агента-в-mp3).

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

## On the local engine every sentence fails with «для MP3 нужен lame или ffmpeg»

With the patch in place the daemon asks for the agent's voice as MP3. Google encodes it
itself; the local engine's audio is encoded on this Mac, by `lame` or `ffmpeg`, and with
neither installed nothing can be spoken. `brew install lame` and it speaks again, no
restart needed. A built-in encoder that needs neither is coming in the next release.

## Every sentence sounds like a different person

**Ровный тон**, on the local engine. The engine seeds itself from the clock and Paseo
sends each sentence separately, so each one is a fresh performance. Google does not
have this problem.

## Speech is harsh and gritty on the phone, fine on the desktop

The mobile app downsamples 24 kHz to 16 kHz with no anti-aliasing filter. Turn on
**Чистый звук на телефоне**. [voices.md](voices.md) has the measurements.

This is PCM only. With the patch in place the agent's voice arrives as MP3, which the
phone's own player decodes at its full 24 kHz, and the setting no longer matters.

## The voice list is empty

Look under the key field — the reason from Google is printed there. Usually the
Text-to-Speech API is not enabled on the project, or the key is restricted to other
APIs. [google.md](google.md#when-google-refuses) lists the specific errors.

## «Незнакомая версия Paseo» in Патч Paseo

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

## `build.sh` ends in an error at 7/7 with no phone attached

The build succeeded — `BUILD SUCCEEDED` is in `~/.paseo-voice/ios-build/xcodebuild.log`,
and the app is under `~/.paseo-voice/ios-build/derived/Build/Products/Release-iphoneos/`.
Only the last step failed: it looks for a connected phone and stops on finding none. A
phone already paired with Xcode takes the app over the network:

```sh
xcrun devicectl list devices
xcrun devicectl device install app --device <UDID> <path to PaseoDebug.app>
```

## The music is a twenty-second loop instead of the whole track

The app was built before the cue cap was raised. Run `ios-build/build.sh` again; it is
60 seconds now.

On the desktop there is no cap, and a change of track or volume takes effect on the
next repeat with no rebuild at all.

## A shipped track stays marked «скачать» and will not play

Its download failed. Press ▶ on it — that fetches it too — or reload the plugin, which
fetches whatever is currently chosen.

The reason is in the daemon log; it is deliberately not raised as an error card,
because with no network the right outcome is Paseo's own tone rather than a complaint:

```sh
grep -a '"pluginId":"voice"' ~/.paseo/daemon.log | grep -i 'не скачалось'
```

## A track plays at the wrong volume after I change it

On the desktop it should not: the volume is read on every repeat. On the phone the
level is compiled in, so it needs a rebuild.

## «Собрать из моих переписок» finds hardly any words

It reads what you typed and dictated to Claude Code, from `projects/` under each Claude
config directory: `~/.claude`, and the one `CLAUDE_CONFIG_DIR` names — which is usually
set for your shell and not for the plugin, since Paseo starts it. List any other config
directories in `~/.paseo-voice/claude-dirs`, one per line.

## Nothing in the panel reacts

Check the daemon log rather than the screen — the error card in the interface is
sticky and can survive a fix:

```sh
grep -a '"pluginId":"voice"' ~/.paseo/daemon.log | tail -5
```
