import * as THREE from 'three';
import { CFG } from './config';
import { comboMultiplier, type GameContext } from './context';

export type EnemyKind = 'agent' | 'hacker' | 'brute';

interface KindSpec {
  hp: (lvl: number) => number;
  speed: (lvl: number) => number;
  dmg: (lvl: number) => number;
  radius: number;
  height: number;
  points: number;
  color: number;
}

const SPECS: Record<EnemyKind, KindSpec> = {
  agent: { hp: (l) => 40 + l * 7, speed: (l) => 5.2 + l * 0.18, dmg: (l) => 9 + l, radius: 0.6, height: 2.1, points: 100, color: 0xff3355 },
  hacker: { hp: (l) => 26 + l * 4, speed: (l) => 4.2 + l * 0.1, dmg: (l) => 7 + l * 0.7, radius: 0.55, height: 2.3, points: 150, color: 0xff2bd6 },
  brute: { hp: (l) => 135 + l * 20, speed: (l) => 3.4 + l * 0.08, dmg: (l) => 20 + l * 1.5, radius: 1.2, height: 3.4, points: 400, color: 0xff8a1f },
};

/** Geometries and materials are created once and shared by every enemy (no per-spawn allocations). */
const RES = (() => {
  const box = (w: number, h: number, d: number): THREE.BoxGeometry => new THREE.BoxGeometry(w, h, d);
  const std = (color: number): THREE.MeshStandardMaterial =>
    new THREE.MeshStandardMaterial({ color, roughness: 0.35, metalness: 0.85, envMapIntensity: 1.2 });
  const glow = (c: number, k: number): THREE.MeshBasicMaterial => new THREE.MeshBasicMaterial({ color: new THREE.Color(c).multiplyScalar(k) });
  const glowNormal = {} as Record<EnemyKind, THREE.MeshBasicMaterial>;
  const glowHot = {} as Record<EnemyKind, THREE.MeshBasicMaterial>;
  for (const k of Object.keys(SPECS) as EnemyKind[]) {
    glowNormal[k] = glow(SPECS[k].color, 3);
    glowHot[k] = glow(0xffffff, 5);
  }
  return {
    dark: std(0x15161f),
    suit: std(0x1b1b28),
    bruteSuit: std(0x261910),
    flash: new THREE.MeshBasicMaterial({ color: new THREE.Color(3, 3, 3) }),
    stunned: new THREE.MeshBasicMaterial({ color: new THREE.Color(0.3, 1.2, 2.5) }),
    glowNormal,
    glowHot,
    barBgGeo: new THREE.PlaneGeometry(1.3, 0.14),
    barFillGeo: new THREE.PlaneGeometry(1, 0.1).translate(0.5, 0, 0),
    barBgMat: new THREE.MeshBasicMaterial({ color: 0x050510, transparent: true, opacity: 0.75, depthTest: false }),
    barFillMats: [0xff3355, 0xffc400, 0x33ff88].map((c) => new THREE.MeshBasicMaterial({ color: c, depthTest: false })),
    g: {
      torso: box(0.8, 1.1, 0.5),
      strip: box(0.2, 0.9, 0.04),
      head: box(0.46, 0.4, 0.46),
      visor: box(0.4, 0.1, 0.05),
      arm: box(0.2, 0.9, 0.24),
      pad: box(0.5, 0.25, 0.6),
      leg: box(0.28, 0.85, 0.3).translate(0, -0.42, 0),
      core: new THREE.OctahedronGeometry(0.55, 0),
      hood: new THREE.ConeGeometry(0.7, 1.1, 6),
      ring: new THREE.TorusGeometry(0.85, 0.035, 6, 20),
    },
  };
})();

export class Enemy {
  readonly root = new THREE.Group();
  readonly pos = this.root.position;
  readonly vel = new THREE.Vector3();
  readonly kb = new THREE.Vector3();
  readonly radius: number;
  readonly height: number;
  readonly speed: number;
  readonly dmg: number;
  readonly maxHp: number;
  hp: number;
  dead = false;
  stunT = 0;
  atkCd = 0.6 + Math.random();
  windup = 0;
  private windupMax = 0;
  private flashT = 0;
  private facing = 0;
  private animT = Math.random() * 10;
  private strafe = Math.random() < 0.5 ? 1 : -1;
  private strafeT = 1 + Math.random() * 2;
  private stunFx = 0;
  /** 0 normal, 1 hit flash, 2 telegraph, 3 stunned — avoids redundant material swaps. */
  private matState = 0;

  private model = new THREE.Group();
  private bodyMeshes: Array<{ m: THREE.Mesh; mat: THREE.Material }> = [];
  private glowMeshes: THREE.Mesh[] = [];
  private legs: THREE.Mesh[] = [];
  private core: THREE.Mesh | null = null;
  private bar = new THREE.Group();
  private barFill: THREE.Mesh;
  private barLevel = -1;

  constructor(readonly kind: EnemyKind, level: number) {
    const s = SPECS[kind];
    this.radius = s.radius;
    this.height = s.height;
    this.speed = s.speed(level);
    this.dmg = s.dmg(level);
    this.maxHp = this.hp = s.hp(level);
    this.build();

    this.bar.position.y = s.height + 0.55;
    const bg = new THREE.Mesh(RES.barBgGeo, RES.barBgMat);
    bg.renderOrder = 30;
    this.barFill = new THREE.Mesh(RES.barFillGeo, RES.barFillMats[2]);
    this.barFill.position.set(-0.6, 0, 0.001);
    this.barFill.renderOrder = 31;
    this.bar.add(bg, this.barFill);
    this.root.add(this.model, this.bar);
  }

  private part(geo: THREE.BufferGeometry, mat: THREE.Material, x: number, y: number, z: number, scale = 1, glow = false): THREE.Mesh {
    const m = new THREE.Mesh(geo, mat);
    m.position.set(x, y, z);
    if (scale !== 1) m.scale.setScalar(scale);
    m.castShadow = !glow;
    this.model.add(m);
    if (glow) this.glowMeshes.push(m);
    else this.bodyMeshes.push({ m, mat });
    return m;
  }

  private build(): void {
    const G = RES.g;
    const gl = RES.glowNormal[this.kind];
    if (this.kind === 'hacker') {
      this.core = this.part(G.core, gl, 0, 1.4, 0, 1, true);
      const hood = this.part(G.hood, RES.suit, 0, 1.0, 0);
      hood.rotation.x = Math.PI;
      const r1 = this.part(G.ring, gl, 0, 1.4, 0, 1, true);
      r1.rotation.x = Math.PI / 2;
      const r2 = this.part(G.ring, gl, 0, 1.4, 0, 1, true);
      this.legs.push(r1, r2);
      return;
    }
    const k = this.kind === 'brute' ? 1.65 : 1;
    const suit = this.kind === 'brute' ? RES.bruteSuit : RES.suit;
    this.part(G.torso, suit, 0, 1.3 * k, 0, k);
    this.part(G.strip, gl, 0, 1.3 * k, 0.27 * k, k, true);
    this.part(G.head, RES.dark, 0, 2.05 * k, 0, k);
    this.part(G.visor, gl, 0, 2.08 * k, 0.24 * k, k, true);
    this.part(G.arm, RES.dark, -0.55 * k, 1.3 * k, 0, k);
    this.part(G.arm, RES.dark, 0.55 * k, 1.3 * k, 0, k);
    if (this.kind === 'brute') {
      this.part(G.pad, RES.dark, -0.62 * k, 1.85 * k, 0, k);
      this.part(G.pad, RES.dark, 0.62 * k, 1.85 * k, 0, k);
    }
    for (const sx of [-0.2, 0.2]) this.legs.push(this.part(G.leg, RES.dark, sx * k, 0.85 * k, 0, k));
  }

  hit(dmg: number, knock: THREE.Vector3): void {
    this.hp -= dmg;
    this.flashT = 0.1;
    const resist = this.kind === 'brute' ? 0.35 : 1;
    this.kb.addScaledVector(knock, resist);
    if (this.kb.length() > 20) this.kb.setLength(20);
    if (this.windup > 0 && this.kind !== 'brute') this.windup = 0;
  }

  stun(t: number): void {
    this.stunT = Math.max(this.stunT, this.kind === 'brute' ? t * 0.5 : t);
    this.windup = 0;
  }

  startWindup(t: number): void {
    this.windup = this.windupMax = t;
  }

  /** 0..1 progress of the current wind-up telegraph (0 when idle). */
  get windupProgress(): number {
    return this.windup > 0 ? 1 - this.windup / this.windupMax : 0;
  }

  face(dx: number, dz: number, dt: number, rate = 10): void {
    const target = Math.atan2(dx, dz);
    let d = (target - this.facing) % (Math.PI * 2);
    if (d > Math.PI) d -= Math.PI * 2;
    if (d < -Math.PI) d += Math.PI * 2;
    this.facing += d * Math.min(1, dt * rate);
  }

  nextStrafe(dt: number): number {
    this.strafeT -= dt;
    if (this.strafeT <= 0) {
      this.strafeT = 1.5 + Math.random() * 2;
      this.strafe *= -1;
    }
    return this.strafe;
  }

  private setMaterialState(state: number): void {
    if (state === this.matState) return;
    this.matState = state;
    for (const b of this.bodyMeshes) b.m.material = state === 1 ? RES.flash : b.mat;
    const gm = state === 0 ? RES.glowNormal[this.kind] : state === 3 ? RES.stunned : RES.glowHot[this.kind];
    for (const g of this.glowMeshes) g.material = gm;
  }

  /** Visual update: hit flash, telegraph glow (shared material swaps), walk cycle, health bar billboard. */
  animate(dt: number, moving: number, cam: THREE.Camera): void {
    this.animT += dt;
    this.flashT = Math.max(0, this.flashT - dt);
    const wp = this.windupProgress;
    if (this.flashT > 0) this.setMaterialState(1);
    else if (this.stunT > 0) this.setMaterialState(Math.sin(this.animT * 40) > 0 ? 3 : 0);
    else this.setMaterialState(wp > 0.5 ? 2 : 0);

    this.model.rotation.y = this.facing;
    if (this.kind === 'hacker') {
      this.pos.y = 0.35 + Math.sin(this.animT * 2.2) * 0.18;
      if (this.core) {
        this.core.rotation.y += dt * 2;
        this.core.scale.setScalar(1 + wp * 0.7);
      }
      this.legs[0].rotation.z += dt * 2.4;
      this.legs[1].rotation.x += dt * 3.1;
    } else {
      const sw = Math.sin(this.animT * 10) * moving * 0.8;
      if (this.legs[0]) this.legs[0].rotation.x = sw;
      if (this.legs[1]) this.legs[1].rotation.x = -sw;
      this.model.position.y = Math.abs(Math.sin(this.animT * 10)) * 0.05 * moving;
      this.model.rotation.x = this.windup > 0 ? -0.35 * Math.min(1, wp * 2) : 0;
    }
    this.model.rotation.z = this.stunT > 0 ? Math.sin(this.animT * 50) * 0.06 : 0;

    const frac = Math.max(0, this.hp / this.maxHp);
    this.barFill.scale.x = Math.max(0.001, frac * 1.2);
    const level = frac > 0.6 ? 2 : frac > 0.3 ? 1 : 0;
    if (level !== this.barLevel) {
      this.barLevel = level;
      this.barFill.material = RES.barFillMats[level];
    }
    this.bar.quaternion.copy(cam.quaternion);
    this.stunFx = Math.max(0, this.stunFx - dt);
  }

  get needsStunSpark(): boolean {
    if (this.stunT > 0 && this.stunFx <= 0) {
      this.stunFx = 0.09;
      return true;
    }
    return false;
  }
}

/** Spawns, simulates and destroys enemies. */
export class EnemyManager {
  readonly list: Enemy[] = [];
  private toSpawn = 0;
  private spawnTimer = 1;
  private tmp = new THREE.Vector3();
  private boltO = new THREE.Vector3();

  constructor(private ctx: GameContext, private scene: THREE.Scene) {}

  get alive(): number {
    return this.list.length;
  }

  get remainingToSpawn(): number {
    return this.toSpawn;
  }

  startLevel(total: number): void {
    this.clear();
    this.toSpawn = total;
    this.spawnTimer = 1.2;
  }

  stopSpawning(): void {
    this.toSpawn = 0;
  }

  clear(): void {
    for (const e of this.list) this.scene.remove(e.root);
    this.list.length = 0;
    this.toSpawn = 0;
  }

  private pickKind(level: number): EnemyKind {
    const r = Math.random();
    if (level >= 3 && r < 0.13 + Math.min(0.12, level * 0.01)) return 'brute';
    if (level >= 2 && r < 0.45) return 'hacker';
    return 'agent';
  }

  private spawnOne(): boolean {
    const { player, world, state } = this.ctx;
    for (let tries = 0; tries < 10; tries++) {
      const a = Math.random() * Math.PI * 2;
      const d = 24 + Math.random() * 10;
      const x = player.pos.x + Math.cos(a) * d;
      const z = player.pos.z + Math.sin(a) * d;
      if (world.isBlocked(x, z, 1.6)) continue;
      const e = new Enemy(this.pickKind(state.level), state.level);
      e.pos.set(x, 0, z);
      e.face(player.pos.x - x, player.pos.z - z, 1, 1);
      this.scene.add(e.root);
      this.list.push(e);
      this.ctx.fx.burst(this.tmp.set(x, 1, z), { color: SPECS[e.kind].color, count: 24, speed: 6, life: 0.6, size: 0.3 });
      return true;
    }
    return false;
  }

  update(dt: number): void {
    const { player, state } = this.ctx;
    const maxAlive = Math.min(CFG.maxEnemiesCap, 4 + state.level * 2);
    if (this.toSpawn > 0 && !player.dead) {
      this.spawnTimer -= dt;
      if (this.spawnTimer <= 0 && this.list.length < maxAlive) {
        if (this.spawnOne()) this.toSpawn--;
        this.spawnTimer = Math.max(0.6, 2.3 - state.level * 0.17);
      }
    }
    for (const e of this.list) this.simulate(e, dt);
  }

  private simulate(e: Enemy, dt: number): void {
    const { player, world, combat, camera, fx } = this.ctx;
    const dx = player.pos.x - e.pos.x;
    const dz = player.pos.z - e.pos.z;
    const dist = Math.max(0.001, Math.hypot(dx, dz));
    const nx = dx / dist;
    const nz = dz / dist;
    let mx = 0;
    let mz = 0;
    let moving = 0;

    if (e.stunT > 0) {
      e.stunT -= dt;
      if (e.needsStunSpark) fx.burst(this.tmp.set(e.pos.x, e.height * 0.7, e.pos.z), { color: 0x66ccff, count: 3, speed: 4, life: 0.25, size: 0.18 });
    } else if (!player.dead) {
      e.atkCd -= dt;
      if (e.kind === 'hacker') {
        e.face(nx, nz, dt, 12);
        const side = e.nextStrafe(dt);
        if (e.windup <= 0) {
          if (dist > 13) { mx = nx; mz = nz; } else if (dist < 8) { mx = -nx; mz = -nz; } else { mx = -nz * side; mz = nx * side; }
          if (e.atkCd <= 0 && dist < 26) e.startWindup(0.55);
        } else {
          e.windup -= dt;
          if (e.windup <= 0) {
            const lead = (dist / 17) * 0.5;
            const dir = this.tmp.set(dx + player.vel.x * lead, 0, dz + player.vel.z * lead).normalize();
            combat.fireBolt(this.boltO.set(e.pos.x + dir.x, 1.5, e.pos.z + dir.z), dir, { friendly: false, dmg: e.dmg, speed: 17, life: 3, variant: 'red' });
            this.ctx.audio.enemyShot();
            e.atkCd = Math.max(1.3, 2.4 - this.ctx.state.level * 0.06) + Math.random() * 0.5;
          }
        }
        moving = Math.hypot(mx, mz);
      } else {
        const reach = e.kind === 'brute' ? 3.4 : 2.1;
        if (e.windup <= 0) {
          e.face(nx, nz, dt, 9);
          if (dist > reach * 0.8) { mx = nx; mz = nz; moving = 1; }
          if (dist < reach && e.atkCd <= 0) e.startWindup(e.kind === 'brute' ? 0.75 : 0.42);
        } else {
          e.windup -= dt;
          if (e.windup <= 0) {
            e.atkCd = e.kind === 'brute' ? 1.9 : 1.15;
            if (e.kind === 'brute') {
              combat.ringFx(this.tmp.set(e.pos.x, 0.2, e.pos.z), 0xff8a1f, 5, 0.4);
              fx.burst(this.tmp.set(e.pos.x, 0.3, e.pos.z), { color: 0xff8a1f, count: 40, speed: 12, life: 0.5, size: 0.3, gravity: 6 });
              this.ctx.shake(0.4);
              this.ctx.audio.explode();
              if (dist < 5.2) player.takeDamage(e.dmg, e.pos);
            } else if (dist < reach + 0.8) {
              player.takeDamage(e.dmg, e.pos);
              fx.burst(this.tmp.set(player.pos.x, 1.2, player.pos.z), { color: 0xff3355, count: 12, speed: 6, life: 0.3, size: 0.22 });
            }
          }
        }
      }
    }

    // Separation so the horde spreads out instead of stacking.
    for (const o of this.list) {
      if (o === e || o.dead) continue;
      const ox = e.pos.x - o.pos.x;
      const oz = e.pos.z - o.pos.z;
      const min = e.radius + o.radius + 0.3;
      const d2 = ox * ox + oz * oz;
      if (d2 < min * min && d2 > 1e-6) {
        const d = Math.sqrt(d2);
        mx += (ox / d) * 0.9 * (min - d);
        mz += (oz / d) * 0.9 * (min - d);
      }
    }

    const sp = e.stunT > 0 || e.windup > 0 ? 0 : e.speed;
    e.pos.x += mx * sp * dt + e.kb.x * dt;
    e.pos.z += mz * sp * dt + e.kb.z * dt;
    e.kb.multiplyScalar(Math.exp(-7 * dt));
    world.resolve(e.pos, e.radius);
    e.animate(dt, moving, camera);
  }

  kill(e: Enemy): void {
    if (e.dead) return;
    e.dead = true;
    const { ctx } = this;
    const { state, fx, audio, combat, player } = ctx;
    const idx = this.list.indexOf(e);
    if (idx >= 0) this.list.splice(idx, 1);
    const spec = SPECS[e.kind];
    const c = this.tmp.set(e.pos.x, e.height * 0.55, e.pos.z);

    fx.burst(c, { color: spec.color, color2: 0xffffff, count: e.kind === 'brute' ? 100 : 56, speed: 15, life: 0.9, size: 0.38, gravity: 14, drag: 1.2 });
    fx.burst(c, { color: 0x66f6ff, count: 18, speed: 7, life: 0.5, size: 0.5, drag: 3 });
    combat.ringFx(c.set(e.pos.x, 0.25, e.pos.z), spec.color, e.kind === 'brute' ? 7 : 4, 0.4);
    audio.explode();
    ctx.shake(e.kind === 'brute' ? 0.5 : 0.18);
    ctx.hitStop(e.kind === 'brute' ? 0.12 : 0.05);

    state.kills++;
    state.totalKills++;
    state.combo++;
    state.comboTimer = 4;
    state.score += Math.round(spec.points * comboMultiplier(state.combo));
    player.energy = Math.min(player.maxEnergy, player.energy + 9);
    if (Math.random() < 0.2) player.heal(4);

    this.scene.remove(e.root);
  }
}
