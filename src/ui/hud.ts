import * as THREE from 'three';
import type { Action, Input } from '../input';
import type { AudioFX } from '../audio';
import { CITY } from '../config';
import { QUALITY_KEY, readQualitySetting, type QualitySetting } from '../graphics/renderer';
import type { MissionLogData, MissionMarker } from '../systems/missions';

export interface HudAbility { key: string; name: string; left: number; cooldown: number; cost: number }

export interface HudData {
  hp: number;
  maxHp: number;
  energy: number;
  maxEnergy: number;
  ram: number;
  maxRam: number;
  shieldHp: number;
  shieldTime: number;
  level: number;
  xp: number;
  xpNext: number;
  skillPoints: number;
  credits: number;
  district: string;
  abilities: HudAbility[];
  dashFrac: number;
}

export interface MinimapData {
  px: number;
  pz: number;
  camYaw: number;
  facing: number;
  markers: MissionMarker[];
}

export interface GameOverStats {
  level: number;
  kills: number;
  hacks: number;
  missions: number;
  creditsLost: number;
}

export interface ConsoleChip { label: string; cmd: string; submit: boolean }
type LineClass = 'out' | 'ok' | 'warn' | 'err' | 'dim' | 'sys' | 'in';

interface Callbacks {
  onStart: (newGame: boolean) => void;
  onRespawn: () => void;
}

interface Floater { el: HTMLElement; pos: THREE.Vector3; life: number; vy: number }

const TOUCH_BUTTONS: Array<{ act: Action; label: string; r: number; b: number; s: number; cls?: string }> = [
  { act: 'attack', label: 'ATK', r: 0.4, b: 0.4, s: 1.6, cls: 'big' },
  { act: 'shoot', label: 'SHOT', r: 2.3, b: 0.3, s: 1.1 },
  { act: 'jump', label: 'JUMP', r: 2.2, b: 1.7, s: 1.1 },
  { act: 'dash', label: 'DASH', r: 0.4, b: 2.2, s: 1.1 },
  { act: 'emp', label: 'EMP', r: 3.75, b: 0.3, s: 1.0, cls: 'skill' },
  { act: 'shield', label: 'SHLD', r: 3.75, b: 1.5, s: 1.0, cls: 'skill' },
  { act: 'burst', label: 'QNTM', r: 3.75, b: 2.7, s: 1.0, cls: 'skill' },
  { act: 'interact', label: 'HACK', r: 0.4, b: 3.6, s: 1.2, cls: 'interact' },
];

const ACT_TO_ABILITY: Partial<Record<Action, number>> = { emp: 0, shield: 1, burst: 2 };

const sleep = (ms: number): Promise<void> => new Promise((r) => window.setTimeout(r, ms));

/** CRT command console: typewriter output, command history, tab completion, tappable command chips. */
export class ConsoleUI {
  onSubmit: (line: string) => void = () => undefined;
  onClose: () => void = () => undefined;
  complete: (prefix: string) => string | null = () => null;

  private root: HTMLElement;
  private log: HTMLElement;
  private chips: HTMLElement;
  private input: HTMLInputElement;
  private ramEl: HTMLElement;
  private queue: Array<{ text: string; cls: LineClass; instant: boolean }> = [];
  private pumping = false;
  private history: string[] = [];
  private histIdx = -1;
  private isOpen = false;

  constructor(parent: HTMLElement, private audio: AudioFX) {
    this.root = document.createElement('div');
    this.root.className = 'console hidden';
    this.root.innerHTML = `
      <div class="con-crt"></div>
      <div class="con-head"><span>NEURAL LINK // /dev/nexus</span><span class="con-ram"></span><button class="con-x" type="button" aria-label="close">✕</button></div>
      <div class="con-log"></div>
      <div class="con-chips"></div>
      <div class="con-input"><span>&gt;</span><input type="text" autocomplete="off" autocapitalize="off" autocorrect="off" spellcheck="false" enterkeyhint="send" placeholder="/help" /></div>`;
    parent.appendChild(this.root);
    this.log = this.root.querySelector('.con-log') as HTMLElement;
    this.chips = this.root.querySelector('.con-chips') as HTMLElement;
    this.input = this.root.querySelector('input') as HTMLInputElement;
    this.ramEl = this.root.querySelector('.con-ram') as HTMLElement;
    (this.root.querySelector('.con-x') as HTMLElement).addEventListener('click', () => this.onClose());
    this.input.addEventListener('keydown', (e) => {
      e.stopPropagation();
      if (e.key === 'Enter') {
        const v = this.input.value;
        this.input.value = '';
        if (v.trim()) { this.history.unshift(v); this.histIdx = -1; }
        this.flush();
        this.onSubmit(v);
      } else if (e.key === 'Escape') {
        e.preventDefault();
        this.onClose();
      } else if (e.key === 'ArrowUp') {
        e.preventDefault();
        this.histIdx = Math.min(this.history.length - 1, this.histIdx + 1);
        if (this.histIdx >= 0) this.input.value = this.history[this.histIdx];
      } else if (e.key === 'ArrowDown') {
        e.preventDefault();
        this.histIdx = Math.max(-1, this.histIdx - 1);
        this.input.value = this.histIdx >= 0 ? this.history[this.histIdx] : '';
      } else if (e.key === 'Tab') {
        e.preventDefault();
        const c = this.complete(this.input.value);
        if (c) this.input.value = c;
      } else if (e.key.length === 1) {
        this.audio.type();
      }
    });
    this.input.addEventListener('keyup', (e) => e.stopPropagation());
  }

  get opened(): boolean { return this.isOpen; }

  open(): void {
    this.isOpen = true;
    this.root.classList.remove('hidden');
    this.log.innerHTML = '';
    this.queue.length = 0;
    this.input.value = '';
    window.setTimeout(() => this.input.focus(), 30);
  }

  close(): void {
    this.isOpen = false;
    this.root.classList.add('hidden');
    this.queue.length = 0;
    this.input.blur();
  }

  focus(): void { this.input.focus(); }
  blur(): void { this.input.blur(); }

  setRam(text: string): void { this.ramEl.textContent = text; }

  clear(): void {
    this.log.innerHTML = '';
    this.queue.length = 0;
  }

  setChips(items: ConsoleChip[]): void {
    this.chips.innerHTML = '';
    for (const it of items) {
      const b = document.createElement('button');
      b.type = 'button';
      b.className = 'chip-btn';
      b.textContent = it.label;
      b.addEventListener('pointerdown', (e) => {
        e.preventDefault();
        this.audio.click();
        if (it.submit) { this.history.unshift(it.cmd); this.flush(); this.onSubmit(it.cmd); }
        else { this.input.value = it.cmd + ' '; this.input.focus(); }
      });
      this.chips.appendChild(b);
    }
  }

  /** Queues a line; non-instant lines are typed out like a machine terminal. */
  print(text: string, cls: LineClass = 'out', instant = false): void {
    this.queue.push({ text, cls, instant });
    if (!this.pumping) void this.pump();
  }

  /** Finishes everything queued immediately. */
  flush(): void {
    for (const q of this.queue) q.instant = true;
  }

  private async pump(): Promise<void> {
    this.pumping = true;
    while (this.queue.length && this.isOpen) {
      const item = this.queue.shift()!;
      const div = document.createElement('div');
      div.className = `ln ${item.cls}`;
      this.log.appendChild(div);
      if (item.instant) {
        div.textContent = item.text;
      } else {
        const step = item.text.length > 60 ? 3 : 2;
        for (let i = 0; i < item.text.length; i += step) {
          if (this.queue.length > 8) { div.textContent = item.text; break; }
          div.textContent = item.text.slice(0, i + step) + '█';
          if (i % 6 === 0) this.audio.type();
          this.log.scrollTop = this.log.scrollHeight;
          await sleep(7);
        }
        div.textContent = item.text;
      }
      while (this.log.children.length > 140) this.log.firstElementChild!.remove();
      this.log.scrollTop = this.log.scrollHeight;
    }
    this.pumping = false;
  }
}

export class HUD {
  readonly root: HTMLElement;
  readonly console: ConsoleUI;
  private hud: HTMLElement;
  private menu: HTMLElement;
  private over: HTMLElement;
  private pauseEl: HTMLElement;
  private loadEl: HTMLElement;
  private hintEl: HTMLElement;
  private promptEl: HTMLElement;
  private toasts: HTMLElement;
  private vig: HTMLElement;
  private floatLayer: HTMLElement;
  private markerLayer: HTMLElement;
  private mlog: HTMLElement;
  private detectEl: HTMLElement;
  private touchLayer: HTMLElement | null = null;
  private interactBtn: HTMLElement | null = null;
  private touchSkillBtns: Array<HTMLElement | null> = [null, null, null];
  private nums: Floater[] = [];
  private bubbles: Floater[] = [];
  private markerEls: HTMLElement[] = [];
  private cache = new Map<string, string>();
  private slotEls: HTMLElement[] = [];
  private dashSlot: HTMLElement;
  private mini: HTMLCanvasElement;
  private miniCtx: CanvasRenderingContext2D;
  private miniT = 0;
  private mapData: MinimapData | null = null;
  private markers: MissionMarker[] = [];
  private scanMarkers: Array<MissionMarker & { until: number }> = [];
  private v = new THREE.Vector3();

  constructor(root: HTMLElement, private input: Input, private audio: AudioFX, cb: Callbacks) {
    this.root = root;
    const touch = input.isTouch;
    root.innerHTML = `
      <div class="loading">
        <div class="load-inner">
          <div class="logo glitch" data-text="CYBER-NEXUS">CYBER-NEXUS</div>
          <div class="logo-sub">OPEN WORLD PROTOCOL</div>
          <div class="load-bar"><i></i></div>
          <div class="load-text">BOOTING ...</div>
        </div>
      </div>
      <div class="hud hidden">
        <div class="hud-tl">
          <div class="lvl"><b class="lv">LV 1</b><div class="xpbar"><i></i></div><span class="sp"></span></div>
          <div class="bar hp"><label>INTEGRITY</label><div class="track"><i></i><b></b></div><span class="val"></span></div>
          <div class="bar en"><label>ENERGY</label><div class="track"><i></i></div><span class="val"></span></div>
          <div class="bar ram"><label>RAM</label><div class="track"><i></i></div><span class="val"></span></div>
          <div class="credits">¢ <b>0</b></div>
          <div class="chip shield hidden">DATA SHIELD <span></span></div>
        </div>
        <div class="hud-tr">
          <canvas class="minimap" width="176" height="176"></canvas>
          <div class="district"></div>
        </div>
        <div class="mlog hidden"></div>
        ${touch ? '' : `<div class="hud-bc">
          <div class="slot dash"><span class="k">SHIFT</span><span class="n">DASH</span><i></i></div>
          <div class="slot" data-i="0"><span class="k">Q</span><span class="n">EMP</span><i></i></div>
          <div class="slot" data-i="1"><span class="k">E</span><span class="n">SHIELD</span><i></i></div>
          <div class="slot" data-i="2"><span class="k">R</span><span class="n">QUANTUM</span><i></i></div>
        </div>`}
        <div class="detect hidden"><span>DETECCIÓN</span><div><i></i></div></div>
        <div class="prompt hidden"></div>
        <div class="markers"></div>
        <div class="toasts"></div>
        <div class="dmg-vig"></div>
        <div class="dmg-layer"></div>
        <div class="hint hidden">CLICK TO CAPTURE MOUSE</div>
      </div>
      <div class="screen pause hidden"><div class="panel"><h2>PAUSED</h2><p>${touch ? 'Tap to resume' : 'Press P or click to resume'}</p></div></div>
      <div class="screen menu hidden">
        <div class="menu-inner">
          <div class="logo glitch" data-text="CYBER-NEXUS">CYBER-NEXUS</div>
          <div class="logo-sub">OPEN WORLD PROTOCOL</div>
          <div class="tagline">// the grid never forgets //</div>
          <button class="btn primary" data-act="continue" type="button">CONTINUE</button>
          <button class="btn" data-act="new" type="button">NEW GAME</button>
          <button class="btn ghost" data-act="controls" type="button">CONTROLS</button>
          <button class="btn ghost" data-act="quality" type="button"></button>
          <div class="controls hidden">
            ${touch
              ? `<ul><li><b>Floating stick</b> move (left side)</li><li><b>Drag right side</b> camera</li><li><b>ATK / SHOT</b> blade combo / kinetic shot</li><li><b>JUMP</b> (x2) · <b>DASH</b> i-frames</li><li><b>EMP / SHLD / QNTM</b> super powers</li><li><b>HACK</b> opens the console: tap the chips</li></ul>`
              : `<ul><li><b>WASD</b> move · <b>Mouse</b> camera</li><li><b>Click / J</b> energy blade · <b>Right click / K</b> shot</li><li><b>Space</b> jump (x2) · <b>Shift</b> dash</li><li><b>Q</b> EMP · <b>E</b> shield · <b>R</b> quantum burst</li><li><b>F / Enter</b> hack console · <b>P</b> pause</li></ul>`}
            <p class="goal">Open the console, type /missions, accept a contract and cross the city. /scan shows what you can hack.</p>
          </div>
          <div class="best"></div>
        </div>
      </div>
      <div class="screen over hidden">
        <div class="panel">
          <h2 class="glitch" data-text="FLATLINED">FLATLINED</h2>
          <div class="stats"></div>
          <button class="btn primary" data-act="respawn" type="button">RESPAWN</button>
        </div>
      </div>
    `;
    const q = <T extends HTMLElement>(s: string): T => root.querySelector(s) as T;
    this.hud = q('.hud');
    this.menu = q('.menu');
    this.over = q('.over');
    this.pauseEl = q('.pause');
    this.loadEl = q('.loading');
    this.hintEl = q('.hint');
    this.promptEl = q('.prompt');
    this.toasts = q('.toasts');
    this.vig = q('.dmg-vig');
    this.floatLayer = q('.dmg-layer');
    this.markerLayer = q('.markers');
    this.mlog = q('.mlog');
    this.detectEl = q('.detect');
    this.mini = q('.minimap');
    this.miniCtx = this.mini.getContext('2d')!;
    this.dashSlot = (root.querySelector('.slot.dash') as HTMLElement) ?? document.createElement('div');
    this.slotEls = [...root.querySelectorAll('.slot[data-i]')] as HTMLElement[];
    for (let i = 0; i < 8; i++) {
      const el = document.createElement('div');
      el.className = 'mk hidden';
      el.innerHTML = '<i>◆</i><span></span>';
      this.markerLayer.appendChild(el);
      this.markerEls.push(el);
    }
    if (touch) this.mini.classList.add('small');

    this.console = new ConsoleUI(root, audio);

    const start = (newGame: boolean): void => { this.audio.unlock(); this.audio.click(); this.requestFullscreen(); cb.onStart(newGame); };
    q('[data-act="continue"]').addEventListener('click', () => start(false));
    q('[data-act="new"]').addEventListener('click', () => start(true));
    q('[data-act="respawn"]').addEventListener('click', () => { this.audio.click(); cb.onRespawn(); });
    q('[data-act="controls"]').addEventListener('click', () => {
      this.audio.unlock();
      this.audio.click();
      q('.controls').classList.toggle('hidden');
    });
    const qBtn = q('[data-act="quality"]');
    const qOrder: QualitySetting[] = ['auto', 'low', 'medium', 'high'];
    const qLabel = (): string => `GRAPHICS: ${readQualitySetting().toUpperCase()}`;
    qBtn.textContent = qLabel();
    qBtn.addEventListener('click', () => {
      this.audio.click();
      const next = qOrder[(qOrder.indexOf(readQualitySetting()) + 1) % qOrder.length];
      try { localStorage.setItem(QUALITY_KEY, next); } catch { /* storage unavailable */ }
      qBtn.textContent = `${qLabel()} — RELOADING…`;
      window.setTimeout(() => location.reload(), 250);
    });
    if (touch) this.buildTouch();
  }

  private requestFullscreen(): void {
    if (!this.input.isTouch) return;
    try {
      void document.documentElement.requestFullscreen?.()
        .then(() => (screen.orientation as ScreenOrientation & { lock?: (o: string) => Promise<void> }).lock?.('landscape'))
        .catch(() => undefined);
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

    // Floating joystick: appears wherever the thumb lands in the left zone.
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
      if (len > R) {
        // Floating: drag the base along with the thumb so the stick never "runs out".
        const excess = len - R;
        ox += (dx / len) * excess;
        oy += (dy / len) * excess;
        base.style.left = `${ox}px`;
        base.style.top = `${oy}px`;
        dx = (dx / len) * R;
        dy = (dy / len) * R;
      }
      knob.style.transform = `translate(calc(-50% + ${dx}px), calc(-50% + ${dy}px))`;
      const mag = Math.min(1, Math.hypot(dx, dy) / R);
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

  setLoading(progress: number, text: string): void {
    (this.loadEl.querySelector('.load-bar i') as HTMLElement).style.width = `${Math.round(progress * 100)}%`;
    (this.loadEl.querySelector('.load-text') as HTMLElement).textContent = text;
  }

  hideLoading(): void {
    this.loadEl.classList.add('fade');
    window.setTimeout(() => this.loadEl.classList.add('hidden'), 600);
  }

  showMenu(hasSave: boolean): void {
    (this.root.querySelector('[data-act="continue"]') as HTMLElement).classList.toggle('hidden', !hasSave);
    (this.root.querySelector('.best') as HTMLElement).textContent = hasSave ? 'SAVE DATA FOUND' : 'NO SAVE DATA';
    this.menu.classList.remove('hidden');
    this.over.classList.add('hidden');
    this.setHudVisible(false);
  }

  hideMenu(): void {
    this.menu.classList.add('hidden');
  }

  showGameOver(s: GameOverStats): void {
    (this.over.querySelector('.stats') as HTMLElement).innerHTML = `
      <div><span>LEVEL</span><b>${s.level}</b></div>
      <div><span>HOSTILES PURGED</span><b>${s.kills}</b></div>
      <div><span>SYSTEMS HACKED</span><b>${s.hacks}</b></div>
      <div><span>CONTRACTS DONE</span><b>${s.missions}</b></div>
      <div><span>CREDITS LOST</span><b>¢${s.creditsLost}</b></div>`;
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
      this.bubbles.forEach((n) => n.el.remove());
      this.nums.length = 0;
      this.bubbles.length = 0;
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

  private set(key: string, value: string, apply: () => void): void {
    if (this.cache.get(key) === value) return;
    this.cache.set(key, value);
    apply();
  }

  setHud(d: HudData): void {
    const q = <T extends HTMLElement>(s: string): T => this.hud.querySelector(s) as T;
    const hpPct = Math.round((d.hp / d.maxHp) * 100);
    this.set('hp', `${hpPct}|${Math.ceil(d.hp)}|${Math.round(d.shieldHp)}`, () => {
      q('.hp .track i').style.width = `${hpPct}%`;
      q('.hp .track b').style.width = `${Math.min(100, (d.shieldHp / d.maxHp) * 100)}%`;
      q('.hp .val').textContent = `${Math.ceil(d.hp)}`;
      q('.bar.hp').classList.toggle('low', hpPct < 30);
    });
    const enPct = Math.round((d.energy / d.maxEnergy) * 100);
    this.set('en', `${enPct}`, () => { q('.en .track i').style.width = `${enPct}%`; q('.en .val').textContent = `${enPct}`; });
    const ramPct = Math.round((d.ram / d.maxRam) * 100);
    this.set('ram', `${ramPct}`, () => { q('.ram .track i').style.width = `${ramPct}%`; q('.ram .val').textContent = `${Math.floor(d.ram)}`; });
    this.console.setRam(`RAM ${Math.floor(d.ram)}/${d.maxRam}`);
    this.set('lvl', `${d.level}|${Math.round((d.xp / d.xpNext) * 100)}|${d.skillPoints}`, () => {
      q('.lv').textContent = `LV ${d.level}`;
      q('.xpbar i').style.width = `${Math.round((d.xp / d.xpNext) * 100)}%`;
      q('.sp').textContent = d.skillPoints > 0 ? `+${d.skillPoints} SP` : '';
    });
    this.set('cred', `${d.credits}`, () => { q('.credits b').textContent = d.credits.toLocaleString(); });
    this.set('dist', d.district, () => { q('.district').textContent = d.district; });
    this.set('shield', `${Math.ceil(d.shieldTime)}|${d.shieldHp > 0}`, () => {
      const chip = q('.chip.shield');
      chip.classList.toggle('hidden', d.shieldHp <= 0);
      chip.querySelector('span')!.textContent = `${Math.ceil(d.shieldTime)}s`;
    });
    d.abilities.forEach((a, i) => {
      const frac = a.left > 0 ? a.left / a.cooldown : 0;
      const poor = d.energy < a.cost;
      this.set(`ab${i}`, `${frac.toFixed(2)}|${poor}`, () => {
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
  }

  setMissionLog(d: MissionLogData | null): void {
    const key = d ? JSON.stringify(d) : '';
    this.set('mlog', key, () => {
      this.mlog.classList.toggle('hidden', !d);
      if (!d) return;
      this.mlog.innerHTML = `
        <div class="ml-tag">CONTRATO ACTIVO</div>
        <div class="ml-title">${d.title}</div>
        <div class="ml-dist">${d.district}</div>
        <ul>${d.lines.map((l) => `<li class="${l.done ? 'done' : ''}${l.optional ? ' opt' : ''}"><i>${l.done ? '✔' : '◇'}</i>${l.text}</li>`).join('')}</ul>
        <div class="ml-reward">${d.reward}</div>`;
    });
  }

  setDetection(v: number): void {
    this.set('detect', v.toFixed(2), () => {
      this.detectEl.classList.toggle('hidden', v <= 0.01);
      (this.detectEl.querySelector('i') as HTMLElement).style.width = `${Math.round(v * 100)}%`;
    });
  }

  setPrompt(text: string | null): void {
    this.set('prompt', text ?? '', () => {
      this.promptEl.classList.toggle('hidden', !text);
      this.promptEl.textContent = text ?? '';
      this.interactBtn?.classList.toggle('hot', !!text);
    });
  }

  toast(msg: string, kind: 'ok' | 'warn' | 'info' | 'err' = 'info'): void {
    const el = document.createElement('div');
    el.className = `toast ${kind}`;
    el.textContent = msg;
    this.toasts.appendChild(el);
    while (this.toasts.children.length > 4) this.toasts.firstElementChild!.remove();
    window.setTimeout(() => el.remove(), 3200);
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
    this.floatLayer.appendChild(el);
    this.nums.push({ el, pos: pos.clone().add(new THREE.Vector3((Math.random() - 0.5) * 0.8, 0.8, 0)), life: 0.8, vy: 2.2 });
  }

  /** Speech bubble anchored to a world position. */
  say(pos: THREE.Vector3, text: string, seconds = 2): void {
    if (this.bubbles.length > 7) this.bubbles.shift()!.el.remove();
    const el = document.createElement('div');
    el.className = 'bubble';
    el.textContent = text;
    this.floatLayer.appendChild(el);
    this.bubbles.push({ el, pos: pos.clone(), life: seconds, vy: 0.15 });
  }

  setMarkers(list: MissionMarker[]): void {
    this.markers = list;
  }

  setScanMarkers(list: MissionMarker[]): void {
    const until = performance.now() + 12000;
    this.scanMarkers = list.map((m) => ({ ...m, until }));
  }

  setMinimap(d: MinimapData): void {
    this.mapData = d;
  }

  /** Per-frame DOM overlays: floating numbers, bubbles, projected markers, minimap redraw (10 Hz). */
  updateOverlays(dt: number, camera: THREE.Camera): void {
    this.stepFloaters(this.nums, dt, camera, 1);
    this.stepFloaters(this.bubbles, dt, camera, 0.6);

    const now = performance.now();
    this.scanMarkers = this.scanMarkers.filter((m) => m.until > now);
    const all = [...this.markers, ...this.scanMarkers];
    const W = window.innerWidth;
    const Hh = window.innerHeight;
    for (let i = 0; i < this.markerEls.length; i++) {
      const el = this.markerEls[i];
      const m = all[i];
      if (!m) { if (!el.classList.contains('hidden')) el.classList.add('hidden'); continue; }
      this.v.copy(m.pos);
      this.v.y += m.kind === 'scan' ? 0.6 : 3;
      const dist = this.v.distanceTo(camera.position);
      this.v.project(camera);
      let x = this.v.x;
      let y = this.v.y;
      const behind = this.v.z > 1;
      if (behind) { x = -x; y = -y; }
      let sx = (x * 0.5 + 0.5) * W;
      let sy = (-y * 0.5 + 0.5) * Hh;
      const margin = 46;
      const edge = behind || sx < margin || sx > W - margin || sy < margin || sy > Hh - margin;
      sx = THREE.MathUtils.clamp(sx, margin, W - margin);
      sy = THREE.MathUtils.clamp(sy, margin + 40, Hh - margin - 70);
      if (sx > W - 220 && sy < 250) sy = 250;
      if (sx < 340 && sy < 420) sx = 340;
      el.classList.remove('hidden');
      el.style.transform = `translate(${sx}px, ${sy}px) translate(-50%,-50%)`;
      el.style.color = m.color;
      el.classList.toggle('edge', edge);
      (el.querySelector('span') as HTMLElement).textContent = m.kind === 'scan' ? m.label : `${m.label} ${Math.round(dist)}m`;
    }

    this.miniT += dt;
    if (this.mapData && this.miniT > 0.08) {
      this.miniT = 0;
      this.drawMinimap(this.mapData, now);
    }
  }

  private stepFloaters(list: Floater[], dt: number, camera: THREE.Camera, fadeAt: number): void {
    for (let i = list.length - 1; i >= 0; i--) {
      const n = list[i];
      n.life -= dt;
      if (n.life <= 0) { n.el.remove(); list.splice(i, 1); continue; }
      n.pos.y += n.vy * dt;
      this.v.copy(n.pos).project(camera);
      if (this.v.z > 1) { n.el.style.opacity = '0'; continue; }
      n.el.style.opacity = String(Math.min(1, n.life / fadeAt * 2));
      n.el.style.transform = `translate(${(this.v.x * 0.5 + 0.5) * window.innerWidth}px, ${(-this.v.y * 0.5 + 0.5) * window.innerHeight}px) translate(-50%,-100%)`;
    }
  }

  private drawMinimap(d: MinimapData, now: number): void {
    const c = this.miniCtx;
    const SZ = this.mini.width;
    const cx = SZ / 2;
    const R = SZ / 2 - 3;
    const RANGE = 95;
    const sc = R / RANGE;
    const cosY = Math.cos(d.camYaw);
    const sinY = Math.sin(d.camYaw);
    /** World offset -> minimap pixel (camera forward is up). */
    const toMap = (wx: number, wz: number): [number, number] => {
      const dx = wx - d.px;
      const dz = wz - d.pz;
      const f = dx * -sinY + dz * -cosY;
      const r = dx * cosY + dz * -sinY;
      return [cx + r * sc, cx - f * sc];
    };

    c.save();
    c.clearRect(0, 0, SZ, SZ);
    c.beginPath();
    c.arc(cx, cx, R, 0, Math.PI * 2);
    c.clip();
    c.fillStyle = 'rgba(2,8,16,0.88)';
    c.fillRect(0, 0, SZ, SZ);

    // Streets.
    const S = CITY.S;
    const kx0 = Math.floor((d.px - RANGE * 1.5) / S);
    const kx1 = Math.ceil((d.px + RANGE * 1.5) / S);
    const kz0 = Math.floor((d.pz - RANGE * 1.5) / S);
    const kz1 = Math.ceil((d.pz + RANGE * 1.5) / S);
    c.lineCap = 'butt';
    const road = (ax: number, az: number, bx: number, bz: number): void => {
      const [x1, y1] = toMap(ax, az);
      const [x2, y2] = toMap(bx, bz);
      c.beginPath();
      c.moveTo(x1, y1);
      c.lineTo(x2, y2);
      c.stroke();
    };
    c.strokeStyle = '#12233a';
    c.lineWidth = Math.max(2, 8 * sc);
    for (let k = kx0; k <= kx1; k++) road(k * S, d.pz - RANGE * 1.6, k * S, d.pz + RANGE * 1.6);
    for (let k = kz0; k <= kz1; k++) road(d.px - RANGE * 1.6, k * S, d.px + RANGE * 1.6, k * S);
    c.strokeStyle = 'rgba(0,240,255,0.35)';
    c.lineWidth = 1;
    for (let k = kx0; k <= kx1; k++) road(k * S, d.pz - RANGE * 1.6, k * S, d.pz + RANGE * 1.6);
    for (let k = kz0; k <= kz1; k++) road(d.px - RANGE * 1.6, k * S, d.px + RANGE * 1.6, k * S);

    // Markers.
    const drawMarker = (m: MissionMarker, scan: boolean): void => {
      let [mx, my] = toMap(m.pos.x, m.pos.z);
      const dx = mx - cx;
      const dy = my - cx;
      const dd = Math.hypot(dx, dy);
      const clamped = dd > R - 6;
      if (clamped) { mx = cx + (dx / dd) * (R - 6); my = cx + (dy / dd) * (R - 6); }
      c.fillStyle = m.color;
      c.beginPath();
      if (scan) c.arc(mx, my, 2.4, 0, Math.PI * 2);
      else { c.moveTo(mx, my - 6); c.lineTo(mx + 5, my); c.lineTo(mx, my + 6); c.lineTo(mx - 5, my); c.closePath(); }
      c.fill();
      if (!scan && !clamped) {
        c.strokeStyle = m.color;
        c.globalAlpha = 0.45 + 0.35 * Math.sin(now / 250);
        c.beginPath();
        c.arc(mx, my, 10, 0, Math.PI * 2);
        c.stroke();
        c.globalAlpha = 1;
      }
    };
    for (const m of this.scanMarkers) drawMarker(m, true);
    for (const m of d.markers) drawMarker(m, false);

    // Player arrow.
    c.save();
    c.translate(cx, cx);
    c.rotate(Math.PI - (d.facing - d.camYaw));
    c.fillStyle = '#00f0ff';
    c.shadowColor = '#00f0ff';
    c.shadowBlur = 8;
    c.beginPath();
    c.moveTo(0, -9);
    c.lineTo(6, 7);
    c.lineTo(0, 3);
    c.lineTo(-6, 7);
    c.closePath();
    c.fill();
    c.restore();
    c.restore();

    // Ring + north tick.
    c.strokeStyle = 'rgba(0,240,255,0.8)';
    c.lineWidth = 2;
    c.beginPath();
    c.arc(cx, cx, R, 0, Math.PI * 2);
    c.stroke();
    const nx = cx + Math.sin(d.camYaw) * (R - 2);
    const ny = cx - Math.cos(d.camYaw) * (R - 2);
    c.fillStyle = '#ff2bd6';
    c.font = 'bold 11px monospace';
    c.textAlign = 'center';
    c.textBaseline = 'middle';
    c.fillText('N', cx + (nx - cx) * 0.86, cx + (ny - cx) * 0.86);
  }
}
