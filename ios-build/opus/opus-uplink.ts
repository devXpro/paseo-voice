/**
 * paseo-voice: the microphone, compressed on its way to the daemon — one module for voice
 * mode and dictation alike.
 *
 * 16 kHz PCM is about 340 kbit/s on the wire once it is base64, more than a weak mobile
 * uplink carries. Opus at 24 kbit/s is a tenth of it, encoded by iOS itself through the
 * native module's `encodeOpus`. It goes only to a daemon that can decode it: this plugin
 * says so, and it says yes only when its corrections that decode Opus are loaded in the
 * daemon running now. Anything short of that — the web, no plugin, an older one, an
 * encoder that fails — and the microphone goes as PCM, the way upstream sends it.
 *
 * Written into Paseo's app by `ios-build/patch-app.mjs` as `src/audio/opus-uplink.ts`.
 */

export const PCM_FORMAT = "audio/pcm;rate=16000;bits=16";
/** 20 ms Opus packets, each prefixed with its length as a little-endian u16. */
export const OPUS_FORMAT = "audio/opus;rate=16000;framing=u16le";

/** One encoder per stream, in the native module: the two never share Opus state. */
export type OpusStream = "voice" | "dictation";

type NativeOpus = {
  encodeOpus(stream: string, pcm: Uint8Array): Uint8Array | null;
  resetOpusEncoder(stream: string): void;
};

/**
 * Expo hands a typed array to native code by its constructor's name, looked up among the
 * standard ones: a `Buffer` — a `Uint8Array` subclass, which is what dictation holds —
 * throws "unordered_map::at: key not found". So the bytes cross as a plain view.
 */
function plain(bytes: Uint8Array): Uint8Array {
  return bytes.constructor === Uint8Array ? bytes : new Uint8Array(bytes.buffer, bytes.byteOffset, bytes.byteLength);
}

/** The native module's encoder where there is one; on the web there is none. */
function nativeOpus(): NativeOpus | null {
  try {
    const native = require("@getpaseo/expo-two-way-audio") as Partial<NativeOpus>;
    return typeof native.encodeOpus === "function" && typeof native.resetOpusEncoder === "function"
      ? (native as NativeOpus)
      : null;
  } catch {
    return null;
  }
}

type PluginClient = {
  invokePluginRpc?(plugin: string, method: string, input: unknown): Promise<unknown>;
};

/** Whether the daemon takes the microphone as Opus. Only this plugin can say. */
export async function daemonTakesOpus(client: PluginClient | null | undefined): Promise<boolean> {
  if (!client?.invokePluginRpc) {
    return false;
  }
  try {
    const answer = (await client.invokePluginRpc("voice", "voice.codec", {})) as { opus?: boolean } | null;
    return answer?.opus === true;
  } catch {
    return false;
  }
}

/**
 * One stream of the microphone. `reset` starts it — afresh on both ends, since the daemon
 * gives every stream a decoder of its own — and says whether it goes as Opus. `pack`
 * turns PCM into what to send: Opus packets, possibly none yet while less than 20 ms has
 * built up, or the PCM itself — and PCM for the rest of the stream if encoding fails.
 */
export function createOpusUplink(stream: OpusStream) {
  let opus = false;
  return {
    get opus(): boolean {
      return opus;
    },

    reset(useOpus: boolean): void {
      const native = nativeOpus();
      try {
        native?.resetOpusEncoder(stream);
        opus = useOpus && native !== null;
      } catch {
        opus = false;
      }
    },

    // Any failure of the encoder, thrown or returned, is PCM from here on: the microphone
    // must never stop because compressing it did not work.
    pack(pcm: Uint8Array): { audio: Uint8Array; format: string } {
      if (opus) {
        let packed: Uint8Array | null = null;
        try {
          packed = nativeOpus()?.encodeOpus(stream, plain(pcm)) ?? null;
        } catch {
          packed = null;
        }
        if (packed !== null) {
          return { audio: packed, format: OPUS_FORMAT };
        }
        opus = false;
      }
      return { audio: pcm, format: PCM_FORMAT };
    },
  };
}
