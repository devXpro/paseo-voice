import type { z } from "zod";
import type { status } from "../shared/voice.shared.ts";

export type Status = z.output<typeof status>;

export type SectionId = "voice" | "limits" | "cue" | "patch" | "local" | "dictation" | "speech" | "paseo";

/**
 * The line on the right of each index row. Kept away from the markup because this is
 * the whole point of the index — somebody should be able to read six lines down one
 * edge and know what is missing — and because logic inside JSX cannot be tested.
 */
export type Summary = { text: string; tone?: "ok" | "warn" };

const shortVoice = (name: string) => name.replace(/^ru-RU-/, "").replace("Chirp3-HD-", "");

/** The billing family a Google voice belongs to, read from its name the way the server does. */
export function tierOfVoice(name: string): string {
  if (name.includes("Chirp3-HD")) return "chirp3-hd";
  if (name.includes("Standard")) return "standard";
  if (name.includes("Wavenet")) return "wavenet";
  return "";
}

export function summarise(id: SectionId, data: Status): Summary {
  switch (id) {
    case "voice": {
      if (data.provider === "google") {
        if (!data.keyPresent) return { text: "нет ключа", tone: "warn" };
        return data.cloudVoice ? { text: shortVoice(data.cloudVoice), tone: "ok" } : { text: "не выбран", tone: "warn" };
      }
      return data.localVoice ? { text: `${data.localVoice} · локально`, tone: "ok" } : { text: "не выбран", tone: "warn" };
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
      return chosen ? { text: chosen.title, tone: "ok" } : { text: "не выбран", tone: "warn" };
    }

    case "patch": {
      if (!data.patch.available) return { text: "не найден", tone: "warn" };
      if (data.patch.unknownVersion) return { text: "другая версия", tone: "warn" };
      if (data.patch.restartRequired) return { text: "нужен перезапуск", tone: "warn" };
      return data.patch.applied ? { text: "наложен", tone: "ok" } : { text: "не наложен", tone: "warn" };
    }

    case "local": {
      if (!data.localSupported) return { text: "не та платформа" };
      if (!data.binaryInstalled) return { text: "движка нет", tone: "warn" };
      return data.localModels.some((model) => model.installed) ? { text: "готов", tone: "ok" } : { text: "нет модели" };
    }

    case "dictation": {
      const { whisper } = data;
      if (whisper.downloading) return { text: "качаю", tone: "warn" };
      if (!whisper.engineInstalled) return { text: "нет движка", tone: "warn" };
      if (!whisper.models.some((one) => one.installed)) return { text: "нет модели", tone: "warn" };
      return whisper.wired ? { text: "работает", tone: "ok" } : { text: "не подключена" };
    }

    case "speech":
      // Without the first setting voice mode hears you and has nothing to answer with,
      // so that is a warning rather than a neutral fact.
      if (!data.settings.mcpInjected) return { text: "выключено", tone: "warn" };
      return data.settings.promptSet ? { text: "включено", tone: "ok" } : { text: "без промпта", tone: "warn" };

    case "paseo":
      if (data.restartRequired) return { text: "нужен перезапуск", tone: "warn" };
      return data.wired ? { text: "подключено", tone: "ok" } : { text: "не подключено", tone: "warn" };
  }
}
