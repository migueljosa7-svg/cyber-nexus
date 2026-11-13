import type * as THREE from 'three';
import type { Engine, GameStateId } from './core/engine';
import type { GfxRenderer } from './graphics/renderer';
import type { Input } from './input';
import type { AudioFX } from './audio';
import type { ParticleSystem } from './particles';
import type { City } from './world/city';
import type { Traffic } from './world/traffic';
import type { NpcManager, Npc } from './world/npcs';
import type { Player } from './player/player';
import type { Combat } from './combat';
import type { Enemy, EnemyManager } from './enemies';
import type { MissionManager, Mission } from './systems/missions';
import type { HackingSystem } from './systems/hacking';
import type { HUD } from './ui/hud';
import type { Shop } from './systems/shop';
import type { AdService } from './systems/ads';
import type { DailyStreak } from './systems/daily';
import type { Progress } from './systems/progress';

export interface GameState {
  time: number;
  kills: number;
  hacks: number;
  missionsDone: number;
  creditsEarned: number;
}

export type HackMode = 'hack' | 'override' | 'interrogate';
export type HackKind = 'npc' | 'car' | 'terminal' | 'camera' | 'door';

export interface HackResult {
  ok: boolean;
  lines: string[];
}

/** Anything the player can scan / hack from the console. Created on demand by the owning system. */
export interface HackTarget {
  id: string;
  kind: HackKind;
  label: string;
  pos: THREE.Vector3;
  dist: number;
  modes: HackMode[];
  /** Extra minigame difficulty for this target (0..6). */
  difficulty: number;
  details: string[];
  apply(mode: HackMode): HackResult;
}

export interface GameEvents {
  stateChanged: { from: GameStateId; to: GameStateId };
  enemyKilled: { enemy: Enemy };
  npcHacked: { npc: Npc; mode: HackMode };
  terminalHacked: { id: string };
  doorOpened: { id: string };
  cameraDisabled: { id: string };
  playerDied: undefined;
  levelUp: { level: number };
  missionStarted: { mission: Mission };
  missionCompleted: { mission: Mission };
  missionFailed: { mission: Mission; reason: string };
  alert: { reason: string };
}

/** Shared services every gameplay module can reach. Modules only read these lazily (inside methods). */
export interface GameContext {
  engine: Engine;
  gfx: GfxRenderer;
  scene: THREE.Scene;
  camera: THREE.PerspectiveCamera;
  input: Input;
  audio: AudioFX;
  fx: ParticleSystem;
  city: City;
  traffic: Traffic;
  npcs: NpcManager;
  player: Player;
  combat: Combat;
  enemies: EnemyManager;
  missions: MissionManager;
  hacking: HackingSystem;
  ui: HUD;
  shop: Shop;
  ads: AdService;
  daily: DailyStreak;
  progress: Progress;
  state: GameState;
  /** Camera yaw in radians (movement is relative to it). */
  camYaw: number;
  /** Freezes the world and routes input to a DOM panel (shop, ads, daily reward). Calls nest. */
  modal: { open(): void; close(): void; readonly depth: number };
  save(force?: boolean): void;
  shake(amount: number): void;
  hitStop(seconds: number): void;
}
