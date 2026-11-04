import './style.css';
import * as THREE from 'three';
import { CFG, CITY, PALETTE, SAVE_KEY } from './config';
import type { GameContext, GameState } from './context';
import { Engine } from './core/engine';
import { GfxRenderer } from './graphics/renderer';
import { ChaseCamera } from './graphics/camera';
import { ContactShadows } from './graphics/contactShadows';
import { Input } from './input';
import { AudioFX } from './audio';
import { ParticleSystem } from './particles';
import { City } from './world/city';
import { Traffic } from './world/traffic';
import { NpcManager } from './world/npcs';
import { Player, type Profile } from './player/player';
import { Combat } from './combat';
import { EnemyManager } from './enemies';
import { MissionManager, type MissionMarker } from './systems/missions';
import { HackingSystem } from './systems/hacking';
import { HUD } from './ui/hud';
import { Transitions, bootLines, deathLines } from './transitions';

const WORLD_SEED = 20771;
const nextFrame = (): Promise<void> => new Promise((r) => requestAnimationFrame(() => r()));

interface SaveData {
  profile: Profile;
  kills: number;
  hacks: number;
  missionsDone: number;
}

/**
 * Entry point and composition root. Builds every module behind a progress bar, wires the systems into the
 * engine in a fixed order, and owns the high-level flow (menu -> playing <-> hacking -> game over -> respawn).
 */
class Game implements GameContext {
  engine!: Engine;
  gfx!: GfxRenderer;
  scene!: THREE.Scene;
  camera!: THREE.PerspectiveCamera;
  input!: Input;
  audio!: AudioFX;
  fx!: ParticleSystem;
  city!: City;
  traffic!: Traffic;
  npcs!: NpcManager;
  player!: Player;
  combat!: Combat;
  enemies!: EnemyManager;
  missions!: MissionManager;
  hacking!: HackingSystem;
  ui!: HUD;
  tx!: Transitions;
  rig!: ChaseCamera;
  blobs!: ContactShadows;
  state: GameState = { time: 0, kills: 0, hacks: 0, missionsDone: 0, creditsEarned: 0 };

  private canvas = document.getElementById('game') as HTMLCanvasElement;
  private uiRoot = document.getElementById('ui') as HTMLElement;
  private spawn = new THREE.Vector3((0 + 0.5) * CITY.S, 0, (0 + 0.5) * CITY.S + 1);
  private markers: MissionMarker[] = [];
  private mapMarkers: MissionMarker[] = [];
  private dyingT = 0;
  private dying = false;
  private statsEl: HTMLDivElement | null = null;
  private statsT = 0;
  private districtT = 0;
  private districtLabel = '';
  private saveT = 0;
  private starting = false;

  get camYaw(): number {
    return this.rig ? this.rig.yaw : 0;
  }

  shake(amount: number): void {
    this.engine.addTrauma(amount);
  }

  hitStop(seconds: number): void {
    this.engine.hitStop(seconds);
  }

  // ───────────────────────────── boot (loading screen with progress) ─────────────────────────────

  async boot(): Promise<void> {
    this.gfx = new GfxRenderer(this.canvas);
    this.scene = this.gfx.scene;
    this.camera = this.gfx.camera;
    this.engine = new Engine(this.gfx);
    this.audio = new AudioFX();
    this.input = new Input(this.canvas);
    this.ui = new HUD(this.uiRoot, this.input, this.audio, {
      onStart: (newGame) => void this.startGame(newGame),
      onRespawn: () => void this.respawn(),
    });

    const step = async (p: number, text: string, work: () => void | Promise<void>): Promise<void> => {
      this.ui.setLoading(p, text);
      await nextFrame();
      await nextFrame();
      await work();
    };

    await step(0.08, 'INITIALIZING PARTICLE CORE ...', () => {
      this.fx = new ParticleSystem(this.scene, CFG.particleCap);
      this.gfx.onResizeCallback(() => this.fx.setScale(this.gfx.drawingHeight, this.camera.fov));
    });
    await step(0.2, 'COMPILING CITY SHADERS ...', () => {
      this.city = new City(this.scene, this.gfx);
    });
    await step(0.34, 'SPAWNING TRAFFIC GRID ...', () => {
      this.traffic = new Traffic(this, this.scene);
    });
    await step(0.46, 'CLONING CITIZENS ...', () => {
      this.npcs = new NpcManager(this, this.scene);
      this.player = new Player(this, this.scene);
    });
    await step(0.58, 'LOADING COMBAT SUBSYSTEMS ...', () => {
      this.combat = new Combat(this, this.scene);
      this.enemies = new EnemyManager(this, this.scene);
      this.missions = new MissionManager(this, this.scene);
      this.hacking = new HackingSystem(this, this.uiRoot);
      this.tx = new Transitions(this.ui.root, this.audio, this.gfx);
      this.rig = new ChaseCamera(this.camera, this);
      this.blobs = new ContactShadows(this.scene);
    });
    await step(0.7, 'BUILDING METROPOLIS ...', () => {
      this.gfx.setTheme(PALETTE);
      this.city.reset(WORLD_SEED, this.spawn);
      this.player.respawn(this.spawn);
      this.rig.update(1, true);
    });
    await step(0.86, 'WARMING UP SHADERS ...', async () => {
      await this.gfx.warmup();
    });

    this.registerSystems();
    this.bindEvents();
    if (new URLSearchParams(location.search).has('debug')) {
      this.toggleStats();
      (window as unknown as { game: Game }).game = this;
    }
    this.ui.setLoading(1, 'READY');
    await nextFrame();
    this.ui.hideLoading();
    this.engine.setState('menu');
    this.ui.showMenu(this.loadSave() !== null);
    this.engine.onRender((dt, rawDt) => {
      this.gfx.followShadow(this.player.pos);
      this.fx.setScale(this.gfx.drawingHeight, this.camera.fov);
      this.gfx.render(rawDt, this.engine.clock);
      this.updateStats(rawDt);
      void dt;
    });
    this.engine.start();
  }

  // ───────────────────────────── systems (fixed update order) ─────────────────────────────

  private registerSystems(): void {
    const e = this.engine;
    const play: Array<'playing' | 'hacking'> = ['playing', 'hacking'];
    const idle: Array<'menu' | 'gameover'> = ['menu', 'gameover'];

    e.addSystem({
      name: 'input',
      states: play,
      update: () => {
        this.input.poll();
        this.rig.look(this.input.yawDelta, this.input.pitchDelta);
        if (this.input.consume('pause') && e.state === 'playing') this.setPaused(true);
      },
    });
    e.addSystem({ name: 'player', states: play, update: (dt) => this.player.update(dt) });
    e.addSystem({ name: 'combat', states: play, update: (dt) => this.combat.update(dt) });
    e.addSystem({ name: 'enemies', states: play, update: (dt) => this.enemies.update(dt) });
    e.addSystem({ name: 'traffic', states: [...play, ...idle], update: (dt) => this.traffic.update(dt, e.clock) });
    e.addSystem({ name: 'npcs', states: [...play, ...idle], update: (dt) => this.npcs.update(dt, e.clock) });
    e.addSystem({
      name: 'contact-shadows',
      states: [...play, ...idle],
      update: () => {
        const b = this.blobs;
        b.begin();
        for (const n of this.npcs.list) b.add(n.rx, n.rz, 0.46);
        for (const en of this.enemies.list) b.add(en.pos.x, en.pos.z, en.radius * (en.kind === 'hacker' ? 1.5 : 1.25), en.kind === 'hacker' ? 0.55 : 1);
        if (!this.player.dead) b.add(this.player.pos.x, this.player.pos.z, 0.55 + this.player.pos.y * 0.02, this.player.grounded ? 1 : 0.6);
        b.end();
      },
    });
    e.addSystem({ name: 'missions', states: play, update: (dt) => this.missions.update(dt, e.clock) });
    e.addSystem({ name: 'hacking', states: ['playing'], update: (dt) => this.hacking.update(dt) });
    e.addSystem({
      name: 'world',
      states: [...play, ...idle],
      update: (dt) => {
        this.city.update(dt, e.clock, this.player.pos);
        this.fx.update(dt);
        this.state.time += dt;
      },
    });
    e.addSystem({
      name: 'camera',
      states: [...play],
      update: (_dt, rawDt) => {
        this.rig.update(rawDt);
        if (this.player.dead && !this.dying) this.onDeath();
        if (this.dying) {
          this.dyingT -= rawDt;
          if (this.dyingT <= 0) void this.gameOver();
        }
      },
    });
    e.addSystem({
      name: 'idle-camera',
      states: idle,
      update: () => this.rig.orbit(e.clock, this.player.pos),
    });
    e.addSystem({
      name: 'hud',
      states: [...play, 'paused'],
      update: (_dt, rawDt) => {
        this.pushHud(rawDt);
        this.ui.updateOverlays(rawDt, this.camera);
        this.ui.setMouseHint(e.state === 'playing' && !this.input.isTouch && !this.input.pointerLocked);
        if (e.state === 'paused') {
          this.input.poll();
          if (this.input.consume('pause')) this.setPaused(false);
        }
        this.saveT += rawDt;
        if (this.saveT > 25) { this.saveT = 0; this.save(); }
      },
    });
    e.addSystem({ name: 'input-end', states: [...play, 'paused'], update: () => this.input.endFrame() });
  }

  // ───────────────────────────── events / UI plumbing ─────────────────────────────

  private bindEvents(): void {
    this.canvas.addEventListener('click', () => {
      if (this.input.isTouch) return;
      if (this.engine.state === 'playing' && !this.input.pointerLocked) void this.canvas.requestPointerLock?.();
    });
    this.ui.root.querySelector('.pause')!.addEventListener('click', () => {
      if (this.engine.state === 'paused') this.setPaused(false);
    });
    document.addEventListener('visibilitychange', () => { if (document.hidden && this.engine.state === 'playing') this.setPaused(true); });
    window.addEventListener('blur', () => { if (this.engine.state === 'playing') this.setPaused(true); });
    window.addEventListener('keydown', (e) => { if (e.code === 'F3') { e.preventDefault(); this.toggleStats(); } });

    const ev = this.engine.events;
    ev.on('missionCompleted', () => this.save());
    ev.on('levelUp', () => this.save());
  }

  private setPaused(p: boolean): void {
    if (p && this.engine.state === 'playing') {
      this.engine.setState('paused');
      this.ui.setPaused(true);
      if (document.pointerLockElement) document.exitPointerLock();
    } else if (!p && this.engine.state === 'paused') {
      this.engine.setState('playing');
      this.ui.setPaused(false);
      this.input.clearAll();
      if (!this.input.isTouch) void this.canvas.requestPointerLock?.();
    }
  }

  private pushHud(rawDt: number): void {
    const { player, combat, missions, ui, city } = this;
    this.districtT -= rawDt;
    if (this.districtT <= 0) {
      this.districtT = 0.5;
      const d = city.districtAt(player.pos.x, player.pos.z);
      this.districtLabel = `D${d.id} · ${d.name}`;
    }
    ui.setHud({
      hp: player.hp,
      maxHp: player.maxHp,
      energy: player.energy,
      maxEnergy: player.maxEnergy,
      ram: player.ram,
      maxRam: player.maxRam,
      shieldHp: player.shieldHp,
      shieldTime: player.shieldTime,
      level: player.profile.level,
      xp: player.profile.xp,
      xpNext: player.xpToNext,
      skillPoints: player.profile.skillPoints,
      credits: player.profile.credits,
      district: this.districtLabel,
      abilities: combat.abilities.map((a) => ({ key: a.key, name: a.name, left: a.left, cooldown: a.cooldown, cost: a.cost })),
      dashFrac: player.dashCd / 1.0,
    });
    ui.setMissionLog(missions.logData());
    this.markers.length = 0;
    missions.markers(this.markers);
    ui.setMarkers(this.markers);
    this.mapMarkers = this.markers;
    ui.setMinimap({ px: player.pos.x, pz: player.pos.z, camYaw: this.rig.yaw, facing: player.facing, markers: this.mapMarkers });
  }

  // ───────────────────────────── game flow ─────────────────────────────

  private loadSave(): SaveData | null {
    try {
      const raw = localStorage.getItem(SAVE_KEY);
      return raw ? (JSON.parse(raw) as SaveData) : null;
    } catch {
      return null;
    }
  }

  private save(): void {
    if (!this.player || this.engine.state === 'menu' || this.engine.state === 'loading') return;
    const data: SaveData = { profile: this.player.serialize(), kills: this.state.kills, hacks: this.state.hacks, missionsDone: this.state.missionsDone };
    try { localStorage.setItem(SAVE_KEY, JSON.stringify(data)); } catch { /* storage unavailable */ }
  }

  private async startGame(newGame: boolean): Promise<void> {
    if (this.starting) return;
    this.starting = true;
    this.engine.setState('loading');
    this.input.enabled = false;
    this.ui.hideMenu();
    this.audio.unlock();
    this.audio.startAmbient();
    await this.tx.run({
      title: 'SYSTEM BREACH',
      subtitle: 'OPEN WORLD PROTOCOL',
      lines: bootLines(),
      work: () => {
        const save = newGame ? null : this.loadSave();
        this.state = { time: 0, kills: save?.kills ?? 0, hacks: save?.hacks ?? 0, missionsDone: save?.missionsDone ?? 0, creditsEarned: 0 };
        if (save) this.player.load(save.profile);
        else this.player.load({ level: 1, xp: 0, credits: 250, skillPoints: 0, up: { hp: 0, energy: 0, ram: 0, speed: 0, damage: 0 } });
        this.resetWorld();
        this.missions.generateOffers();
        this.missions.accept(0);
      },
    });
    this.starting = false;
    this.beginPlaying();
    this.ui.toast('ENTER / F opens the hack console — try /missions, /scan', 'info');
  }

  private resetWorld(): void {
    this.city.reset(WORLD_SEED, this.spawn);
    this.player.respawn(this.spawn);
    this.enemies.clear();
    this.combat.clear();
    this.fx.clear();
    this.npcs.reset();
    this.missions.refreshSite();
    this.dying = false;
    this.rig.yaw = 0;
    this.rig.pitch = 0.36;
    this.rig.update(1, true);
  }

  private beginPlaying(): void {
    this.engine.setState('playing');
    this.input.enabled = true;
    this.input.clearAll();
    this.ui.setHudVisible(true);
  }

  private onDeath(): void {
    this.dying = true;
    this.dyingT = 1.7;
    this.engine.timeTarget = 0.25;
    this.hacking.close();
    this.input.enabled = false;
    this.input.clearAll();
    const p = this.player;
    p.group.visible = false;
    this.fx.burst(new THREE.Vector3(p.pos.x, 1.2, p.pos.z), { color: 0x00f0ff, color2: 0xff2bd6, count: 160, speed: 18, life: 1.2, size: 0.4, gravity: 8, drag: 1 });
    this.combat.ringFx(new THREE.Vector3(p.pos.x, 0.3, p.pos.z), 0xff2bd6, 10, 0.7);
    this.audio.explode();
    this.shake(0.9);
    this.gfx.glitch = 1;
    this.ui.setPrompt(null);
    this.engine.events.emit('playerDied', undefined);
    if (document.pointerLockElement) document.exitPointerLock();
  }

  private async gameOver(): Promise<void> {
    this.dying = false;
    this.engine.setState('loading');
    this.audio.stopAmbient();
    const lost = Math.floor(this.player.profile.credits * 0.15);
    await this.tx.run({
      title: 'SIGNAL LOST',
      lines: deathLines(this.player.profile.credits),
      work: () => {
        this.player.profile.credits -= lost;
        this.save();
        this.ui.showGameOver({ level: this.player.profile.level, kills: this.state.kills, hacks: this.state.hacks, missions: this.state.missionsDone, creditsLost: lost });
      },
    });
    this.engine.timeTarget = 1;
    this.engine.setState('gameover');
  }

  private async respawn(): Promise<void> {
    if (this.starting) return;
    this.starting = true;
    this.ui.hideGameOver();
    this.engine.setState('loading');
    this.audio.startAmbient();
    await this.tx.run({
      title: 'REBOOTING',
      subtitle: 'CLONE VAT 07',
      lines: bootLines().slice(0, 5),
      work: () => {
        this.resetWorld();
        this.engine.timeTarget = 1;
      },
    });
    this.starting = false;
    this.beginPlaying();
  }

  // ───────────────────────────── debug overlay ─────────────────────────────

  /** Performance overlay (F3 or ?debug): FPS, draw calls, triangles, resolution scale, quality tier and recent changes. */
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
    const log = this.engine.qualityLog.length ? `\n${this.engine.qualityLog.join('\n')}` : '';
    this.statsEl.textContent =
      `${this.engine.fps.toFixed(0)} FPS | ${s.calls} draws | ${(s.tris / 1000).toFixed(0)}k tris\n` +
      `res x${this.gfx.pixelRatio.toFixed(2)} | ${this.gfx.qualityLabel} | bloom ${this.gfx.bloomMode} | ${this.gfx.gpuName.slice(0, 40)}${log}`;
  }
}

void new Game().boot();
