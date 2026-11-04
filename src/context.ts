import type * as THREE from 'three';
import type { GfxRenderer } from './engine/renderer';
import type { Input } from './input';
import type { AudioFX } from './audio';
import type { ParticleSystem } from './particles';
import type { World } from './world';
import type { Player } from './player';
import type { Combat } from './combat';
import type { EnemyManager } from './enemies';
import type { UI } from './ui';

export interface GameState {
  level: number;
  score: number;
  kills: number;
  killsNeeded: number;
  combo: number;
  comboTimer: number;
  totalKills: number;
  terminalsHacked: number;
  time: number;
}

/** Shared services every gameplay module can reach. Modules only read these lazily (inside methods). */
export interface GameContext {
  gfx: GfxRenderer;
  scene: THREE.Scene;
  camera: THREE.PerspectiveCamera;
  input: Input;
  audio: AudioFX;
  fx: ParticleSystem;
  world: World;
  player: Player;
  combat: Combat;
  enemies: EnemyManager;
  ui: UI;
  state: GameState;
  /** Camera yaw in radians (movement is relative to it). */
  camYaw: number;
  shake(amount: number): void;
  hitStop(seconds: number): void;
}

export function comboMultiplier(combo: number): number {
  return Math.min(5, 1 + Math.floor(combo / 3) * 0.5);
}
