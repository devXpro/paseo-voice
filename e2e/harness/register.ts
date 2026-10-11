import { register } from "node:module";
import { currentNativeAudio } from "./native-audio.ts";
import { appSrc, requireSource } from "./paseo-source.ts";

/**
 * Loaded with `--import` ahead of every scenario: puts the patched Paseo checkout into
 * Node's module resolution, and gives the phone's audio engine its native module.
 */

requireSource();
register("./hooks.ts", import.meta.url, { data: { appSrc } });

// `audio-engine.native.ts` reaches its native module through a bare `require`. In an ES
// module that name is looked up on the global object, which is where the stand-in waits.
Object.assign(globalThis, {
  require(id: string): unknown {
    if (id === "@getpaseo/expo-two-way-audio") {
      return currentNativeAudio();
    }
    throw new Error(`the harness has no stand-in for ${id}`);
  },
});
