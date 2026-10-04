#!/usr/bin/env bash
# Fetches Paseo, applies this plugin's corrections and builds the iOS app.
#
# Everything lands in ~/.paseo-voice/ios-build, outside the plugin directory, so
# `paseo plugin remove` does not take a several-gigabyte checkout with it. Run it again
# after an upstream release and it pulls, re-patches and rebuilds.
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
WORK="${PASEO_VOICE_IOS_WORK:-$HOME/.paseo-voice/ios-build}"
CHECKOUT="$WORK/paseo"
TRACK="${1:-}"   # empty = whatever the plugin panel has chosen
REF="${2:-}"

# Which Paseo to build.
#
# Not `main`: the app and the daemon speak a protocol that changes between releases,
# and a client built from a newer tree connects, exchanges hello, waits for something
# the older daemon never sends, and closes itself after ten seconds — which reads as a
# pairing timeout and is not one. So the default is whatever the daemon on this machine
# actually is.
if [ -z "$REF" ]; then
  PASEO_CLI="${PASEO_CLI:-/Applications/Paseo.app/Contents/Resources/bin/paseo}"
  INSTALLED="$("$PASEO_CLI" --version 2>/dev/null | head -1 | tr -d ' v')"
  [ -n "$INSTALLED" ] && REF="v$INSTALLED"
fi

say() { printf '\n\033[1m%s\033[0m\n' "$*"; }
die() { printf '\033[31m%s\033[0m\n' "$*" >&2; exit 1; }

say "1/7  Checking what this machine has"
command -v xcodebuild >/dev/null || die "no Xcode. Install it from the App Store and accept the licence: sudo xcodebuild -license"
command -v pod        >/dev/null || die "no CocoaPods: brew install cocoapods"
command -v git        >/dev/null || die "no git"
# Expo 54 wants Node 22; a newer one fails deep inside Metro with nothing useful said.
NODE_WANT="$( [ -f "$CHECKOUT/.tool-versions" ] && awk '/^nodejs/{print $2}' "$CHECKOUT/.tool-versions" || echo 22.20.0 )"
if command -v mise >/dev/null; then
  eval "$(mise activate bash 2>/dev/null || true)"
  mise use -g "node@$NODE_WANT" >/dev/null 2>&1 || true
fi
NODE_HAVE="$(node -v 2>/dev/null | tr -d v || echo 0)"
[ "${NODE_HAVE%%.*}" = "${NODE_WANT%%.*}" ] || die "need Node ${NODE_WANT}, found ${NODE_HAVE}. Install it: mise use -g node@${NODE_WANT}"
echo "  Xcode $(xcodebuild -version | head -1 | cut -d' ' -f2) · CocoaPods $(pod --version) · Node ${NODE_HAVE}"

say "2/7  Fetching Paseo's source"
mkdir -p "$WORK"
if [ -d "$CHECKOUT/.git" ]; then
  git -C "$CHECKOUT" fetch --tags --depth 1 origin "${REF:-HEAD}"
  git -C "$CHECKOUT" reset --hard FETCH_HEAD
else
  git clone --depth 1 ${REF:+--branch "$REF"} https://github.com/getpaseo/paseo.git "$CHECKOUT"
fi
echo "  ${REF:-main}, commit $(git -C "$CHECKOUT" log -1 --format='%h %s' | cut -c1-60)"
BUILT="$(python3 -c "import json;print(json.load(open('$CHECKOUT/package.json'))['version'])" 2>/dev/null)"
echo "  app version: ${BUILT:-?}   daemon on this machine: ${INSTALLED:-?}"
# Their .mise.toml sets Android paths this build never needs, but an untrusted file
# makes mise warn on every command run inside the checkout.
command -v mise >/dev/null && mise trust "$CHECKOUT" >/dev/null 2>&1 || true

# The team comes from whatever Apple Development certificate is in the keychain, so a
# free Apple ID added in Xcode once is all the setup there is.
# The team is the OU of the *Apple Development* certificate, and nothing else. A
# keychain usually holds several identities — a Developer ID for notarising Mac apps,
# somebody else's from a past job — and picking the first one that matches a prefix is
# how this came out signed by a stranger's team. So: find the identity by its full
# name, then read that certificate.
if [ -z "${DEVELOPMENT_TEAM:-}" ]; then
  IDENTITY="$(security find-identity -v -p codesigning 2>/dev/null \
    | sed -n 's/.*"\(Apple Development: [^"]*\)".*/\1/p' | head -1)"
  [ -n "$IDENTITY" ] || die "no Apple Development certificate in the keychain"
  echo "  certificate: $IDENTITY"
  TEAM="$(security find-certificate -c "$IDENTITY" -p 2>/dev/null \
    | openssl x509 -noout -subject 2>/dev/null | tr ',/' '\n\n' \
    | sed -n 's/ *OU=\([A-Z0-9]*\)/\1/p' | head -1)"
else
  TEAM="$DEVELOPMENT_TEAM"
fi
[ -n "$TEAM" ] || die "could not work out the development team"

# The certificate alone is not enough: Xcode mints the provisioning profile for this
# bundle id, and for that it needs the Apple ID signed in. There is no way to add one
# from a script.
if [ -z "$(ls ~/Library/Developer/Xcode/UserData/Provisioning\ Profiles 2>/dev/null)" ] \
   && [ -z "$(ls ~/Library/MobileDevice/Provisioning\ Profiles 2>/dev/null)" ]; then
  echo "  no profiles yet — Xcode issues one itself, provided an Apple ID is in Settings -> Accounts"
fi
echo "  development team: $TEAM"

say "3/7  Applying the corrections, music: ${TRACK:-the one chosen in the panel}"
DEVELOPMENT_TEAM="$TEAM" node "$HERE/patch-app.mjs" "$CHECKOUT" $TRACK

say "4/7  Installing dependencies (slow the first time)"
( cd "$CHECKOUT" && npm ci --no-audit --no-fund )
( cd "$CHECKOUT" && npm run build:app-deps )

say "5/7  Generating the Xcode project"
# The development variant, always: it carries its own bundle id (sh.paseo.debug) and
# its own name, so this lands beside the App Store Paseo instead of replacing it.
export APP_VARIANT=development
# There is no ios/ directory in the repository: Expo writes it from app.config.js, so a
# clean prebuild is the normal path rather than a reset.
( cd "$CHECKOUT/packages/app" && npx expo prebuild --platform ios --clean )
( cd "$CHECKOUT/packages/app/ios" && pod install )

# Push notifications, dropped unless something says otherwise.
#
# A free Apple ID is a "personal team", and Apple does not issue those a profile for
# an app that declares push — the build fails outright with nothing else wrong. The
# capability is not needed to hear the thing this build exists to change, so it goes.
# With a paid certificate set KEEP_PUSH=1 and it stays.
ENTITLEMENTS="$(find "$CHECKOUT/packages/app/ios" -maxdepth 2 -name '*.entitlements' | head -1)"
if [ -n "$ENTITLEMENTS" ] && [ -z "${KEEP_PUSH:-}" ]; then
  /usr/libexec/PlistBuddy -c "Delete :aps-environment" "$ENTITLEMENTS" 2>/dev/null \
    && echo "  push entitlement removed: a free Apple ID cannot sign it"
fi

WORKSPACE="$(find "$CHECKOUT/packages/app/ios" -maxdepth 1 -name '*.xcworkspace' | head -1)"
[ -n "$WORKSPACE" ] || die "prebuild produced no .xcworkspace"

say "6/7  Building"
# The scheme is named after the variant, so it is read from the workspace rather than
# assumed: the development build is "PaseoDebug", the production one "Paseo".
SCHEME="$(basename "$WORKSPACE" .xcworkspace)"
echo "  scheme: $SCHEME"
DERIVED="$WORK/derived"
# Release, not Debug. A Debug build of an Expo app is a dev client: it ships a launcher
# that asks for a Metro server and loads the JavaScript over the network, so the patched
# code would never be inside it. Release runs the phase that bundles the JS in.
xcodebuild -workspace "$WORKSPACE" -scheme "$SCHEME" -configuration Release \
  -destination "generic/platform=iOS" -derivedDataPath "$DERIVED" \
  -allowProvisioningUpdates DEVELOPMENT_TEAM="$TEAM" \
  build > "$WORK/xcodebuild.log" 2>&1 || true
# Written to a file, then read back. Piping xcodebuild into `head` closes the pipe as
# soon as it has enough lines, and the SIGPIPE that follows kills the build itself —
# which looks exactly like a build failure and is not one.
grep -aE "error:" "$WORK/xcodebuild.log" | sort -u | head -10 || true
# The whole log is kept: xcodebuild reports the real failure in the middle of eight
# thousand lines, and a truncated tail shows only that something went wrong.
grep -aq "BUILD SUCCEEDED" "$WORK/xcodebuild.log" || die "the build failed; details in $WORK/xcodebuild.log"

APP="$(find "$DERIVED/Build/Products/Release-iphoneos" -maxdepth 1 -name '*.app' | head -1)"
[ -n "$APP" ] || die "the build left no .app behind"

say "7/7  Installing on the phone"
# By UUID shape, not by column: the model name has spaces in it and the columns shift.
DEVICE="$(xcrun devicectl list devices 2>/dev/null | grep -i connected \
  | grep -oE '[0-9A-F]{8}-[0-9A-F]{4}-[0-9A-F]{4}-[0-9A-F]{4}-[0-9A-F]{12}' | head -1)"
if [ -n "$DEVICE" ]; then
  xcrun devicectl device install app --device "$DEVICE" "$APP" && echo "  installed on $DEVICE"
else
  echo "  no phone connected; the build is at $APP"
fi

cat <<TEXT

  Built:    $APP
  Project:  $WORKSPACE

  A separate "Paseo Debug" icon appears on the phone; the App Store one is untouched.
  On first launch: Settings -> General -> VPN & Device Management ->
  your Apple ID -> Trust.

  A free Apple ID signs for 7 days; after that, run this script again.

  Once a real certificate exists and an .ipa is wanted for distribution:

    xcodebuild -workspace "$WORKSPACE" -scheme Paseo \\
      -configuration Release -archivePath "$WORK/Paseo.xcarchive" archive
    xcodebuild -exportArchive -archivePath "$WORK/Paseo.xcarchive" \\
      -exportOptionsPlist "$HERE/export-options.plist" -exportPath "$WORK/ipa"

  To change the music, run it again with another track:

    $0 lobby-time
    $0 spy-glass
    $0 samba-isobel
    $0 mining-by-moonlight

TEXT
