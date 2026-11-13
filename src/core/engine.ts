import type { GfxRenderer } from '../graphics/renderer';
import type { GameEvents } from '../context';

export type GameStateId = 'loading' | 'menu' | 'playing' | 'hacking' | 'paused' | 'gameover';

/** Tiny typed publish/subscribe bus used to decouple gameplay systems. */
export class Emitter<E extends object> {
  private map = new Map<keyof E, Set<(payload: never) => void>>();

  on<K extends keyof E>(key: K, fn: (payload: E[K]) => void): () => void {
    let set = this.map.get(key);
    if (!set) {
      set = new Set();
      this.map.set(key, set);
    }
    set.add(fn as (payload: never) => void);
    return () => this.off(key, fn);
  }

  off<K extends keyof E>(key: K, fn: (payload: E[K]) => void): void {
    this.map.get(key)?.delete(fn as (payload: never) => void);
  }

  emit<K extends keyof E>(key: K, payload: E[K]): void {
    const set = this.map.get(key);
    if (!set) return;
    for (const fn of [...set]) (fn as (p: E[K]) => void)(payload);
  }
}

export interface System {
  name: string;
  /** States in which this system runs. */
  states: GameStateId[];
  update(dt: number, rawDt: number): void;
}

/**
 * Core loop: requestAnimationFrame, delta-time synchronisation (clamped), time scaling (slow-mo while hacking),
 * hit-stop, camera trauma, a global state machine, an ordered system list, and adaptive quality control.
 */
export class Engine {
  readonly events = new Emitter<GameEvents>();
  state: GameStateId = 'loading';
  clock = 0;
  timeScale = 1;
  timeTarget = 1;
  trauma = 0;
  fps = 60;
  /** Human readable log of automatic quality changes (shown in the F3 overlay). */
  qualityLog: string[] = [];

  private systems: System[] = [];
  private failed = new Set<string>();
  private last = 0;
  private running = false;
  private hitStopT = 0;
  private renderCb: (dt: number, rawDt: number) => void = () => undefined;

  // adaptive quality
  private winT = 0;
  private winFrames = 0;
  private lowStreak = 0;
  private highStreak = 0;
  private sinceChange = 0;
  private grace = 2;

  constructor(private gfx: GfxRenderer) {}

  addSystem(system: System): void {
    this.systems.push(system);
  }

  onRender(cb: (dt: number, rawDt: number) => void): void {
    this.renderCb = cb;
  }

  setState(next: GameStateId): void {
    if (next === this.state) return;
    const from = this.state;
    this.state = next;
    this.timeTarget = next === 'hacking' ? 0.2 : 1;
    this.events.emit('stateChanged', { from, to: next });
  }

  is(...states: GameStateId[]): boolean {
    return states.includes(this.state);
  }

  addTrauma(amount: number): void {
    this.trauma = Math.min(1, this.trauma + amount);
  }

  hitStop(seconds: number): void {
    this.hitStopT = Math.max(this.hitStopT, seconds);
  }

  start(): void {
    if (this.running) return;
    this.running = true;
    this.last = performance.now();
    requestAnimationFrame(this.frame);
  }

  private frame = (now: number): void => {
    requestAnimationFrame(this.frame);
    const realDt = Math.max(0, (now - this.last) / 1000);
    const rawDt = Math.min(0.05, realDt);
    this.last = now;
    this.clock += rawDt;

    this.timeScale += (this.timeTarget - this.timeScale) * Math.min(1, rawDt * 8);
    let dt = rawDt * this.timeScale;
    if (this.hitStopT > 0) {
      this.hitStopT -= rawDt;
      dt *= 0.04;
    }
    this.trauma = Math.max(0, this.trauma - rawDt * 1.9);

    for (const s of this.systems) {
      if (!s.states.includes(this.state)) continue;
      // One faulty system must never freeze the loop (and with it input / HUD): isolate and report once.
      try { s.update(dt, rawDt); } catch (e) {
        if (!this.failed.has(s.name)) { this.failed.add(s.name); console.error(`[engine] system "${s.name}" threw`, e); }
      }
    }
    this.renderCb(dt, rawDt);
    this.monitorQuality(realDt);
  };

  /**
   * Adaptive quality: sample the frame rate once per second. Below 55 FPS for two samples in a row we step down
   * (resolution -> bloom -> shadows); after a long healthy streak we step back up.
   */
  private monitorQuality(realDt: number): void {
    if (document.visibilityState !== 'visible' || this.state === 'loading') return;
    this.winT += realDt;
    this.winFrames++;
    this.sinceChange += realDt;
    if (this.grace > 0) {
      this.grace -= realDt;
      this.winT = 0;
      this.winFrames = 0;
      return;
    }
    if (this.winT < 0.6) return;
    this.fps = this.winFrames / this.winT;
    this.winT = 0;
    this.winFrames = 0;

    if (this.fps < 50) {
      this.lowStreak++;
      this.highStreak = 0;
    } else if (this.fps >= 58.5) {
      this.highStreak++;
      this.lowStreak = 0;
    } else {
      this.lowStreak = 0;
      this.highStreak = 0;
    }

    if (this.lowStreak >= 2 && this.sinceChange > 0.9) {
      const change = this.gfx.stepDown();
      this.lowStreak = 0;
      this.sinceChange = 0;
      if (change) this.logQuality(`↓ ${change} (${this.fps.toFixed(0)} fps)`);
    } else if (this.highStreak >= 30 && this.sinceChange > 12) {
      const change = this.gfx.stepUp();
      this.highStreak = 0;
      this.sinceChange = 0;
      if (change) this.logQuality(`↑ ${change}`);
    }
  }

  private logQuality(msg: string): void {
    this.qualityLog.push(msg);
    if (this.qualityLog.length > 4) this.qualityLog.shift();
  }
}
