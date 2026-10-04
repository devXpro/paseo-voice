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
