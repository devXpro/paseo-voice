import type { PluginSurfaceProps } from "@getpaseo/plugin/client";
import { useRpc } from "@getpaseo/plugin/client";
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
  refreshCloud,
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
  const keyRpc = useRpc(setKey);
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
  const player = useRef<HTMLAudioElement | null>(null);

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
    if (!AUDIO) {
      toast.error("В мобильном приложении плагину нечем проиграть звук");
      return;
    }
    const target = voice ?? (data?.provider === "google" ? data.cloudVoice : data?.localVoice) ?? "";
    if (listeningTo) {
      return;
    }
    const element = (player.current ??= new AUDIO());
    element.src = `data:audio/wav;base64,${SILENCE}`;
    void element.play().catch(() => {});

    setListeningTo(target || "…");
    void probe({ text: PROBE, ...(voice ? { voice } : {}) })
      .then((result) => {
        if (result.error || !result.wavBase64) {
          toast.error(result.error || "Синтез ничего не вернул");
          return;
        }
        element.src = `data:audio/wav;base64,${result.wavBase64}`;
        return element.play();
      })
      .catch((error: unknown) => toast.error(String(error)))
      .finally(() => setListeningTo(""));
  }

  /** The same gesture-unlock dance as the voices, against the cue renderer. */
  function playCue(cue: string) {
    if (!AUDIO) {
      toast.error("В мобильном приложении плагину нечем проиграть звук");
      return;
    }
    if (listeningTo) {
      return;
    }
    const element = (player.current ??= new AUDIO());
    element.src = `data:audio/wav;base64,${SILENCE}`;
    void element.play().catch(() => {});

    setListeningTo(cue);
    void cuePreviewRpc({ cue })
      .then((result) => {
        if (result.error || !result.wavBase64) {
          toast.error(result.error || "Нечего проигрывать");
          return;
        }
        element.src = `data:audio/wav;base64,${result.wavBase64}`;
        return element.play();
      })
      .catch((error: unknown) => toast.error(String(error)))
      .finally(() => setListeningTo(""));
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
      applyPatch: () => patching.mutate(false),
      revertPatch: () => patching.mutate(true),
      patching: patching.isPending,
      installEngine: () => installing.mutate(),
      installingEngine: installing.isPending,
      apply: () => applying.mutate(),
      applying: applying.isPending,
      listen,
      listeningTo,
      canPlay: AUDIO !== undefined,
      enableSpeech: () => switching.mutate(false),
      disableSpeech: () => switching.mutate(true),
      switching: switching.isPending,
    },
  };

  const wide = !layout.compact;
  const current = SECTIONS.find((section) => section.id === open) ?? (wide ? SECTIONS[0]! : null);

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
          {index}
        </ScrollView>
      );
    }
    return (
      <ScrollView contentContainerStyle={{ padding: 16, paddingBottom: 48 }}>
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
