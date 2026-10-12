# Building Paseo's iOS app

`ios-build/build.sh` fetches Paseo's source, applies this plugin's corrections, builds
the app and installs it on a connected iPhone.

This exists for one reason: **the waiting cue on a phone is compiled into the app.**
There are no over-the-air updates (`expo-updates` is not a dependency), the bundle is
sealed by its signature and encrypted by the App Store, and nothing on the device can
write into it. Changing that sound means building the app. Everything the desktop gets
through a patch, the phone gets through a build.

The result installs **beside** the App Store app, as a separate "Paseo Debug" icon.
The store one is untouched.

## Running it

```sh
./build.sh                        # the track chosen in the panel, matching your daemon
./build.sh lobby-time             # a specific track
./build.sh lobby-time v0.11.0     # and a specific Paseo tag
```

Twenty to thirty minutes the first time; the checkout and the pods are reused after
that. The script's output is in English; the panel it builds is in Russian.

## Which version it builds

**Whatever your daemon is**, by default — read from `paseo --version`.

Not `main`. The app and the daemon speak a protocol that changes between releases, and
a client built from a newer tree connects, exchanges `hello`, waits for something the
older daemon never sends, and closes itself after ten seconds. That reads as a pairing
timeout and is not one. The script prints both versions after checking out, so a
mismatch is visible before the build rather than after the install.

A patch release whose protocol has not changed can be built ahead of the daemon by
naming its tag — `./build.sh "" v0.11.2` against a 0.11.1 daemon, where the only
change was in the app itself. Compare the two tags' `packages/protocol` and
`packages/server` before relying on that.

**Before a build, the end-to-end tests** run the same patched tree the build will
compile — see [e2e.md](e2e.md#trying-a-fix-before-it-ships).

## The seven steps

1. **Checks the machine** — Xcode, CocoaPods, git, and Node 22. Expo 54 fails on
   anything newer, deep inside Metro and with nothing useful in the error. `mise` is
   used to switch if it is installed.
2. **Fetches `getpaseo/paseo`** into `~/.paseo-voice/ios-build/paseo`, at the tag
   above. Outside the plugin directory, so `paseo plugin remove` does not take a
   several-gigabyte checkout with it.
3. **Applies the corrections** (below).
4. **Installs dependencies.**
5. **Runs `expo prebuild`.** There is no `ios/` directory in the repository — Expo
   writes one from `app.config.js` — so this is the normal path, not a reset of
   something.
6. **Builds**, `-configuration Release`. Debug produces a dev client that looks for a
   Metro server and shows "No development servers found" on a phone.
7. **Installs** on a connected device with `xcrun devicectl`, if one is there.

## The corrections it applies

- **The waiting sound.** `packages/app/src/utils/thinking-tone.native-pcm.ts` is a
  generated module holding the cue as base64 PCM, so it is rewritten whole rather than
  picked at. Capped at 60 seconds.
- **The gap between repeats**, 350 ms, set to zero — a gap reads as a stutter once the
  cue is music rather than a single ding.
- **The silence before the first play**, 1500 ms, cut to 250 ms.
- **The cue holds back while the agent speaks.** A spoken reply comes as separate
  sentences, each sent once the phone confirms the one before, and the runtime saw only
  the pauses — so the cue played between sentences, and again after the last one while
  the model closed its turn. `speak` is a tool call whose `running` and `completed`
  already reach the phone; the session context now passes them to the runtime, which
  keeps the cue out while a call is in flight and for three seconds after the last one
  ends. Music while the agent thinks, and only then — `e2e/` proves both halves.
- **The microphone goes up as Opus**, in voice mode and in dictation. 16 kHz PCM is
  about 340 kbit/s on the wire once it is base64 — more than a weak mobile uplink carries,
  and then nothing said gets through, or it crawls. Opus at 24 kbit/s is a tenth of it,
  and iOS encodes it itself through AudioToolbox, so nothing is linked into the app.
  One module does it for both modes, `src/audio/opus-uplink.ts`, copied in from
  `ios-build/opus/` with the encoder, `VoiceOpusEncoder.swift`, which goes into the
  native module beside the audio engine. Before every voice session and every dictation
  the phone asks this plugin whether the daemon can decode Opus, and the plugin says yes
  only when its corrections that do it are loaded in the daemon running now; otherwise
  — the web, no plugin, an older one, an unpatched daemon, an encoder that fails — the
  microphone goes as PCM, as upstream sends it. See
  [patches.md](patches.md#the-phones-voice-in-opus).
- **The test pinning the old tone's length** is skipped, or it fails the build.
- **The bundle identifier** becomes `sh.paseo.debug.<team>`. Plain `sh.paseo.debug` is
  already registered to Paseo's own team and cannot be claimed.

Each is a string replacement that refuses when its anchor is missing or appears twice.
After an upstream release, run it again: it will either apply or say exactly which
correction no longer fits.

## Signing

The script finds your Apple Development certificate and reads the team from it. You
need an Apple ID added in **Xcode → Settings → Accounts** first; everything else is
automatic.

A **free Apple ID** works and signs for **seven days**. After that the app refuses to
launch and the script has to be run again. A paid certificate makes it permanent and
exportable.

Xcode reuses the profile it issued last until it expires, so a build made on day six is
signed with one that has a day left: installing it the next day fails with «This
provisioning profile has expired», and so does launching the copy already on the phone.
Run the build again; with the Apple ID signed in, `-allowProvisioningUpdates` gets a new
profile. Without one it stops at «No Accounts».

Push notifications are removed from the entitlements, because a personal team cannot
sign them. Set `KEEP_PUSH=1` to keep them if you have a real team.

On first launch the phone will not trust the certificate:
**Settings → General → VPN & Device Management → your Apple ID → Trust.**

## Making an .ipa to hand to somebody

With a real certificate:

```sh
xcodebuild -workspace ~/.paseo-voice/ios-build/paseo/packages/app/ios/PaseoDebug.xcworkspace \
  -scheme Paseo -configuration Release \
  -archivePath ~/.paseo-voice/ios-build/Paseo.xcarchive archive

xcodebuild -exportArchive -archivePath ~/.paseo-voice/ios-build/Paseo.xcarchive \
  -exportOptionsPlist ios-build/export-options.plist \
  -exportPath ~/.paseo-voice/ios-build/ipa
```

**Check the music licence before you distribute anything.** A track you dropped into
`~/.paseo-voice/music/` is compiled into that `.ipa`. Build with one of the four CC BY
tracks instead — `./build.sh lobby-time` — unless you hold the rights to what you used.

## Later, when updating an .ipa in place

Replacing the cue in a signed `.ipa` without a full rebuild means unzip, replace,
re-sign, install. The JS is Hermes bytecode and the cue lives in its string table, so
the replacement has to be exactly as long as the original.
