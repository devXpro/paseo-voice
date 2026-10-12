import { Buffer } from "node:buffer";
import { randomUUID } from "node:crypto";
import { setTimeout as sleep } from "node:timers/promises";
import { codecAnswer, connectLive, type VoiceCodecChoice } from "./live-daemon.ts";
import type { TestDaemon } from "./test-daemon.ts";
import type { Timeline } from "./timeline.ts";
import { roomTone, synthesize } from "./tts.ts";

/**
 * The phone's dictation, as far as the microphone goes: Paseo's own
 * `DictationStreamSender` from the patched checkout — the code that decides whether to
 * send Opus and packs it — fed the way `use-dictation.ts` feeds it: a stream started,
 * one base64 PCM segment per microphone buffer as it comes, then the final sequence
 * number and the transcript back.
 */

// In a variable, so that TypeScript leaves it alone: it resolves through the harness's
// hooks into the Paseo checkout.
const SENDER = "@/dictation/dictation-stream-sender";
const PCM_FORMAT = "audio/pcm;rate=16000;bits=16";
/** The iOS tap's buffer: 128 ms at 16 kHz. */
const SEGMENT_BYTES = 4096;

type Sender = {
  restartStream(reason: string): Promise<void>;
  enqueueSegment(base64Pcm: string): void;
  getFinalSeq(): number;
  finish(finalSeq: number): Promise<{ dictationId: string; text: string }>;
  dispose(): void;
};

export type Dictation = Awaited<ReturnType<typeof openDictation>>;

export async function openDictation(options: { timeline: Timeline; daemon?: TestDaemon; voiceCodec?: VoiceCodecChoice }) {
  const { timeline } = options;
  const { client } = await connectLive(timeline, options.daemon);
  const answer = codecAnswer(client, options.voiceCodec);
  /** What went up, as sent: base64 characters, per format. */
  const traffic = { chars: 0, formats: new Set<string>(), chunks: 0 };

  // The daemon client as the sender sees it, with two differences: chunks are counted on
  // their way out, and the codec question gets the answer this test chose.
  const seen = new Proxy(client, {
    get(target, property) {
      if (property === "sendDictationStreamChunk") {
        return (dictationId: string, seq: number, audio: string, format: string) => {
          traffic.chars += audio.length;
          traffic.formats.add(format);
          traffic.chunks += 1;
          return target.sendDictationStreamChunk(dictationId, seq, audio, format);
        };
      }
      if (property === "invokePluginRpc") {
        return (plugin: string, method: string, input: unknown) =>
          method === "voice.codec"
            ? answer
              ? answer().then((one) => {
                  timeline.note("phone.codec", one.opus ? "opus" : "pcm");
                  return one;
                })
              : Promise.resolve({ opus: false })
            : target.invokePluginRpc(plugin, method, input);
      }
      const value = Reflect.get(target, property, target);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
  const { DictationStreamSender } = (await import(SENDER)) as {
    DictationStreamSender: new (params: { client: unknown; format: string; createDictationId: () => string }) => Sender;
  };

  return {
    traffic,

    /**
     * Says `text` into a dictation at the speed of speech, then stops and waits for the
     * transcript, as a tap on the tick does. `ms` is how long that wait was.
     */
    async dictate(text: string, options: { voice?: string } = {}): Promise<{ transcript: string; ms: number }> {
      const sender = new DictationStreamSender({ client: seen, format: PCM_FORMAT, createDictationId: randomUUID });
      try {
        await sender.restartStream("start");
        const speech = Buffer.concat([await synthesize(text, options.voice), roomTone(16_000)]);
        timeline.note("person.dictates", text);
        for (let at = 0; at < speech.length; at += SEGMENT_BYTES) {
          sender.enqueueSegment(speech.subarray(at, at + SEGMENT_BYTES).toString("base64"));
          await sleep(128);
        }
        const stopped = timeline.now();
        const { text: transcript } = await sender.finish(sender.getFinalSeq());
        timeline.note("phone.dictation", transcript);
        return { transcript, ms: timeline.now() - stopped };
      } finally {
        sender.dispose();
      }
    },

    async close(): Promise<void> {
      await client.close();
    },
  };
}
