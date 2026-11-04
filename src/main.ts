import './style.css';
import * as THREE from 'three';
import { BEST_KEY, CFG, PALETTES, type Palette } from './config';
import { comboMultiplier, type GameContext, type GameState } from './context';
import { GfxRenderer } from './engine/renderer';
import { Input } from './input';
import { AudioFX } from './audio';
import { ParticleSystem } from './particles';
import { World, type Terminal } from './world';
import { Player } from './player';
import { Combat } from './combat';
import { EnemyManager } from './enemies';
import { UI } from './ui';
import { Transitions, bootLines, deathLines, hackLines, sectorLines } from './transitions';
import { Minigame } from './minigame';

type Phase = 'menu' | 'transition' | 'playing' | 'hacking' | 'paused' | 'dying' | 'gameover';

const ORIGIN = new THREE.Vector3(0, 0, 0);
const CAM_DIST = 9.5;

class Game implements GameContext {
  readonly gfx: GfxRenderer;
  readonly scene: THREE.Scene;
  readonly camera: THREE.PerspectiveCamera;
  readonly input: Input;
  readonly audio: AudioFX;
  readonly fx: ParticleSystem;
  readonly world: World;
  readonly player: Player;
  readonly combat: Combat;
  readonly enemies: EnemyManager;
  readonly ui: UI;
  readonly tx: Transitions;
  readonly minigame: Minigame;
  readonly canvas: HTMLCanvasElement;

  state: GameState = this.freshState();
  camYaw = 0;
  camPitch = 0.38;

  private phase: Phase = 'menu';
  private clock = 0;
  private last = 0;
  private timeScale = 1;
  private timeTarget = 1;
  private hitStopT = 0;
  private trauma = 0;
  private camDist = CAM_DIST;
  private portalOpen = false;
  private dyingT = 0;
  private best = 0;
  private palette: Palette = PALETTES[0];
  private tmpV = new THREE.Vector3();
  private tmpDir = new THREE.Vector3();
  private lookTarget = new THREE.Vector3();
  private focus = new THREE.Vector3();
  private statsEl: HTMLDivElement | null = null;
  private statsT = 0;

  constructor() {
    this.canvas = document.getElementById('game') as HTMLCanvasElement;
    const uiRoot = document.getElementById('ui') as HTMLElement;

    this.gfx = new GfxRenderer(this.canvas);
    this.scene = this.gfx.scene;
    this.camera = this.gfx.camera;
    this.audio = new AudioFX();
    this.input = new Input(this.canvas);
    this.fx = new ParticleSystem(this.scene, CFG.particleCap);
    this.gfx.onResizeCallback(() => this.fx.setScale(this.gfx.drawingHeight, this.camera.fov));
    this.world = new World(this.scene, this.gfx);
    this.player = new Player(this, this.scene);
    this.combat = new Combat(this, this.scene);
    this.enemies = new EnemyManager(this, this.scene);
    this.ui = new UI(uiRoot, this.input, this.audio, {
      onStart: () => void this.startRun(),
      onRetry: () => { this.ui.hideGameOver(); void this.startRun(); },
    });
    this.tx = new Transitions(this.ui.root, this.audio, this.gfx);
    this.minigame = new Minigame(this.ui.root, this.audio);

    this.best = this.loadBest();
    this.bindEvents();

    // Idle showcase behind the main menu.
    this.palette = PALETTES[0];
    this.gfx.setTheme(this.palette);
    this.world.reset(1337, this.palette, ORIGIN);
    this.player.fullReset(ORIGIN);
    this.input.enabled = false;
    this.ui.showMenu(this.best);

    if (new URLSearchParams(location.search).has('debug')) this.toggleStats();
    window.addEventListener('keydown', (e) => { if (e.code === 'F3') { e.preventDefault(); this.toggleStats(); } });
    requestAnimationFrame(this.frame);
  }

  /** Performance overlay (F3 or ?debug): FPS, draw calls, triangles, resolution scale and quality tier. */
  private toggleStats(): void {
    if (this.statsEl) {
      this.statsEl.remove();
      this.statsEl = null;
      return;
    }
    const el = document.createElement('div');
    el.style.cssText = 'position:fixed;left:6px;bottom:6px;z-index:99;padding:4px 8px;font:11px/1.4 monospace;color:#3dffb4;background:rgba(0,0,0,.6);pointer-events:none;white-space:pre';
    document.body.appendChild(el);
    this.statsEl = el;
  }

  private updateStats(rawDt: number): void {
    if (!this.statsEl) return;
    this.statsT += rawDt;
    if (this.statsT < 0.5) return;
    this.statsT = 0;
    const s = this.gfx.stats;
    this.statsEl.textContent = `${s.fps.toFixed(0)} FPS | ${s.calls} draws | ${(s.tris / 1000).toFixed(0)}k tris
res x${this.gfx.pixelRatioNow.toFixed(2)} | ${this.gfx.qualityLabel} | ${this.gfx.gpuName.slice(0, 48)}`;
  }

  // ───────────────────────────── GameContext helpers ─────────────────────────────

  shake(amount: number): void {
    this.trauma = Math.min(1, this.trauma + amount);
  }

  hitStop(seconds: number): void {
    this.hitStopT = Math.max(this.hitStopT, seconds);
  }

  private freshState(): GameState {
    return { level: 1, score: 0, kills: 0, killsNeeded: 12, combo: 0, comboTimer: 0, totalKills: 0, terminalsHacked: 0, time: 0 };
  }

  private loadBest(): number {
    try { return Number(localStorage.getItem(BEST_KEY)) || 0; } catch { return 0; }
  }

  private saveBest(v: number): void {
    try { localStorage.setItem(BEST_KEY, String(v)); } catch { /* storage unavailable */ }
  }

  // ───────────────────────────── events ─────────────────────────────

  private bindEvents(): void {
    this.canvas.addEventListener('click', () => {
      if (this.input.isTouch) return;
      if ((this.phase === 'playing') && !this.input.pointerLocked) void this.canvas.requestPointerLock?.();
    });
    this.ui.root.querySelector('.pause')!.addEventListener('click', () => {
      if (this.phase === 'paused') this.setPaused(false);
    });
    document.addEventListener('visibilitychange', () => { if (document.hidden && this.phase === 'playing') this.setPaused(true); });
    window.addEventListener('blur', () => { if (this.phase === 'playing') this.setPaused(true); });
  }

  private setPaused(p: boolean): void {
    if (p && this.phase === 'playing') {
      this.phase = 'paused';
      this.ui.setPaused(true);
      if (document.pointerLockElement) document.exitPointerLock();
    } else if (!p && this.phase === 'paused') {
      this.phase = 'playing';
      this.ui.setPaused(false);
      if (!this.input.isTouch) void this.canvas.requestPointerLock?.();
    }
  }

  // ───────────────────────────── run / level flow ─────────────────────────────

  private async startRun(): Promise<void> {
    if (this.phase === 'transition') return;
    this.phase = 'transition';
    this.input.enabled = false;
    this.ui.hideMenu();
    this.audio.unlock();
    this.audio.startAmbient();
    await this.tx.run({
      title: 'SYSTEM BREACH',
      subtitle: 'PROTOCOL ZERO',
      lines: bootLines(),
      work: () => {
        this.state = this.freshState();
        this.player.fullReset(ORIGIN);
        this.setupLevel(1);
      },
    });
    this.beginPlaying();
    this.ui.toast('PURGE THE HOSTILES — HACK TERMINALS FOR BUFFS', 'info');
  }

  private beginPlaying(): void {
    this.phase = 'playing';
    this.input.enabled = true;
    this.input.clearAll();
    this.ui.setHudVisible(true);
    this.timeTarget = 1;
  }

  private setupLevel(level: number): void {
    const s = this.state;
    s.level = level;
    s.kills = 0;
    s.killsNeeded = 8 + level * 4;
    s.combo = 0;
    s.comboTimer = 0;
    this.palette = PALETTES[(level - 1) % PALETTES.length];
    this.gfx.setTheme(this.palette);
    this.world.reset(level * 7919 + 13, this.palette, ORIGIN);
    this.combat.clear();
    this.fx.clear();
    this.enemies.startLevel(s.killsNeeded);
    this.player.reset(ORIGIN, 0);
    if (level > 1) this.player.heal(30);
    this.portalOpen = false;
    this.camYaw = 0;
    this.camPitch = 0.38;
    this.camDist = CAM_DIST;
    this.snapCamera();
  }

  private openPortal(): void {
    const { player, world } = this;
    this.portalOpen = true;
    this.enemies.stopSpawning();
    let placed = false;
    for (let i = 0; i < 24 && !placed; i++) {
      const a = Math.random() * Math.PI * 2;
      const d = 22 + Math.random() * 10;
      const x = player.pos.x + Math.cos(a) * d;
      const z = player.pos.z + Math.sin(a) * d;
      if (!world.isBlocked(x, z, 3.5)) {
        world.spawnPortal(this.tmpV.set(x, 0, z));
        placed = true;
      }
    }
    if (!placed) world.spawnPortal(this.tmpV.set(player.pos.x + 14, 0, player.pos.z));
    this.audio.portal();
    this.shake(0.3);
    this.gfx.glitch = 0.7;
    this.ui.toast('EXIT PORTAL ONLINE', 'ok');
  }

  private async advanceLevel(): Promise<void> {
    if (this.phase !== 'playing') return;
    this.phase = 'transition';
    this.input.enabled = false;
    this.input.clearAll();
    this.state.score += 500 * this.state.level;
    const next = this.state.level + 1;
    const pal = PALETTES[(next - 1) % PALETTES.length];
    this.ui.setObjectiveArrow(null, 0);
    this.ui.setPrompt(null);
    await this.tx.run({
      title: `SECTOR ${String(next).padStart(2, '0')}`,
      subtitle: pal.name,
      lines: sectorLines(next, pal.name),
      work: () => this.setupLevel(next),
    });
    this.beginPlaying();
    this.ui.toast(`SECTOR ${next} — ICE LEVEL RISING`, 'warn');
  }

  private async startHack(t: Terminal): Promise<void> {
    if (this.phase !== 'playing') return;
    this.phase = 'hacking';
    this.input.enabled = false;
    this.input.clearAll();
    if (document.pointerLockElement) document.exitPointerLock();
    this.timeTarget = 0.12;
    this.ui.setPrompt(null);
    this.audio.glitch();
    const ok = await this.minigame.start(this.state.level);
    if (this.phase !== 'hacking') return; // the runner died mid-hack
    this.phase = 'playing';
    this.input.enabled = true;
    this.input.clearAll();
    this.timeTarget = 1;
    if (ok) {
      this.world.markHacked(t);
      this.state.terminalsHacked++;
      this.state.score += 250;
      this.applyBuff();
      void this.tx.quick(hackLines(true), 500);
    } else {
      this.player.invuln = 0;
      this.player.takeDamage(12, t.pos);
      this.ui.toast('ICE FEEDBACK — HACK FAILED', 'err');
      void this.tx.quick(hackLines(false), 300);
    }
  }

  private applyBuff(): void {
    const { player, state, ui, combat } = this;
    this.audio.success();
    switch (Math.floor(Math.random() * 5)) {
      case 0:
        player.buffs.overclock = 20;
        ui.toast('OVERCLOCK — DAMAGE +60% (20s)', 'ok');
        break;
      case 1:
        player.buffs.phase = 20;
        ui.toast('PHASE-DRIVE — SPEED +35% (20s)', 'ok');
        break;
      case 2:
        player.heal(50);
        ui.toast('NANO-REPAIR — INTEGRITY +50', 'ok');
        break;
      case 3:
        player.energy = player.maxEnergy;
        combat.resetCooldowns();
        ui.toast('CORE SURGE — COOLDOWNS RESET', 'ok');
        break;
      default: {
        const remaining = Math.max(0, state.killsNeeded - state.kills);
        state.killsNeeded = state.kills + Math.ceil(remaining / 2);
        ui.toast('FIREWALL BYPASS — OBJECTIVE HALVED', 'ok');
      }
    }
  }

  private onDeath(): void {
    if (this.phase !== 'playing' && this.phase !== 'hacking') return;
    if (this.phase === 'hacking') this.minigame.abort();
    this.phase = 'dying';
    this.dyingT = 1.7;
    this.timeTarget = 0.25;
    this.input.enabled = false;
    this.input.clearAll();
    const p = this.player;
    p.group.visible = false;
    this.fx.burst(this.tmpV.set(p.pos.x, 1.2, p.pos.z), { color: 0x00f0ff, color2: 0xff2bd6, count: 160, speed: 18, life: 1.2, size: 0.4, gravity: 8, drag: 1 });
    this.combat.ringFx(this.tmpV.set(p.pos.x, 0.3, p.pos.z), 0xff2bd6, 10, 0.7);
    this.audio.explode();
    this.shake(0.9);
    this.gfx.glitch = 1;
    this.ui.setPrompt(null);
    this.ui.setObjectiveArrow(null, 0);
    if (document.pointerLockElement) document.exitPointerLock();
  }

  private async gameOver(): Promise<void> {
    this.phase = 'transition';
    this.audio.stopAmbient();
    const s = this.state;
    const newBest = s.score > this.best;
    if (newBest) { this.best = s.score; this.saveBest(this.best); }
    await this.tx.run({
      title: 'SIGNAL LOST',
      lines: deathLines(s.score),
      work: () => {
        this.ui.showGameOver({ score: s.score, best: this.best, level: s.level, kills: s.totalKills, hacks: s.terminalsHacked, newBest });
      },
    });
    this.phase = 'gameover';
    this.timeTarget = 1;
  }

  // ───────────────────────────── main loop ─────────────────────────────

  private frame = (now: number): void => {
    requestAnimationFrame(this.frame);
    const rawDt = Math.min(0.05, Math.max(0, (now - this.last) / 1000));
    this.last = now;
    this.clock += rawDt;

    this.timeScale += (this.timeTarget - this.timeScale) * Math.min(1, rawDt * 8);
    let dt = rawDt * this.timeScale;
    if (this.hitStopT > 0) {
      this.hitStopT -= rawDt;
      dt *= 0.04;
    }

    switch (this.phase) {
      case 'menu':
      case 'gameover':
        this.tickIdle(dt);
        break;
      case 'transition':
        this.world.update(dt, this.clock, this.player.pos);
        this.fx.update(dt);
        this.updateCamera(rawDt);
        break;
      case 'playing':
      case 'hacking':
        this.tickPlaying(dt, rawDt);
        break;
      case 'paused':
        this.input.poll();
        if (this.input.consume('pause')) this.setPaused(false);
        this.input.endFrame();
        this.pushHud();
        break;
      case 'dying':
        this.tickDying(dt, rawDt);
        break;
    }

    this.fx.setScale(this.gfx.drawingHeight, this.camera.fov);
    this.gfx.followShadow(this.player.pos);
    this.gfx.render(rawDt, this.clock, rawDt);
    this.updateStats(rawDt);
  };

  private tickIdle(dt: number): void {
    this.world.update(dt, this.clock, this.player.pos);
    this.fx.update(dt);
    this.player.update(dt);
    const a = this.clock * 0.12;
    this.camera.position.set(Math.sin(a) * 15, 6.5, Math.cos(a) * 15);
    this.camera.lookAt(0, 3.2, 0);
    this.camera.fov += (62 - this.camera.fov) * 0.1;
    this.camera.updateProjectionMatrix();
  }

  private tickPlaying(dt: number, rawDt: number): void {
    const { input, player, state, world } = this;
    input.poll();
    this.camYaw += input.yawDelta;
    this.camPitch = THREE.MathUtils.clamp(this.camPitch + input.pitchDelta, 0.08, 1.1);
    if (input.consume('pause') && this.phase === 'playing') this.setPaused(true);

    player.update(dt);
    this.combat.update(dt);
    this.enemies.update(dt);
    world.update(dt, this.clock, player.pos);
    this.fx.update(dt);
    state.time += dt;
    if (state.combo > 0) {
      state.comboTimer -= dt;
      if (state.comboTimer <= 0) state.combo = 0;
    }

    if (this.phase === 'playing') {
      const t = world.nearestTerminal(player.pos, 3.4);
      this.ui.setPrompt(t ? (input.isTouch ? 'HACK' : '[F] HACK TERMINAL') : null);
      if (t && input.consume('interact')) void this.startHack(t);
    }

    if (!this.portalOpen && state.kills >= state.killsNeeded && !player.dead) this.openPortal();
    if (this.portalOpen && world.portal && this.phase === 'playing') {
      const dx = world.portal.pos.x - player.pos.x;
      const dz = world.portal.pos.z - player.pos.z;
      const d = Math.hypot(dx, dz);
      const f = this.tmpDir.set(-Math.sin(this.camYaw), 0, -Math.cos(this.camYaw));
      const ang = Math.atan2(dx * Math.cos(this.camYaw) - dz * Math.sin(this.camYaw), dx * f.x + dz * f.z);
      this.ui.setObjectiveArrow(ang, d);
      if (d < 2.4) void this.advanceLevel();
    }

    if (player.dead) this.onDeath();

    this.updateCamera(rawDt);
    this.pushHud();
    this.ui.updateDamageNumbers(rawDt, this.camera);
    this.ui.setMouseHint(this.phase === 'playing' && !input.isTouch && !input.pointerLocked);
    input.endFrame();
  }

  private tickDying(dt: number, rawDt: number): void {
    this.dyingT -= rawDt;
    this.world.update(dt, this.clock, this.player.pos);
    this.enemies.update(dt);
    this.combat.update(dt);
    this.fx.update(dt);
    this.updateCamera(rawDt);
    this.ui.updateDamageNumbers(rawDt, this.camera);
    this.input.endFrame();
    if (this.dyingT <= 0) void this.gameOver();
  }

  private pushHud(): void {
    const { player, state, combat } = this;
    this.ui.setHud({
      hp: player.hp,
      maxHp: player.maxHp,
      energy: player.energy,
      maxEnergy: player.maxEnergy,
      shieldHp: player.shieldHp,
      shieldTime: player.shieldTime,
      level: state.level,
      sector: this.palette.name,
      kills: state.kills,
      need: state.killsNeeded,
      score: state.score,
      combo: state.combo,
      mult: comboMultiplier(state.combo),
      abilities: combat.abilities.map((a) => ({ key: a.key, name: a.name, left: a.left, cooldown: a.cooldown, cost: a.cost })),
      dashFrac: player.dashCd / 1.1,
      buffs: [
        ...(player.buffs.overclock > 0 ? [{ name: 'OVERCLOCK', time: player.buffs.overclock }] : []),
        ...(player.buffs.phase > 0 ? [{ name: 'PHASE-DRIVE', time: player.buffs.phase }] : []),
      ],
    });
  }

  // ───────────────────────────── camera ─────────────────────────────

  private snapCamera(): void {
    this.updateCamera(1, true);
  }

  private updateCamera(rawDt: number, snap = false): void {
    const { camera, player, world } = this;
    const lead = 0.09;
    const goal = this.lookTarget.set(player.pos.x + player.vel.x * lead, player.pos.y + 1.7, player.pos.z + player.vel.z * lead);
    if (snap) this.focus.copy(goal);
    else this.focus.lerp(goal, 1 - Math.exp(-rawDt * 12));
    const target = this.focus;
    const cp = Math.cos(this.camPitch);
    const dir = this.tmpDir.set(Math.sin(this.camYaw) * cp, Math.sin(this.camPitch), Math.cos(this.camYaw) * cp);
    let d = CAM_DIST + (player.dashing > 0 ? 1.8 : 0);
    while (d > 2.4 && world.isBlocked(target.x + dir.x * d, target.z + dir.z * d, 0.7)) d -= 1.2;
    this.camDist += (d - this.camDist) * (snap ? 1 : Math.min(1, rawDt * (d < this.camDist ? 18 : 4)));

    const desired = this.tmpV.copy(target).addScaledVector(dir, this.camDist);
    desired.y = Math.max(0.6, desired.y);
    if (snap) camera.position.copy(desired);
    else camera.position.lerp(desired, 1 - Math.exp(-rawDt * 24));

    camera.lookAt(target.x, target.y + 0.2, target.z);

    this.trauma = Math.max(0, this.trauma - rawDt * 1.9);
    if (this.trauma > 0) {
      const s = this.trauma * this.trauma;
      camera.position.x += (Math.random() - 0.5) * 1.1 * s;
      camera.position.y += (Math.random() - 0.5) * 1.1 * s;
      camera.position.z += (Math.random() - 0.5) * 1.1 * s;
      camera.rotateZ((Math.random() - 0.5) * 0.06 * s);
    }

    const fovTarget = 70 + (player.dashing > 0 ? 12 : 0) + Math.min(5, Math.hypot(player.vel.x, player.vel.z) * 0.3);
    if (Math.abs(camera.fov - fovTarget) > 0.01) {
      camera.fov += (fovTarget - camera.fov) * Math.min(1, rawDt * 10);
      camera.updateProjectionMatrix();
    }
  }
}

new Game();
