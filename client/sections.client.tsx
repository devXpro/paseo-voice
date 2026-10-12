import React from "react";
import { View } from "react-native";
import { type Key, UI_LANGUAGES } from "../shared/i18n/index.ts";
import { SPEECH_LANGUAGES, speechLanguageOf } from "../shared/languages.shared.ts";
import { ChoiceRow, Group, gigabytes, KeyField, type Lab, Meter, PromptEditor, Row, Slider, Switch, VoiceRow } from "./lab.client.tsx";
import { type SectionId, tierOfVoice } from "./summary.ts";

export type { SectionId };

export type Section = {
  id: SectionId;
  /** Said in the panel's language when the section is drawn. */
  title: Key;
  icon: string;
  Component(lab: Lab): React.ReactElement;
};

/** Google's own order, cheapest allowance last, with the one worth defaulting to first. */
const FAMILIES: { id: string; label: string; hint: Key }[] = [
  { id: "chirp3-hd", label: "Chirp 3 HD", hint: "voice.familyChirp" },
  { id: "standard", label: "Standard", hint: "voice.familyStandard" },
  { id: "wavenet", label: "WaveNet", hint: "voice.familyWavenet" },
];

/** What each billing family is, in a line, beside its meter. */
const TIER_NOTES: Record<string, Key> = {
  "chirp3-hd": "limits.noteChirp",
  standard: "limits.noteStandard",
  wavenet: "limits.noteWavenet",
};

/** A dictation model's one-line description, by its id. */
const MODEL_NOTES: Record<string, Key> = {
  "large-v3-turbo-q8_0": "dictation.q8",
  "large-v3-turbo-q5_0": "dictation.q5",
  "large-v3-turbo": "dictation.full",
};

/** A voice by its own name: the accent is chosen above, the family beside it. */
const short = (name: string) =>
  name.replace(/^[a-z]{2,3}-[A-Z]{2}-/, "").replace("Chirp3-HD-", "").replace(/^(Standard|Wavenet)-/, "");

function tone(theme: Lab["theme"], kind?: "ok" | "warn"): string | undefined {
  if (kind === "ok") return theme.colors.statusSuccess;
  if (kind === "warn") return theme.colors.statusWarning;
  return undefined;
}

export const SECTIONS: Section[] = [
  {
    // First: somebody who picked a language they cannot read has to find the way back,
    // and the title carries the English word in every language for the same reason.
    id: "language",
    title: "language.title",
    icon: "Globe",
    Component: (lab) => {
      const { data, theme, act, tr } = lab;
      const speaking = speechLanguageOf(data.speechLocale);
      const locales = SPEECH_LANGUAGES.flatMap((language) => language.locales);
      return (
        <View>
          <Group theme={theme} title={tr.t("language.interface")} footer={tr.t("language.interfaceFooter")}>
            {UI_LANGUAGES.map((language, index) => (
              <Row
                key={language.id}
                theme={theme}
                label={language.label}
                value={language.id === data.uiLanguage ? tr.t("common.selected") : undefined}
                valueColour={tone(theme, "ok")}
                onPress={() => act.setUiLanguage(language.id)}
                last={index === UI_LANGUAGES.length - 1}
              />
            ))}
          </Group>

          <Group theme={theme} title={tr.t("language.speech")} footer={tr.t("language.speechFooter")}>
            {locales.map((locale, index) => (
              <Row
                key={locale.id}
                theme={theme}
                label={locale.label}
                value={locale.id === data.speechLocale ? tr.t("common.selected") : undefined}
                valueColour={tone(theme, "ok")}
                onPress={() => act.setSpeechLocale(locale.id)}
                last={index === locales.length - 1}
              />
            ))}
          </Group>

          {speaking.engine === null && data.provider === "local" ? (
            <Group theme={theme}>
              <Row
                theme={theme}
                label={tr.t("language.noLocalEngine", { language: speaking.locales[0]!.label })}
                hint={tr.t("language.noLocalEngineNoKey")}
                valueColour={tone(theme, "warn")}
                last
              />
            </Group>
          ) : null}
        </View>
      );
    },
  },

  {
    id: "voice",
    title: "voice.title",
    icon: "Mic",
    Component: (lab) => {
      const { data, theme, act, tr } = lab;
      const cloud = data.provider === "google";
      const family = tierOfVoice(data.cloudVoice) || "chirp3-hd";
      const inFamily = data.cloudVoices.filter((voice) => voice.tier === family);
      const speaking = speechLanguageOf(data.speechLocale);

      return (
        <View>
          <Group
            theme={theme}
            title={tr.t("voice.source")}
            footer={cloud ? tr.t("voice.sourceFooterGoogle") : tr.t("voice.sourceFooterLocal")}
          >
            <ChoiceRow
              theme={theme}
              label={tr.t("voice.provider")}
              value={data.provider}
              options={[
                { label: "Google", value: "google" },
                { label: tr.t("voice.providerLocal"), value: "local" },
              ]}
              onChange={(value) => act.setProvider(value as "google" | "local")}
              last={!(speaking.engine === null && !cloud)}
            />
            {speaking.engine === null && !cloud ? (
              <Row
                theme={theme}
                label={tr.t("language.noLocalEngine", { language: speaking.locales[0]!.label })}
                hint={data.keyPresent ? tr.t("language.noLocalEngineHint") : tr.t("language.noLocalEngineNoKey")}
                valueColour={tone(theme, "warn")}
                last
              />
            ) : null}
          </Group>

          {cloud ? (
            <Group
              theme={theme}
              title={tr.t("voice.key")}
              footer={data.keyPresent ? tr.t("voice.keyFooterPresent") : tr.t("voice.keyFooterMissing")}
            >
              <KeyField
                theme={theme}
                tr={tr}
                hint={data.keyHint}
                path={data.keyPath}
                busy={act.savingKey}
                error={tr.say(data.cloudError)}
                onSave={(next) => act.setKey(next)}
              />
              {data.keyPresent && data.cloudError ? (
                <Row
                  theme={theme}
                  label={tr.t("voice.googleDown")}
                  hint={tr.say(data.cloudError)}
                  action={tr.t("common.retry")}
                  onPress={() => act.refreshCloud()}
                  last
                />
              ) : null}
            </Group>
          ) : null}

          {cloud && data.keyPresent ? (
            <>
              <Group theme={theme} title={tr.t("voice.family")}>
                {FAMILIES.map((entry, index) => (
                  <Row
                    key={entry.id}
                    theme={theme}
                    label={entry.label}
                    hint={tr.t(entry.hint)}
                    value={family === entry.id ? tr.t("common.selected") : undefined}
                    valueColour={tone(theme, "ok")}
                    onPress={() => {
                      const first = data.cloudVoices.find((voice) => voice.tier === entry.id);
                      if (first) act.chooseCloudVoice(first.name);
                    }}
                    last={index === FAMILIES.length - 1}
                  />
                ))}
              </Group>

              <Group
                theme={theme}
                title={tr.t("voice.voices", { n: inFamily.length })}
                footer={act.canPlay ? tr.t("voice.footerPlay") : tr.t("voice.footerNoPlay")}
              >
                {inFamily.map((voice, index) => (
                  <VoiceRow
                    key={voice.name}
                    theme={theme}
                    name={short(voice.name)}
                    detail={voice.gender === "female" ? tr.t("common.female") : tr.t("common.male")}
                    selected={voice.name === data.cloudVoice}
                    playing={act.listeningTo === voice.name ? act.listeningState : ""}
                    canPlay={act.canPlay}
                    onSelect={() => act.chooseCloudVoice(voice.name)}
                    onPlay={() => act.listen(voice.name)}
                    last={index === inFamily.length - 1}
                  />
                ))}
              </Group>
            </>
          ) : null}

          {!cloud ? (
            <Group
              theme={theme}
              title={tr.t("voice.engineVoice")}
              footer={data.engine.running ? undefined : tr.t("voice.engineVoiceFooter")}
            >
              {data.localVoices.length > 0 ? (
                data.localVoices.map((name, index) => (
                  <VoiceRow
                    key={name}
                    theme={theme}
                    name={name}
                    selected={name === data.localVoice}
                    playing={act.listeningTo === name ? act.listeningState : ""}
                    canPlay={act.canPlay}
                    onSelect={() => act.chooseLocalVoice(name)}
                    onPlay={() => act.listen(name)}
                    last={index === data.localVoices.length - 1}
                  />
                ))
              ) : (
                <Row
                  theme={theme}
                  label={tr.t("voice.engineAsleep")}
                  hint={tr.t("voice.engineAsleepHint")}
                  action={act.listeningTo ? tr.t("voice.waking") : tr.t("voice.listenAction")}
                  disabled={act.listeningTo !== "" || !act.canPlay}
                  onPress={() => act.listen()}
                  last
                />
              )}
            </Group>
          ) : null}

          <Group
            theme={theme}
            title={tr.t("voice.delivery")}
            footer={(cloud ? "" : tr.t("voice.deliverySteady")) + tr.t("voice.deliveryClean")}
          >
            {/* Google has no seed to pin and does not vary between takes; the switch
                would be a control that does nothing. */}
            {!cloud ? (
              <Switch
                theme={theme}
                label={tr.t("voice.steady")}
                hint={tr.t("voice.steadyHint")}
                value={data.steady}
                onChange={(next) => act.setSteady(next)}
              />
            ) : null}
            <Switch
              theme={theme}
              label={tr.t("voice.phoneSafe")}
              hint={tr.t("voice.phoneSafeHint")}
              value={data.phoneSafe}
              onChange={(next) => act.setPhoneSafe(next)}
            />
            <Slider
              theme={theme}
              label={tr.t("voice.rate")}
              hint={tr.t("voice.rateHint", { one: tr.fixed(1, 1) })}
              value={data.rate}
              min={data.rateMin}
              max={data.rateMax}
              format={(value) => `${tr.fixed(value, 2)}×`}
              onSettle={(value) => act.setRate(value)}
            />
            <Row
              theme={theme}
              label={tr.t("voice.listenChosen")}
              hint={tr.t("voice.listenChosenHint", { probe: speaking.probe })}
              action={act.listeningTo ? tr.t("common.synthesising") : tr.t("common.listen")}
              disabled={act.listeningTo !== "" || !act.canPlay}
              onPress={() => act.listen()}
              last
            />
          </Group>
        </View>
      );
    },
  },

  {
    id: "limits",
    title: "limits.title",
    icon: "Gauge",
    Component: (lab) => {
      const { data, theme, tr } = lab;
      const active = tierOfVoice(data.cloudVoice);
      const resets = data.usageResetsAt ? new Date(data.usageResetsAt) : null;
      const owed = data.usage.reduce((sum, row) => sum + row.owed, 0);

      return (
        <View>
          <Group
            theme={theme}
            title={tr.t("limits.free")}
            footer={tr.t("limits.footer")}
          >
            {data.usage.map((row, index) => (
              <Meter
                key={row.id}
                theme={theme}
                tr={tr}
                label={row.label}
                note={TIER_NOTES[row.id] ? tr.t(TIER_NOTES[row.id]!) : row.note}
                charsPerHour={speechLanguageOf(data.speechLocale).charsPerHour}
                used={row.used}
                free={row.free}
                owed={row.owed}
                price={row.dollarsPerMillion}
                active={row.id === active}
                last={index === data.usage.length - 1}
              />
            ))}
          </Group>

          <Group theme={theme}>
            <Row
              theme={theme}
              label={tr.t("limits.resets")}
              hint={tr.t("limits.resetsHint")}
              value={resets ? resets.toLocaleDateString(tr.locale, { day: "numeric", month: "long" }) : "—"}
            />
            <Row
              theme={theme}
              label={tr.t("limits.owed")}
              hint={owed > 0 ? tr.t("limits.owedHint") : tr.t("limits.owedNone")}
              value={`$${owed.toFixed(2)}`}
              valueColour={tone(theme, owed > 0 ? "warn" : "ok")}
              last
            />
          </Group>
        </View>
      );
    },
  },

  {
    id: "cue",
    title: "cue.title",
    icon: "Music",
    Component: (lab) => {
      const { data, theme, act, tr } = lab;
      const own = data.cues.filter((entry) => entry.kind === "own");
      return (
        <View>
          <Group
            theme={theme}
            title={tr.t("cue.what")}
            footer={(act.canPlay ? tr.t("cue.footerPlay") : tr.t("cue.footerNoPlay")) + tr.t("cue.footer")}
          >
            {data.cues.map((entry, index) => (
              <VoiceRow
                key={entry.id}
                theme={theme}
                name={entry.kind === "silence" ? tr.t("cue.silenceTitle") : entry.title}
                detail={
                  entry.kind === "own"
                    ? tr.t("cue.own")
                    : entry.kind === "silence"
                      ? tr.t("cue.silence")
                      : entry.seconds === 0
                        ? tr.t("cue.download")
                        : undefined
                }
                selected={entry.id === data.cue}
                playing={act.listeningTo === entry.id ? act.listeningState : ""}
                canPlay={act.canPlay && entry.kind !== "silence"}
                onSelect={() => act.chooseCue(entry.id)}
                onPlay={() => act.playCue(entry.id)}
                last={index === data.cues.length - 1}
              />
            ))}
          </Group>

          <Group
            theme={theme}
            title={tr.t("cue.volume")}
            footer={tr.t("cue.volumeFooter")}
          >
            <Slider
              theme={theme}
              label={tr.t("cue.volumeLabel")}
              hint={tr.t("cue.volumeHint", { one: tr.fixed(1, 1) })}
              value={data.cueVolume}
              min={0}
              max={data.cueVolumeMax}
              format={(value) => (value === 0 ? tr.t("cue.quiet") : `${tr.fixed(value, 2)}\u00d7`)}
              onSettle={(value) => act.setCueVolume(value)}
              last
            />
          </Group>

          <Group
            theme={theme}
            title={tr.t("cue.yours")}
            footer={tr.t("cue.yoursFooter")}
          >
            <Row
              theme={theme}
              label={tr.t("cue.folder")}
              hint={data.cueFolder}
              value={own.length > 0 ? tr.tn("cue.count", own.length) : tr.t("cue.empty")}
              valueColour={tone(theme, own.length > 0 ? "ok" : undefined)}
              last
            />
          </Group>

          <Group
            theme={theme}
            footer={tr.t("cue.whereFooter")}
          >
            <Row
              theme={theme}
              label={tr.t("cue.desktop")}
              hint={tr.t("cue.desktopHint")}
              value={data.patch.targets.find((one) => one.id === "cue")?.applied ? tr.t("cue.works") : tr.t("cue.needsPatch")}
              valueColour={tone(theme, data.patch.targets.find((one) => one.id === "cue")?.applied ? "ok" : "warn")}
            />
            <Row
              theme={theme}
              label={tr.t("cue.phone")}
              hint={tr.t("cue.phoneHint")}
              value="ios-build/build.sh"
              last
            />
          </Group>
        </View>
      );
    },
  },

  {
    id: "patch",
    title: "patch.title",
    icon: "Wrench",
    Component: (lab) => {
      const { data, theme, act, tr } = lab;
      const { patch } = data;
      // One patch and one button: the corrections are applied and reverted together, so
      // the panel says what the whole of it does rather than file by file.
      const partly = !patch.applied && patch.targets.some((target) => target.applied);
      const state: { value: string; hint: string; tone: "ok" | "warn" } = !patch.available
        ? { value: tr.t("patch.notFound"), hint: tr.say(patch.error) || tr.t("patch.notFoundHint"), tone: "warn" }
        : patch.unknownVersion
          ? { value: tr.t("patch.otherVersion"), hint: tr.t("patch.otherVersionHint"), tone: "warn" }
          : patch.restartRequired
            ? { value: tr.t("patch.restartNeeded"), hint: tr.t("patch.restartHint"), tone: "warn" }
            : patch.applied
              ? { value: tr.t("patch.applied"), hint: tr.t("patch.appliedHint"), tone: "ok" }
              : {
                  value: partly ? tr.t("patch.partly") : tr.t("patch.notApplied"),
                  hint: tr.t("patch.notAppliedHint"),
                  tone: "warn",
                };
      const alerts = patch.targets.filter((target) => target.alert);
      return (
        <View>
          <Group theme={theme}>
            <Row
              theme={theme}
              label={tr.t("common.state")}
              hint={state.hint}
              value={state.value}
              valueColour={tone(theme, state.tone)}
            />
            <Row
              theme={theme}
              label={patch.applied ? tr.t("patch.revert") : tr.t("patch.apply")}
              hint={patch.applied ? tr.t("patch.revertHint") : tr.t("patch.applyHint")}
              action={act.patching ? tr.t("common.writing") : patch.applied ? tr.t("patch.revert") : tr.t("patch.apply")}
              disabled={act.patching || !patch.available || patch.unknownVersion}
              onPress={() => (patch.applied ? act.revertPatch() : act.applyPatch())}
              last
            />
          </Group>

          {alerts.length > 0 ? (
            <Group theme={theme} title={tr.t("patch.alerts")}>
              {alerts.map((target, index) => (
                <Row
                  key={target.id}
                  theme={theme}
                  label={tr.say(target.title)}
                  hint={tr.say(target.alert)}
                  last={index === alerts.length - 1}
                />
              ))}
            </Group>
          ) : null}

          <Group
            theme={theme}
            title={tr.t("patch.changes")}
            footer={tr.t("patch.changesFooter")}
          >
            {patch.targets.map((target, index) => (
              <Row
                key={target.id}
                theme={theme}
                label={tr.say(target.title)}
                hint={tr.say(target.note)}
                last={index === patch.targets.length - 1}
              />
            ))}
          </Group>
        </View>
      );
    },
  },

  {
    id: "local",
    title: "local.title",
    icon: "Cpu",
    Component: (lab) => {
      const { data, theme, act, tr } = lab;
      if (!data.localSupported) {
        return (
          <Group theme={theme} footer={tr.t("local.platformFooter")}>
            <Row theme={theme} label={tr.t("local.wrongPlatform")} last />
          </Group>
        );
      }
      const installed = data.localModels.filter((model) => model.installed);
      return (
        <View>
          <Group
            theme={theme}
            title={tr.t("local.fallback")}
            footer={tr.t("local.fallbackFooter")}
          >
            <Row
              theme={theme}
              label={tr.t("common.engine")}
              hint={data.binaryInstalled ? tr.t("local.binaryHere") : tr.t("local.binaryNeeded")}
              value={data.binaryInstalled ? tr.t("local.installed") : undefined}
              valueColour={tone(theme, "ok")}
              action={data.binaryInstalled ? undefined : act.installingEngine ? tr.t("common.installing") : tr.t("common.install")}
              disabled={act.installingEngine}
              onPress={() => act.installEngine()}
            />
            <Row
              theme={theme}
              label={tr.t("common.state")}
              hint={tr.say(data.engine.error) || undefined}
              value={data.engine.running ? tr.t("local.running", { model: data.engine.model }) : tr.t("local.asleep")}
              valueColour={tone(theme, data.engine.running ? "ok" : undefined)}
              last={installed.length === 0}
            />
            {installed.length > 0 ? (
              <ChoiceRow
                theme={theme}
                label={tr.t("common.model")}
                hint={tr.t("local.modelHint")}
                value={data.activeModel}
                options={installed.map((model) => ({
                  label: model.label,
                  value: model.id,
                  detail: gigabytes(tr, model.onDisk),
                }))}
                onChange={(value) => act.chooseModel(value)}
                last
              />
            ) : null}
          </Group>

          {installed.length === 0 ? (
            <Group theme={theme} footer={tr.t("local.noModelsFooter")}>
              <Row theme={theme} label={tr.t("local.noModels")} last />
            </Group>
          ) : null}
        </View>
      );
    },
  },

  {
    id: "dictation",
    title: "dictation.title",
    icon: "Keyboard",
    Component: (lab) => {
      const { data, theme, act, tr } = lab;
      const w = data.whisper;
      const ready = w.engineInstalled && w.models.some((one) => one.installed);
      const chosen = w.models.find((one) => one.id === w.model);

      return (
        <View>
          {w.error ? (
            <Group theme={theme}>
              <Row theme={theme} label={tr.t("common.failed")} hint={tr.say(w.error)} valueColour={tone(theme, "warn")} last />
            </Group>
          ) : null}

          <Group
            theme={theme}
            title={tr.t("common.engine")}
            footer={tr.t("dictation.engineFooter")}
          >
            <Row
              theme={theme}
              label="whisper-server"
              hint={w.engineInstalled ? w.enginePath : tr.t("dictation.engineNeeded")}
              value={w.busy ? tr.say(w.busy) : w.engineInstalled ? tr.t("dictation.inPlace") : tr.t("common.no")}
              valueColour={tone(theme, w.engineInstalled ? "ok" : "warn")}
              action={!w.engineInstalled && !w.busy ? tr.t("common.install") : undefined}
              onPress={!w.engineInstalled && !w.busy ? () => act.installRecogniser() : undefined}
              last
            />
          </Group>

          <Group
            theme={theme}
            title={tr.t("common.model")}
            footer={tr.t("dictation.modelFooter", { directory: w.directory })}
          >
            {w.models.map((one, index) => {
              const busy = w.downloading === one.id;
              const share = busy && w.downloadTotal > 0 ? Math.round((w.downloadedBytes / w.downloadTotal) * 100) : 0;
              return (
                <Row
                  key={one.id}
                  theme={theme}
                  label={one.title}
                  hint={
                    busy
                      ? tr.t("dictation.progress", {
                          percent: share,
                          done: gigabytes(tr, w.downloadedBytes),
                          total: gigabytes(tr, w.downloadTotal),
                        })
                      : MODEL_NOTES[one.id]
                        ? tr.t(MODEL_NOTES[one.id]!)
                        : one.note
                  }
                  value={
                    one.id === w.model && one.installed
                      ? tr.t("dictation.chosen")
                      : one.installed
                        ? gigabytes(tr, one.onDisk)
                        : gigabytes(tr, one.bytes)
                  }
                  valueColour={tone(theme, one.id === w.model && one.installed ? "ok" : undefined)}
                  action={
                    busy
                      ? undefined
                      : one.installed
                        ? one.id === w.model
                          ? tr.t("dictation.delete")
                          : tr.t("dictation.choose")
                        : tr.t("dictation.download")
                  }
                  onPress={
                    busy
                      ? undefined
                      : one.installed
                        ? one.id === w.model
                          ? () => act.forgetRecogniserModel(one.id)
                          : () => act.setRecogniserModel(one.id)
                        : () => act.fetchRecogniserModel(one.id)
                  }
                  last={index === w.models.length - 1}
                />
              );
            })}
          </Group>

          <Group
            theme={theme}
            title={tr.t("dictation.dictionary")}
            footer={tr.t("dictation.dictionaryFooter")}
          >
            <PromptEditor
              theme={theme}
              tr={tr}
              value={w.dictionary}
              isDefault={w.dictionary === ""}
              busy={w.busy !== ""}
              onSave={(next) => act.setDictionary(next)}
              onReset={() => act.setDictionary("")}
              placeholder={tr.t("dictation.placeholder")}
              resetLabel={tr.t("dictation.clear")}
              emptyLabel={tr.t("dictation.emptyLabel")}
              minHeight={120}
            />
            <Row
              theme={theme}
              label={tr.t("dictation.mine")}
              hint={tr.t("dictation.mineHint")}
              action={w.busy ? tr.t("dictation.reading") : tr.t("dictation.mineAction")}
              onPress={w.busy ? undefined : () => act.mineDictionary()}
              last
            />
          </Group>

          <Group
            theme={theme}
            title={tr.t("dictation.connection")}
            footer={tr.t("dictation.connectionFooter")}
          >
            <Switch
              theme={theme}
              label={tr.t("dictation.viaPlugin")}
              hint={
                w.busy
                  ? tr.say(w.busy)
                  : !ready
                    ? tr.t("dictation.needsEngine")
                    : chosen
                      ? tr.t("dictation.usingModel", { model: chosen.title })
                      : tr.t("dictation.noModel")
              }
              value={w.wired}
              onChange={(next) => act.wireDictation(next)}
              last
            />
          </Group>
        </View>
      );
    },
  },

  {
    id: "speech",
    title: "speech.title",
    icon: "Settings",
    Component: (lab) => {
      const { data, theme, act, tr } = lab;
      const { settings } = data;
      const on = settings.mcpInjected && settings.promptSet;
      return (
        <View>
          <Group
            theme={theme}
            title={tr.t("speech.daemon")}
            footer={tr.t("speech.daemonFooter", { path: settings.configPath })}
          >
            <Row
              theme={theme}
              label={tr.t("speech.tool")}
              hint={tr.t("speech.toolHint")}
              value={settings.mcpInjected ? tr.t("common.on") : tr.t("common.off")}
              valueColour={tone(theme, settings.mcpInjected ? "ok" : "warn")}
            />
            <Row
              theme={theme}
              label={tr.t("speech.sayAll")}
              hint={settings.foreignPrompt ? tr.t("speech.foreignPrompt") : "daemon.appendSystemPrompt"}
              value={settings.promptSet ? tr.t("common.on") : tr.t("common.no")}
              valueColour={tone(theme, settings.promptSet ? "ok" : undefined)}
              last
            />
          </Group>

          <Group
            theme={theme}
            title={tr.t("speech.text")}
            footer={tr.t("speech.textFooter")}
          >
            <PromptEditor
              theme={theme}
              tr={tr}
              value={data.prompt.text}
              isDefault={data.prompt.isDefault}
              busy={act.savingPrompt}
              onSave={(next) => act.setPrompt(next)}
              onReset={() => act.setPrompt(data.prompt.defaultText)}
            />
          </Group>

          <Group theme={theme} footer={tr.t("speech.applyFooter")}>
            <Row
              theme={theme}
              label={on ? tr.t("speech.turnOff") : tr.t("speech.turnOn")}
              hint={on ? tr.t("speech.turnOffHint") : tr.t("speech.turnOnHint")}
              action={act.switching ? tr.t("speech.applying") : on ? tr.t("speech.turnOff") : tr.t("speech.turnOn")}
              disabled={act.switching}
              onPress={() => (on ? act.disableSpeech() : act.enableSpeech())}
              last
            />
          </Group>

          {settings.error ? (
            <Group theme={theme}>
              <Row theme={theme} label={tr.t("common.error")} hint={tr.say(settings.error)} last />
            </Group>
          ) : null}
        </View>
      );
    },
  },

  {
    id: "paseo",
    title: "paseo.title",
    icon: "Link",
    Component: (lab) => {
      const { data, theme, act, tr } = lab;
      return (
        <View>
          <Group
            theme={theme}
            title={tr.t("paseo.mode")}
            footer={tr.t("paseo.modeFooter")}
          >
            <Row
              theme={theme}
              label={tr.t("paseo.where")}
              hint="providers.openai.tts.baseUrl"
              value={data.wired ? tr.t("paseo.atPlugin") : tr.t("paseo.elsewhere")}
              valueColour={tone(theme, data.wired ? "ok" : "warn")}
            />
            <Row
              theme={theme}
              label={tr.t("paseo.write")}
              hint={data.restartRequired ? tr.t("paseo.writtenHint") : tr.t("paseo.writeHint")}
              action={act.applying ? tr.t("common.writing") : tr.t("paseo.write")}
              disabled={act.applying}
              onPress={() => act.apply()}
              last
            />
          </Group>
        </View>
      );
    },
  },
];
