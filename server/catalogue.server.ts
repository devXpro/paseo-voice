/**
 * The waiting cues this plugin ships with.
 *
 * Fetched on first use rather than committed: four tracks is fifteen megabytes, and a
 * repository is a bad place to keep audio that never changes. They land beside the
 * weights, outside the plugin directory, so `paseo plugin remove` leaves them.
 *
 * All four are Kevin MacLeod's, under CC BY 4.0 — which does allow shipping them
 * inside a distributed program, as long as the credit below travels with it. That is
 * the whole reason these and not the track this was modelled on: that one is Megatrax
 * library music, licensed per use by arrangement, and no amount of goodwill makes it
 * redistributable.
 */

export const ATTRIBUTION =
  "Kevin MacLeod (incompetech.com), CC BY 4.0 — https://creativecommons.org/licenses/by/4.0/";

export type Builtin = {
  id: string;
  title: string;
  /** What it sounds like, for somebody choosing without listening first. */
  note: string;
  url: string;
  sha256: string;
  /** Where to take the loop from: every one of these opens with an intro. */
  fromSeconds: number;
};

export const BUILTIN: readonly Builtin[] = [
  {
    id: "lobby-time",
    title: "Lobby Time",
    note: "лобби-джаз, спокойный",
    url: "https://incompetech.com/music/royalty-free/mp3-royaltyfree/Lobby%20Time.mp3",
    sha256: "bc47dc1f1a0b1fe4ff631cee89ca3987b8f7b52f533d06233665d51300331beb",
    fromSeconds: 30,
  },
  {
    id: "spy-glass",
    title: "Spy Glass",
    note: "ретро-лаунж",
    url: "https://incompetech.com/music/royalty-free/mp3-royaltyfree/Spy%20Glass.mp3",
    sha256: "e790c5ceb0b64eed48d83ee3aa458daebc246d751bf7cf12c87231faadb5f6f1",
    fromSeconds: 30,
  },
  {
    id: "samba-isobel",
    title: "Samba Isobel",
    note: "самба, живее остальных",
    url: "https://incompetech.com/music/royalty-free/mp3-royaltyfree/Samba%20Isobel.mp3",
    sha256: "563bd5a5686560f56f012d302a672796110cab392a0e3ecbbfdd8f96c6489527",
    fromSeconds: 30,
  },
  {
    id: "mining-by-moonlight",
    title: "Mining by Moonlight",
    note: "медленный лаунж",
    url: "https://incompetech.com/music/royalty-free/mp3-royaltyfree/Mining%20by%20Moonlight.mp3",
    sha256: "683e5638ab2b3017a89d9c9a2ab7a3b516956f9dc5651740fed3508eddd35997",
    fromSeconds: 30,
  },
];

export const builtinOf = (id: string): Builtin | undefined => BUILTIN.find((one) => one.id === id);
