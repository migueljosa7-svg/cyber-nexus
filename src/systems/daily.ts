import type { GameContext } from '../context';
import { MAX_GEAR, type GearId } from '../player/player';
import { dayKey, yesterdayKey } from './meta';

interface DayReward {
  title: string;
  desc: string;
  icon: string;
  /** Applies the reward (`x` = 2 when doubled by a rewarded ad). Returns log lines. */
  grant(ctx: GameContext, x: number): string[];
}

const gearBump = (ctx: GameContext, id: GearId, label: string, fallbackCredits: number): string => {
  const p = ctx.player.profile;
  if (p.gear[id] < MAX_GEAR) {
    p.gear[id]++;
    ctx.player.applyGear();
    return `${label} +1 TIER`;
  }
  ctx.player.addCredits(fallbackCredits);
  return `${label} maxed → +¢${fallbackCredits}`;
};

const REWARDS: DayReward[] = [
  { title: 'CREDIT STASH', desc: '¢300', icon: '¢', grant: (c, x) => { c.player.addCredits(300 * x); return [`+¢${300 * x}`]; } },
  {
    title: 'RAM EXPANSION', desc: '+1 NEURAL RAM LV', icon: '▦',
    grant: (c, x) => {
      const p = c.player.profile;
      const out: string[] = [];
      if (p.up.ram < 10) { p.up.ram++; out.push('NEURAL RAM +1 LEVEL'); } else { c.player.addCredits(400); out.push('+¢400'); }
      p.items.ram += x;
      out.push(`+${x} RAM PACK`);
      return out;
    },
  },
  { title: 'WEAPON TUNE-UP', desc: '+1 LASER TIER', icon: '⚔', grant: (c) => [gearBump(c, 'laser', 'PLASMA BLADE', 600)] },
  {
    title: 'BLACK MARKET', desc: '¢700 · 2 RAM PACKS · KIT', icon: '◈',
    grant: (c, x) => {
      const p = c.player.profile;
      c.player.addCredits(700 * x);
      p.items.ram += 2 * x;
      p.items.kit += x;
      return [`+¢${700 * x}`, `+${2 * x} RAM PACK`, `+${x} INTEGRITY KIT`];
    },
  },
  { title: 'SHIELD CAPACITOR', desc: '+1 SHIELD TIER', icon: '⬡', grant: (c) => [gearBump(c, 'shield', 'DATA SHIELD', 600)] },
  {
    title: 'RUNNER SUPPLY', desc: '2 SKILL PTS · 2 KITS · ADRENALINE', icon: '✚',
    grant: (c, x) => {
      const p = c.player.profile;
      p.skillPoints += 2 * x;
      p.items.kit += 2 * x;
      p.items.adrenaline += x;
      return [`+${2 * x} SKILL POINTS`, `+${2 * x} INTEGRITY KIT`, `+${x} ADRENALINE`];
    },
  },
  {
    title: 'JACKPOT', desc: '¢3000 · ARMOR TIER · 2 ADRENALINE', icon: '★',
    grant: (c, x) => {
      c.player.addCredits(3000 * x);
      c.player.profile.items.adrenaline += 2 * x;
      return [`+¢${3000 * x}`, gearBump(c, 'armor', 'ARMOR PLATING', 1500), `+${2 * x} ADRENALINE`];
    },
  },
];

/** Day-by-day login streak with a holographic reward panel. The streak resets if a calendar day is skipped. */
export class DailyStreak {
  private el: HTMLElement;
  private pendingDay = 0;
  private busy = false;
  private onKey = (e: KeyboardEvent): void => {
    e.stopPropagation();
    if (e.code === 'Escape') this.close();
  };

  constructor(private ctx: GameContext, root: HTMLElement) {
    this.el = document.createElement('div');
    this.el.className = 'screen daily hidden';
    root.appendChild(this.el);
  }

  get isOpen(): boolean { return !this.el.classList.contains('hidden'); }

  /** Day (1..7) that would be awarded now, or 0 if today's reward was already claimed. */
  nextDay(): number {
    const s = this.ctx.progress.meta.data.streak;
    const today = dayKey();
    if (s.last === today) return 0;
    if (s.last > today) return 0; // clock moved backwards: don't hand out rewards twice
    return s.last === yesterdayKey() ? (s.day % 7) + 1 : 1;
  }

  /** Shows the panel automatically when a reward is waiting. */
  checkOnStart(): void {
    if (this.nextDay() > 0) this.open();
  }

  open(): void {
    if (this.isOpen) return;
    const day = this.nextDay();
    const s = this.ctx.progress.meta.data.streak;
    this.pendingDay = day;
    const cards = REWARDS.map((r, i) => {
      const n = i + 1;
      const state = day === 0 ? (n <= s.day ? 'done' : 'locked') : n < day ? 'done' : n === day ? 'today' : 'locked';
      return `<div class="dy-card ${state}"><span class="dy-day">DAY ${n}</span><span class="dy-icon">${r.icon}</span><b>${r.title}</b><small>${r.desc}</small>${state === 'done' ? '<em>✔</em>' : ''}</div>`;
    }).join('');
    const streakDays = day === 0 ? s.day : day;
    const claim = day > 0
      ? `<button class="btn primary" data-a="claim" type="button">CLAIM DAY ${day}</button>
         <button class="btn" data-a="double" type="button">▶ WATCH AD · CLAIM ×2</button>
         <button class="btn ghost" data-a="later" type="button">LATER</button>`
      : `<p class="dy-done">TODAY'S REWARD CLAIMED — COME BACK TOMORROW TO KEEP YOUR STREAK</p><button class="btn" data-a="later" type="button">CLOSE</button>`;
    this.el.innerHTML = `
      <div class="dy-holo">
        <div class="dy-scan"></div>
        <h2>DAILY UPLINK</h2>
        <div class="dy-sub">STREAK <b>${streakDays}</b> · BEST <b>${Math.max(s.best, streakDays)}</b> · LOG IN EVERY DAY, REWARDS STACK</div>
        <div class="dy-grid">${cards}</div>
        <div class="dy-actions">${claim}</div>
      </div>`;
    this.el.classList.remove('hidden');
    this.ctx.modal.open();
    window.addEventListener('keydown', this.onKey, true);
    this.el.querySelector('[data-a="claim"]')?.addEventListener('click', () => void this.claim(1));
    this.el.querySelector('[data-a="double"]')?.addEventListener('click', () => void this.claim(2));
    this.el.querySelector('[data-a="later"]')?.addEventListener('click', () => this.close());
  }

  close(): void {
    if (!this.isOpen || this.busy) return;
    this.el.classList.add('hidden');
    this.el.innerHTML = '';
    window.removeEventListener('keydown', this.onKey, true);
    this.ctx.modal.close();
  }

  private async claim(x: 1 | 2): Promise<void> {
    const day = this.pendingDay;
    if (this.busy || day < 1) return;
    if (this.nextDay() !== day) { this.close(); return; }
    this.busy = true;
    let mult = 1;
    if (x === 2) {
      const ok = await this.ctx.ads.request('daily_double');
      if (ok) mult = 2;
      else this.ctx.ui.toast('AD NOT COMPLETED — NORMAL REWARD', 'warn');
    }
    this.busy = false;
    // Re-validate: the panel may have been closed / claimed while the ad was playing.
    if (!this.isOpen || this.nextDay() !== day) return;
    const meta = this.ctx.progress.meta;
    const s = meta.data.streak;
    s.day = day;
    s.last = dayKey();
    s.best = Math.max(s.best, day);
    const lines = REWARDS[day - 1].grant(this.ctx, mult);
    if (mult === 2) {
      this.ctx.player.addCredits(day === 3 || day === 5 ? 500 : 0);
    }
    meta.save();
    this.ctx.save();
    this.ctx.audio.success();
    this.ctx.ui.toast(`DAY ${day} CLAIMED  ${lines.join('  ·  ')}`, 'ok');
    this.ctx.progress.checkAchievements();
    this.close();
  }
}
