import { existsSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";

/**
 * The Paseo tree under test: the checkout `ios-build/build.sh` patched for the phone, so
 * the client code exercised here is exactly the code the phone runs. It is imported from
 * there and never copied in — Paseo is not MIT-licensed, and this repository is.
 */
export const paseoSource = process.env.PASEO_SRC || path.join(homedir(), ".paseo-voice", "ios-build", "paseo");

/** The app's own `src`, which its `@/` imports are relative to. */
export const appSrc = path.join(paseoSource, "packages", "app", "src");

/**
 * The native audio engine, wherever this version keeps it: Paseo 0.11 moved it out of
 * `voice/` into a shared `audio/` and rebuilt its queue.
 */
export const engineSpecifier = existsSync(path.join(appSrc, "audio", "audio-engine.native.ts"))
  ? "@/audio/audio-engine.native"
  : "@/voice/audio-engine.native";

export function requireSource(): void {
  if (!existsSync(path.join(appSrc, "voice", "voice-runtime.ts"))) {
    throw new Error(`no patched Paseo checkout at ${paseoSource}: run ios-build/build.sh once, or point PASEO_SRC at one`);
  }
}
