import * as THREE from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import type { GameContext } from './context';

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
  const glow = (c: number, k: number): THREE.MeshBasicMaterial => new THREE.MeshBasicMaterial({ color: new THREE.Color(c).multiplyScalar(k) });
  const glowNormal = {} as Record<EnemyKind, THREE.MeshBasicMaterial>;
  const glowHot = {} as Record<EnemyKind, THREE.MeshBasicMaterial>;
  for (const k of Object.keys(SPECS) as EnemyKind[]) {
    glowNormal[k] = glow(SPECS[k].color, 1.9);
    glowHot[k] = glow(0xffd8b0, 2.2);
  }

  /** Bakes a part into world-of-enemy space: optional rotation, scale, offset and a flat vertex colour. */
  const part = (geo: THREE.BufferGeometry, x: number, y: number, z: number, color: number, scale = 1, rotX = 0): THREE.BufferGeometry => {
    const g = geo.index ? geo.toNonIndexed() : geo;
    if (rotX) g.rotateX(rotX);
    if (scale !== 1) g.scale(scale, scale, scale);
    g.translate(x, y, z);
    const n = g.attributes.position.count;
    const c = new THREE.Color(color);
    const arr = new Float32Array(n * 3);
    for (let i = 0; i < n; i++) { arr[i * 3] = c.r; arr[i * 3 + 1] = c.g; arr[i * 3 + 2] = c.b; }
    g.setAttribute('color', new THREE.BufferAttribute(arr, 3));
    g.deleteAttribute('uv');
    return g;
  };
  const box = (w: number, h: number, d: number): THREE.BoxGeometry => new THREE.BoxGeometry(w, h, d);

  /** Capsule / cylinder helpers (low segment counts: these are merged and drawn many times). */
  const cap = (r: number, len: number): THREE.BufferGeometry => new THREE.CapsuleGeometry(r, len, 3, 6);
  const cyl = (rt: number, rb: number, h: number): THREE.BufferGeometry => new THREE.CylinderGeometry(rt, rb, h, 8);
  const sph = (r: number, sx = 1, sy = 1, sz = 1): THREE.BufferGeometry => new THREE.SphereGeometry(r, 10, 8).scale(sx, sy, sz);

  /**
   * One vertex-coloured body mesh and one glow mesh per kind (2 draw calls per enemy).
   * Proportions: tapered torso, pronounced pauldrons, slim capsule limbs, boots, helmet with an LED visor.
   */
  const build = (kind: EnemyKind): { body: THREE.BufferGeometry; glow: THREE.BufferGeometry } => {
    const DARK = 0x20222e;
    const ARMOR = kind === 'brute' ? 0x6a4428 : 0x4a5278;
    const SUIT = kind === 'brute' ? 0x35261c : 0x2a2e48;
    if (kind === 'hacker') {
      return {
        body: mergeGeometries([
          part(new THREE.ConeGeometry(0.62, 1.5, 8), 0, 0.85, 0, SUIT, 1, Math.PI),
          part(sph(0.17, 1.2, 0.8, 1.05), -0.34, 1.52, 0, ARMOR),
          part(sph(0.17, 1.2, 0.8, 1.05), 0.34, 1.52, 0, ARMOR),
          part(cap(0.05, 0.4), -0.42, 1.2, 0.08, DARK),
          part(cap(0.05, 0.4), 0.42, 1.2, 0.08, DARK),
          part(sph(0.2, 1, 1.12, 1.05), 0, 1.82, 0, ARMOR),
          part(new THREE.ConeGeometry(0.26, 0.35, 6), 0, 1.98, -0.06, DARK),
        ])!,
        glow: mergeGeometries([
          part(box(0.3, 0.07, 0.06), 0, 1.84, 0.19, 0xffffff),
          part(new THREE.OctahedronGeometry(0.17, 0), 0, 1.25, 0.2, 0xffffff),
          part(new THREE.TorusGeometry(0.66, 0.03, 6, 22), 0, 1.1, 0, 0xffffff, 1, Math.PI / 2),
          part(new THREE.TorusGeometry(0.5, 0.025, 6, 22), 0, 1.5, 0, 0xffffff, 1, Math.PI / 2),
        ])!,
      };
    }
    const k = kind === 'brute' ? 1.55 : 1;
    const bulk = kind === 'brute' ? 1.3 : 1;
    const body: THREE.BufferGeometry[] = [
      // boots + legs
      part(box(0.2, 0.16, 0.34), -0.15 * k, 0.08 * k, 0.04 * k, DARK, k),
      part(box(0.2, 0.16, 0.34), 0.15 * k, 0.08 * k, 0.04 * k, DARK, k),
      part(cyl(0.085, 0.065, 0.78), -0.15 * k, 0.55 * k, 0, SUIT, k),
      part(cyl(0.085, 0.065, 0.78), 0.15 * k, 0.55 * k, 0, SUIT, k),
      part(box(0.14, 0.1, 0.12), -0.15 * k, 0.5 * k, 0.07 * k, ARMOR, k),
      part(box(0.14, 0.1, 0.12), 0.15 * k, 0.5 * k, 0.07 * k, ARMOR, k),
      // pelvis, waist, tapered chest
      part(box(0.44 * bulk, 0.2, 0.28), 0, 1.0 * k, 0, DARK, k),
      part(cyl(0.15 * bulk, 0.17 * bulk, 0.22), 0, 1.18 * k, 0, SUIT, k),
      part(new THREE.CylinderGeometry(0.3 * bulk, 0.18 * bulk, 0.5, 8).scale(1, 1, 0.68), 0, 1.5 * k, 0, ARMOR, k),
      // neck + helmet
      part(cyl(0.07, 0.08, 0.1), 0, 1.84 * k, 0, DARK, k),
      part(sph(0.19, 1, 1.1, 1.06), 0, 2.0 * k, 0, ARMOR, k),
      part(box(0.1, 0.12, 0.14), 0.19 * k, 1.99 * k, 0, DARK, k),
      part(box(0.1, 0.12, 0.14), -0.19 * k, 1.99 * k, 0, DARK, k),
      part(box(0.16, 0.08, 0.12), 0, 1.88 * k, 0.12 * k, DARK, k),
      // pauldrons, arms, hands
      part(sph(0.17 * bulk, 1.25, 0.85, 1.15), -0.37 * k * bulk, 1.7 * k, 0, ARMOR, k),
      part(sph(0.17 * bulk, 1.25, 0.85, 1.15), 0.37 * k * bulk, 1.7 * k, 0, ARMOR, k),
      part(cap(0.055, 0.3), -0.42 * k * bulk, 1.45 * k, 0, SUIT, k),
      part(cap(0.055, 0.3), 0.42 * k * bulk, 1.45 * k, 0, SUIT, k),
      part(cap(0.05, 0.28), -0.43 * k * bulk, 1.12 * k, 0.04 * k, DARK, k),
      part(cap(0.05, 0.28), 0.43 * k * bulk, 1.12 * k, 0.04 * k, DARK, k),
      part(sph(0.06), -0.43 * k * bulk, 0.92 * k, 0.05 * k, DARK, k),
      part(sph(0.06), 0.43 * k * bulk, 0.92 * k, 0.05 * k, DARK, k),
      // back unit
      part(box(0.3, 0.42, 0.16), 0, 1.5 * k, -0.2 * k, DARK, k),
    ];
    if (kind === 'brute') {
      body.push(part(sph(0.12, 1.4, 0.7, 1.2), -0.37 * k * bulk, 1.88 * k, 0, DARK, k), part(sph(0.12, 1.4, 0.7, 1.2), 0.37 * k * bulk, 1.88 * k, 0, DARK, k));
    }
    return {
      body: mergeGeometries(body)!,
      glow: mergeGeometries([
        part(box(0.3, 0.07, 0.06), 0, 2.02 * k, 0.185 * k, 0xffffff, k),
        part(box(0.05, 0.4, 0.03), -0.09 * k, 1.5 * k, 0.21 * k, 0xffffff, k),
        part(box(0.05, 0.4, 0.03), 0.09 * k, 1.5 * k, 0.21 * k, 0xffffff, k),
        part(box(0.36 * bulk, 0.04, 0.3), 0, 1.07 * k, 0, 0xffffff, k),
        part(box(0.06, 0.06, 0.05), -0.37 * k * bulk, 1.73 * k, 0.17 * k, 0xffffff, k),
        part(box(0.06, 0.06, 0.05), 0.37 * k * bulk, 1.73 * k, 0.17 * k, 0xffffff, k),
      ])!,
    };
  };

  return {
    bodyMat: new THREE.MeshStandardMaterial({ color: 0xffffff, vertexColors: true, roughness: 0.4, metalness: 0.7, envMapIntensity: 1.4, emissive: 0x0c1020, emissiveIntensity: 1 }),
    flash: new THREE.MeshBasicMaterial({ color: new THREE.Color(3, 3, 3) }),
    stunned: new THREE.MeshBasicMaterial({ color: new THREE.Color(0.3, 1.2, 2.5) }),
    glowNormal,
    glowHot,
    geo: { agent: build('agent'), hacker: build('hacker'), brute: build('brute') } as Record<EnemyKind, { body: THREE.BufferGeometry; glow: THREE.BufferGeometry }>,
    barBgGeo: new THREE.PlaneGeometry(1.3, 0.14),
    barFillGeo: new THREE.PlaneGeometry(1, 0.1).translate(0.5, 0, 0),
    barBgMat: new THREE.MeshBasicMaterial({ color: 0x050510, transparent: true, opacity: 0.75, depthTest: false }),
    barFillMats: [0xff3355, 0xffc400, 0x33ff88].map((c) => new THREE.MeshBasicMaterial({ color: c, depthTest: false })),
  };
})();

export interface EnemyOpts {
  name?: string;
  hpMul?: number;
  dmgMul?: number;
  scale?: number;
  leader?: boolean;
  tag?: string;
  aggro?: boolean;
  aggroRange?: number;
}

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
  name = '';
  leader = false;
  tag = '';
  aggro = true;
  aggroRange = 26;
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
  private bodyMesh!: THREE.Mesh;
  private glowMesh!: THREE.Mesh;
  private bar = new THREE.Group();
  private barFill: THREE.Mesh;
  private barLevel = -1;

  constructor(readonly kind: EnemyKind, level: number, opts: EnemyOpts = {}) {
    const s = SPECS[kind];
    const scale = opts.scale ?? 1;
    this.radius = s.radius * scale;
    this.height = s.height * scale;
    this.speed = s.speed(level);
    this.dmg = s.dmg(level) * (opts.dmgMul ?? 1);
    this.maxHp = this.hp = s.hp(level) * (opts.hpMul ?? 1);
    this.name = opts.name ?? '';
    this.leader = !!opts.leader;
    this.tag = opts.tag ?? '';
    this.aggro = opts.aggro ?? true;
    this.aggroRange = opts.aggroRange ?? 26;
    this.build();
    if (scale !== 1) this.model.scale.setScalar(scale);

    this.bar.position.y = s.height * scale + 0.55;
    const bg = new THREE.Mesh(RES.barBgGeo, RES.barBgMat);
    bg.renderOrder = 30;
    this.barFill = new THREE.Mesh(RES.barFillGeo, RES.barFillMats[2]);
    this.barFill.position.set(-0.6, 0, 0.001);
    this.barFill.renderOrder = 31;
    this.bar.add(bg, this.barFill);
    this.root.add(this.model, this.bar);
  }

  private build(): void {
    const g = RES.geo[this.kind];
    this.bodyMesh = new THREE.Mesh(g.body, RES.bodyMat);
    this.bodyMesh.castShadow = true;
    this.glowMesh = new THREE.Mesh(g.glow, RES.glowNormal[this.kind]);
    this.model.add(this.bodyMesh, this.glowMesh);
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
    this.bodyMesh.material = state === 1 ? RES.flash : RES.bodyMat;
    this.glowMesh.material = state === 0 ? RES.glowNormal[this.kind] : state === 3 ? RES.stunned : RES.glowHot[this.kind];
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
      this.glowMesh.rotation.y = Math.sin(this.animT * 1.4) * 0.12;
      this.glowMesh.scale.setScalar(1 + wp * 0.35);
    } else {
      this.model.position.y = Math.abs(Math.sin(this.animT * 10)) * 0.06 * moving;
      this.model.rotation.x = this.windup > 0 ? -0.35 * Math.min(1, wp * 2) : 0;
    }
    this.model.rotation.z = this.stunT > 0 ? Math.sin(this.animT * 50) * 0.06 : this.kind === 'hacker' ? 0 : Math.sin(this.animT * 10) * 0.05 * moving;

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

/** Spawns, simulates and removes hostile corporate units. Mission sites own their guards through `tag`. */
export class EnemyManager {
  readonly list: Enemy[] = [];
  private tmp = new THREE.Vector3();
  private boltO = new THREE.Vector3();

  constructor(private ctx: GameContext, private scene: THREE.Scene) {}

  get alive(): number {
    return this.list.length;
  }

  spawnAt(kind: EnemyKind, x: number, z: number, opts: EnemyOpts = {}): Enemy {
    const level = this.ctx.player.profile.level;
    const e = new Enemy(kind, level, opts);
    e.pos.set(x, 0, z);
    e.face(this.ctx.player.pos.x - x, this.ctx.player.pos.z - z, 1, 1);
    this.scene.add(e.root);
    this.list.push(e);
    this.ctx.fx.burst(this.tmp.set(x, 1, z), { color: SPECS[kind].color, count: 24, speed: 6, life: 0.6, size: 0.3 });
    return e;
  }

  /** Removes a unit without rewards (despawn). */
  remove(e: Enemy): void {
    const i = this.list.indexOf(e);
    if (i >= 0) this.list.splice(i, 1);
    e.dead = true;
    this.scene.remove(e.root);
  }

  removeTag(tag: string): void {
    for (const e of [...this.list]) if (e.tag === tag) this.remove(e);
  }

  clear(): void {
    for (const e of this.list) this.scene.remove(e.root);
    this.list.length = 0;
  }

  alertTag(tag: string): void {
    for (const e of this.list) if (e.tag === tag) e.aggro = true;
  }

  count(tag: string): number {
    let n = 0;
    for (const e of this.list) if (e.tag === tag) n++;
    return n;
  }

  update(dt: number): void {
    for (const e of this.list) this.simulate(e, dt);
  }

  private simulate(e: Enemy, dt: number): void {
    const { player, city, combat, camera, fx } = this.ctx;
    const dx = player.pos.x - e.pos.x;
    const dz = player.pos.z - e.pos.z;
    const dist = Math.max(0.001, Math.hypot(dx, dz));
    const nx = dx / dist;
    const nz = dz / dist;
    let mx = 0;
    let mz = 0;
    let moving = 0;

    if (!e.aggro && !player.dead && dist < e.aggroRange) {
      e.aggro = true;
      this.ctx.engine.events.emit('alert', { reason: e.tag });
    }

    if (e.stunT > 0) {
      e.stunT -= dt;
      if (e.needsStunSpark) fx.burst(this.tmp.set(e.pos.x, e.height * 0.7, e.pos.z), { color: 0x66ccff, count: 3, speed: 4, life: 0.25, size: 0.18 });
    } else if (!player.dead && e.aggro) {
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
            e.atkCd = Math.max(1.3, 2.4 - player.profile.level * 0.05) + Math.random() * 0.5;
          }
        }
        moving = Math.hypot(mx, mz);
      } else {
        const reach = e.kind === 'brute' ? 3.4 * (e.radius / 1.2 > 1 ? 1.1 : 1) : 2.1;
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

    // Separation so groups spread out instead of stacking.
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

    const sp = e.stunT > 0 || e.windup > 0 || !e.aggro ? 0 : e.speed;
    e.pos.x += mx * sp * dt + e.kb.x * dt;
    e.pos.z += mz * sp * dt + e.kb.z * dt;
    e.kb.multiplyScalar(Math.exp(-7 * dt));
    city.resolve(e.pos, e.radius);
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
    const credits = Math.round(spec.points * (e.leader ? 3 : 0.4));
    player.addCredits(credits);
    player.addXp(Math.round(spec.points * 0.18 * (e.leader ? 3 : 1)));
    player.energy = Math.min(player.maxEnergy, player.energy + 9);
    if (Math.random() < 0.2) player.heal(4);

    this.scene.remove(e.root);
    ctx.engine.events.emit('enemyKilled', { enemy: e });
  }
}
