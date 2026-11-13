import * as THREE from 'three';
import { CITY } from '../config';
import type { GameContext } from '../context';
import type { ItemId } from '../player/player';
import type { MissionMarker } from './missions';
import { Meta } from './meta';

interface Achievement {
  id: string;
  name: string;
  desc: string;
  reward: number;
  test(c: GameContext, m: Meta): boolean;
}

export const ACHIEVEMENTS: Achievement[] = [
  { id: 'first_blood', name: 'FIRST BLOOD', desc: 'Purge 1 hostile', reward: 100, test: (c) => c.state.kills >= 1 },
  { id: 'slayer', name: 'SLAYER', desc: 'Purge 50 hostiles', reward: 500, test: (c) => c.state.kills >= 50 },
  { id: 'exterminator', name: 'EXTERMINATOR', desc: 'Purge 250 hostiles', reward: 2000, test: (c) => c.state.kills >= 250 },
  { id: 'script_kiddie', name: 'SCRIPT KIDDIE', desc: 'Hack 5 systems', reward: 150, test: (c) => c.state.hacks >= 5 },
  { id: 'netrunner', name: 'NETRUNNER', desc: 'Hack 40 systems', reward: 800, test: (c) => c.state.hacks >= 40 },
  { id: 'contractor', name: 'CONTRACTOR', desc: 'Complete a contract', reward: 250, test: (c) => c.state.missionsDone >= 1 },
  { id: 'fixer', name: 'FIXER', desc: 'Complete 10 contracts', reward: 1500, test: (c) => c.state.missionsDone >= 10 },
  { id: 'combo_x2', name: 'ON A ROLL', desc: 'Reach combo multiplier ×2', reward: 300, test: (_c, m) => m.data.counters.maxCombo >= 20 },
  { id: 'combo_x3', name: 'UNSTOPPABLE', desc: 'Reach combo multiplier ×3', reward: 900, test: (_c, m) => m.data.counters.maxCombo >= 40 },
  { id: 'lvl5', name: 'RISING RUNNER', desc: 'Reach level 5', reward: 400, test: (c) => c.player.profile.level >= 5 },
  { id: 'lvl10', name: 'LEGEND OF THE GRID', desc: 'Reach level 10', reward: 1500, test: (c) => c.player.profile.level >= 10 },
  { id: 'rich', name: 'CORPO MONEY', desc: 'Hold ¢5000', reward: 500, test: (c) => c.player.profile.credits >= 5000 },
  { id: 'chromed', name: 'CHROMED OUT', desc: 'Max out any gear', reward: 1000, test: (c) => Object.values(c.player.profile.gear).some((v) => v >= 5) },
  { id: 'drops', name: 'SCAVENGER', desc: 'Grab 5 data drops', reward: 400, test: (_c, m) => m.data.counters.drops >= 5 },
  { id: 'streak3', name: 'REGULAR', desc: '3-day login streak', reward: 300, test: (_c, m) => m.data.streak.best >= 3 },
  { id: 'streak7', name: 'ADDICTED', desc: '7-day login streak', reward: 1500, test: (_c, m) => m.data.streak.best >= 7 },
];

const COMBO_WINDOW = 3.2;
const DROP_LIFE = 32;

type DropKind = 'credits' | 'ram' | 'energy' | 'kit';

/**
 * Engagement layer: combo multiplier, quick street events (data drops), achievements, quick-item bar,
 * the watch-to-double mission offer, and all of their small HUD widgets.
 */
export class Progress {
  readonly meta = new Meta();

  /** Hits chained inside the combo window. */
  combo = 0;
  private comboT = 0;

  private root: HTMLElement;
  private comboEl: HTMLElement;
  private itemEls: Record<ItemId, HTMLElement>;
  private offerEl: HTMLButtonElement;
  private offer: { credits: number; xp: number; t: number } | null = null;
  private lastItemKey = '';
  private lastComboKey = '';

  // street event
  private drop = new THREE.Group();
  private dropGem: THREE.Mesh;
  private dropActive = false;
  private dropT = 0;
  private dropKind: DropKind = 'credits';
  private nextDropIn = 40;
  private achT = 0;
  private tmp = new THREE.Vector3();
  private readonly geos: THREE.BufferGeometry[] = [];
  private readonly mats: THREE.Material[] = [];

  constructor(private ctx: GameContext, scene: THREE.Scene, hudRoot: HTMLElement) {
    this.root = hudRoot;
    const touch = ctx.input.isTouch;
    this.comboEl = document.createElement('div');
    this.comboEl.className = 'combo hidden';
    hudRoot.appendChild(this.comboEl);

    const bar = document.createElement('div');
    bar.className = 'items';
    bar.innerHTML = `
      <button type="button" class="it" data-i="ram"><span class="ik">${touch ? '' : '1'}</span><b>▦</b><em>RAM</em><u>0</u></button>
      <button type="button" class="it" data-i="kit"><span class="ik">${touch ? '' : '2'}</span><b>✚</b><em>KIT</em><u>0</u></button>
      <button type="button" class="it" data-i="adrenaline"><span class="ik">${touch ? '' : '3'}</span><b>⚡</b><em>ADR</em><u>0</u></button>
      <button type="button" class="it shopbtn" data-i="shop"><span class="ik">${touch ? '' : 'B'}</span><b>¢</b><em>SHOP</em></button>`;
    hudRoot.appendChild(bar);
    this.itemEls = {
      ram: bar.querySelector('[data-i="ram"]') as HTMLElement,
      kit: bar.querySelector('[data-i="kit"]') as HTMLElement,
      adrenaline: bar.querySelector('[data-i="adrenaline"]') as HTMLElement,
    };
    bar.addEventListener('pointerdown', (e) => {
      const t = (e.target as HTMLElement).closest('[data-i]') as HTMLElement | null;
      if (!t) return;
      e.preventDefault();
      if (t.dataset.i === 'shop') this.openShop();
      else this.useItem(t.dataset.i as ItemId);
    });

    this.offerEl = document.createElement('button');
    this.offerEl.type = 'button';
    this.offerEl.className = 'offer hidden';
    hudRoot.appendChild(this.offerEl);
    this.offerEl.addEventListener('pointerdown', (e) => { e.preventDefault(); void this.claimOffer(); });

    // Data drop beacon (one pooled object).
    const gemGeo = new THREE.OctahedronGeometry(0.55, 0);
    const ringGeo = new THREE.RingGeometry(1.1, 1.35, 32).rotateX(-Math.PI / 2);
    const beamGeo = new THREE.CylinderGeometry(0.35, 0.8, 40, 12, 1, true).translate(0, 20, 0);
    const gemMat = new THREE.MeshBasicMaterial({ color: new THREE.Color(3.2, 2.6, 0.4) });
    const ringMat = new THREE.MeshBasicMaterial({ color: new THREE.Color(3.2, 2.2, 0.3), side: THREE.DoubleSide, transparent: true, opacity: 0.85 });
    const beamMat = new THREE.MeshBasicMaterial({ color: new THREE.Color(1.6, 1.2, 0.2), transparent: true, opacity: 0.16, blending: THREE.AdditiveBlending, depthWrite: false, side: THREE.DoubleSide, fog: false });
    this.geos.push(gemGeo, ringGeo, beamGeo);
    this.mats.push(gemMat, ringMat, beamMat);
    this.dropGem = new THREE.Mesh(gemGeo, gemMat);
    this.dropGem.position.y = 1.4;
    const ring = new THREE.Mesh(ringGeo, ringMat);
    ring.position.y = 0.08;
    this.drop.add(this.dropGem, ring, new THREE.Mesh(beamGeo, beamMat));
    this.drop.visible = false;
    scene.add(this.drop);
  }

  // ───────────────────────────── combo ─────────────────────────────

  /** Current kill-reward multiplier (×1.0 … ×3.0). */
  get comboMult(): number {
    return 1 + Math.min(8, Math.floor(this.combo / 5)) * 0.25;
  }

  registerHit(): void {
    this.combo++;
    this.comboT = COMBO_WINDOW;
    const d = this.meta.data.counters;
    if (this.combo > d.maxCombo) d.maxCombo = this.combo;
  }

  onPlayerHurt(): void {
    if (this.combo > 0) this.combo = Math.floor(this.combo / 2);
  }

  // ───────────────────────────── lifecycle ─────────────────────────────

  /** Fresh world (new game / respawn). */
  reset(): void {
    this.combo = 0;
    this.comboT = 0;
    this.endDrop();
    this.nextDropIn = 35 + Math.random() * 30;
    this.offer = null;
    this.offerEl.classList.add('hidden');
  }

  bindEvents(): void {
    this.ctx.engine.events.on('missionCompleted', () => {
      const r = this.ctx.missions.lastReward;
      if (r.credits <= 0) return;
      this.offer = { credits: r.credits, xp: r.xp, t: 16 };
      const key = this.ctx.input.isTouch ? 'TAP' : '[G]';
      this.offerEl.innerHTML = `<b>CONTRACT PAID</b><span>${key} ▶ WATCH AD · DOUBLE: +¢${r.credits} +${r.xp} XP</span>`;
      this.offerEl.classList.remove('hidden');
      this.checkAchievements();
    });
    this.ctx.engine.events.on('enemyKilled', () => this.checkAchievements());
    this.ctx.engine.events.on('levelUp', () => this.checkAchievements());
  }

  update(dt: number): void {
    const { input, player } = this.ctx;
    if (player.dead) return;

    // combo decay
    if (this.combo > 0) {
      this.comboT -= dt;
      if (this.comboT <= 0) this.combo = 0;
    }

    // hotkeys
    if (input.consume('shop')) this.openShop();
    if (input.consume('item1')) this.useItem('ram');
    if (input.consume('item2')) this.useItem('kit');
    if (input.consume('item3')) this.useItem('adrenaline');
    if (input.consume('offer')) void this.claimOffer();

    // double-reward offer countdown
    if (this.offer) {
      this.offer.t -= dt;
      if (this.offer.t <= 0) { this.offer = null; this.offerEl.classList.add('hidden'); }
    }

    this.updateDrop(dt);

    this.achT -= dt;
    if (this.achT <= 0) { this.achT = 1.5; this.checkAchievements(); }
  }

  /** Per-frame HUD widgets (also runs while paused so counts stay in sync). */
  updateHud(): void {
    const { player } = this.ctx;
    const comboKey = `${this.combo}|${this.comboMult}|${Math.ceil(this.comboT * 4)}`;
    if (comboKey !== this.lastComboKey) {
      this.lastComboKey = comboKey;
      if (this.combo >= 3) {
        const pct = Math.max(0, Math.min(100, (this.comboT / COMBO_WINDOW) * 100));
        this.comboEl.innerHTML = `<div class="cb-n">${this.combo}<small>HITS</small></div><div class="cb-m">×${this.comboMult.toFixed(2)}</div><div class="cb-bar"><i style="width:${pct}%"></i></div>`;
        this.comboEl.classList.remove('hidden');
      } else this.comboEl.classList.add('hidden');
    }
    const it = player.profile.items;
    const key = `${it.ram}|${it.kit}|${it.adrenaline}|${player.adrenaline > 0}`;
    if (key !== this.lastItemKey) {
      this.lastItemKey = key;
      for (const id of ['ram', 'kit', 'adrenaline'] as ItemId[]) {
        const el = this.itemEls[id];
        (el.querySelector('u') as HTMLElement).textContent = String(it[id]);
        el.classList.toggle('empty', it[id] <= 0);
        el.classList.toggle('active', id === 'adrenaline' && player.adrenaline > 0);
      }
    }
  }

  // ───────────────────────────── items / shop / offers ─────────────────────────────

  private openShop(): void {
    if (this.ctx.engine.state !== 'playing' || this.ctx.player.dead) return;
    this.ctx.shop.open();
  }

  useItem(id: ItemId): void {
    if (this.ctx.engine.state !== 'playing') return;
    const msg = this.ctx.player.useItem(id);
    if (msg) { this.ctx.ui.toast(msg, 'ok'); this.ctx.audio.pickup(); } else { this.ctx.audio.error(); }
  }

  private async claimOffer(): Promise<void> {
    const o = this.offer;
    if (!o || this.ctx.engine.state !== 'playing') return;
    this.offer = null;
    this.offerEl.classList.add('hidden');
    await this.ctx.ads.request('double_reward', {
      onAdCompleted: () => {
        this.ctx.player.addCredits(o.credits);
        this.ctx.player.addXp(o.xp);
        this.ctx.ui.toast(`REWARD DOUBLED  +¢${o.credits}  +${o.xp} XP`, 'ok');
      },
      onAdFailed: () => {
        this.ctx.ui.toast('AD NOT COMPLETED — NO BONUS', 'warn');
        // Keep the offer alive for a retry if the ad simply wasn't available / was skipped.
        if (this.ctx.engine.state === 'playing' || this.ctx.engine.state === 'paused') {
          this.offer = { ...o, t: Math.max(6, o.t) };
          this.offerEl.classList.remove('hidden');
        }
      },
    });
  }

  // ───────────────────────────── street event: data drop ─────────────────────────────

  private updateDrop(dt: number): void {
    const { player, ui, audio, fx, city } = this.ctx;
    if (!this.dropActive) {
      this.nextDropIn -= dt;
      if (this.nextDropIn > 0) return;
      // Pick a spot on a nearby street, outside any building.
      for (let tries = 0; tries < 8; tries++) {
        const ang = Math.random() * Math.PI * 2;
        const dist = 24 + Math.random() * 16;
        let x = player.pos.x + Math.cos(ang) * dist;
        let z = player.pos.z + Math.sin(ang) * dist;
        const S = CITY.S;
        if (Math.random() < 0.5) x = Math.round(x / S) * S + (Math.random() - 0.5) * 5;
        else z = Math.round(z / S) * S + (Math.random() - 0.5) * 5;
        const p = this.tmp.set(x, 0, z);
        if (city.resolve(p, 1.2)) continue;
        this.drop.position.set(p.x, 0, p.z);
        this.drop.visible = true;
        this.dropActive = true;
        this.dropT = DROP_LIFE;
        const r = Math.random();
        this.dropKind = r < 0.5 ? 'credits' : r < 0.7 ? 'ram' : r < 0.85 ? 'energy' : 'kit';
        ui.toast('DATA DROP DETECTED — GRAB IT!', 'info');
        audio.pickup();
        return;
      }
      this.nextDropIn = 10;
      return;
    }
    this.dropT -= dt;
    this.dropGem.rotation.y += dt * 2.4;
    this.dropGem.position.y = 1.4 + Math.sin(this.ctx.engine.clock * 3) * 0.25;
    const d = Math.hypot(player.pos.x - this.drop.position.x, player.pos.z - this.drop.position.z);
    if (d < 2.3 && player.pos.y < 2.5) {
      this.grabDrop();
      fx.burst(this.tmp.set(this.drop.position.x, 1.4, this.drop.position.z), { color: 0xffd400, color2: 0xffffff, count: 44, speed: 9, life: 0.7, size: 0.32, gravity: -3 });
      this.endDrop();
    } else if (this.dropT <= 0) {
      ui.toast('DATA DROP EXPIRED', 'warn');
      this.endDrop();
    }
  }

  private grabDrop(): void {
    const { player, ui, audio } = this.ctx;
    const d = this.meta.data.counters;
    d.drops++;
    this.meta.save();
    audio.success();
    switch (this.dropKind) {
      case 'credits': { const c = Math.round((120 + Math.random() * 200) * (1 + player.profile.level * 0.15)); player.addCredits(c); ui.toast(`DATA DROP  +¢${c}`, 'ok'); break; }
      case 'ram': player.ram = player.maxRam; ui.toast('DATA DROP  RAM RECHARGED', 'ok'); break;
      case 'energy': player.energy = player.maxEnergy; ui.toast('DATA DROP  ENERGY RECHARGED', 'ok'); break;
      case 'kit': player.profile.items.kit = Math.min(9, player.profile.items.kit + 1); ui.toast('DATA DROP  +1 INTEGRITY KIT', 'ok'); break;
    }
    this.checkAchievements();
  }

  private endDrop(): void {
    this.dropActive = false;
    this.drop.visible = false;
    this.nextDropIn = 45 + Math.random() * 45;
  }

  markers(out: MissionMarker[]): void {
    if (!this.dropActive) return;
    out.push({ id: 'drop', pos: this.drop.position.clone().setY(0), label: `DATA DROP ${Math.ceil(this.dropT)}s`, color: '#ffd400', kind: 'mission' });
  }

  // ───────────────────────────── achievements ─────────────────────────────

  checkAchievements(): void {
    const { ui, audio, player } = this.ctx;
    if (this.ctx.engine.state === 'menu' || this.ctx.engine.state === 'loading') return;
    for (const a of ACHIEVEMENTS) {
      if (this.meta.data.ach.includes(a.id)) continue;
      if (!a.test(this.ctx, this.meta)) continue;
      this.meta.data.ach.push(a.id);
      player.addCredits(a.reward);
      this.meta.save();
      ui.toast(`🏆 ${a.name}  +¢${a.reward}`, 'ok');
      audio.success();
    }
  }

  /** Console listing for `/achievements`. */
  list(): Array<{ name: string; desc: string; reward: number; done: boolean }> {
    return ACHIEVEMENTS.map((a) => ({ name: a.name, desc: a.desc, reward: a.reward, done: this.meta.data.ach.includes(a.id) }));
  }

  dispose(): void {
    this.geos.forEach((g) => g.dispose());
    this.mats.forEach((m) => m.dispose());
    this.root.querySelectorAll('.combo,.items,.offer').forEach((e) => e.remove());
  }
}
