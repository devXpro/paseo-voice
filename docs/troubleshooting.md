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

Apply **Мьют отправляет фразу**. Without it the audio stream simply stops, the silence
detector never sees silence, and what you dictated waits.

## Long pauses between sentences

Two causes, and they stack.

The local engine synthesises slower than it speaks, so each sentence boundary is a
wait. Switch to Google, which runs about four times faster than real time.

And Paseo splits on every full stop without merging, so each fragment is its own
request and its own round trip. **Читать звук сразу** merges up to the 260-character
limit Paseo already defines.

## Every sentence sounds like a different person

**Ровный тон**, on the local engine. The engine seeds itself from the clock and Paseo
sends each sentence separately, so each one is a fresh performance. Google does not
have this problem.

## Speech is harsh and gritty on the phone, fine on the desktop

The mobile app downsamples 24 kHz to 16 kHz with no anti-aliasing filter. Turn on
**Чистый звук на телефоне**. [voices.md](voices.md) has the measurements.

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

A free Apple ID signs for seven days. Run `ios-build/build.sh` again.

## The music is a twenty-second loop instead of the whole track

The app was built before the cue cap was raised. Run `ios-build/build.sh` again; it is
60 seconds now.

On the desktop there is no cap, and a change of track or volume takes effect on the
next repeat with no rebuild at all.

## A track plays at the wrong volume after I change it

On the desktop it should not: the volume is read on every repeat. On the phone the
level is compiled in, so it needs a rebuild.

## Nothing in the panel reacts

Check the daemon log rather than the screen — the error card in the interface is
sticky and can survive a fix:

```sh
grep -a '"pluginId":"voice"' ~/.paseo/daemon.log | tail -5
```
