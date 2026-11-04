import * as THREE from 'three';
import type { GameContext } from './context';
import type { Enemy } from './enemies';

export type AbilityId = 'emp' | 'shield' | 'burst';

export interface Ability {
  id: AbilityId;
  key: string;
  name: string;
  cooldown: number;
  cost: number;
  left: number;
}

export interface BoltOpts {
  friendly: boolean;
  dmg: number;
  speed: number;
  life: number;
  pierce?: boolean;
  variant?: 'cyan' | 'magenta' | 'red';
}

interface Projectile {
  mesh: THREE.Mesh;
  vel: THREE.Vector3;
  life: number;
  dmg: number;
  friendly: boolean;
  pierce: boolean;
  alive: boolean;
  hit: Set<Enemy>;
}

interface Transient {
  obj: THREE.Object3D;
  mat: THREE.Material;
  geo: THREE.BufferGeometry;
  t: number;
  dur: number;
  step: (k: number) => void;
}

const POOL = 72;
const SLASH_ARC = [2.4, 2.6, 3.6];

/** Abilities (EMP / Data Shield / Quantum Burst), projectiles, deflection and shared hit effects. */
export class Combat {
  readonly abilities: Ability[] = [
    { id: 'emp', key: 'Q', name: 'EMP', cooldown: 9, cost: 30, left: 0 },
    { id: 'shield', key: 'E', name: 'SHIELD', cooldown: 14, cost: 20, left: 0 },
    { id: 'burst', key: 'R', name: 'QUANTUM', cooldown: 12, cost: 40, left: 0 },
  ];

  private pool: Projectile[] = [];
  private transients: Transient[] = [];
  private burstLeft = 0;
  private burstTimer = 0;
  private burstDir = new THREE.Vector3();
  private boltGeo = new THREE.BoxGeometry(0.16, 0.16, 1.1);
  private boltMats: Record<NonNullable<BoltOpts['variant']>, THREE.MeshBasicMaterial> = {
    cyan: new THREE.MeshBasicMaterial({ color: new THREE.Color(0.2, 2.4, 3.2) }),
    magenta: new THREE.MeshBasicMaterial({ color: new THREE.Color(3.0, 0.3, 2.4) }),
    red: new THREE.MeshBasicMaterial({ color: new THREE.Color(3.2, 0.35, 0.5) }),
  };
  private tmp = new THREE.Vector3();
  private tmp2 = new THREE.Vector3();

  constructor(private ctx: GameContext, private scene: THREE.Scene) {
    for (let i = 0; i < POOL; i++) {
      const mesh = new THREE.Mesh(this.boltGeo, this.boltMats.cyan);
      mesh.visible = false;
      scene.add(mesh);
      this.pool.push({ mesh, vel: new THREE.Vector3(), life: 0, dmg: 0, friendly: true, pierce: false, alive: false, hit: new Set() });
    }
  }

  // ───────────────────────────── abilities ─────────────────────────────

  resetCooldowns(): void {
    this.abilities.forEach((a) => (a.left = 0));
  }

  clear(): void {
    for (const p of this.pool) this.kill(p);
    for (const t of this.transients) this.disposeTransient(t);
    this.transients.length = 0;
    this.burstLeft = 0;
  }

  update(dt: number): void {
    const { input, player } = this.ctx;
    for (const a of this.abilities) a.left = Math.max(0, a.left - dt);

    if (!player.dead) {
      if (input.consume('emp')) this.cast('emp');
      if (input.consume('shield')) this.cast('shield');
      if (input.consume('burst')) this.cast('burst');
    }

    if (this.burstLeft > 0) {
      this.burstTimer -= dt;
      while (this.burstTimer <= 0 && this.burstLeft > 0) {
        this.burstTimer += 0.028;
        this.burstLeft--;
        const spread = 0.42;
        const a = (Math.random() - 0.5) * spread * 2;
        const d = this.tmp.copy(this.burstDir);
        const ca = Math.cos(a), sa = Math.sin(a);
        const dir = this.tmp2.set(d.x * ca - d.z * sa, 0, d.x * sa + d.z * ca);
        const o = new THREE.Vector3(player.pos.x + dir.x, 1.3 + (Math.random() - 0.5) * 0.4, player.pos.z + dir.z);
        this.fireBolt(o, dir, { friendly: true, dmg: 15 * player.damageMult, speed: 58, life: 0.85, pierce: true, variant: 'magenta' });
      }
    }

    this.updateProjectiles(dt);
    this.updateTransients(dt);
  }

  private cast(id: AbilityId): boolean {
    const { player, audio, ui } = this.ctx;
    const ab = this.abilities.find((a) => a.id === id)!;
    if (ab.left > 0) { audio.error(); return false; }
    if (player.energy < ab.cost) {
      audio.error();
      ui.toast('INSUFFICIENT ENERGY', 'warn');
      return false;
    }
    player.energy -= ab.cost;
    ab.left = ab.cooldown;
    if (id === 'emp') this.castEMP();
    else if (id === 'shield') this.castShield();
    else this.castBurst();
    return true;
  }

  private castEMP(): void {
    const { player, enemies, audio, fx, gfx } = this.ctx;
    const R = 15;
    const origin = new THREE.Vector3(player.pos.x, 1, player.pos.z);
    audio.emp();
    this.ctx.shake(0.6);
    gfx.glitch = 0.9;
    this.ringFx(origin, 0x33ccff, R, 0.55);
    this.ringFx(origin, 0xff2bd6, R * 0.7, 0.4);
    fx.burst(origin, { color: 0x33ccff, color2: 0xffffff, count: 90, speed: 24, life: 0.7, size: 0.3, drag: 2.5 });
    for (const e of [...enemies.list]) {
      if (e.dead) continue;
      const dx = e.pos.x - player.pos.x;
      const dz = e.pos.z - player.pos.z;
      const d = Math.hypot(dx, dz);
      if (d > R + e.radius) continue;
      e.stun(2.6);
      const kn = new THREE.Vector3(dx, 0, dz).normalize().multiplyScalar(11);
      this.damageEnemy(e, 32 * player.damageMult, kn);
    }
    for (const p of this.pool) {
      if (!p.alive || p.friendly) continue;
      if (Math.hypot(p.mesh.position.x - player.pos.x, p.mesh.position.z - player.pos.z) < R) {
        fx.burst(p.mesh.position, { color: 0xff3355, count: 8, speed: 5, life: 0.3, size: 0.2 });
        this.kill(p);
      }
    }
  }

  private castShield(): void {
    const { player, audio, fx } = this.ctx;
    player.shieldHp = 70;
    player.shieldTime = 8;
    audio.shield();
    this.ringFx(new THREE.Vector3(player.pos.x, 0.2, player.pos.z), 0x33ffcc, 4, 0.5);
    fx.burst(new THREE.Vector3(player.pos.x, 1, player.pos.z), { color: 0x33ffcc, count: 36, speed: 7, life: 0.6, size: 0.25 });
    this.ctx.ui.toast('DATA SHIELD ONLINE', 'ok');
  }

  private castBurst(): void {
    const { player, audio } = this.ctx;
    player.aimDir(this.burstDir, 30, 0.5);
    player.facing = Math.atan2(this.burstDir.x, this.burstDir.z);
    this.burstLeft = 18;
    this.burstTimer = 0;
    audio.burst();
    this.ctx.shake(0.35);
    player.vel.x -= this.burstDir.x * 3;
    player.vel.z -= this.burstDir.z * 3;
  }

  // ───────────────────────────── damage & fx ─────────────────────────────

  damageEnemy(e: Enemy, dmg: number, knock: THREE.Vector3, opts: { crit?: boolean } = {}): void {
    if (e.dead) return;
    const { fx, audio, ui } = this.ctx;
    const crit = opts.crit ?? Math.random() < 0.18;
    const total = Math.max(1, Math.round(dmg * (crit ? 2 : 1)));
    e.hit(total, knock);
    const at = this.tmp.set(e.pos.x, e.height * 0.6, e.pos.z);
    fx.burst(at, crit
      ? { color: 0xffee33, color2: 0xff2bd6, count: 34, speed: 13, life: 0.55, size: 0.34, gravity: 12 }
      : { color: 0x66f6ff, color2: 0xffffff, count: 14, speed: 8, life: 0.4, size: 0.24, gravity: 10 });
    if (crit) { audio.crit(); this.ctx.shake(0.32); this.ctx.hitStop(0.075); this.ctx.gfx.glitch = Math.max(this.ctx.gfx.glitch, 0.3); }
    else { audio.hit(); this.ctx.hitStop(0.03); }
    ui.damageNumber(at, total, crit);
    if (e.hp <= 0) this.ctx.enemies.kill(e);
  }

  /** Turns hostile bolts inside a frontal arc into friendly ones. */
  deflect(origin: THREE.Vector3, radius: number, dir: THREE.Vector3, arc: number): number {
    let n = 0;
    for (const p of this.pool) {
      if (!p.alive || p.friendly) continue;
      const dx = p.mesh.position.x - origin.x;
      const dz = p.mesh.position.z - origin.z;
      const d = Math.hypot(dx, dz);
      if (d > radius) continue;
      if (d > 0.3 && Math.acos(THREE.MathUtils.clamp((dx * dir.x + dz * dir.z) / d, -1, 1)) > arc / 2) continue;
      p.friendly = true;
      p.dmg *= 2;
      p.mesh.material = this.boltMats.cyan;
      const speed = p.vel.length() * 1.4;
      p.vel.copy(dir).multiplyScalar(speed);
      p.life = 1.2;
      p.mesh.lookAt(p.mesh.position.clone().add(p.vel));
      this.ctx.audio.shieldHit();
      this.ctx.fx.burst(p.mesh.position, { color: 0xffffff, color2: 0x33ddff, count: 12, speed: 7, life: 0.3, size: 0.25 });
      n++;
    }
    return n;
  }

  fireBolt(origin: THREE.Vector3, dir: THREE.Vector3, o: BoltOpts): void {
    let p = this.pool.find((q) => !q.alive);
    if (!p) p = this.pool.reduce((a, b) => (a.life < b.life ? a : b));
    p.alive = true;
    p.friendly = o.friendly;
    p.dmg = o.dmg;
    p.life = o.life;
    p.pierce = !!o.pierce;
    p.hit.clear();
    p.vel.copy(dir).setY(0).normalize().multiplyScalar(o.speed);
    p.mesh.material = this.boltMats[o.variant ?? (o.friendly ? 'cyan' : 'red')];
    p.mesh.position.copy(origin);
    p.mesh.lookAt(origin.x + p.vel.x, origin.y, origin.z + p.vel.z);
    p.mesh.visible = true;
  }

  private kill(p: Projectile): void {
    p.alive = false;
    p.mesh.visible = false;
  }

  private updateProjectiles(dt: number): void {
    const { enemies, player, world, fx } = this.ctx;
    for (const p of this.pool) {
      if (!p.alive) continue;
      p.life -= dt;
      if (p.life <= 0) { this.kill(p); continue; }
      const dist = p.vel.length() * dt;
      const steps = Math.max(1, Math.ceil(dist / 0.7));
      const sdt = dt / steps;
      for (let s = 0; s < steps && p.alive; s++) {
        p.mesh.position.addScaledVector(p.vel, sdt);
        const pos = p.mesh.position;
        if (world.isBlocked(pos.x, pos.z, 0.15)) {
          fx.burst(pos, { color: p.friendly ? 0x66f6ff : 0xff4466, count: 10, speed: 6, life: 0.3, size: 0.2, gravity: 8 });
          this.kill(p);
          break;
        }
        if (p.friendly) {
          for (const e of enemies.list) {
            if (e.dead || p.hit.has(e)) continue;
            const dx = e.pos.x - pos.x;
            const dz = e.pos.z - pos.z;
            const r = e.radius + 0.25;
            if (dx * dx + dz * dz < r * r && pos.y < e.height + 0.4) {
              p.hit.add(e);
              this.damageEnemy(e, p.dmg, this.tmp2.copy(p.vel).setY(0).normalize().multiplyScalar(3));
              if (!p.pierce) { this.kill(p); break; }
            }
          }
        } else {
          const dx = player.pos.x - pos.x;
          const dz = player.pos.z - pos.z;
          if (dx * dx + dz * dz < 0.75 * 0.75 && pos.y < 2.2) {
            if (player.takeDamage(p.dmg, pos)) {
              fx.burst(pos, { color: 0xff3355, count: 16, speed: 8, life: 0.4, size: 0.25 });
              this.kill(p);
            }
          }
        }
      }
      if (p.alive) fx.spark(p.mesh.position, p.friendly ? (p.mesh.material === this.boltMats.magenta ? 0xff2bd6 : 0x00f0ff) : 0xff3355, 0.2, 0.25);
    }
  }

  // ───────────────────────────── transient visuals ─────────────────────────────

  ringFx(at: THREE.Vector3, color: number, maxR: number, dur: number): void {
    const geo = new THREE.RingGeometry(0.94, 1, 56);
    const mat = new THREE.MeshBasicMaterial({ color: new THREE.Color(color).multiplyScalar(3), transparent: true, opacity: 1, blending: THREE.AdditiveBlending, depthWrite: false, side: THREE.DoubleSide });
    const mesh = new THREE.Mesh(geo, mat);
    mesh.rotation.x = -Math.PI / 2;
    mesh.position.copy(at);
    this.scene.add(mesh);
    this.transients.push({
      obj: mesh, mat, geo, t: 0, dur,
      step: (k) => {
        const e = 1 - Math.pow(1 - k, 3);
        mesh.scale.setScalar(Math.max(0.01, e * maxR));
        mat.opacity = 1 - k;
      },
    });
  }

  slashFx(origin: THREE.Vector3, facing: number, range: number, idx: number): void {
    const arc = SLASH_ARC[idx];
    const geo = new THREE.RingGeometry(range * 0.45, range, 28, 1, -arc / 2, arc);
    const mat = new THREE.MeshBasicMaterial({ color: new THREE.Color(idx === 2 ? 3 : 0.4, idx === 2 ? 0.8 : 2.6, idx === 2 ? 2.5 : 3.2), transparent: true, opacity: 0.9, blending: THREE.AdditiveBlending, depthWrite: false, side: THREE.DoubleSide });
    const mesh = new THREE.Mesh(geo, mat);
    mesh.rotation.x = -Math.PI / 2;
    const holder = new THREE.Group();
    holder.position.set(origin.x, 1.0, origin.z);
    holder.rotation.y = facing - Math.PI / 2;
    holder.add(mesh);
    this.scene.add(holder);
    const dir = new THREE.Vector3(Math.sin(facing), 0, Math.cos(facing));
    this.ctx.fx.burst(new THREE.Vector3(origin.x + dir.x * range * 0.7, 1.2, origin.z + dir.z * range * 0.7), {
      color: 0x66f6ff, color2: 0xff2bd6, count: idx === 2 ? 30 : 12, speed: 9, life: 0.35, size: 0.22, dir, cone: 0.9,
    });
    this.transients.push({
      obj: holder, mat, geo, t: 0, dur: 0.22,
      step: (k) => {
        mat.opacity = (1 - k) * 0.9;
        mesh.scale.setScalar(1 + k * 0.25);
      },
    });
  }

  private disposeTransient(t: Transient): void {
    this.scene.remove(t.obj);
    t.geo.dispose();
    t.mat.dispose();
  }

  private updateTransients(dt: number): void {
    for (let i = this.transients.length - 1; i >= 0; i--) {
      const t = this.transients[i];
      t.t += dt;
      const k = Math.min(1, t.t / t.dur);
      t.step(k);
      if (k >= 1) {
        this.disposeTransient(t);
        this.transients.splice(i, 1);
      }
    }
  }
}
