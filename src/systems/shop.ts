import type { GameContext } from '../context';
import { MAX_GEAR, type GearId, type ItemId } from '../player/player';

export const GEAR_INFO: Record<GearId, { label: string; icon: string; perk: (lv: number) => string; look: string }> = {
  laser: { label: 'PLASMA BLADE', icon: '⚔', perk: (l) => `+${12 * l}% damage · longer, evolving blade`, look: 'Blade length, colour & slash trail evolve' },
  shield: { label: 'DATA SHIELD CORE', icon: '⬡', perk: (l) => `shield ${70 + 25 * l} HP · ${8 + l}s`, look: 'Larger, brighter energy dome' },
  core: { label: 'ARC CORE', icon: '◉', perk: (l) => `+${12 * l} max energy · +${(1.4 * l).toFixed(1)}/s regen`, look: 'LED strips glow brighter, stronger aura' },
  armor: { label: 'ARMOR PLATING', icon: '▣', perk: (l) => `+${18 * l} integrity · −${(4.5 * l).toFixed(1)}% damage`, look: 'Pauldrons, chest plate, spikes, wings, halo' },
};

/** Credit price to buy tier N+1, and the alternative price in skill points. */
export const GEAR_CREDITS = [400, 900, 1700, 3000, 5200];
export const GEAR_SP = [1, 2, 2, 3, 4];

export const ITEM_INFO: Record<ItemId, { label: string; icon: string; price: number; desc: string; key: string }> = {
  ram: { label: 'RAM PACK', icon: '▦', price: 120, desc: '+60 RAM instantly', key: '1' },
  kit: { label: 'INTEGRITY KIT', icon: '✚', price: 150, desc: '+60 integrity', key: '2' },
  adrenaline: { label: 'ADRENALINE', icon: '⚡', price: 220, desc: '+25% speed & damage · 12s', key: '3' },
};
const MAX_STACK = 9;

/** Black-market storefront: gear tiers (credits or skill points), consumables and watch-to-earn offers. */
export class Shop {
  private el: HTMLElement;
  private onKey = (e: KeyboardEvent): void => {
    e.stopPropagation();
    if (e.code === 'Escape' || e.code === 'KeyB') { e.preventDefault(); this.close(); }
  };
  private timer = 0;

  constructor(private ctx: GameContext, root: HTMLElement) {
    this.el = document.createElement('div');
    this.el.className = 'screen shop hidden';
    root.appendChild(this.el);
    this.el.addEventListener('click', (e) => {
      const t = (e.target as HTMLElement).closest('[data-a]') as HTMLElement | null;
      if (t && !t.hasAttribute('disabled')) this.action(t.dataset.a!, t.dataset.id ?? '', t.dataset.cur ?? '');
    });
  }

  get isOpen(): boolean { return !this.el.classList.contains('hidden'); }

  open(): void {
    if (this.isOpen || this.ctx.player.dead) return;
    this.el.classList.remove('hidden');
    this.ctx.modal.open();
    window.addEventListener('keydown', this.onKey, true);
    this.render();
    // Cooldown labels on the ad offers tick.
    this.timer = window.setInterval(() => {
      const a = this.ctx.ads;
      if (!a.isBusy && (a.status('ram_refill').wait > 0 || a.status('rescue_credits').wait > 0)) this.render();
    }, 1000);
  }

  close(): void {
    if (!this.isOpen) return;
    this.el.classList.add('hidden');
    this.el.innerHTML = '';
    window.clearInterval(this.timer);
    window.removeEventListener('keydown', this.onKey, true);
    this.ctx.modal.close();
  }

  // ───────────────────────────── purchase logic ─────────────────────────────

  /** Returns an error message, or null on success. */
  buyGear(id: GearId, cur: 'credits' | 'sp'): string | null {
    const p = this.ctx.player.profile;
    const lv = p.gear[id];
    if (lv >= MAX_GEAR) return 'ALREADY AT MAX TIER';
    if (cur === 'credits') {
      if (!this.ctx.player.spendCredits(GEAR_CREDITS[lv])) return 'NOT ENOUGH CREDITS';
    } else {
      const sp = GEAR_SP[lv];
      if (p.skillPoints < sp) return 'NOT ENOUGH SKILL POINTS';
      p.skillPoints -= sp;
    }
    p.gear[id]++;
    const pl = this.ctx.player;
    const maxBefore = (id === 'armor' ? 18 : 0);
    pl.applyGear();
    if (id === 'armor') pl.heal(maxBefore);
    if (id === 'core') pl.energy = Math.min(pl.maxEnergy, pl.energy + 12);
    this.ctx.progress.checkAchievements();
    this.ctx.save();
    return null;
  }

  buyItem(id: ItemId): string | null {
    const p = this.ctx.player.profile;
    if (p.items[id] >= MAX_STACK) return 'STACK FULL';
    if (!this.ctx.player.spendCredits(ITEM_INFO[id].price)) return 'NOT ENOUGH CREDITS';
    p.items[id]++;
    this.ctx.save();
    return null;
  }

  private action(a: string, id: string, cur: string): void {
    const { ui, audio, player } = this.ctx;
    let err: string | null = null;
    if (a === 'gear') err = this.buyGear(id as GearId, cur as 'credits' | 'sp');
    else if (a === 'item') err = this.buyItem(id as ItemId);
    else if (a === 'use') {
      const msg = player.useItem(id as ItemId);
      if (msg) ui.toast(msg, 'ok'); else err = 'CANNOT USE RIGHT NOW';
    } else if (a === 'ad') { void this.watch(id as 'ram_refill' | 'rescue_credits'); return; }
    else if (a === 'close') { this.close(); return; }
    if (err) { audio.error(); ui.toast(err, 'warn'); } else { audio.success(); }
    this.render();
  }

  private async watch(p: 'ram_refill' | 'rescue_credits'): Promise<void> {
    const { player, ui, ads } = this.ctx;
    await ads.request(p, {
      onAdCompleted: () => {
        if (p === 'ram_refill') { player.ram = player.maxRam; ui.toast('RAM FULLY RECHARGED', 'ok'); } else {
          const c = this.rescueAmount();
          player.addCredits(c);
          ui.toast(`RESCUE FUNDS  +¢${c}`, 'ok');
        }
      },
      onAdFailed: (_pl, reason) => ui.toast(reason === 'cooldown' || reason === 'limit' ? 'AD NOT AVAILABLE RIGHT NOW' : 'AD NOT COMPLETED — NO REWARD', 'warn'),
    });
    if (this.isOpen) this.render();
  }

  /** Credit payout of the "rescue funds" ad. */
  rescueAmount(): number {
    return 300 + this.ctx.player.profile.level * 60;
  }

  // ───────────────────────────── view ─────────────────────────────

  private render(): void {
    if (!this.isOpen) return;
    const { player, ads } = this.ctx;
    const p = player.profile;
    const prevScroll = this.el.querySelector('.sh-scroll')?.scrollTop ?? 0;
    const gear = (Object.keys(GEAR_INFO) as GearId[]).map((id) => {
      const info = GEAR_INFO[id];
      const lv = p.gear[id];
      const max = lv >= MAX_GEAR;
      const pips = Array.from({ length: MAX_GEAR }, (_, i) => `<i class="${i < lv ? 'on' : ''}"></i>`).join('');
      const cost = GEAR_CREDITS[lv];
      const sp = GEAR_SP[lv];
      return `<div class="sh-card">
        <div class="sh-ico">${info.icon}</div>
        <div class="sh-body">
          <b>${info.label}</b><div class="sh-pips">${pips}</div>
          <small>NOW: ${lv ? info.perk(lv) : 'stock'}</small>
          <small>${max ? 'MAX TIER' : `NEXT: ${info.perk(lv + 1)}`}</small>
          <small class="sh-look">◈ ${info.look}</small>
        </div>
        <div class="sh-buy">
          <button class="btn sh-btn" data-a="gear" data-id="${id}" data-cur="credits" type="button" ${max || p.credits < cost ? 'disabled' : ''}>${max ? 'MAX' : `¢${cost}`}</button>
          <button class="btn sh-btn alt" data-a="gear" data-id="${id}" data-cur="sp" type="button" ${max || p.skillPoints < sp ? 'disabled' : ''}>${max ? '—' : `${sp} SP`}</button>
        </div>
      </div>`;
    }).join('');
    const items = (Object.keys(ITEM_INFO) as ItemId[]).map((id) => {
      const it = ITEM_INFO[id];
      return `<div class="sh-card item">
        <div class="sh-ico">${it.icon}</div>
        <div class="sh-body"><b>${it.label} <span class="sh-own">×${p.items[id]}</span></b><small>${it.desc}</small><small>HOTKEY [${it.key}]</small></div>
        <div class="sh-buy">
          <button class="btn sh-btn" data-a="item" data-id="${id}" type="button" ${p.credits < it.price || p.items[id] >= MAX_STACK ? 'disabled' : ''}>¢${it.price}</button>
          <button class="btn sh-btn alt" data-a="use" data-id="${id}" type="button" ${p.items[id] <= 0 ? 'disabled' : ''}>USE</button>
        </div>
      </div>`;
    }).join('');
    const ramS = ads.status('ram_refill');
    const resS = ads.status('rescue_credits');
    const adBtn = (s: { ok: boolean; left: number; wait: number }, id: string, label: string): string =>
      `<button class="btn sh-btn ad" data-a="ad" data-id="${id}" type="button" ${s.ok ? '' : 'disabled'}>${s.wait > 0 ? `${s.wait}s` : s.left <= 0 ? 'LIMIT' : `▶ ${label}`}</button>`;
    this.el.innerHTML = `
      <div class="sh-panel">
        <div class="sh-head">
          <h2>BLACK MARKET</h2>
          <div class="sh-wallet"><span>¢ <b>${p.credits.toLocaleString()}</b></span><span>SP <b>${p.skillPoints}</b></span></div>
          <button class="btn ghost sh-x" data-a="close" type="button">CLOSE [B]</button>
        </div>
        <div class="sh-scroll">
          <h3>// GEAR — your runner changes as you upgrade</h3>
          <div class="sh-grid">${gear}</div>
          <h3>// CONSUMABLES</h3>
          <div class="sh-grid">${items}</div>
          <h3>// WATCH-TO-EARN</h3>
          <div class="sh-grid">
            <div class="sh-card"><div class="sh-ico">▦</div><div class="sh-body"><b>INSTANT RAM RECHARGE</b><small>Watch a 30s broadcast · RAM → full</small><small>${ramS.left} left this session</small></div><div class="sh-buy">${adBtn(ramS, 'ram_refill', 'WATCH')}</div></div>
            <div class="sh-card"><div class="sh-ico">¢</div><div class="sh-body"><b>RESCUE CREDITS</b><small>Watch a 30s broadcast · +¢${this.rescueAmount()}</small><small>${resS.left} left this session</small></div><div class="sh-buy">${adBtn(resS, 'rescue_credits', 'WATCH')}</div></div>
          </div>
        </div>
      </div>`;
    const sc = this.el.querySelector('.sh-scroll');
    if (sc) sc.scrollTop = prevScroll;
  }
}
