import * as THREE from 'three';
import type { Action, Input } from './input';
import type { AudioFX } from './audio';

export interface HudAbility { key: string; name: string; left: number; cooldown: number; cost: number }

export interface HudData {
  hp: number;
  maxHp: number;
  energy: number;
  maxEnergy: number;
  shieldHp: number;
  shieldTime: number;
  level: number;
  sector: string;
  kills: number;
  need: number;
  score: number;
  combo: number;
  mult: number;
  abilities: HudAbility[];
  dashFrac: number;
  buffs: Array<{ name: string; time: number }>;
}

export interface GameOverStats {
  score: number;
  best: number;
  level: number;
  kills: number;
  hacks: number;
  newBest: boolean;
}

interface Callbacks {
  onStart: () => void;
  onRetry: () => void;
}

interface DmgNumber { el: HTMLElement; pos: THREE.Vector3; life: number; vy: number }

const TOUCH_BUTTONS: Array<{ act: Action; label: string; r: number; b: number; s: number; cls?: string }> = [
  { act: 'attack', label: 'ATK', r: 0.4, b: 0.4, s: 1.6, cls: 'big' },
  { act: 'shoot', label: 'SHOT', r: 2.3, b: 0.3, s: 1.1 },
  { act: 'jump', label: 'JUMP', r: 2.2, b: 1.7, s: 1.1 },
  { act: 'dash', label: 'DASH', r: 0.4, b: 2.2, s: 1.1 },
  { act: 'emp', label: 'EMP', r: 3.75, b: 0.3, s: 1.0, cls: 'skill' },
  { act: 'shield', label: 'SHLD', r: 3.75, b: 1.5, s: 1.0, cls: 'skill' },
  { act: 'burst', label: 'QNTM', r: 3.75, b: 2.7, s: 1.0, cls: 'skill' },
  { act: 'interact', label: 'HACK', r: 0.4, b: 3.6, s: 1.2, cls: 'interact hidden' },
];

const ACT_TO_ABILITY: Partial<Record<Action, number>> = { emp: 0, shield: 1, burst: 2 };

export class UI {
  readonly root: HTMLElement;
  private hud: HTMLElement;
  private menu: HTMLElement;
  private over: HTMLElement;
  private pauseEl: HTMLElement;
  private hintEl: HTMLElement;
  private promptEl: HTMLElement;
  private arrowEl: HTMLElement;
  private arrowIco: HTMLElement;
  private arrowTxt: HTMLElement;
  private toasts: HTMLElement;
  private vig: HTMLElement;
  private dmgLayer: HTMLElement;
  private touchLayer: HTMLElement | null = null;
  private interactBtn: HTMLElement | null = null;
  private touchSkillBtns: Array<HTMLElement | null> = [null, null, null];
  private nums: DmgNumber[] = [];
  private cache = new Map<string, string>();
  private slotEls: HTMLElement[] = [];
  private dashSlot: HTMLElement;
  private v = new THREE.Vector3();

  constructor(root: HTMLElement, private input: Input, private audio: AudioFX, cb: Callbacks) {
    this.root = root;
    const touch = input.isTouch;
    root.innerHTML = `
      <div class="hud hidden">
        <div class="hud-tl">
          <div class="bar hp"><label>INTEGRITY</label><div class="track"><i></i><b></b></div><span class="val"></span></div>
          <div class="bar en"><label>ENERGY</label><div class="track"><i></i><b></b></div><span class="val"></span></div>
          <div class="chip shield hidden">DATA SHIELD <span></span></div>
        </div>
        <div class="hud-tc">
          <div class="sector"></div>
          <div class="objective"></div>
          <div class="obj-track"><i></i></div>
        </div>
        <div class="hud-tr">
          <div class="score"></div>
          <div class="combo"></div>
        </div>
        <div class="buffs"></div>
        ${touch ? '' : `<div class="hud-bc">
          <div class="slot dash"><span class="k">SHIFT</span><span class="n">DASH</span><i></i></div>
          <div class="slot" data-i="0"><span class="k">Q</span><span class="n">EMP</span><i></i></div>
          <div class="slot" data-i="1"><span class="k">E</span><span class="n">SHIELD</span><i></i></div>
          <div class="slot" data-i="2"><span class="k">R</span><span class="n">QUANTUM</span><i></i></div>
        </div>`}
        <div class="prompt hidden"></div>
        <div class="arrow hidden"><div class="arrow-ico">➤</div><span></span></div>
        <div class="toasts"></div>
        <div class="dmg-vig"></div>
        <div class="dmg-layer"></div>
        <div class="hint hidden">CLICK TO CAPTURE MOUSE</div>
      </div>
      <div class="screen pause hidden"><div class="panel"><h2>PAUSED</h2><p>${touch ? 'Tap to resume' : 'Press P or click to resume'}</p></div></div>
      <div class="screen menu">
        <div class="menu-inner">
          <div class="logo glitch" data-text="CYBER-NEXUS">CYBER-NEXUS</div>
          <div class="logo-sub">PROTOCOL ZERO</div>
          <div class="tagline">// the grid never forgets //</div>
          <button class="btn primary" data-act="start" type="button">INITIATE BREACH</button>
          <button class="btn ghost" data-act="controls" type="button">CONTROLS</button>
          <div class="controls hidden">
            ${touch
              ? `<ul><li><b>Left stick</b> move</li><li><b>Drag right side</b> camera</li><li><b>ATK</b> laser sword combo</li><li><b>SHOT</b> energy bolt</li><li><b>JUMP</b> (x2) · <b>DASH</b> i-frames</li><li><b>EMP / SHLD / QNTM</b> super powers</li><li><b>HACK</b> appears near terminals</li></ul>`
              : `<ul><li><b>WASD</b> move · <b>Mouse</b> camera</li><li><b>Click / J</b> laser sword combo</li><li><b>Right click / K</b> energy bolt</li><li><b>Space</b> jump (x2) · <b>Shift</b> dash</li><li><b>Q</b> EMP · <b>E</b> Data Shield · <b>R</b> Quantum Burst</li><li><b>F</b> hack terminal · <b>P</b> pause</li></ul>`}
            <p class="goal">Purge the sector, hack terminals for buffs, then enter the exit portal.</p>
          </div>
          <div class="best"></div>
        </div>
      </div>
      <div class="screen over hidden">
        <div class="panel">
          <h2 class="glitch" data-text="CONNECTION LOST">CONNECTION LOST</h2>
          <div class="stats"></div>
          <button class="btn primary" data-act="retry" type="button">REBOOT RUN</button>
        </div>
      </div>
    `;
    this.hud = root.querySelector('.hud') as HTMLElement;
    this.menu = root.querySelector('.menu') as HTMLElement;
    this.over = root.querySelector('.over') as HTMLElement;
    this.pauseEl = root.querySelector('.pause') as HTMLElement;
    this.hintEl = root.querySelector('.hint') as HTMLElement;
    this.promptEl = root.querySelector('.prompt') as HTMLElement;
    this.arrowEl = root.querySelector('.arrow') as HTMLElement;
    this.arrowIco = root.querySelector('.arrow-ico') as HTMLElement;
    this.arrowTxt = root.querySelector('.arrow span') as HTMLElement;
    this.toasts = root.querySelector('.toasts') as HTMLElement;
    this.vig = root.querySelector('.dmg-vig') as HTMLElement;
    this.dmgLayer = root.querySelector('.dmg-layer') as HTMLElement;
    this.dashSlot = (root.querySelector('.slot.dash') as HTMLElement) ?? document.createElement('div');
    this.slotEls = [...root.querySelectorAll('.slot[data-i]')] as HTMLElement[];

    root.querySelector('[data-act="start"]')!.addEventListener('click', () => { this.audio.unlock(); this.audio.click(); this.requestFullscreen(); cb.onStart(); });
    root.querySelector('[data-act="retry"]')!.addEventListener('click', () => { this.audio.click(); cb.onRetry(); });
    root.querySelector('[data-act="controls"]')!.addEventListener('click', () => {
      this.audio.unlock();
      this.audio.click();
      root.querySelector('.controls')!.classList.toggle('hidden');
    });
    if (touch) this.buildTouch();
  }

  private requestFullscreen(): void {
    if (!this.input.isTouch) return;
    const el = document.documentElement;
    try {
      void el.requestFullscreen?.().then(() => (screen.orientation as ScreenOrientation & { lock?: (o: string) => Promise<void> }).lock?.('landscape')).catch(() => undefined);
    } catch { /* fullscreen is optional */ }
  }

  // ───────────────────────────── touch controls ─────────────────────────────

  private buildTouch(): void {
    const layer = document.createElement('div');
    layer.className = 'touch hidden';
    layer.innerHTML = `<div class="cam-zone"></div><div class="joy-zone"><div class="joy-base"><div class="joy-knob"></div></div></div><div class="tbtns"></div>`;
    this.root.appendChild(layer);
    this.touchLayer = layer;

    const btns = layer.querySelector('.tbtns') as HTMLElement;
    for (const b of TOUCH_BUTTONS) {
      const el = document.createElement('button');
      el.type = 'button';
      el.className = `tb ${b.cls ?? ''}`;
      el.textContent = b.label;
      el.style.setProperty('--r', String(b.r));
      el.style.setProperty('--b', String(b.b));
      el.style.setProperty('--sz', String(b.s));
      el.innerHTML = `<span>${b.label}</span><i></i>`;
      const down = (e: PointerEvent): void => {
        e.preventDefault();
        el.setPointerCapture(e.pointerId);
        el.classList.add('down');
        this.input.press(b.act);
      };
      const up = (): void => { el.classList.remove('down'); this.input.release(b.act); };
      el.addEventListener('pointerdown', down);
      el.addEventListener('pointerup', up);
      el.addEventListener('pointercancel', up);
      el.addEventListener('lostpointercapture', up);
      btns.appendChild(el);
      if (b.act === 'interact') this.interactBtn = el;
      const ai = ACT_TO_ABILITY[b.act];
      if (ai !== undefined) this.touchSkillBtns[ai] = el;
    }

    const zone = layer.querySelector('.joy-zone') as HTMLElement;
    const base = layer.querySelector('.joy-base') as HTMLElement;
    const knob = layer.querySelector('.joy-knob') as HTMLElement;
    let joyId = -1;
    let ox = 0;
    let oy = 0;
    const R = 56;
    zone.addEventListener('pointerdown', (e) => {
      if (joyId !== -1) return;
      e.preventDefault();
      joyId = e.pointerId;
      zone.setPointerCapture(e.pointerId);
      ox = e.clientX;
      oy = e.clientY;
      base.style.left = `${ox}px`;
      base.style.top = `${oy}px`;
      base.classList.add('show');
      knob.style.transform = 'translate(-50%,-50%)';
    });
    zone.addEventListener('pointermove', (e) => {
      if (e.pointerId !== joyId) return;
      let dx = e.clientX - ox;
      let dy = e.clientY - oy;
      const len = Math.hypot(dx, dy);
      if (len > R) { dx = (dx / len) * R; dy = (dy / len) * R; }
      knob.style.transform = `translate(calc(-50% + ${dx}px), calc(-50% + ${dy}px))`;
      const mag = Math.min(1, len / R);
      if (mag < 0.15) this.input.setStick(0, 0);
      else this.input.setStick(dx / R, -dy / R);
    });
    const end = (e: PointerEvent): void => {
      if (e.pointerId !== joyId) return;
      joyId = -1;
      base.classList.remove('show');
      this.input.setStick(0, 0);
    };
    zone.addEventListener('pointerup', end);
    zone.addEventListener('pointercancel', end);

    const cam = layer.querySelector('.cam-zone') as HTMLElement;
    let camId = -1;
    let lx = 0;
    let ly = 0;
    cam.addEventListener('pointerdown', (e) => {
      if (camId !== -1) return;
      e.preventDefault();
      camId = e.pointerId;
      cam.setPointerCapture(e.pointerId);
      lx = e.clientX;
      ly = e.clientY;
    });
    cam.addEventListener('pointermove', (e) => {
      if (e.pointerId !== camId) return;
      this.input.addLook(e.clientX - lx, e.clientY - ly);
      lx = e.clientX;
      ly = e.clientY;
    });
    const camEnd = (e: PointerEvent): void => { if (e.pointerId === camId) camId = -1; };
    cam.addEventListener('pointerup', camEnd);
    cam.addEventListener('pointercancel', camEnd);

    this.pauseEl.addEventListener('pointerdown', () => this.input.press('pause'));
  }

  // ───────────────────────────── screens ─────────────────────────────

  showMenu(best: number): void {
    (this.root.querySelector('.best') as HTMLElement).textContent = best > 0 ? `BEST SCORE  ${best.toLocaleString()}` : 'NO RECORDS YET';
    this.menu.classList.remove('hidden');
    this.over.classList.add('hidden');
    this.setHudVisible(false);
  }

  hideMenu(): void {
    this.menu.classList.add('hidden');
  }

  showGameOver(s: GameOverStats): void {
    (this.over.querySelector('.stats') as HTMLElement).innerHTML = `
      <div><span>SCORE</span><b>${s.score.toLocaleString()}</b></div>
      <div><span>BEST</span><b>${s.best.toLocaleString()}${s.newBest ? ' ★ NEW' : ''}</b></div>
      <div><span>SECTOR</span><b>${s.level}</b></div>
      <div><span>HOSTILES PURGED</span><b>${s.kills}</b></div>
      <div><span>NODES HACKED</span><b>${s.hacks}</b></div>`;
    this.over.classList.remove('hidden');
    this.setHudVisible(false);
  }

  hideGameOver(): void {
    this.over.classList.add('hidden');
  }

  setHudVisible(v: boolean): void {
    this.hud.classList.toggle('hidden', !v);
    this.touchLayer?.classList.toggle('hidden', !v);
    if (!v) {
      this.nums.forEach((n) => n.el.remove());
      this.nums.length = 0;
      this.toasts.innerHTML = '';
    }
  }

  setPaused(p: boolean): void {
    this.pauseEl.classList.toggle('hidden', !p);
  }

  setMouseHint(show: boolean): void {
    this.hintEl.classList.toggle('hidden', !show);
  }

  // ───────────────────────────── HUD ─────────────────────────────

  private set(key: string, value: string, apply: (v: string) => void): void {
    if (this.cache.get(key) === value) return;
    this.cache.set(key, value);
    apply(value);
  }

  setHud(d: HudData): void {
    const q = <T extends HTMLElement>(s: string): T => this.hud.querySelector(s) as T;
    const hpPct = Math.round((d.hp / d.maxHp) * 100);
    this.set('hp', `${hpPct}|${Math.round(d.hp)}|${Math.round(d.shieldHp)}`, () => {
      q('.hp .track i').style.width = `${hpPct}%`;
      q('.hp .track b').style.width = `${Math.min(100, (d.shieldHp / d.maxHp) * 100)}%`;
      q('.hp .val').textContent = `${Math.ceil(d.hp)}`;
      q('.bar.hp').classList.toggle('low', hpPct < 30);
    });
    const enPct = Math.round((d.energy / d.maxEnergy) * 100);
    this.set('en', `${enPct}`, () => {
      q('.en .track i').style.width = `${enPct}%`;
      q('.en .val').textContent = `${enPct}`;
    });
    this.set('shield', `${Math.ceil(d.shieldTime)}|${d.shieldHp > 0}`, () => {
      const chip = q('.chip.shield');
      chip.classList.toggle('hidden', d.shieldHp <= 0);
      chip.querySelector('span')!.textContent = `${Math.ceil(d.shieldTime)}s`;
    });
    this.set('sector', `${d.level}|${d.sector}`, () => (q('.sector').textContent = `SECTOR ${String(d.level).padStart(2, '0')} · ${d.sector}`));
    this.set('obj', `${d.kills}|${d.need}`, () => {
      const done = d.kills >= d.need;
      q('.objective').textContent = done ? 'EXIT PORTAL ONLINE — REACH IT' : `PURGE HOSTILES  ${d.kills} / ${d.need}`;
      q('.obj-track i').style.width = `${Math.min(100, (d.kills / d.need) * 100)}%`;
      q('.objective').classList.toggle('done', done);
    });
    this.set('score', `${d.score}`, () => (q('.score').textContent = d.score.toLocaleString()));
    this.set('combo', `${d.combo}|${d.mult}`, () => {
      const c = q('.combo');
      c.textContent = d.combo >= 2 ? `${d.combo} CHAIN  ×${d.mult.toFixed(1)}` : '';
      c.classList.remove('pop');
      void c.offsetWidth;
      c.classList.add('pop');
    });

    d.abilities.forEach((a, i) => {
      const frac = a.left > 0 ? a.left / a.cooldown : 0;
      const poor = d.energy < a.cost;
      const k = `ab${i}`;
      this.set(k, `${frac.toFixed(2)}|${poor}`, () => {
        for (const el of [this.slotEls[i], this.touchSkillBtns[i]]) {
          if (!el) continue;
          el.style.setProperty('--cd', String(frac));
          el.classList.toggle('cooling', frac > 0);
          el.classList.toggle('poor', poor && frac === 0);
        }
      });
    });
    this.set('dash', d.dashFrac.toFixed(2), () => {
      this.dashSlot.style.setProperty('--cd', String(d.dashFrac));
      this.dashSlot.classList.toggle('cooling', d.dashFrac > 0);
    });
    this.set('buffs', d.buffs.map((b) => `${b.name}${Math.ceil(b.time)}`).join(','), () => {
      q('.buffs').innerHTML = d.buffs.map((b) => `<div class="chip buff">${b.name} <span>${Math.ceil(b.time)}s</span></div>`).join('');
    });
  }

  setPrompt(text: string | null): void {
    this.set('prompt', text ?? '', () => {
      this.promptEl.classList.toggle('hidden', !text);
      this.promptEl.textContent = text ?? '';
    });
    this.interactBtn?.classList.toggle('hidden', !text);
  }

  /** Angle is relative to the screen (0 = up), null hides the arrow. */
  setObjectiveArrow(angle: number | null, dist: number): void {
    if (angle === null) {
      this.arrowEl.classList.add('hidden');
      return;
    }
    this.arrowEl.classList.remove('hidden');
    this.arrowIco.style.transform = `rotate(${angle - Math.PI / 2}rad)`;
    this.arrowTxt.textContent = `PORTAL ${Math.round(dist)}m`;
  }

  toast(msg: string, kind: 'ok' | 'warn' | 'info' | 'err' = 'info'): void {
    const el = document.createElement('div');
    el.className = `toast ${kind}`;
    el.textContent = msg;
    this.toasts.appendChild(el);
    while (this.toasts.children.length > 4) this.toasts.firstElementChild!.remove();
    window.setTimeout(() => el.remove(), 2600);
  }

  flashDamage(): void {
    this.vig.classList.remove('hit');
    void this.vig.offsetWidth;
    this.vig.classList.add('hit');
  }

  damageNumber(pos: THREE.Vector3, value: number, crit: boolean): void {
    if (this.nums.length > 24) return;
    const el = document.createElement('div');
    el.className = `dmg${crit ? ' crit' : ''}`;
    el.textContent = crit ? `${value}!` : String(value);
    this.dmgLayer.appendChild(el);
    this.nums.push({ el, pos: pos.clone().add(new THREE.Vector3((Math.random() - 0.5) * 0.8, 0.8, 0)), life: 0.8, vy: 2.2 });
  }

  updateDamageNumbers(dt: number, camera: THREE.Camera): void {
    for (let i = this.nums.length - 1; i >= 0; i--) {
      const n = this.nums[i];
      n.life -= dt;
      if (n.life <= 0) { n.el.remove(); this.nums.splice(i, 1); continue; }
      n.pos.y += n.vy * dt;
      this.v.copy(n.pos).project(camera);
      if (this.v.z > 1) { n.el.style.opacity = '0'; continue; }
      n.el.style.opacity = String(Math.min(1, n.life * 2.5));
      n.el.style.transform = `translate(${(this.v.x * 0.5 + 0.5) * window.innerWidth}px, ${(-this.v.y * 0.5 + 0.5) * window.innerHeight}px) translate(-50%,-50%)`;
    }
  }
}
