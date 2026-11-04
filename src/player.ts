import * as THREE from 'three';
import { CFG } from './config';
import type { GameContext } from './context';

interface ComboStep {
  dur: number;
  hitAt: number;
  dmg: number;
  range: number;
  arc: number;
  knock: number;
  lunge: number;
  shake: number;
}

const COMBO: ComboStep[] = [
  { dur: 0.3, hitAt: 0.1, dmg: 18, range: 3.4, arc: 2.4, knock: 6, lunge: 7, shake: 0.06 },
  { dur: 0.32, hitAt: 0.11, dmg: 20, range: 3.5, arc: 2.6, knock: 7, lunge: 7.5, shake: 0.08 },
  { dur: 0.55, hitAt: 0.24, dmg: 36, range: 4.4, arc: 3.6, knock: 14, lunge: 10, shake: 0.28 },
];

const MAX_SPEED = 9.5;
const JUMP_V = 12.5;
const DASH_SPEED = 30;
const DASH_TIME = 0.2;
const DASH_CD = 1.1;
const DASH_COST = 14;
const SHOT_COST = 5;
const SHOT_CD = 0.2;

/** Third-person hero: inertial movement, double jump, dash with i-frames, 3-hit laser sword combo and energy bolts. */
export class Player {
  readonly group = new THREE.Group();
  readonly pos = this.group.position;
  readonly vel = new THREE.Vector3();
  facing = 0;
  readonly maxHp = 100;
  readonly maxEnergy = 100;
  hp = 100;
  energy = 100;
  shieldHp = 0;
  shieldTime = 0;
  dead = false;
  grounded = true;
  dashing = 0;
  dashCd = 0;
  invuln = 0;
  attackT = -1;
  comboIdx = 0;
  comboWindow = 0;
  shotCd = 0;
  readonly buffs = { overclock: 0, phase: 0 };

  private jumps = 0;
  private hitDone = false;
  private dashDir = new THREE.Vector3();
  private lungeDir = new THREE.Vector3();
  private model = new THREE.Group();
  private legL!: THREE.Mesh;
  private legR!: THREE.Mesh;
  private armL!: THREE.Group;
  private armR!: THREE.Group;
  private swordPivot = new THREE.Group();
  private blade!: THREE.Mesh;
  private shieldMesh: THREE.Mesh;
  private shieldMat: THREE.MeshBasicMaterial;
  private thruster: THREE.Mesh;
  private light: THREE.PointLight;
  private animT = 0;
  private trailT = 0;
  private tmp = new THREE.Vector3();
  private tmp2 = new THREE.Vector3();
  private wish = new THREE.Vector3();

  constructor(private ctx: GameContext, scene: THREE.Scene) {
    this.buildModel();
    this.shieldMat = new THREE.MeshBasicMaterial({ color: new THREE.Color(0.1, 1.2, 2.2), transparent: true, opacity: 0.22, wireframe: false, blending: THREE.AdditiveBlending, depthWrite: false, side: THREE.DoubleSide });
    this.shieldMesh = new THREE.Mesh(new THREE.IcosahedronGeometry(1.6, 2), this.shieldMat);
    this.shieldMesh.position.y = 1.1;
    this.shieldMesh.visible = false;
    this.group.add(this.shieldMesh);

    this.thruster = new THREE.Mesh(
      new THREE.ConeGeometry(0.18, 0.9, 8),
      new THREE.MeshBasicMaterial({ color: new THREE.Color(0.3, 1.6, 2.4), transparent: true, opacity: 0.0, blending: THREE.AdditiveBlending, depthWrite: false }),
    );
    this.thruster.rotation.x = -Math.PI / 2;
    this.thruster.position.set(0, 1.1, -0.65);
    this.model.add(this.thruster);

    this.light = new THREE.PointLight(0x00f0ff, 18, 16, 2);
    this.light.position.y = 2.2;
    this.group.add(this.light);
    scene.add(this.group);
  }

  private buildModel(): void {
    const dark = new THREE.MeshStandardMaterial({ color: 0x141826, roughness: 0.35, metalness: 0.85 });
    const armor = new THREE.MeshStandardMaterial({ color: 0x1d2440, roughness: 0.3, metalness: 0.9, emissive: 0x001a30, emissiveIntensity: 0.6 });
    const glow = new THREE.MeshBasicMaterial({ color: new THREE.Color(0.1, 1.6, 2.2) });
    const glow2 = new THREE.MeshBasicMaterial({ color: new THREE.Color(2.2, 0.2, 1.7) });

    const torso = new THREE.Mesh(new THREE.BoxGeometry(0.8, 0.95, 0.46), armor);
    torso.position.y = 1.35;
    const chest = new THREE.Mesh(new THREE.BoxGeometry(0.32, 0.32, 0.06), glow);
    chest.position.set(0, 1.45, 0.25);
    const belt = new THREE.Mesh(new THREE.BoxGeometry(0.84, 0.12, 0.5), glow2);
    belt.position.y = 0.92;
    const head = new THREE.Mesh(new THREE.BoxGeometry(0.46, 0.42, 0.46), dark);
    head.position.y = 2.1;
    const visor = new THREE.Mesh(new THREE.BoxGeometry(0.38, 0.1, 0.06), glow);
    visor.position.set(0, 2.12, 0.24);
    const pack = new THREE.Mesh(new THREE.BoxGeometry(0.5, 0.7, 0.24), dark);
    pack.position.set(0, 1.4, -0.35);

    this.legL = new THREE.Mesh(new THREE.BoxGeometry(0.28, 0.9, 0.3), dark);
    this.legR = this.legL.clone();
    this.legL.geometry.translate(0, -0.45, 0);
    this.legR.geometry = this.legL.geometry;
    this.legL.position.set(-0.22, 0.9, 0);
    this.legR.position.set(0.22, 0.9, 0);

    const armGeo = new THREE.BoxGeometry(0.22, 0.8, 0.24).translate(0, -0.35, 0);
    this.armL = new THREE.Group();
    this.armL.add(new THREE.Mesh(armGeo, armor));
    this.armL.position.set(-0.55, 1.75, 0);
    this.armR = new THREE.Group();
    this.armR.add(new THREE.Mesh(armGeo, armor));
    this.armR.position.set(0.55, 1.75, 0);

    this.swordPivot.position.set(0, -0.72, 0.05);
    const hilt = new THREE.Mesh(new THREE.CylinderGeometry(0.04, 0.04, 0.3, 8), dark);
    hilt.rotation.x = Math.PI / 2;
    hilt.position.z = 0.1;
    this.blade = new THREE.Mesh(new THREE.BoxGeometry(0.07, 0.07, 1.7), new THREE.MeshBasicMaterial({ color: new THREE.Color(0.2, 2.6, 3.2) }));
    this.blade.position.z = 1.05;
    const bladeGlow = new THREE.Mesh(new THREE.BoxGeometry(0.2, 0.2, 1.8), new THREE.MeshBasicMaterial({ color: new THREE.Color(0, 0.7, 1.2), transparent: true, opacity: 0.35, blending: THREE.AdditiveBlending, depthWrite: false }));
    bladeGlow.position.z = 1.05;
    this.swordPivot.add(hilt, this.blade, bladeGlow);
    this.armR.add(this.swordPivot);

    this.model.add(torso, chest, belt, head, visor, pack, this.legL, this.legR, this.armL, this.armR);
    this.model.traverse((o) => { if (o instanceof THREE.Mesh) o.castShadow = true; });
    this.group.add(this.model);
  }

  get damageMult(): number {
    return this.buffs.overclock > 0 ? 1.6 : 1;
  }

  reset(at: THREE.Vector3, healFraction = 1): void {
    this.pos.set(at.x, 0, at.z);
    this.vel.set(0, 0, 0);
    this.dead = false;
    this.hp = Math.min(this.maxHp, Math.max(this.hp, this.maxHp * healFraction));
    this.energy = this.maxEnergy;
    this.shieldHp = 0;
    this.shieldTime = 0;
    this.attackT = -1;
    this.comboIdx = 0;
    this.comboWindow = 0;
    this.dashing = 0;
    this.dashCd = 0;
    this.invuln = 1;
    this.group.visible = true;
    this.model.rotation.set(0, 0, 0);
  }

  fullReset(at: THREE.Vector3): void {
    this.hp = this.maxHp;
    this.buffs.overclock = 0;
    this.buffs.phase = 0;
    this.reset(at, 1);
  }

  facingDir(out = new THREE.Vector3()): THREE.Vector3 {
    return out.set(Math.sin(this.facing), 0, Math.cos(this.facing));
  }

  /** Direction to the nearest enemy in front (soft auto-aim), otherwise the facing direction. */
  aimDir(out = new THREE.Vector3(), maxDist = 22, cone = 0.9): THREE.Vector3 {
    const f = this.facingDir(this.tmp2);
    let best: THREE.Vector3 | null = null;
    let bestScore = Infinity;
    for (const e of this.ctx.enemies.list) {
      if (e.dead) continue;
      const dx = e.pos.x - this.pos.x;
      const dz = e.pos.z - this.pos.z;
      const d = Math.hypot(dx, dz);
      if (d > maxDist || d < 0.01) continue;
      const dot = (dx * f.x + dz * f.z) / d;
      if (dot < cone * 0.4 && d > 5) continue;
      const score = d * (2 - dot);
      if (score < bestScore) { bestScore = score; best = this.tmp.set(dx / d, 0, dz / d); }
    }
    return best ? out.copy(best) : out.copy(f);
  }

  takeDamage(amount: number, from?: THREE.Vector3): boolean {
    if (this.dead || this.invuln > 0 || this.dashing > 0) return false;
    let dmg = amount;
    if (this.shieldHp > 0) {
      const absorbed = Math.min(this.shieldHp, dmg);
      this.shieldHp -= absorbed;
      dmg -= absorbed;
      this.shieldMat.opacity = 0.7;
      this.ctx.audio.shieldHit();
      this.ctx.fx.burst(this.tmp.set(this.pos.x, 1.2, this.pos.z), { color: 0x33ddff, count: 14, speed: 6, life: 0.4, size: 0.2 });
      if (this.shieldHp <= 0) this.shieldTime = 0;
    }
    this.invuln = 0.35;
    if (dmg > 0) {
      this.hp -= dmg;
      this.ctx.audio.hurt();
      this.ctx.shake(0.35);
      this.ctx.gfx.hurt = 1;
      this.ctx.gfx.glitch = Math.max(this.ctx.gfx.glitch, 0.35);
      this.ctx.ui.flashDamage();
      if (from) {
        const k = this.tmp.set(this.pos.x - from.x, 0, this.pos.z - from.z).normalize();
        this.vel.x += k.x * 9;
        this.vel.z += k.z * 9;
      }
      this.ctx.state.combo = 0;
      if (this.hp <= 0) {
        this.hp = 0;
        this.dead = true;
      }
    }
    return true;
  }

  heal(n: number): void {
    this.hp = Math.min(this.maxHp, this.hp + n);
  }

  update(dt: number): void {
    const ctx = this.ctx;
    const { input, audio, fx, world } = ctx;
    if (this.dead) return;
    this.animT += dt;

    // Timers
    this.invuln = Math.max(0, this.invuln - dt);
    this.dashCd = Math.max(0, this.dashCd - dt);
    this.shotCd = Math.max(0, this.shotCd - dt);
    this.buffs.overclock = Math.max(0, this.buffs.overclock - dt);
    this.buffs.phase = Math.max(0, this.buffs.phase - dt);
    if (this.shieldTime > 0) {
      this.shieldTime -= dt;
      if (this.shieldTime <= 0) this.shieldHp = 0;
    }
    this.energy = Math.min(this.maxEnergy, this.energy + dt * 7);
    this.shieldMesh.visible = this.shieldHp > 0;
    if (this.shieldMesh.visible) {
      this.shieldMesh.rotation.y += dt * 0.8;
      this.shieldMat.opacity += (0.22 + Math.sin(this.animT * 5) * 0.05 - this.shieldMat.opacity) * Math.min(1, dt * 8);
    }

    // Movement intent relative to camera yaw
    const yaw = ctx.camYaw;
    const fwd = this.tmp.set(-Math.sin(yaw), 0, -Math.cos(yaw));
    const right = this.tmp2.set(Math.cos(yaw), 0, -Math.sin(yaw));
    const mv = input.move;
    const wish = this.wish.set(0, 0, 0).addScaledVector(right, mv.x).addScaledVector(fwd, mv.y);
    const wishLen = wish.length();
    const speedMult = this.buffs.phase > 0 ? 1.35 : 1;
    const attacking = this.attackT >= 0;
    const maxSpeed = MAX_SPEED * speedMult * (attacking ? 0.55 : 1);

    // Dash
    if (input.consume('dash') && this.dashCd <= 0 && this.energy >= DASH_COST && this.dashing <= 0) {
      this.energy -= DASH_COST;
      this.dashCd = DASH_CD;
      this.dashing = DASH_TIME;
      if (wishLen > 0.1) this.dashDir.copy(wish).normalize();
      else this.facingDir(this.dashDir);
      this.facing = Math.atan2(this.dashDir.x, this.dashDir.z);
      this.invuln = Math.max(this.invuln, DASH_TIME + 0.08);
      this.attackT = -1;
      audio.dash();
      ctx.shake(0.14);
      ctx.gfx.glitch = Math.max(ctx.gfx.glitch, 0.25);
    }

    if (this.dashing > 0) {
      this.dashing -= dt;
      this.vel.x = this.dashDir.x * DASH_SPEED;
      this.vel.z = this.dashDir.z * DASH_SPEED;
      this.trailT -= dt;
      if (this.trailT <= 0) {
        this.trailT = 0.016;
        fx.burst(this.tmp.set(this.pos.x, 1.2, this.pos.z), { color: 0x00f0ff, color2: 0xff2bd6, count: 5, speed: 1.5, life: 0.4, size: 0.4, drag: 4 });
      }
    } else {
      const accel = this.grounded ? 14 : 5;
      const k = Math.min(1, accel * dt);
      this.vel.x += (wish.x * maxSpeed - this.vel.x) * k;
      this.vel.z += (wish.z * maxSpeed - this.vel.z) * k;
    }

    // Jump / double jump
    if (input.consume('jump') && this.jumps < 2) {
      this.vel.y = this.jumps === 0 ? JUMP_V : JUMP_V * 0.9;
      this.jumps++;
      this.grounded = false;
      audio.jump();
      fx.burst(this.tmp.set(this.pos.x, 0.15, this.pos.z), { color: 0x66ccff, count: this.jumps === 2 ? 22 : 10, speed: 4, life: 0.45, size: 0.25, gravity: 0, dir: new THREE.Vector3(0, 0.1, 0), cone: 1 });
    }
    this.vel.y -= CFG.gravity * dt;

    // Attack / shoot
    this.comboWindow = Math.max(0, this.comboWindow - dt);
    if (this.comboWindow <= 0 && this.attackT < 0) this.comboIdx = 0;
    const wantAttack = input.consume('attack') || input.isHeld('attack');
    if (wantAttack && this.attackT < 0 && this.dashing <= 0) this.startAttack();
    if (this.attackT >= 0) this.updateAttack(dt);
    if ((input.consume('shoot') || input.isHeld('shoot')) && this.shotCd <= 0 && this.dashing <= 0) this.shoot();

    // Integrate
    this.pos.x += this.vel.x * dt;
    this.pos.z += this.vel.z * dt;
    this.pos.y += this.vel.y * dt;
    if (this.pos.y <= 0) {
      if (!this.grounded && this.vel.y < -6) {
        audio.land();
        fx.burst(this.tmp.set(this.pos.x, 0.1, this.pos.z), { color: 0x88aaff, count: 12, speed: 4, life: 0.4, size: 0.22 });
      }
      this.pos.y = 0;
      this.vel.y = 0;
      this.grounded = true;
      this.jumps = 0;
    } else {
      this.grounded = false;
    }
    if (world.resolve(this.pos, CFG.playerRadius)) {
      // Kill velocity into walls so the hero slides instead of sticking.
      this.vel.x *= 0.85;
      this.vel.z *= 0.85;
    }

    // Facing: attack direction > movement
    if (this.attackT < 0 && this.dashing <= 0 && wishLen > 0.15) {
      const target = Math.atan2(wish.x, wish.z);
      this.facing = this.lerpAngle(this.facing, target, Math.min(1, dt * 14));
    }

    this.light.intensity = 14 + Math.sin(this.animT * 4) * 2 + (this.dashing > 0 ? 18 : 0);
    this.animate(dt, wishLen);
  }

  private lerpAngle(a: number, b: number, t: number): number {
    let d = (b - a) % (Math.PI * 2);
    if (d > Math.PI) d -= Math.PI * 2;
    if (d < -Math.PI) d += Math.PI * 2;
    return a + d * t;
  }

  private startAttack(): void {
    const step = COMBO[this.comboIdx];
    const dir = this.aimDir(this.lungeDir, 7, 0.4);
    this.facing = Math.atan2(dir.x, dir.z);
    this.attackT = 0;
    this.hitDone = false;
    this.vel.x += dir.x * step.lunge;
    this.vel.z += dir.z * step.lunge;
    this.ctx.audio.swing(this.comboIdx);
  }

  private updateAttack(dt: number): void {
    const step = COMBO[this.comboIdx];
    this.attackT += dt;
    if (!this.hitDone && this.attackT >= step.hitAt) {
      this.hitDone = true;
      this.applyMelee(step);
    }
    if (this.attackT >= step.dur) {
      this.attackT = -1;
      this.comboIdx = (this.comboIdx + 1) % COMBO.length;
      this.comboWindow = 0.5;
    }
  }

  private applyMelee(step: ComboStep): void {
    const { ctx } = this;
    const f = this.facingDir(new THREE.Vector3());
    const origin = new THREE.Vector3(this.pos.x, 1.2, this.pos.z);
    let hits = 0;
    for (const e of ctx.enemies.list) {
      if (e.dead) continue;
      const dx = e.pos.x - this.pos.x;
      const dz = e.pos.z - this.pos.z;
      const d = Math.hypot(dx, dz);
      if (d > step.range + e.radius) continue;
      if (d > 0.5) {
        const dot = (dx * f.x + dz * f.z) / d;
        if (Math.acos(THREE.MathUtils.clamp(dot, -1, 1)) > step.arc / 2) continue;
      }
      const kn = new THREE.Vector3(dx, 0, dz).normalize().multiplyScalar(step.knock);
      ctx.combat.damageEnemy(e, step.dmg * this.damageMult, kn);
      hits++;
    }
    const deflected = ctx.combat.deflect(origin, step.range + 0.6, f, step.arc);
    if (hits > 0 || deflected > 0) {
      this.energy = Math.min(this.maxEnergy, this.energy + 3 * hits + deflected);
      ctx.shake(step.shake);
    }
    ctx.combat.slashFx(origin, this.facing, step.range, this.comboIdx);
  }

  private shoot(): void {
    if (this.energy < SHOT_COST) return;
    this.energy -= SHOT_COST;
    this.shotCd = SHOT_CD;
    const dir = this.aimDir(new THREE.Vector3(), 30, 0.6);
    this.facing = this.lerpAngle(this.facing, Math.atan2(dir.x, dir.z), 0.6);
    const o = new THREE.Vector3(this.pos.x + dir.x * 0.8, 1.35, this.pos.z + dir.z * 0.8);
    this.ctx.combat.fireBolt(o, dir, { friendly: true, dmg: 12 * this.damageMult, speed: 42, life: 1.1 });
    this.ctx.audio.shot();
    this.vel.x -= dir.x * 1.2;
    this.vel.z -= dir.z * 1.2;
  }

  private animate(dt: number, wishLen: number): void {
    const speed = Math.hypot(this.vel.x, this.vel.z);
    const run = Math.min(1, speed / MAX_SPEED);
    const swing = Math.sin(this.animT * (8 + run * 6)) * run * 0.9;
    this.group.rotation.y = this.facing;
    this.legL.rotation.x = this.grounded ? swing : -0.5;
    this.legR.rotation.x = this.grounded ? -swing : 0.6;
    this.model.position.y = this.grounded ? Math.abs(Math.sin(this.animT * (8 + run * 6))) * 0.06 * run : 0;
    this.model.rotation.x = THREE.MathUtils.lerp(this.model.rotation.x, run * 0.18 + (this.dashing > 0 ? 0.5 : 0), Math.min(1, dt * 10));
    this.armL.rotation.x = -swing * 0.8;

    if (this.attackT >= 0) {
      const step = COMBO[this.comboIdx];
      const t = THREE.MathUtils.clamp(this.attackT / step.dur, 0, 1);
      const e = 1 - Math.pow(1 - t, 3);
      if (this.comboIdx === 0) { this.armR.rotation.set(-1.4, 1.2 - e * 2.4, 0); this.model.rotation.y = 0.6 - e * 1.2; }
      else if (this.comboIdx === 1) { this.armR.rotation.set(-1.4, -1.2 + e * 2.4, 0); this.model.rotation.y = -0.6 + e * 1.2; }
      else { this.armR.rotation.set(-3.0 + e * 3.4, 0, 0); this.model.rotation.y = 0; }
    } else {
      this.armR.rotation.x = THREE.MathUtils.lerp(this.armR.rotation.x, swing * 0.8 - 0.2, Math.min(1, dt * 12));
      this.armR.rotation.y = THREE.MathUtils.lerp(this.armR.rotation.y, 0, Math.min(1, dt * 12));
      this.model.rotation.y = THREE.MathUtils.lerp(this.model.rotation.y, 0, Math.min(1, dt * 12));
    }
    const mat = this.thruster.material as THREE.MeshBasicMaterial;
    mat.opacity = this.dashing > 0 ? 0.9 : THREE.MathUtils.lerp(mat.opacity, wishLen > 0.1 ? 0.25 : 0, Math.min(1, dt * 8));
    this.thruster.scale.y = 1 + run * 0.8;
    const flick = this.invuln > 0 && this.dashing <= 0 && Math.floor(this.animT * 30) % 2 === 0;
    this.model.visible = !flick;
    this.blade.scale.x = this.blade.scale.y = this.buffs.overclock > 0 ? 1.8 : 1;
  }
}
