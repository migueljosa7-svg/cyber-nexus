import { META_KEY } from '../config';

export interface MetaData {
  /** Daily login streak. `day` is the 1..7 slot of the last claimed reward. */
  streak: { day: number; last: string; best: number };
  /** Unlocked achievement ids. */
  ach: string[];
  /** Lifetime counters that survive "new game". */
  counters: { drops: number; maxCombo: number; adsWatched: number };
}

function fresh(): MetaData {
  return { streak: { day: 0, last: '', best: 0 }, ach: [], counters: { drops: 0, maxCombo: 0, adsWatched: 0 } };
}

/** Account-level data (streak, achievements). Stored apart from the run save so "NEW GAME" never wipes it. */
export class Meta {
  data: MetaData = fresh();

  constructor() {
    try {
      const raw = localStorage.getItem(META_KEY);
      if (!raw) return;
      const p = JSON.parse(raw) as Partial<MetaData>;
      const d = fresh();
      this.data = {
        streak: { ...d.streak, ...(p.streak ?? {}) },
        ach: Array.isArray(p.ach) ? p.ach.filter((x) => typeof x === 'string') : [],
        counters: { ...d.counters, ...(p.counters ?? {}) },
      };
    } catch {
      this.data = fresh();
    }
  }

  save(): void {
    try { localStorage.setItem(META_KEY, JSON.stringify(this.data)); } catch { /* storage unavailable */ }
  }
}

/** Local calendar day key, e.g. "2026-11-12". */
export function dayKey(d: Date = new Date()): string {
  const p = (n: number): string => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

export function yesterdayKey(): string {
  const d = new Date();
  d.setDate(d.getDate() - 1);
  return dayKey(d);
}
