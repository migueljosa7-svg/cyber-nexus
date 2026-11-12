import * as THREE from 'three';
import { IS_TOUCH } from './config';

export type Action = 'jump' | 'dash' | 'attack' | 'shoot' | 'emp' | 'shield' | 'burst' | 'interact' | 'pause' | 'shop' | 'offer' | 'item1' | 'item2' | 'item3';

const KEY_MAP: Record<string, Action> = {
  Space: 'jump',
  ShiftLeft: 'dash',
  ShiftRight: 'dash',
  KeyJ: 'attack',
  KeyK: 'shoot',
  KeyQ: 'emp',
  KeyE: 'shield',
  KeyR: 'burst',
  KeyF: 'interact',
  Enter: 'interact',
  Backquote: 'interact',
  KeyP: 'pause',
  KeyB: 'shop',
  KeyG: 'offer',
  Digit1: 'item1',
  Digit2: 'item2',
  Digit3: 'item3',
};

export class Input {
  readonly isTouch = IS_TOUCH;
  /** x: right, y: forward. Magnitude ≤ 1. */
  readonly move = new THREE.Vector2();
  yawDelta = 0;
  pitchDelta = 0;
  pointerLocked = false;
  enabled = true;

  private keys = new Set<string>();
  private pressed = new Set<Action>();
  private held = new Set<Action>();
  private stick = new THREE.Vector2();

  constructor(private canvas: HTMLCanvasElement) {
    window.addEventListener('keydown', this.onKeyDown);
    window.addEventListener('keyup', this.onKeyUp);
    window.addEventListener('blur', this.releaseAll);
    canvas.addEventListener('mousedown', this.onMouseDown);
    window.addEventListener('mouseup', this.onMouseUp);
    window.addEventListener('mousemove', this.onMouseMove);
    canvas.addEventListener('contextmenu', (e) => e.preventDefault());
    document.addEventListener('pointerlockchange', () => {
      this.pointerLocked = document.pointerLockElement === this.canvas;
    });
  }

  private onKeyDown = (e: KeyboardEvent): void => {
    if (e.target instanceof HTMLInputElement) return;
    if (['Space', 'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'Tab'].includes(e.code)) e.preventDefault();
    if (e.repeat) return;
    this.keys.add(e.code);
    if (!this.enabled) return;
    const action = KEY_MAP[e.code];
    if (action) this.press(action);
  };

  private onKeyUp = (e: KeyboardEvent): void => {
    if (e.target instanceof HTMLInputElement) return;
    this.keys.delete(e.code);
    const action = KEY_MAP[e.code];
    if (action) this.release(action);
  };

  private onMouseDown = (e: MouseEvent): void => {
    if (!this.enabled) return;
    if (e.button === 0) this.press('attack');
    else if (e.button === 2) this.press('shoot');
  };

  private onMouseUp = (e: MouseEvent): void => {
    if (e.button === 0) this.release('attack');
    else if (e.button === 2) this.release('shoot');
  };

  private onMouseMove = (e: MouseEvent): void => {
    if (!this.pointerLocked || !this.enabled) return;
    this.yawDelta -= e.movementX * 0.0024;
    this.pitchDelta += e.movementY * 0.0020;
  };

  private releaseAll = (): void => {
    this.keys.clear();
    this.held.clear();
    this.stick.set(0, 0);
  };

  press(a: Action): void {
    if (!this.enabled) return;
    this.pressed.add(a);
    this.held.add(a);
  }

  release(a: Action): void {
    this.held.delete(a);
  }

  /** True once per press. */
  consume(a: Action): boolean {
    if (!this.pressed.has(a)) return false;
    this.pressed.delete(a);
    return true;
  }

  isHeld(a: Action): boolean {
    return this.enabled && this.held.has(a);
  }

  setStick(x: number, y: number): void {
    this.stick.set(x, y);
  }

  addLook(dx: number, dy: number): void {
    if (!this.enabled) return;
    this.yawDelta -= dx * 0.0052;
    this.pitchDelta += dy * 0.0040;
  }

  /** Called once per frame before gameplay logic reads input. */
  poll(): void {
    if (!this.enabled) {
      this.move.set(0, 0);
      return;
    }
    let x = 0;
    let y = 0;
    if (this.keys.has('KeyW') || this.keys.has('ArrowUp')) y += 1;
    if (this.keys.has('KeyS') || this.keys.has('ArrowDown')) y -= 1;
    if (this.keys.has('KeyD') || this.keys.has('ArrowRight')) x += 1;
    if (this.keys.has('KeyA') || this.keys.has('ArrowLeft')) x -= 1;
    x += this.stick.x;
    y += this.stick.y;
    this.move.set(x, y);
    if (this.move.lengthSq() > 1) this.move.normalize();
  }

  /** Called once per frame after gameplay logic. */
  endFrame(): void {
    this.pressed.clear();
    this.yawDelta = 0;
    this.pitchDelta = 0;
  }

  /** Forgets every physically-held key. Used when focus moves to a DOM panel, whose key-ups the game never sees. */
  releaseKeys(): void {
    this.keys.clear();
    this.held.clear();
    this.pressed.clear();
  }

  /** Drops queued/held actions (keys physically held stay registered so movement resumes smoothly). */
  clearAll(): void {
    this.pressed.clear();
    this.held.clear();
    this.stick.set(0, 0);
    this.yawDelta = 0;
    this.pitchDelta = 0;
  }
}
