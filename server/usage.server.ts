import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { paths } from "./paths.server.ts";
import { TIERS, type TierId } from "./google.server.ts";

/**
 * How many characters have gone to each Google tier this month.
 *
 * Counted here rather than asked of Google: they expose usage only through Cloud
 * Monitoring, minutes behind and awkward to query, while every character passes
 * through this plugin's proxy on its way out. Ours is the earlier and more exact
 * number — Google's own count may differ slightly where it processes markup, which
 * matters for a bill but not for a bar on a screen.
 */

export type Month = string;

/** `{ "2026-10": { "chirp3-hd": 112400 } }` — past months are kept, nothing is pruned. */
type Ledger = Record<Month, Partial<Record<TierId, number>>>;

export const monthOf = (at: Date = new Date()): Month =>
  `${at.getUTCFullYear()}-${String(at.getUTCMonth() + 1).padStart(2, "0")}`;

/** The first of next month, UTC: when Google's free allowance starts over. */
export function resetsAt(at: Date = new Date()): Date {
  return new Date(Date.UTC(at.getUTCFullYear(), at.getUTCMonth() + 1, 1));
}

async function read(): Promise<Ledger> {
  try {
    return JSON.parse(await readFile(paths.usage, "utf8")) as Ledger;
  } catch {
    return {};
  }
}

async function write(ledger: Ledger): Promise<void> {
  await mkdir(paths.root, { recursive: true });
  const staged = `${paths.usage}.tmp`;
  await writeFile(staged, `${JSON.stringify(ledger, null, 2)}\n`, { mode: 0o600 });
  await rename(staged, paths.usage);
}

export type TierUsage = {
  id: TierId;
  label: string;
  note: string;
  used: number;
  free: number;
  dollarsPerMillion: number;
  /** What the overspend would cost today, or 0 while still inside the allowance. */
  owed: number;
};

/** Writes are serialised: several sentences of one answer finish at the same moment. */
let queue: Promise<unknown> = Promise.resolve();

export function record(tier: TierId, characters: number): Promise<void> {
  queue = queue.then(async () => {
    if (characters <= 0) {
      return;
    }
    const ledger = await read();
    const month = monthOf();
    const bucket = ledger[month] ?? {};
    bucket[tier] = (bucket[tier] ?? 0) + characters;
    ledger[month] = bucket;
    await write(ledger);
  });
  return queue.then(() => undefined);
}

export async function summary(month: Month = monthOf()): Promise<TierUsage[]> {
  const bucket = (await read())[month] ?? {};
  return TIERS.map((tier) => {
    const used = bucket[tier.id] ?? 0;
    const over = Math.max(0, used - tier.freeChars);
    return {
      id: tier.id,
      label: tier.label,
      note: tier.note,
      used,
      free: tier.freeChars,
      dollarsPerMillion: tier.dollarsPerMillion,
      owed: (over * tier.dollarsPerMillion) / 1_000_000,
    };
  });
}
