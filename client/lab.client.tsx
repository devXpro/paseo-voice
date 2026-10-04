import type { PluginTheme } from "@getpaseo/plugin";
import React from "react";
import { Pressable, Text, View } from "react-native";
import { TextInput } from "@getpaseo/plugin/client/react-native";
import type { z } from "zod";
import type { status } from "../shared/voice.shared.ts";

export type Status = z.output<typeof status>;

/**
 * Everything a section needs, in one object rather than a dozen props. The mutations are
 * created once in the surface and handed down already bound, so a section stays a
 * rendering of state and never has to know about the query cache.
 */
export type Lab = {
  data: Status;
  theme: PluginTheme;
  compact: boolean;
  /** "web" on the desktop client, "ios" or "android" on a phone. */
  platform: string;
  busy: boolean;
  act: {
    setProvider(provider: "google" | "local"): void;
    chooseCloudVoice(voice: string): void;
    chooseLocalVoice(voice: string): void;
    chooseModel(id: string): void;
    setRate(rate: number): void;
    setSteady(steady: boolean): void;
    setPhoneSafe(phoneSafe: boolean): void;
    chooseCue(cue: string): void;
    setCueVolume(volume: number): void;
    /** Auditions a waiting cue; same spinner rules as the voices. */
    playCue(cue: string): void;
    refreshCloud(): void;
    /** Keeps a Google key, or forgets it when handed an empty string. */
    setKey(key: string): void;
    savingKey: boolean;
    setPrompt(text: string): void;
    savingPrompt: boolean;
    applyPatch(): void;
    revertPatch(): void;
    patching: boolean;
    installEngine(): void;
    installingEngine: boolean;
    apply(): void;
    applying: boolean;
    /** Auditions one voice. `undefined` means whichever is currently chosen. */
    listen(voice?: string): void;
    /** The voice being rendered right now, so only its own row shows a spinner. */
    listeningTo: string;
    /** False on a phone: React Native has no audio, and neither does the plugin API. */
    canPlay: boolean;
    enableSpeech(): void;
    disableSpeech(): void;
    switching: boolean;
  };
};

export function gigabytes(bytes: number): string {
  return `${(bytes / 1_000_000_000).toFixed(2)} ГБ`;
}

/** A grouped block of rows, the way a settings app stacks them under a quiet heading. */
export function Group({
  theme,
  title,
  footer,
  children,
}: {
  theme: PluginTheme;
  title?: string;
  footer?: string;
  children: React.ReactNode;
}) {
  return (
    <View style={{ marginBottom: 22 }}>
      {title ? (
        <Text
          style={{
            color: theme.colors.foregroundMuted,
            fontSize: 12,
            fontWeight: "600",
            letterSpacing: 0.6,
            textTransform: "uppercase",
            marginBottom: 8,
            marginLeft: 4,
          }}
        >
          {title}
        </Text>
      ) : null}
      <View
        style={{
          backgroundColor: theme.colors.surface1,
          borderColor: theme.colors.border,
          borderWidth: 1,
          borderRadius: 14,
          overflow: "hidden",
        }}
      >
        {children}
      </View>
      {footer ? (
        <Text style={{ color: theme.colors.foregroundMuted, fontSize: 12, lineHeight: 17, marginTop: 8, marginLeft: 4 }}>
          {footer}
        </Text>
      ) : null}
    </View>
  );
}

/**
 * One line in a group. `value` sits on the right the way a settings app shows the current
 * choice, so the whole screen can be read down the right edge without opening anything.
 */
export function Row({
  theme,
  label,
  hint,
  value,
  valueColour,
  chevron,
  action,
  onPress,
  disabled,
  last,
}: {
  theme: PluginTheme;
  label: string;
  hint?: string;
  value?: string;
  valueColour?: string;
  chevron?: boolean;
  action?: string;
  onPress?: () => void;
  disabled?: boolean;
  last?: boolean;
}) {
  const pressable = Boolean(onPress) && !disabled;
  const body = (
    <View
      style={{
        flexDirection: "row",
        alignItems: "center",
        paddingVertical: 13,
        paddingHorizontal: 14,
        gap: 12,
        borderBottomWidth: last ? 0 : 1,
        borderBottomColor: theme.colors.border,
        opacity: disabled ? 0.45 : 1,
      }}
    >
      <View style={{ flex: 1, gap: 3 }}>
        <Text style={{ color: theme.colors.foreground, fontSize: 15 }}>{label}</Text>
        {hint ? (
          <Text style={{ color: theme.colors.foregroundMuted, fontSize: 12, lineHeight: 16 }}>{hint}</Text>
        ) : null}
      </View>
      {value ? (
        <Text style={{ color: valueColour ?? theme.colors.foregroundMuted, fontSize: 13, maxWidth: 150 }} numberOfLines={1}>
          {value}
        </Text>
      ) : null}
      {action ? (
        <Text style={{ color: theme.colors.accent, fontSize: 14, fontWeight: "600" }}>{action}</Text>
      ) : null}
      {chevron ? <Text style={{ color: theme.colors.foregroundMuted, fontSize: 18 }}>›</Text> : null}
    </View>
  );
  return pressable ? (
    <Pressable onPress={onPress} style={({ pressed }) => ({ backgroundColor: pressed ? theme.colors.surface2 : "transparent" })}>
      {body}
    </Pressable>
  ) : (
    body
  );
}

/** A row whose right side is a list of choices rather than a single value. */
export function ChoiceRow<Value extends string>({
  theme,
  label,
  hint,
  value,
  options,
  onChange,
  last,
}: {
  theme: PluginTheme;
  label: string;
  hint?: string;
  value: Value;
  options: readonly { label: string; value: Value; detail?: string }[];
  onChange(value: Value): void;
  last?: boolean;
}) {
  return (
    <View
      style={{
        paddingVertical: 13,
        paddingHorizontal: 14,
        gap: 10,
        borderBottomWidth: last ? 0 : 1,
        borderBottomColor: theme.colors.border,
      }}
    >
      <View style={{ gap: 3 }}>
        <Text style={{ color: theme.colors.foreground, fontSize: 15 }}>{label}</Text>
        {hint ? <Text style={{ color: theme.colors.foregroundMuted, fontSize: 12, lineHeight: 16 }}>{hint}</Text> : null}
      </View>
      <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 8 }}>
        {options.map((option) => {
          const active = option.value === value;
          return (
            <Pressable
              key={option.value}
              onPress={() => onChange(option.value)}
              style={{
                paddingVertical: 7,
                paddingHorizontal: 12,
                borderRadius: 9,
                borderWidth: 1,
                borderColor: active ? theme.colors.accent : theme.colors.border,
                backgroundColor: active ? theme.colors.accent : theme.colors.surface2,
              }}
            >
              <Text
                style={{
                  color: active ? theme.colors.accentForeground : theme.colors.foreground,
                  fontSize: 13,
                  fontWeight: active ? "600" : "400",
                }}
              >
                {option.label}
              </Text>
              {option.detail ? (
                <Text
                  style={{
                    color: active ? theme.colors.accentForeground : theme.colors.foregroundMuted,
                    fontSize: 11,
                    marginTop: 1,
                    opacity: active ? 0.85 : 1,
                  }}
                >
                  {option.detail}
                </Text>
              ) : null}
            </Pressable>
          );
        })}
      </View>
    </View>
  );
}

/** A bar rather than a percentage alone: four gigabytes is a long time to read numbers. */
export function Progress({ theme, done, total }: { theme: PluginTheme; done: number; total: number }) {
  const ratio = total > 0 ? Math.min(1, done / total) : 0;
  return (
    <View style={{ height: 6, borderRadius: 3, backgroundColor: theme.colors.surface2, overflow: "hidden" }}>
      <View style={{ width: `${ratio * 100}%`, height: "100%", backgroundColor: theme.colors.accent }} />
    </View>
  );
}

export function Switch({
  theme,
  label,
  hint,
  value,
  onChange,
  last,
}: {
  theme: PluginTheme;
  label: string;
  hint?: string;
  value: boolean;
  onChange(next: boolean): void;
  last?: boolean;
}) {
  return (
    <Pressable
      onPress={() => onChange(!value)}
      style={({ pressed }) => ({ backgroundColor: pressed ? theme.colors.surface2 : "transparent" })}
    >
      <View
        style={{
          flexDirection: "row",
          alignItems: "center",
          paddingVertical: 13,
          paddingHorizontal: 14,
          gap: 12,
          borderBottomWidth: last ? 0 : 1,
          borderBottomColor: theme.colors.border,
        }}
      >
        <View style={{ flex: 1, gap: 3 }}>
          <Text style={{ color: theme.colors.foreground, fontSize: 15 }}>{label}</Text>
          {hint ? <Text style={{ color: theme.colors.foregroundMuted, fontSize: 12, lineHeight: 16 }}>{hint}</Text> : null}
        </View>
        {/* Drawn rather than imported: react-native's own Switch does not take the host
            theme, and a two-tone pill is the whole of what this control has to be. */}
        <View
          style={{
            width: 44,
            height: 26,
            borderRadius: 13,
            padding: 3,
            backgroundColor: value ? theme.colors.accent : theme.colors.surface2,
            borderWidth: 1,
            borderColor: value ? theme.colors.accent : theme.colors.border,
            alignItems: value ? "flex-end" : "flex-start",
          }}
        >
          <View style={{ width: 18, height: 18, borderRadius: 9, backgroundColor: theme.colors.foreground }} />
        </View>
      </View>
    </Pressable>
  );
}

/**
 * A drag-anywhere slider, built from the responder system rather than imported:
 * react-native stopped shipping `Slider`, and the community package is not one of the
 * modules the daemon hands to a plugin bundle. Touch and mouse both arrive as responder
 * events, so one implementation covers the phone and the desktop.
 *
 * `onSettle` fires when the finger lifts, not on every pixel — the value goes to the
 * server, and dragging across the track would otherwise be a hundred writes.
 */
export function Slider({
  theme,
  label,
  hint,
  value,
  min,
  max,
  format,
  onSettle,
  last,
}: {
  theme: PluginTheme;
  label: string;
  hint?: string;
  value: number;
  min: number;
  max: number;
  format(value: number): string;
  onSettle(next: number): void;
  last?: boolean;
}) {
  const [width, setWidth] = React.useState(0);
  // Held locally while dragging so the handle tracks the finger without a round trip;
  // null means "show whatever the server last said".
  const [dragging, setDragging] = React.useState<number | null>(null);
  const shown = dragging ?? value;
  const ratio = Math.min(1, Math.max(0, (shown - min) / (max - min)));

  // Rounded to a twentieth: the ear cannot tell 1.13 from 1.15, and a round number is
  // what somebody wants to read back.
  const at = (x: number) => {
    const raw = min + (max - min) * Math.min(1, Math.max(0, width > 0 ? x / width : 0));
    return Math.round(raw * 20) / 20;
  };

  return (
    <View
      style={{
        paddingVertical: 13,
        paddingHorizontal: 14,
        gap: 10,
        borderBottomWidth: last ? 0 : 1,
        borderBottomColor: theme.colors.border,
      }}
    >
      <View style={{ flexDirection: "row", alignItems: "center", gap: 12 }}>
        <View style={{ flex: 1, gap: 3 }}>
          <Text style={{ color: theme.colors.foreground, fontSize: 15 }}>{label}</Text>
          {hint ? <Text style={{ color: theme.colors.foregroundMuted, fontSize: 12, lineHeight: 16 }}>{hint}</Text> : null}
        </View>
        <Text style={{ color: theme.colors.foregroundMuted, fontSize: 14, fontVariant: ["tabular-nums"] }}>
          {format(shown)}
        </Text>
      </View>

      <View
        onLayout={(event) => setWidth(event.nativeEvent.layout.width)}
        onStartShouldSetResponder={() => true}
        onMoveShouldSetResponder={() => true}
        onResponderGrant={(event) => setDragging(at(event.nativeEvent.locationX))}
        onResponderMove={(event) => setDragging(at(event.nativeEvent.locationX))}
        onResponderRelease={(event) => {
          const next = at(event.nativeEvent.locationX);
          setDragging(null);
          onSettle(next);
        }}
        onResponderTerminate={() => setDragging(null)}
        // Tall enough to hit with a thumb; the visible track is the thin bar inside.
        style={{ height: 28, justifyContent: "center" }}
      >
        <View style={{ height: 4, borderRadius: 2, backgroundColor: theme.colors.surface2 }}>
          <View style={{ width: `${ratio * 100}%`, height: "100%", borderRadius: 2, backgroundColor: theme.colors.accent }} />
        </View>
        <View
          style={{
            position: "absolute",
            left: `${ratio * 100}%`,
            marginLeft: -11,
            width: 22,
            height: 22,
            borderRadius: 11,
            backgroundColor: theme.colors.foreground,
            borderWidth: 1,
            borderColor: theme.colors.border,
          }}
        />
      </View>
    </View>
  );
}

/**
 * A voice in a list, with its own play button. The button is the whole point: picking
 * a voice blind from a list of eighteen names is not picking, it is guessing.
 */
export function VoiceRow({
  theme,
  name,
  detail,
  selected,
  playing,
  canPlay,
  onSelect,
  onPlay,
  last,
}: {
  theme: PluginTheme;
  name: string;
  detail?: string;
  selected: boolean;
  playing: boolean;
  canPlay: boolean;
  onSelect(): void;
  onPlay(): void;
  last?: boolean;
}) {
  return (
    <View
      style={{
        flexDirection: "row",
        alignItems: "center",
        borderBottomWidth: last ? 0 : 1,
        borderBottomColor: theme.colors.border,
      }}
    >
      <Pressable
        onPress={onSelect}
        style={({ pressed }) => ({
          flex: 1,
          paddingVertical: 13,
          paddingLeft: 14,
          paddingRight: 8,
          backgroundColor: pressed ? theme.colors.surface2 : "transparent",
        })}
      >
        <View style={{ flexDirection: "row", alignItems: "center", gap: 8 }}>
          <Text
            style={{
              color: selected ? theme.colors.accent : theme.colors.foreground,
              fontSize: 15,
              fontWeight: selected ? "600" : "400",
            }}
          >
            {name}
          </Text>
          {detail ? <Text style={{ color: theme.colors.foregroundMuted, fontSize: 12 }}>{detail}</Text> : null}
        </View>
      </Pressable>
      {canPlay ? (
        <Pressable
          onPress={onPlay}
          disabled={playing}
          style={({ pressed }) => ({
            paddingVertical: 13,
            paddingHorizontal: 14,
            opacity: playing ? 0.5 : 1,
            backgroundColor: pressed ? theme.colors.surface2 : "transparent",
          })}
        >
          <Text style={{ color: theme.colors.accent, fontSize: 14 }}>{playing ? "…" : "▶"}</Text>
        </Pressable>
      ) : null}
    </View>
  );
}

/** How much of a monthly allowance is gone, as a bar and the numbers behind it. */
export function Meter({
  theme,
  label,
  note,
  used,
  free,
  owed,
  price,
  active,
  last,
}: {
  theme: PluginTheme;
  label: string;
  note: string;
  used: number;
  free: number;
  owed: number;
  price: number;
  active: boolean;
  last?: boolean;
}) {
  const ratio = free > 0 ? Math.min(1, used / free) : 0;
  // 24 kHz Russian runs about 37 400 characters to the hour of speech, measured.
  const hours = (count: number) => count / 37_400;
  const colour = owed > 0 ? theme.colors.statusWarning : active ? theme.colors.accent : theme.colors.foregroundMuted;

  return (
    <View
      style={{
        paddingVertical: 13,
        paddingHorizontal: 14,
        gap: 8,
        borderBottomWidth: last ? 0 : 1,
        borderBottomColor: theme.colors.border,
      }}
    >
      <View style={{ flexDirection: "row", alignItems: "baseline", gap: 8 }}>
        <Text style={{ color: theme.colors.foreground, fontSize: 15, fontWeight: active ? "600" : "400" }}>{label}</Text>
        {active ? <Text style={{ color: theme.colors.accent, fontSize: 11 }}>сейчас</Text> : null}
        <View style={{ flex: 1 }} />
        <Text style={{ color: theme.colors.foregroundMuted, fontSize: 12, fontVariant: ["tabular-nums"] }}>
          {Math.round(ratio * 100)}%
        </Text>
      </View>

      <View style={{ height: 6, borderRadius: 3, backgroundColor: theme.colors.surface2, overflow: "hidden" }}>
        <View style={{ width: `${ratio * 100}%`, height: "100%", backgroundColor: colour }} />
      </View>

      <Text style={{ color: theme.colors.foregroundMuted, fontSize: 12, lineHeight: 17 }}>
        {used.toLocaleString("ru-RU")} из {free.toLocaleString("ru-RU")} символов · осталось{" "}
        {hours(Math.max(0, free - used)).toFixed(1)} ч речи
        {owed > 0 ? ` · сверху набежало $${owed.toFixed(2)}` : ` · дальше $${price} за 1 млн`}
      </Text>
      <Text style={{ color: theme.colors.foregroundMuted, fontSize: 11 }}>{note}</Text>
    </View>
  );
}

/**
 * A block of text somebody edits and then saves, rather than on every keystroke: this
 * one goes into the daemon's config and makes it re-read itself, which is not a thing
 * to do per character. Local until saved, so a half-typed sentence is never in force.
 */
export function PromptEditor({
  theme,
  value,
  isDefault,
  busy,
  onSave,
  onReset,
}: {
  theme: PluginTheme;
  value: string;
  isDefault: boolean;
  busy: boolean;
  onSave(next: string): void;
  onReset(): void;
}) {
  const [draft, setDraft] = React.useState(value);
  // Follows the server when somebody else changes it, but never while being edited.
  const [lastSeen, setLastSeen] = React.useState(value);
  if (value !== lastSeen) {
    setLastSeen(value);
    setDraft(value);
  }
  const dirty = draft.trim() !== value.trim();

  return (
    <View style={{ padding: 14, gap: 10 }}>
      <TextInput
        value={draft}
        onChangeText={setDraft}
        multiline
        editable={!busy}
        textAlignVertical="top"
        placeholder="Что агент должен проговаривать, а что оставлять на экране"
        placeholderTextColor={theme.colors.foregroundMuted}
        style={{
          minHeight: 200,
          color: theme.colors.foreground,
          backgroundColor: theme.colors.surface2,
          borderColor: dirty ? theme.colors.accent : theme.colors.border,
          borderWidth: 1,
          borderRadius: 10,
          padding: 12,
          fontSize: 14,
          lineHeight: 20,
        }}
      />
      <View style={{ flexDirection: "row", alignItems: "center", gap: 10 }}>
        <Text style={{ color: theme.colors.foregroundMuted, fontSize: 12, flex: 1 }}>
          {draft.length} символов{isDefault && !dirty ? " · исходный текст" : ""}
        </Text>
        {!isDefault || dirty ? (
          <Pressable
            onPress={() => {
              setDraft(value);
              onReset();
            }}
            disabled={busy}
          >
            <Text style={{ color: theme.colors.foregroundMuted, fontSize: 14 }}>Вернуть исходный</Text>
          </Pressable>
        ) : null}
        <Pressable
          onPress={() => onSave(draft)}
          disabled={busy || !dirty || draft.trim().length === 0}
          style={({ pressed }) => ({
            paddingVertical: 8,
            paddingHorizontal: 14,
            borderRadius: 8,
            opacity: busy || !dirty || draft.trim().length === 0 ? 0.4 : pressed ? 0.7 : 1,
            backgroundColor: theme.colors.accent,
          })}
        >
          <Text style={{ color: theme.colors.accentForeground, fontSize: 14, fontWeight: "600" }}>
            {busy ? "Сохраняю…" : "Сохранить"}
          </Text>
        </Pressable>
      </View>
    </View>
  );
}

/**
 * The Google key: shown as a fingerprint, replaced by typing a new one.
 *
 * The stored key is never sent here — the surface only ever receives `AIzaSy…Hk4`, so
 * there is nothing to reveal and no eye icon to offer. Replacing means typing the whole
 * thing again, which is the cost of a panel that is safe to photograph.
 *
 * Saving is slow on purpose: the server asks Google to confirm the key before keeping
 * it, so a wrong paste comes back as a message instead of silently killing speech.
 */
export function KeyField({
  theme,
  hint,
  path,
  busy,
  error,
  onSave,
}: {
  theme: PluginTheme;
  hint: string;
  path: string;
  busy: boolean;
  error: string;
  onSave(next: string): void;
}) {
  const [editing, setEditing] = React.useState(hint === "");
  const [draft, setDraft] = React.useState("");

  // Google's own keys are `AIza` and 35 more. Said rather than enforced: the check
  // that counts happens on the server, and a future prefix should not lock anyone out.
  const odd = draft.trim() !== "" && !/^AIza[\w-]{35}$/.test(draft.trim());

  if (!editing) {
    return (
      <View style={{ padding: 14, gap: 10, flexDirection: "row", alignItems: "center" }}>
        <View style={{ flex: 1 }}>
          <Text style={{ color: theme.colors.foreground, fontSize: 15, fontFamily: "monospace" }}>{hint}</Text>
          <Text style={{ color: theme.colors.foregroundMuted, fontSize: 12, marginTop: 2 }}>{path}</Text>
        </View>
        <Pressable onPress={() => setEditing(true)} disabled={busy}>
          <Text style={{ color: theme.colors.accent, fontSize: 14 }}>Заменить</Text>
        </Pressable>
      </View>
    );
  }

  return (
    <View style={{ padding: 14, gap: 10 }}>
      <TextInput
        value={draft}
        onChangeText={setDraft}
        editable={!busy}
        autoCapitalize="none"
        autoCorrect={false}
        placeholder="AIza…"
        placeholderTextColor={theme.colors.foregroundMuted}
        style={{
          color: theme.colors.foreground,
          backgroundColor: theme.colors.surface2,
          borderColor: odd ? theme.colors.statusWarning : draft ? theme.colors.accent : theme.colors.border,
          borderWidth: 1,
          borderRadius: 10,
          padding: 12,
          fontSize: 14,
          fontFamily: "monospace",
        }}
      />
      {error ? (
        <Text style={{ color: theme.colors.statusWarning, fontSize: 12 }}>{error}</Text>
      ) : odd ? (
        <Text style={{ color: theme.colors.statusWarning, fontSize: 12 }}>
          Ключи Google начинаются с AIza и состоят из 39 символов. Проверю всё равно.
        </Text>
      ) : null}
      <View style={{ flexDirection: "row", alignItems: "center", gap: 14 }}>
        <Text style={{ color: theme.colors.foregroundMuted, fontSize: 12, flex: 1 }}>
          {busy ? "Спрашиваю Google…" : "Проверю у Google, потом сохраню"}
        </Text>
        {hint ? (
          <Pressable
            onPress={() => {
              setDraft("");
              setEditing(false);
            }}
            disabled={busy}
          >
            <Text style={{ color: theme.colors.foregroundMuted, fontSize: 14 }}>Отмена</Text>
          </Pressable>
        ) : null}
        <Pressable
          onPress={() => onSave(draft.trim())}
          disabled={busy || draft.trim() === ""}
          style={({ pressed }) => ({
            paddingVertical: 8,
            paddingHorizontal: 14,
            borderRadius: 8,
            opacity: busy || draft.trim() === "" ? 0.4 : pressed ? 0.7 : 1,
            backgroundColor: theme.colors.accent,
          })}
        >
          <Text style={{ color: theme.colors.accentForeground, fontSize: 14, fontWeight: "600" }}>
            {busy ? "Проверяю…" : "Сохранить"}
          </Text>
        </Pressable>
      </View>
    </View>
  );
}
