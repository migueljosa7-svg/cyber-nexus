import * as THREE from 'three';
import type { GameContext } from '../context';

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
    if (snap) camera.position.copy(this.desired);
    else camera.position.lerp(this.desired, 1 - Math.exp(-rawDt * 24));
    camera.lookAt(target.x, target.y + 0.2, target.z);

    const trauma = engine.trauma;
    if (trauma > 0) {
      const s = trauma * trauma;
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

  /** Slow cinematic orbit around a point (main menu / game over). */
  orbit(time: number, around: THREE.Vector3): void {
    const a = time * 0.1;
    this.camera.position.set(around.x + Math.sin(a) * 17, 7.5, around.z + Math.cos(a) * 17);
    this.camera.lookAt(around.x, 4, around.z);
    this.camera.fov += (62 - this.camera.fov) * 0.1;
    this.camera.updateProjectionMatrix();
  }
}
