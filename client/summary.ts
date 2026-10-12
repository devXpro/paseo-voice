import type { z } from "zod";
import { translator } from "../shared/i18n/index.ts";
import { SPEECH_LOCALES } from "../shared/languages.shared.ts";
import type { status } from "../shared/voice.shared.ts";

export type Status = z.output<typeof status>;

export type SectionId = "language" | "voice" | "limits" | "cue" | "patch" | "local" | "dictation" | "speech" | "paseo";

/**
 * The line on the right of each index row. Kept away from the markup because this is
 * the whole point of the index — somebody should be able to read six lines down one
 * edge and know what is missing — and because logic inside JSX cannot be tested.
 */
export type Summary = { text: string; tone?: "ok" | "warn" };

const shortVoice = (name: string) => name.replace(/^[a-z]{2,3}-[A-Z]{2}-/, "").replace("Chirp3-HD-", "");

/** The billing family a Google voice belongs to, read from its name the way the server does. */
export function tierOfVoice(name: string): string {
  if (name.includes("Chirp3-HD")) return "chirp3-hd";
  if (name.includes("Standard")) return "standard";
  if (name.includes("Wavenet")) return "wavenet";
  return "";
}

export function summarise(id: SectionId, data: Status): Summary {
  const { t } = translator(data.uiLanguage);
  switch (id) {
    case "language": {
      // The speech, not the panel's own language: the panel shows that by being in it.
      const speech = SPEECH_LOCALES.find((locale) => locale.id === data.speechLocale);
      return { text: speech?.label ?? data.speechLocale, tone: "ok" };
    }

    case "voice": {
      if (data.provider === "google") {
        if (!data.keyPresent) return { text: t("summary.noKey"), tone: "warn" };
        return data.cloudVoice
          ? { text: shortVoice(data.cloudVoice), tone: "ok" }
          : { text: t("summary.notChosen"), tone: "warn" };
      }
      return data.localVoice
        ? { text: t("summary.local", { voice: data.localVoice }), tone: "ok" }
        : { text: t("summary.notChosen"), tone: "warn" };
    }

    case "limits": {
      // The family actually in use is the one worth reporting; the others sit idle.
      const id = tierOfVoice(data.cloudVoice);
      const active = data.usage.find((row) => row.id === id) ?? data.usage.find((row) => row.used > 0);
      if (!active || active.free === 0) return { text: "—" };
      const percent = Math.min(100, Math.round((active.used / active.free) * 100));
      return percent >= 90 ? { text: `${percent}%`, tone: "warn" } : { text: `${percent}%`, tone: "ok" };
    }

    case "cue": {
      const chosen = data.cues.find((entry) => entry.id === data.cue);
      if (!chosen) return { text: t("summary.notChosen"), tone: "warn" };
      return { text: chosen.kind === "silence" ? t("cue.silenceTitle") : chosen.title, tone: "ok" };
    }

    case "patch": {
      if (!data.patch.available) return { text: t("patch.notFound"), tone: "warn" };
      if (data.patch.unknownVersion) return { text: t("patch.otherVersion"), tone: "warn" };
      if (data.patch.restartRequired) return { text: t("patch.restartNeeded"), tone: "warn" };
      return data.patch.applied
        ? { text: t("patch.applied"), tone: "ok" }
        : { text: t("patch.notApplied"), tone: "warn" };
    }

    case "local": {
      if (!data.localSupported) return { text: t("summary.wrongPlatform") };
      if (!data.binaryInstalled) return { text: t("summary.noEngine"), tone: "warn" };
      return data.localModels.some((model) => model.installed)
        ? { text: t("summary.ready"), tone: "ok" }
        : { text: t("summary.noModel") };
    }

    case "dictation": {
      const { whisper } = data;
      if (whisper.downloading) return { text: t("summary.downloading"), tone: "warn" };
      if (!whisper.engineInstalled) return { text: t("summary.noRecogniser"), tone: "warn" };
      if (!whisper.models.some((one) => one.installed)) return { text: t("summary.noModel"), tone: "warn" };
      return whisper.wired ? { text: t("summary.working"), tone: "ok" } : { text: t("summary.dictationOff") };
    }

    case "speech":
      // Without the first setting voice mode hears you and has nothing to answer with,
      // so that is a warning rather than a neutral fact.
      if (!data.settings.mcpInjected) return { text: t("common.off"), tone: "warn" };
      return data.settings.promptSet ? { text: t("common.on"), tone: "ok" } : { text: t("summary.noPrompt"), tone: "warn" };

    case "paseo":
      if (data.restartRequired) return { text: t("patch.restartNeeded"), tone: "warn" };
      return data.wired ? { text: t("summary.connected"), tone: "ok" } : { text: t("summary.notConnected"), tone: "warn" };
  }
}
