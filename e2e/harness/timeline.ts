/**
 * What happened and when, in milliseconds since the scenario began — on both sides of the
 * link, and what came out of the phone's speaker. A failing assertion prints all of it,
 * because the order of events is the whole story in a race.
 */

export type Moment = { at: number; what: string; detail: string };

/** A stretch of sound the speaker put out. `to` is cut short when playback is stopped. */
export type Heard = { label: string; from: number; to: number };

export type Timeline = ReturnType<typeof createTimeline>;

export function createTimeline() {
  const started = performance.now();
  const moments: Moment[] = [];
  const heard: Heard[] = [];
  const now = (): number => Math.round(performance.now() - started);

  return {
    now,
    moments,
    heard,

    note(what: string, detail = ""): void {
      moments.push({ at: now(), what, detail });
    },

    /** The sounds audible at any point after `from`, longest first; empty stretches skipped. */
    heardAfter(from: number): Heard[] {
      return heard.filter((one) => one.to > from && one.to > one.from).sort((a, b) => b.to - b.from - (a.to - a.from));
    },

    render(): string {
      const lines = [
        ...moments.map((one) => ({ at: one.at, text: `${one.what}${one.detail ? `  ${one.detail}` : ""}` })),
        ...heard
          .filter((one) => one.to > one.from)
          .map((one) => ({ at: one.from, text: `♪ ${one.label} audible until ${one.to}` })),
      ].sort((a, b) => a.at - b.at);
      return lines.map((line) => `${String(line.at).padStart(6)} ms  ${line.text}`).join("\n");
    },
  };
}
