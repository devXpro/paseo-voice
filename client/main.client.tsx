import type { PluginSurfaceProps } from "@getpaseo/plugin/client";
import { useRpc } from "@getpaseo/plugin/client";
import * as hostNative from "@getpaseo/plugin/client/react-native";
import { Icon, ScrollView, useToast } from "@getpaseo/plugin/client/react-native";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import React, { useRef, useState } from "react";
import { ActivityIndicator, Pressable, Text, View } from "react-native";
import {
  applyPatch,
  applyToPaseo,
  disableSpeech,
  enableSpeech,
  getStatus,
  installBinary,
  type modelId,
  preview,
  fetchRecogniserModel,
  forgetRecogniserModel,
  installRecogniser,
  mineDictionary,
  refreshCloud,
  setDictionary,
  setRecogniserModel,
  wireDictation,
  restartProxy,
  revertPatch,
  setActiveModel,
  setCloudVoice,
  setLocalVoice,
  previewCue,
  setCue,
  setCueVolume,
  setPhoneSafe,
  setKey,
  setPrompt,
  setProvider,
  setRate,
  setSteady,
} from "../shared/voice.shared.ts";
import type { Lab } from "./lab.client.tsx";
import { SECTIONS } from "./sections.client.tsx";
import { type SectionId, summarise } from "./summary.ts";

const QUERY_KEY = ["voice", "status"];

/** One short line, so auditioning a voice never costs more than a few characters. */
const PROBE = "Проверка связи. Слышно меня?";

/** A 44-byte WAV with no samples, used only to buy the right to play later. */
const SILENCE = "UklGRiQAAABXQVZFZm10IBAAAAABAAEAQB8AAIA+AAACABAAZGF0YQAAAAA=";

/**
 * Whether this client can make a sound at all.
 *
 * The desktop surface is a browser and has `Audio`. The phone is React Native on
 * Hermes, and the host hands plugin bundles react, react-native, zod and react-query —
 * no audio among them, and none in the plugin API either. Rather than send somebody
 * out of the app to a system player, the buttons simply say they cannot.
 */
const AUDIO: { new (src?: string): HTMLAudioElement } | undefined = (
  globalThis as unknown as { Audio?: { new (src?: string): HTMLAudioElement } }
).Audio;

/**
 * The phone's own audio engine, when the app it is running in was built to lend it.
 *
 * Nothing in the plugin API makes a sound, so on an unpatched app this is undefined
 * and the buttons stay hidden rather than offering something that cannot happen. A
 * patched build publishes the engine that plays the waiting music, and it is the same
 * engine, so what is auditioned here is exactly what will be heard later.
 *
 * `play` resolves when the sound finishes — which is what lets the row stay lit for
 * the real duration instead of a moment.
 */
type NativeAudio = {
  play(source: { arrayBuffer(): Promise<ArrayBuffer>; size: number; type: string }): Promise<number>;
  stop(): void;
  clearQueue(): void;
};
const NATIVE: NativeAudio | undefined = (hostNative as { audioEngine?: NativeAudio }).audioEngine;

const B64 = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";

/** Decoded by hand: `atob` is a browser thing and `Buffer` is not handed to plugins. */
function bytesOf(base64: string): Uint8Array {
  const clean = base64.replace(/=+$/, "");
  const out = new Uint8Array((clean.length * 3) >> 2);
  let bits = 0;
  let held = 0;
  let at = 0;
  for (const character of clean) {
    const value = B64.indexOf(character);
    if (value < 0) {
      continue;
    }
    held = (held << 6) | value;
    bits += 6;
    if (bits >= 8) {
      bits -= 8;
      out[at++] = (held >> bits) & 0xff;
    }
  }
  return out.subarray(0, at);
}

/**
 * The samples out of a WAV, and the rate they were recorded at.
 *
 * The engine takes raw PCM and reads the rate off the mime type, while both preview
 * calls answer with a WAV because that is what a browser can play from a data URL.
 * Reading the header here keeps one reply good for both surfaces — the alternative
 * was a second shape over the wire for the sake of forty-four bytes.
 */
function pcmFromWav(base64: string): { pcm: Uint8Array; rate: number } {
  const bytes = bytesOf(base64);
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let rate = 24000;
  // Chunks, rather than a fixed offset: a WAV may carry others before `data`.
  let at = 12;
  while (at + 8 <= bytes.byteLength) {
    const id = String.fromCharCode(bytes[at]!, bytes[at + 1]!, bytes[at + 2]!, bytes[at + 3]!);
    const size = view.getUint32(at + 4, true);
    const body = at + 8;
    if (id === "fmt ") {
      rate = view.getUint32(body + 4, true);
    } else if (id === "data") {
      return { pcm: bytes.subarray(body, Math.min(body + size, bytes.byteLength)), rate };
    }
    at = body + size + (size & 1);
  }
  return { pcm: bytes, rate };
}

/** Below this the two-column layout has no room for both; above, it reads like a settings app. */
const WIDE_ENOUGH = 720;

export function VoiceSurface({ theme, layout }: PluginSurfaceProps) {
  const fetchStatus = useRpc(getStatus);
  const install = useRpc(installBinary);
  const providerRpc = useRpc(setProvider);
  const cloudVoiceRpc = useRpc(setCloudVoice);
  const localVoiceRpc = useRpc(setLocalVoice);
  const modelRpc = useRpc(setActiveModel);
  const rateRpc = useRpc(setRate);
  const steadyRpc = useRpc(setSteady);
  const phoneSafeRpc = useRpc(setPhoneSafe);
  const cueRpc = useRpc(setCue);
  const cueVolumeRpc = useRpc(setCueVolume);
  const cuePreviewRpc = useRpc(previewCue);
  const refreshRpc = useRpc(refreshCloud);
  const restartProxyRpc = useRpc(restartProxy);
  const keyRpc = useRpc(setKey);
  const installRecogniserRpc = useRpc(installRecogniser);
  const fetchModelRpc = useRpc(fetchRecogniserModel);
  const forgetModelRpc = useRpc(forgetRecogniserModel);
  const chooseModelRpc = useRpc(setRecogniserModel);
  const wireDictationRpc = useRpc(wireDictation);
  const dictionaryRpc = useRpc(setDictionary);
  const mineRpc = useRpc(mineDictionary);
  const promptRpc = useRpc(setPrompt);
  const applyPatchRpc = useRpc(applyPatch);
  const revertPatchRpc = useRpc(revertPatch);
  const wire = useRpc(applyToPaseo);
  const probe = useRpc(preview);
  const enableRpc = useRpc(enableSpeech);
  const disableRpc = useRpc(disableSpeech);
  const toast = useToast();
  const queryClient = useQueryClient();

  // On a phone this is the whole navigation: null is the index, anything else is a page
  // with a back button. On a wide screen it is which pane is selected, and never null.
  const [open, setOpen] = useState<SectionId | null>(null);
  const [listeningTo, setListeningTo] = useState("");
  const [listeningState, setListeningState] = useState<"" | "loading" | "playing">("");
  const player = useRef<HTMLAudioElement | null>(null);
  // Bumped on every start and on every stop. A reply from a round trip that is no
  // longer the current one has to be dropped, or an audition somebody cancelled comes
  // back to life a second later when its bytes arrive.
  const token = useRef(0);

  /** Silences whatever is playing and forgets it. Safe to call when nothing is. */
  function hush(): void {
    token.current += 1;
    const element = player.current;
    if (element) {
      element.pause();
      // Freeing the data URL as well: these are megabytes and the element keeps them.
      element.removeAttribute("src");
      element.load();
    }
    if (NATIVE) {
      NATIVE.stop();
      // The engine queues, so stopping the sound is not enough on its own: anything
      // waiting behind it would start the moment this one is cut.
      NATIVE.clearQueue();
    }
    setListeningTo("");
    setListeningState("");
  }

  /** Twenty seconds on a phone, all of it on a desktop. See the RPC for why. */
  const cueCapSeconds = AUDIO ? 0 : 20;

  /**
   * The browser element, started on silence inside the tap so it is allowed to make a
   * sound later. Null on a phone, where there is no element and no such rule — the
   * native engine plays whenever it is asked.
   */
  function unlocked(): HTMLAudioElement | null {
    if (!AUDIO) {
      return null;
    }
    const element = (player.current ??= new AUDIO());
    element.src = `data:audio/wav;base64,${SILENCE}`;
    void element.play().catch(() => {});
    return element;
  }

  const { data, isLoading } = useQuery({
    queryKey: QUERY_KEY,
    queryFn: () => fetchStatus({}),
    refetchInterval: 5000,
  });

  // Every mutation answers with the whole status, so the cache is seeded from the reply
  // rather than invalidated — the surface never shows a stale value for a frame.
  const seed = (next: unknown) => queryClient.setQueryData(QUERY_KEY, next);
  const fail = (error: unknown) => toast.error(String(error));
  const run = (promise: Promise<unknown>) => void promise.then(seed).catch(fail);

  const installing = useMutation({ mutationFn: () => install({}), onSuccess: seed, onError: fail });
  const applying = useMutation({ mutationFn: () => wire({}), onSuccess: seed, onError: fail });
  const savingPrompt = useMutation({
    mutationFn: (text: string) => promptRpc({ text }),
    onSuccess: seed,
    onError: fail,
  });
  // Google is asked to confirm the key before it is kept, so this one waits on a
  // round trip to Google and back rather than on a file being written.
  const restarting = useMutation({ mutationFn: () => restartProxyRpc({}), onSuccess: seed, onError: fail });
  const savingKey = useMutation({
    mutationFn: (key: string) => keyRpc({ key }),
    onSuccess: seed,
    onError: fail,
  });
  const patching = useMutation({
    mutationFn: (undo: boolean) => (undo ? revertPatchRpc({}) : applyPatchRpc({})),
    onSuccess: seed,
    onError: fail,
  });
  const switching = useMutation({
    mutationFn: (off: boolean) => (off ? disableRpc({}) : enableRpc({})),
    onSuccess: seed,
    onError: fail,
  });

  /**
   * Auditioning a voice, with the permission problem handled.
   *
   * A browser refuses `play()` unless the call sits inside a user gesture, and the
   * bytes here come from a round trip that outlives it. So the element is created and
   * started on silence synchronously in the tap, which grants it permission; when the
   * audio arrives it is only a change of `src`. Without this the phone-sized browsers
   * silently refuse, which is what used to push the old build out to a system player.
   */
  function listen(voice?: string) {
    // Both surfaces, or neither. Checking only the browser here while the button was
    // shown for either is what made a patched phone offer a play it then refused.
    if (!AUDIO && !NATIVE) {
      toast.error("Это приложение не даёт плагину проигрывать звук");
      return;
    }
    const target = voice ?? (data?.provider === "google" ? data.cloudVoice : data?.localVoice) ?? "";
    // Pressing the row that is already sounding means stop; pressing another one means
    // swap, which is the same stop followed by a start.
    const wasThis = listeningTo === (target || "…");
    hush();
    if (wasThis) {
      return;
    }
    const mine = token.current;
    const element = unlocked();

    setListeningTo(target || "…");
    setListeningState("loading");
    void probe({ text: PROBE, ...(voice ? { voice } : {}) })
      .then((result) => {
        if (token.current !== mine) {
          return;
        }
        if (result.error || !result.wavBase64) {
          toast.error(result.error || "Синтез ничего не вернул");
          hush();
          return;
        }
        return start(element, result.wavBase64, mine);
      })
      .catch((error: unknown) => {
        if (token.current === mine) {
          toast.error(String(error));
          hush();
        }
      });
  }

  /**
   * Plays the bytes and holds the row lit until they actually finish.
   *
   * `play()` settles when playback *begins*, so clearing the state from its `finally`
   * — which is what this used to do — put the row back to a resting arrow a moment
   * after the sound started, with minutes of audio still to come and no way to stop
   * it. The end is `ended`, and nothing else.
   */
  function start(element: HTMLAudioElement | null, wavBase64: string, mine: number): Promise<void> {
    setListeningState("playing");

    if (!element) {
      // The phone. Its engine wants raw samples and reads the rate off the type, and
      // its `play` resolves when the sound ends — so the row stays lit for the real
      // duration and clears itself without an `ended` listener.
      const { pcm, rate } = pcmFromWav(wavBase64);
      const source = {
        size: pcm.byteLength,
        type: `audio/pcm;rate=${rate};bits=16`,
        arrayBuffer: async () => (pcm.buffer as ArrayBuffer).slice(pcm.byteOffset, pcm.byteOffset + pcm.byteLength),
      };
      return NATIVE!.play(source)
        .then(() => {
          if (token.current === mine) {
            hush();
          }
        })
        .catch((error: unknown) => {
          if (token.current === mine) {
            toast.error(String(error));
            hush();
          }
        });
    }

    element.onended = () => {
      if (token.current === mine) {
        hush();
      }
    };
    element.src = `data:audio/wav;base64,${wavBase64}`;
    return element.play().catch((error: unknown) => {
      if (token.current === mine) {
        toast.error(String(error));
        hush();
      }
    });
  }

  /** The same gesture-unlock dance as the voices, against the cue renderer. */
  function playCue(cue: string) {
    // Both surfaces, or neither. Checking only the browser here while the button was
    // shown for either is what made a patched phone offer a play it then refused.
    if (!AUDIO && !NATIVE) {
      toast.error("Это приложение не даёт плагину проигрывать звук");
      return;
    }
    const wasThis = listeningTo === cue;
    hush();
    if (wasThis) {
      return;
    }
    const mine = token.current;
    const element = unlocked();

    setListeningTo(cue);
    setListeningState("loading");
    void cuePreviewRpc({ cue, capSeconds: cueCapSeconds })
      .then((result) => {
        if (token.current !== mine) {
          return;
        }
        if (result.error || !result.wavBase64) {
          toast.error(result.error || "Нечего проигрывать");
          hush();
          return;
        }
        return start(element, result.wavBase64, mine);
      })
      .catch((error: unknown) => {
        if (token.current === mine) {
          toast.error(String(error));
          hush();
        }
      });
  }

  if (isLoading || !data) {
    return (
      <View style={{ flex: 1, alignItems: "center", justifyContent: "center" }}>
        <ActivityIndicator />
      </View>
    );
  }

  const lab: Lab = {
    data,
    theme,
    compact: layout.compact,
    platform: layout.platform,
    busy: false,
    act: {
      setProvider: (provider) => run(providerRpc({ provider })),
      chooseCloudVoice: (voice) => run(cloudVoiceRpc({ voice })),
      chooseLocalVoice: (voice) => run(localVoiceRpc({ voice })),
      chooseModel: (id) => run(modelRpc({ id: id as (typeof modelId)["_output"] })),
      setRate: (rate) => run(rateRpc({ rate })),
      setSteady: (steady) => run(steadyRpc({ steady })),
      setPhoneSafe: (phoneSafe) => run(phoneSafeRpc({ phoneSafe })),
      chooseCue: (cue) => run(cueRpc({ cue })),
      setCueVolume: (volume) => run(cueVolumeRpc({ volume })),
      playCue,
      refreshCloud: () => run(refreshRpc({})),
      setPrompt: (text) => savingPrompt.mutate(text),
      savingPrompt: savingPrompt.isPending,
      setKey: (key) => savingKey.mutate(key),
      savingKey: savingKey.isPending,
      // All of these answer with the whole status, including whatever is in progress,
      // so the panel needs no state of its own for a download that outlives a render.
      installRecogniser: () => run(installRecogniserRpc({})),
      fetchRecogniserModel: (id) => run(fetchModelRpc({ id })),
      forgetRecogniserModel: (id) => run(forgetModelRpc({ id })),
      setRecogniserModel: (id) => run(chooseModelRpc({ id })),
      wireDictation: (on) => run(wireDictationRpc({ on })),
      setDictionary: (text) => run(dictionaryRpc({ text })),
      mineDictionary: () => run(mineRpc({})),
      applyPatch: () => patching.mutate(false),
      revertPatch: () => patching.mutate(true),
      patching: patching.isPending,
      installEngine: () => installing.mutate(),
      installingEngine: installing.isPending,
      apply: () => applying.mutate(),
      applying: applying.isPending,
      listen,
      listeningTo,
      listeningState,
      canPlay: AUDIO !== undefined || NATIVE !== undefined,
      enableSpeech: () => switching.mutate(false),
      disableSpeech: () => switching.mutate(true),
      switching: switching.isPending,
    },
  };

  const wide = !layout.compact;
  const current = SECTIONS.find((section) => section.id === open) ?? (wide ? SECTIONS[0]! : null);

  /**
   * Shown above everything when the local server is down.
   *
   * Nothing else in the panel would say so: every section keeps rendering its settings
   * and the plugin still reports itself as running, while speech has silently stopped
   * because the one port it all goes through was never bound. This is the only place
   * that failure becomes visible without reading a log.
   */
  const alarm =
    data.proxy.listening ? null : (
      <View
        style={{
          backgroundColor: theme.colors.surface1,
          borderColor: theme.colors.statusWarning,
          borderWidth: 1,
          borderRadius: 14,
          padding: 14,
          marginBottom: 12,
          gap: 8,
        }}
      >
        <Text style={{ color: theme.colors.statusWarning, fontSize: 15, fontWeight: "600" }}>
          Речь не работает: порт {data.proxy.port} не занят плагином
        </Text>
        <Text style={{ color: theme.colors.foregroundMuted, fontSize: 13, lineHeight: 18 }}>
          {data.proxy.error
            ? `Не удалось встать на порт: ${data.proxy.error}`
            : "Локальный сервер не поднялся."}{" "}
          Обычно это проходит само за пару секунд, и плагин полминуты пробует снова. Если
          дошло до этого сообщения — порт держит кто-то посторонний.
        </Text>
        <Pressable
          onPress={() => restarting.mutate()}
          disabled={restarting.isPending}
          style={({ pressed }) => ({
            alignSelf: "flex-start",
            paddingVertical: 8,
            paddingHorizontal: 14,
            borderRadius: 8,
            opacity: restarting.isPending ? 0.4 : pressed ? 0.7 : 1,
            backgroundColor: theme.colors.accent,
          })}
        >
          <Text style={{ color: theme.colors.accentForeground, fontSize: 14, fontWeight: "600" }}>
            {restarting.isPending ? "Поднимаю…" : "Поднять заново"}
          </Text>
        </Pressable>
      </View>
    );

  /** The index: every section with its state on the right, readable without opening anything. */
  const index = (
    <View
      style={{
        backgroundColor: theme.colors.surface1,
        borderColor: theme.colors.border,
        borderWidth: 1,
        borderRadius: 14,
        overflow: "hidden",
      }}
    >
      {SECTIONS.map((section, position) => {
        const summary = summarise(section.id, data);
        const selected = wide && current?.id === section.id;
        const colour =
          summary.tone === "ok"
            ? theme.colors.statusSuccess
            : summary.tone === "warn"
              ? theme.colors.statusWarning
              : theme.colors.foregroundMuted;
        return (
          <Pressable
            key={section.id}
            onPress={() => setOpen(section.id)}
            style={({ pressed }) => ({
              backgroundColor: selected ? theme.colors.surface2 : pressed ? theme.colors.surface2 : "transparent",
            })}
          >
            <View
              style={{
                flexDirection: "row",
                alignItems: "center",
                gap: 12,
                paddingVertical: 13,
                paddingHorizontal: 14,
                borderBottomWidth: position === SECTIONS.length - 1 ? 0 : 1,
                borderBottomColor: theme.colors.border,
              }}
            >
              <Icon name={section.icon} size={18} color={theme.colors.foregroundMuted} />
              <Text style={{ color: theme.colors.foreground, fontSize: 15, flex: 1 }}>{section.title}</Text>
              <Text style={{ color: colour, fontSize: 13 }} numberOfLines={1}>
                {summary.text}
              </Text>
              {!wide && <Text style={{ color: theme.colors.foregroundMuted, fontSize: 18 }}>›</Text>}
            </View>
          </Pressable>
        );
      })}
    </View>
  );

  // A phone gets one thing at a time: the index, or a page with a way back. Anything
  // else means scrolling past four sections to reach the fifth, which is what this
  // layout replaced.
  if (!wide) {
    if (!current) {
      return (
        <ScrollView contentContainerStyle={{ padding: 16, paddingBottom: 48 }}>
          {alarm}
          {index}
        </ScrollView>
      );
    }
    return (
      <ScrollView contentContainerStyle={{ padding: 16, paddingBottom: 48 }}>
        {alarm}
        <Pressable onPress={() => setOpen(null)} style={{ marginBottom: 14 }}>
          <View style={{ flexDirection: "row", alignItems: "center", gap: 6 }}>
            <Text style={{ color: theme.colors.accent, fontSize: 17 }}>‹</Text>
            <Text style={{ color: theme.colors.accent, fontSize: 15 }}>Всё</Text>
          </View>
        </Pressable>
        <Text style={{ color: theme.colors.foreground, fontSize: 22, fontWeight: "700", marginBottom: 16 }}>
          {current.title}
        </Text>
        {current.Component(lab)}
      </ScrollView>
    );
  }

  return (
    <View style={{ flex: 1, flexDirection: "row" }}>
      <ScrollView
        style={{ width: 268, borderRightWidth: 1, borderRightColor: theme.colors.border }}
        contentContainerStyle={{ padding: 16 }}
      >
        <Text style={{ color: theme.colors.foreground, fontSize: 19, fontWeight: "700", marginBottom: 14 }}>Голос</Text>
        {alarm}
        {index}
      </ScrollView>
      <ScrollView style={{ flex: 1 }} contentContainerStyle={{ padding: 24, paddingBottom: 48, maxWidth: WIDE_ENOUGH }}>
        <Text style={{ color: theme.colors.foreground, fontSize: 22, fontWeight: "700", marginBottom: 18 }}>
          {current?.title}
        </Text>
        {current?.Component(lab)}
      </ScrollView>
    </View>
  );
}
