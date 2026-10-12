import type { PluginClientContext } from "@getpaseo/plugin/client";
import { DEFAULT_UI_LANGUAGE, t, type UiLanguage } from "./shared/i18n/index.ts";
import { getUiLanguage } from "./shared/voice.shared.ts";
import { VoiceSurface } from "./client/main.client.tsx";
import { onRetitle } from "./client/titles.client.ts";

export default function contribute(client: PluginClientContext) {
  client.addSurface("main", VoiceSurface);

  // The titles are in the panel's language, which lives on the server: registered in
  // English at once, because `contribute()` cannot wait, and again in the right language
  // when the answer comes — a tenth of a second later.
  let removeSettings: (() => void) | undefined;
  let removeSidebarItem: (() => void) | undefined;

  // The same page under Settings as well as in the sidebar: picking the voice Paseo
  // answers in is as much a setting as it is a workspace, and that is where somebody
  // goes looking when the answer comes out in the wrong language.
  const settings = (language: UiLanguage) => {
    void removeSettings?.();
    removeSettings = client.addSettingsScreen({
      id: "settings",
      title: t(language, "app.title"),
      icon: "Mic",
      Component: VoiceSurface,
    });
  };
  // Held and returned rather than dropped: `contribute()` must hand back a cleanup, and
  // a contribution without one is refused whole — surface and sidebar entry together.
  const sidebar = (language: UiLanguage) => {
    void removeSidebarItem?.();
    removeSidebarItem = client.addSidebarItem({
      id: "main",
      title: t(language, "app.title"),
      icon: "Mic",
      surface: "main",
    });
  };

  settings(DEFAULT_UI_LANGUAGE);
  sidebar(DEFAULT_UI_LANGUAGE);
  void client
    .rpc(getUiLanguage, {})
    .then(({ language }) => {
      if (language !== DEFAULT_UI_LANGUAGE) {
        settings(language);
        sidebar(language);
      }
    })
    .catch(() => {
      // An older server, or none yet: the English titles stay, and nothing else is lost.
    });
  // Only the sidebar entry is retitled while the app runs: re-registering the Settings
  // screen while somebody is on it would take the page out from under them.
  onRetitle(sidebar);

  return () => {
    void removeSettings?.();
    void removeSidebarItem?.();
  };
}
