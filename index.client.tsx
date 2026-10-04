import type { PluginClientContext } from "@getpaseo/plugin/client";
import { VoiceSurface } from "./client/main.client.tsx";

export default function contribute(client: PluginClientContext) {
  client.addSurface("main", VoiceSurface);

  // The same page under Settings as well as in the sidebar: picking the voice Paseo
  // answers in is as much a setting as it is a workspace, and that is where somebody
  // goes looking when the answer comes out in the wrong language.
  client.addSettingsScreen({ id: "settings", title: "Голос", icon: "Mic", Component: VoiceSurface });

  // Held and returned rather than dropped: `contribute()` must hand back a cleanup, and
  // a contribution without one is refused whole — surface and sidebar entry together.
  const removeSidebarItem = client.addSidebarItem({
    id: "main",
    title: "Голос",
    icon: "Mic",
    surface: "main",
  });

  return () => {
    void removeSidebarItem?.();
  };
}
