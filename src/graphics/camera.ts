import * as THREE from 'three';
import type { GameContext } from '../context';
import { REDUCED_MOTION } from '../config';

const BASE_DIST = 9.5;

/** Smooth third-person rig: exponential follow with velocity look-ahead, wall avoidance, dash FOV kick and trauma shake. */
export class ChaseCamera {
  yaw = 0;
  pitch = 0.36;
  private dist = BASE_DIST;
  private focus = new THREE.Vector3();
  private goal = new THREE.Vector3();
  private dir = new THREE.Vector3();
  private desired = new THREE.Vector3();
  private shakeOff = new THREE.Vector3();
  private shakeRoll = 0;
  private shakeT = 0;

  constructor(private camera: THREE.PerspectiveCamera, private ctx: GameContext) {}

  look(dyaw: number, dpitch: number): void {
    this.yaw += dyaw;
    this.pitch = THREE.MathUtils.clamp(this.pitch + dpitch, 0.06, 1.1);
  }

  update(rawDt: number, snap = false): void {
    const { camera, ctx } = this;
    const { player, city, engine } = ctx;
    this.goal.set(player.pos.x + player.vel.x * 0.09, player.pos.y + 1.7, player.pos.z + player.vel.z * 0.09);
    if (snap) this.focus.copy(this.goal);
    else this.focus.lerp(this.goal, 1 - Math.exp(-rawDt * 12));
    const target = this.focus;

    const cp = Math.cos(this.pitch);
    this.dir.set(Math.sin(this.yaw) * cp, Math.sin(this.pitch), Math.cos(this.yaw) * cp);
    let d = BASE_DIST + (player.dashing > 0 ? 1.8 : 0);
    while (d > 2.4 && city.isBlocked(target.x + this.dir.x * d, target.z + this.dir.z * d, 0.7)) d -= 1.2;
    this.dist += (d - this.dist) * (snap ? 1 : Math.min(1, rawDt * (d < this.dist ? 18 : 4)));

    this.desired.copy(target).addScaledVector(this.dir, this.dist);
    this.desired.y = Math.max(0.6, this.desired.y);
    // Remove last frame's shake offset first so it never feeds back into the follow smoothing.
    camera.position.sub(this.shakeOff);
    if (snap) camera.position.copy(this.desired);
    else camera.position.lerp(this.desired, 1 - Math.exp(-rawDt * 24));
    camera.lookAt(target.x, target.y + 0.2, target.z);

    // Trauma shake: smooth, allocation-free layered sines (no per-frame random jitter), quadratic falloff.
    const trauma = REDUCED_MOTION ? 0 : engine.trauma;
    if (trauma > 0.002) {
      this.shakeT += rawDt * 26;
      const s = trauma * trauma;
      const t = this.shakeT;
      const n = (f: number, p: number): number => Math.sin(t * f + p) * 0.65 + Math.sin(t * f * 2.31 + p * 1.7) * 0.35;
      this.shakeOff.set(n(1.0, 0.0) * 0.5 * s, n(1.27, 2.1) * 0.42 * s, n(0.83, 4.2) * 0.4 * s);
      this.shakeRoll = n(1.63, 1.3) * 0.035 * s;
      camera.position.add(this.shakeOff);
      camera.rotateZ(this.shakeRoll);
    } else if (this.shakeOff.lengthSq() > 0) {
      this.shakeOff.set(0, 0, 0);
      this.shakeRoll = 0;
    }

    const fovTarget = 70 + (player.dashing > 0 ? 12 : 0) + Math.min(5, Math.hypot(player.vel.x, player.vel.z) * 0.3);
    if (Math.abs(camera.fov - fovTarget) > 0.01) {
      camera.fov += (fovTarget - camera.fov) * Math.min(1, rawDt * 10);
      camera.updateProjectionMatrix();
    }
  }

  /** Slow cinematic orbit around a point (main menu / game over). */
  orbit(time: number, around: THREE.Vector3): void {
    const a = time * 0.1;
    this.camera.position.set(around.x + Math.sin(a) * 17, 7.5, around.z + Math.cos(a) * 17);
    this.camera.lookAt(around.x, 4, around.z);
    this.camera.fov += (62 - this.camera.fov) * 0.1;
    this.camera.updateProjectionMatrix();
  }
}
