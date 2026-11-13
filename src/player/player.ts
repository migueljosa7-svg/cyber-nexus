import * as THREE from 'three';
import { buildHumanoid, type Cape, type HumanoidRig } from './humanoid';
import { CFG } from '../config';
import type { GameContext } from '../context';

export type UpgradeId = 'hp' | 'energy' | 'ram' | 'speed' | 'damage';

export type GearId = 'laser' | 'shield' | 'core' | 'armor';
export type ItemId = 'ram' | 'kit' | 'adrenaline';
export const MAX_GEAR = 5;

export interface Profile {
  level: number;
  xp: number;
  credits: number;
  skillPoints: number;
  up: Record<UpgradeId, number>;
  /** Purchased equipment tiers (0..5). They change the character's 3D model. */
  gear: Record<GearId, number>;
  /** Consumable stock. */
  items: Record<ItemId, number>;
}

export function defaultProfile(): Profile {
  return {
    level: 1, xp: 0, credits: 250, skillPoints: 0,
    up: { hp: 0, energy: 0, ram: 0, speed: 0, damage: 0 },
    gear: { laser: 0, shield: 0, core: 0, armor: 0 },
    items: { ram: 1, kit: 1, adrenaline: 0 },
  };
}

/** Blade colour per laser tier (HDR so it blooms). */
const BLADE_TINT: Array<[number, number, number]> = [
  [0.2, 2.6, 3.2], [0.3, 3.0, 3.0], [0.4, 3.4, 1.4], [3.0, 0.8, 3.0], [3.6, 3.0, 1.0], [3.8, 3.4, 3.4],
];

export const UPGRADE_INFO: Record<UpgradeId, { label: string; desc: string }> = {
  hp: { label: 'CYBERNETIC HULL', desc: '+20 max integrity' },
  energy: { label: 'ARC REACTOR', desc: '+15 max energy' },
  ram: { label: 'NEURAL RAM', desc: '+20 max RAM, faster regen' },
  speed: { label: 'SERVO LEGS', desc: '+5% move speed' },
  damage: { label: 'PLASMA EDGE', desc: '+10% damage' },
};

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

const BASE_SPEED = 10;
const JUMP_V = 12.5;
const DASH_SPEED = 32;
const DASH_TIME = 0.2;
const DASH_CD = 1.0;
const DASH_COST = 14;
const SHOT_COST = 4;
const SHOT_CD = 0.17;

const clamp = THREE.MathUtils.clamp;

type Rig = HumanoidRig;

/** Third-person runner: inertial movement, double jump, dash with trail, 3-hit energy-blade combo, kinetic shots, RPG stats. */
export class Player {
  readonly group = new THREE.Group();
  readonly pos = this.group.position;
  readonly vel = new THREE.Vector3();
  facing = 0;
  hp = 100;
  energy = 100;
  ram = 100;
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
  readonly profile: Profile = defaultProfile();
  /** Seconds of adrenaline boost left. */
  adrenaline = 0;
  /** Current slash / trail colour (follows the laser tier). */
  readonly trailColor = new THREE.Color(0.4, 2.6, 3.2);

  private jumps = 0;
  private hitDone = false;
  private dashDir = new THREE.Vector3();
  private lungeDir = new THREE.Vector3();
  private model = new THREE.Group();
  private rig!: Rig;
  private swordPivot = new THREE.Group();
  private blade!: THREE.Mesh;
  private visorMat = new THREE.MeshBasicMaterial({ color: new THREE.Color(0.1, 1.6, 2.2) });
  private glowMat = new THREE.MeshBasicMaterial({ color: new THREE.Color(0.1, 1.6, 2.2) });
  private glow2Mat = new THREE.MeshBasicMaterial({ color: new THREE.Color(2.2, 0.2, 1.7) });
  private armorMat = new THREE.MeshStandardMaterial({ color: 0x232c52, roughness: 0.25, metalness: 0.95, emissive: 0x002a44, emissiveIntensity: 0.8, envMapIntensity: 1.6 });
  private bladeMat = new THREE.MeshBasicMaterial({ color: new THREE.Color(0.2, 2.6, 3.2) });
  private bladeGlow!: THREE.Mesh;
  private armorTiers: THREE.Object3D[] = [];
  private cape!: Cape;
  private lastFacing = 0;
  private gearLight = 0;
  private equipFlash = 0;
  private bladeBase = 1;
  private trailHex = 0x66f6ff;
  private shieldMesh: THREE.Mesh;
  private shieldMat: THREE.MeshBasicMaterial;
  private thruster: THREE.Mesh;
  private light: THREE.PointLight;
  private animT = 0;
  private trailT = 0;
  private lastStep = 0;
  private shotPose = 0;
  private hurtT = 0;
  private tmp = new THREE.Vector3();
  private tmp2 = new THREE.Vector3();
  private wish = new THREE.Vector3();

  constructor(private ctx: GameContext, scene: THREE.Scene) {
    this.buildModel();
    this.shieldMat = new THREE.MeshBasicMaterial({ color: new THREE.Color(0.1, 1.2, 2.2), transparent: true, opacity: 0.18, blending: THREE.AdditiveBlending, depthWrite: false, side: THREE.DoubleSide });
    this.shieldMesh = new THREE.Mesh(new THREE.IcosahedronGeometry(1.6, 2), this.shieldMat);
    this.shieldMesh.position.y = 1.0;
    this.shieldMesh.visible = false;
    this.group.add(this.shieldMesh);

    this.thruster = new THREE.Mesh(
      new THREE.ConeGeometry(0.16, 0.9, 8),
      new THREE.MeshBasicMaterial({ color: new THREE.Color(0.3, 1.6, 2.4), transparent: true, opacity: 0, blending: THREE.AdditiveBlending, depthWrite: false }),
    );
    this.thruster.rotation.x = -Math.PI / 2;
    this.thruster.position.set(0, 1.15, -0.55);
    this.model.add(this.thruster);

    this.light = new THREE.PointLight(0x00f0ff, 14, 14, 2);
    this.light.position.y = 2.2;
    this.group.add(this.light);
    scene.add(this.group);
    this.applyGear();
    this.hp = this.maxHp;
    this.energy = this.maxEnergy;
    this.ram = this.maxRam;
  }

  // ───────────────────────────── stats & progression ─────────────────────────────

  get maxHp(): number { return 100 + 20 * this.profile.up.hp + 18 * this.profile.gear.armor; }
  get maxEnergy(): number { return 100 + 15 * this.profile.up.energy + 12 * this.profile.gear.core; }
  get energyRegen(): number { return 7 + 1.4 * this.profile.gear.core; }
  /** Incoming damage multiplier from armour plating. */
  get armorFactor(): number { return 1 - 0.045 * this.profile.gear.armor; }
  get shieldCap(): number { return 70 + 25 * this.profile.gear.shield; }
  get shieldDuration(): number { return 8 + this.profile.gear.shield; }
  get maxRam(): number { return 100 + 20 * this.profile.up.ram; }
  get speedMult(): number { return (1 + 0.05 * this.profile.up.speed) * (this.adrenaline > 0 ? 1.25 : 1); }
  get damageMult(): number { return (1 + 0.1 * this.profile.up.damage) * (1 + 0.12 * this.profile.gear.laser) * (this.adrenaline > 0 ? 1.25 : 1); }
  get xpToNext(): number { return 100 + (this.profile.level - 1) * 70; }

  addXp(n: number): void {
    const p = this.profile;
    p.xp += n;
    let leveled = false;
    while (p.xp >= this.xpToNext) {
      p.xp -= this.xpToNext;
      p.level++;
      p.skillPoints++;
      leveled = true;
      this.hp = this.maxHp;
      this.energy = this.maxEnergy;
      this.ram = this.maxRam;
      this.ctx.engine.events.emit('levelUp', { level: p.level });
    }
    if (leveled) {
      this.ctx.ui.toast(`LEVEL ${p.level} — SKILL POINT AVAILABLE (/upgrade)`, 'ok');
      this.ctx.audio.success();
      this.ctx.fx.burst(this.tmp.set(this.pos.x, 1.2, this.pos.z), { color: 0xb6ff00, color2: 0x00f0ff, count: 70, speed: 10, life: 1.0, size: 0.35, gravity: -2 });
    }
  }

  addCredits(n: number): void {
    this.profile.credits += n;
    this.ctx.state.creditsEarned += n;
  }

  spendCredits(n: number): boolean {
    if (this.profile.credits < n) return false;
    this.profile.credits -= n;
    return true;
  }

  upgrade(id: UpgradeId): boolean {
    const p = this.profile;
    if (p.skillPoints <= 0 || p.up[id] >= 10) return false;
    p.skillPoints--;
    p.up[id]++;
    this.hp = Math.min(this.maxHp, this.hp + (id === 'hp' ? 20 : 0));
    return true;
  }

  /** Spends RAM for a hacking action. */
  useRam(n: number): boolean {
    if (this.ram < n) return false;
    this.ram -= n;
    return true;
  }

  serialize(): Profile {
    return JSON.parse(JSON.stringify(this.profile)) as Profile;
  }

  load(p: Partial<Profile>): void {
    const d = defaultProfile();
    Object.assign(this.profile, d, p);
    this.profile.up = { ...d.up, ...(p.up ?? {}) };
    this.profile.gear = { ...d.gear, ...(p.gear ?? {}) };
    this.profile.items = { ...d.items, ...(p.items ?? {}) };
    for (const k of Object.keys(this.profile.gear) as GearId[]) this.profile.gear[k] = clamp(Math.floor(this.profile.gear[k]) || 0, 0, MAX_GEAR);
    // A hand-edited / corrupted save must never break the session: coerce every number into a sane range.
    const pr = this.profile;
    const num = (v: unknown, lo: number, hi: number, d: number): number => (typeof v === 'number' && Number.isFinite(v) ? clamp(Math.floor(v), lo, hi) : d);
    pr.level = num(pr.level, 1, 999, 1);
    pr.xp = num(pr.xp, 0, 1e9, 0);
    pr.credits = num(pr.credits, 0, 1e9, d.credits);
    pr.skillPoints = num(pr.skillPoints, 0, 9999, 0);
    for (const k of Object.keys(pr.up) as UpgradeId[]) pr.up[k] = num(pr.up[k], 0, 10, 0);
    for (const k of Object.keys(pr.items) as ItemId[]) pr.items[k] = num(pr.items[k], 0, 9, 0);
    this.adrenaline = 0;
    this.applyGear();
    this.hp = this.maxHp;
    this.energy = this.maxEnergy;
    this.ram = this.maxRam;
  }

  /** Spends one consumable. Returns a short result line, or null when it cannot be used right now. */
  useItem(id: ItemId): string | null {
    const p = this.profile;
    if (p.items[id] <= 0 || this.dead) return null;
    if (id === 'ram') {
      if (this.ram >= this.maxRam - 1) return null;
      this.ram = Math.min(this.maxRam, this.ram + 60);
      p.items.ram--;
      return 'RAM PACK  +60 RAM';
    }
    if (id === 'kit') {
      if (this.hp >= this.maxHp - 1) return null;
      this.heal(60);
      p.items.kit--;
      return 'INTEGRITY KIT  +60 HP';
    }
    if (this.adrenaline > 0) return null;
    this.adrenaline = 12;
    p.items.adrenaline--;
    return 'ADRENALINE  +25% SPEED / DAMAGE (12s)';
  }

  /** Re-skins the character from purchased gear: plates, LED intensity, blade length / colour, trail. */
  applyGear(): void {
    const g = this.profile.gear;
    this.armorTiers.forEach((t, i) => { t.visible = g.armor > i; });
    this.cape.visible = g.armor >= 4;
    const led = 1 + 0.28 * g.core + 0.12 * g.armor;
    this.glowMat.color.setRGB(0.1 * led, 1.6 * led, 2.2 * led);
    this.glow2Mat.color.setRGB(2.2 * led, 0.2 * led, 1.7 * led);
    this.armorMat.emissiveIntensity = 0.8 + 0.45 * g.armor;
    this.gearLight = 2 * g.core + 1.5 * g.armor;
    const tint = BLADE_TINT[g.laser];
    this.bladeMat.color.setRGB(tint[0], tint[1], tint[2]);
    this.trailColor.setRGB(tint[0], tint[1], tint[2]);
    this.trailHex = new THREE.Color(Math.min(1, tint[0] * 0.3), Math.min(1, tint[1] * 0.3), Math.min(1, tint[2] * 0.3)).getHex();
    (this.bladeGlow.material as THREE.MeshBasicMaterial).color.setRGB(tint[0] * 0.28, tint[1] * 0.28, tint[2] * 0.28);
    const len = 1 + 0.14 * g.laser;
    this.blade.scale.z = len;
    this.bladeGlow.scale.z = len;
    this.blade.position.z = 0.2 + 0.8 * len;
    this.bladeGlow.position.z = this.blade.position.z;
    this.bladeBase = 1 + 0.12 * g.laser;
    this.shieldMesh.scale.setScalar(1 + 0.06 * g.shield);
    this.shieldMat.color.setRGB(0.1 + 0.2 * g.shield, 1.2, 2.2 - 0.2 * g.shield);
  }

  /** Visual confirmation after buying gear: energy ring, particles and a brief glow on the runner. */
  equipFx(id: GearId): void {
    const col = id === 'laser' ? this.trailHex : id === 'shield' ? 0x33ffcc : id === 'core' ? 0xb6ff00 : 0xff2bd6;
    const c = this.tmp.set(this.pos.x, 1.0, this.pos.z);
    this.ctx.fx.burst(c, { color: col, color2: 0xffffff, count: 90, speed: 9, life: 1.0, size: 0.34, gravity: -2 });
    this.ctx.combat.ringFx(this.tmp2.set(this.pos.x, 0.2, this.pos.z), col, 3.4, 0.7);
    this.ctx.audio.success();
    this.equipFlash = 1;
  }

  /** Bolt colour variant for the current laser tier. */
  get boltVariant(): 'cyan' | 'magenta' | 'red' | 'gold' {
    const l = this.profile.gear.laser;
    return l >= 4 ? 'magenta' : l >= 2 ? 'cyan' : 'gold';
  }

  // ───────────────────────────── model ─────────────────────────────

  private buildModel(): void {
    const std = (color: number, rough: number, metal = 0, extra: THREE.MeshStandardMaterialParameters = {}): THREE.MeshStandardMaterial =>
      new THREE.MeshStandardMaterial({ color, roughness: rough, metalness: metal, ...extra });
    const h = buildHumanoid({
      skin: std(0xc8977a, 0.55, 0, { emissive: 0x20100a, emissiveIntensity: 0.4 }),
      hoodie: std(0x1c2540, 0.88, 0.02, { envMapIntensity: 0.6 }),
      pants: std(0x11141f, 0.85, 0.02, { envMapIntensity: 0.5 }),
      dark: std(0x0b0c12, 0.45, 0.35, { envMapIntensity: 1.1 }),
      hair: std(0x0c0a10, 0.6, 0.1),
      armor: this.armorMat,
      glow: this.glowMat,
      glow2: this.glow2Mat,
      visor: this.visorMat,
      cape: std(0x1a2150, 0.92, 0, { side: THREE.DoubleSide, emissive: 0x050a22, emissiveIntensity: 0.6 }),
    });
    this.rig = h.rig;
    this.armorTiers = h.tiers;
    this.cape = h.cape;

    // Energy blade held in the right hand.
    this.swordPivot.position.set(0, -0.32, 0.02);
    const dark = new THREE.MeshStandardMaterial({ color: 0x141826, roughness: 0.3, metalness: 0.9, envMapIntensity: 1.5 });
    const mk = (geo: THREE.BufferGeometry, mat: THREE.Material, x = 0, y = 0, z = 0): THREE.Mesh => {
      const m = new THREE.Mesh(geo, mat);
      m.position.set(x, y, z);
      return m;
    };
    const hilt = mk(new THREE.CylinderGeometry(0.03, 0.03, 0.26, 8), dark, 0, 0, 0.08);
    hilt.rotation.x = Math.PI / 2;
    hilt.castShadow = true;
    this.blade = mk(new THREE.BoxGeometry(0.06, 0.06, 1.6), this.bladeMat, 0, 0, 1.0);
    this.bladeGlow = mk(new THREE.BoxGeometry(0.18, 0.18, 1.7), new THREE.MeshBasicMaterial({ color: new THREE.Color(0, 0.7, 1.2), transparent: true, opacity: 0.35, blending: THREE.AdditiveBlending, depthWrite: false }), 0, 0, 1.0);
    this.swordPivot.add(hilt, this.blade, this.bladeGlow);
    h.rig.elbowR.add(this.swordPivot);

    this.model.add(h.body);
    this.group.add(this.model);
  }

  // ───────────────────────────── state ─────────────────────────────

  respawn(at: THREE.Vector3): void {
    this.pos.set(at.x, 0, at.z);
    this.vel.set(0, 0, 0);
    this.dead = false;
    this.hp = this.maxHp;
    this.energy = this.maxEnergy;
    this.ram = this.maxRam;
    this.shieldHp = 0;
    this.shieldTime = 0;
    this.adrenaline = 0;
    this.attackT = -1;
    this.comboIdx = 0;
    this.comboWindow = 0;
    this.dashing = 0;
    this.dashCd = 0;
    this.invuln = 1.5;
    this.group.visible = true;
    this.model.rotation.set(0, 0, 0);
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
    let dmg = amount * this.armorFactor;
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
      this.hurtT = 0.5;
      this.ctx.progress.onPlayerHurt();
      this.ctx.audio.hurt();
      // Hard hits shake harder (0.2 .. 0.6); chip damage stays subtle.
      this.ctx.shake(Math.min(0.6, 0.15 + dmg / 70));
      this.ctx.gfx.hurt = 1;
      this.ctx.gfx.glitch = Math.max(this.ctx.gfx.glitch, 0.35);
      this.ctx.ui.flashDamage();
      if (from) {
        const k = this.tmp.set(this.pos.x - from.x, 0, this.pos.z - from.z).normalize();
        this.vel.x += k.x * 9;
        this.vel.z += k.z * 9;
      }
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
    const { input, audio, fx, city } = ctx;
    if (this.dead) return;
    this.animT += dt;

    this.invuln = Math.max(0, this.invuln - dt);
    this.dashCd = Math.max(0, this.dashCd - dt);
    this.shotCd = Math.max(0, this.shotCd - dt);
    this.hurtT = Math.max(0, this.hurtT - dt);
    this.shotPose = Math.max(0, this.shotPose - dt);
    if (this.shieldTime > 0) {
      this.shieldTime -= dt;
      if (this.shieldTime <= 0) this.shieldHp = 0;
    }
    this.energy = Math.min(this.maxEnergy, this.energy + dt * this.energyRegen);
    this.adrenaline = Math.max(0, this.adrenaline - dt);
    this.ram = Math.min(this.maxRam, this.ram + dt * (3 + this.profile.up.ram * 0.8));
    this.shieldMesh.visible = this.shieldHp > 0;
    if (this.shieldMesh.visible) {
      this.shieldMesh.rotation.y += dt * 0.8;
      this.shieldMat.opacity += (0.18 + Math.sin(this.animT * 5) * 0.05 - this.shieldMat.opacity) * Math.min(1, dt * 8);
    }

    // Movement intent relative to the camera yaw.
    const yaw = ctx.camYaw;
    const fwd = this.tmp.set(-Math.sin(yaw), 0, -Math.cos(yaw));
    const right = this.tmp2.set(Math.cos(yaw), 0, -Math.sin(yaw));
    const mv = input.move;
    const wish = this.wish.set(0, 0, 0).addScaledVector(right, mv.x).addScaledVector(fwd, mv.y);
    const wishLen = wish.length();
    const attacking = this.attackT >= 0;
    const maxSpeed = BASE_SPEED * this.speedMult * (attacking ? 0.55 : 1);

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
        this.trailT = 0.014;
        fx.burst(this.tmp.set(this.pos.x, 1.1, this.pos.z), { color: 0x00f0ff, color2: 0xff2bd6, count: 6, speed: 1.6, life: 0.45, size: 0.42, drag: 4 });
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
      fx.burst(this.tmp.set(this.pos.x, 0.15, this.pos.z), { color: 0x66ccff, count: this.jumps === 2 ? 22 : 10, speed: 4, life: 0.45, size: 0.25, dir: this.tmp2.set(0, 0.1, 0), cone: 1 });
    }
    this.vel.y -= CFG.gravity * dt;

    // Combat
    this.comboWindow = Math.max(0, this.comboWindow - dt);
    if (this.comboWindow <= 0 && this.attackT < 0) this.comboIdx = 0;
    const wantAttack = input.consume('attack') || input.isHeld('attack');
    if (wantAttack && this.attackT < 0 && this.dashing <= 0) this.startAttack();
    if (this.attackT >= 0) this.updateAttack(dt);
    if ((input.consume('shoot') || input.isHeld('shoot')) && this.shotCd <= 0 && this.dashing <= 0) this.shoot();

    // Integrate
    // Sub-stepped horizontal move + collision so a dash on a slow frame can't tunnel through thin fences.
    const steps = Math.min(6, Math.max(1, Math.ceil((Math.hypot(this.vel.x, this.vel.z) * dt) / 0.4)));
    let collided = false;
    for (let i = 0; i < steps; i++) {
      this.pos.x += (this.vel.x * dt) / steps;
      this.pos.z += (this.vel.z * dt) / steps;
      if (city.resolve(this.pos, CFG.playerRadius)) collided = true;
    }
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
    if (collided) {
      this.vel.x *= 0.85;
      this.vel.z *= 0.85;
    }

    if (this.attackT < 0 && this.dashing <= 0 && wishLen > 0.15) {
      this.facing = this.lerpAngle(this.facing, Math.atan2(wish.x, wish.z), Math.min(1, dt * 14));
    }

    this.light.intensity = 12 + this.gearLight + Math.sin(this.animT * 4) * 2 + (this.dashing > 0 ? 16 : 0) + (this.adrenaline > 0 ? 6 : 0) + this.equipFlash * 30;
    this.equipFlash = Math.max(0, this.equipFlash - dt * 1.4);
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
    // Snapshot: damageEnemy() may kill (and splice) enemies from the live list while we iterate.
    for (const e of [...ctx.enemies.list]) {
      if (e.dead) continue;
      const dx = e.pos.x - this.pos.x;
      const dz = e.pos.z - this.pos.z;
      const d = Math.hypot(dx, dz);
      if (d > step.range + e.radius) continue;
      if (d > 0.5) {
        const dot = (dx * f.x + dz * f.z) / d;
        if (Math.acos(clamp(dot, -1, 1)) > step.arc / 2) continue;
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
    this.shotPose = 0.14;
    const dir = this.aimDir(new THREE.Vector3(), 34, 0.6);
    this.facing = this.lerpAngle(this.facing, Math.atan2(dir.x, dir.z), 0.6);
    const o = new THREE.Vector3(this.pos.x + dir.x * 0.9, 1.35, this.pos.z + dir.z * 0.9);
    this.ctx.combat.fireBolt(o, dir, { friendly: true, dmg: 13 * this.damageMult, speed: 62, life: 0.9, variant: this.boltVariant });
    this.ctx.fx.burst(o, { color: 0xffe08a, color2: 0xffffff, count: 6, speed: 6, life: 0.14, size: 0.3, dir, cone: 0.4 });
    this.ctx.audio.shot();
    this.vel.x -= dir.x * 1.0;
    this.vel.z -= dir.z * 1.0;
  }

  // ───────────────────────────── procedural animation ─────────────────────────────

  private animate(dt: number, wishLen: number): void {
    const r = this.rig;
    const speed = Math.hypot(this.vel.x, this.vel.z);
    const run = clamp(speed / BASE_SPEED, 0, 1.3);
    const phase = this.animT * (7 + run * 5);
    const s = Math.sin(phase);
    const c = Math.cos(phase);
    const k = Math.min(1, dt * 14);
    const air = !this.grounded;
    this.group.rotation.y = this.facing;

    // Legs (thigh swing + knee flex), tucked in the air.
    const thighA = air ? -0.55 : s * 0.9 * run;
    const thighB = air ? 0.35 : -s * 0.9 * run;
    const kneeA = air ? 1.0 : Math.max(0, -c) * 1.15 * run + 0.05;
    const kneeB = air ? 0.4 : Math.max(0, c) * 1.15 * run + 0.05;
    const lerpRot = (obj: THREE.Object3D, x: number): void => { obj.rotation.x += (x - obj.rotation.x) * k; };
    lerpRot(r.hipL, thighA);
    lerpRot(r.hipR, thighB);
    lerpRot(r.kneeL, kneeA);
    lerpRot(r.kneeR, kneeB);

    // Pelvis bob, torso lean/twist.
    const bob = this.grounded ? Math.abs(s) * 0.07 * run : 0;
    const idle = Math.sin(this.animT * 1.8) * 0.012;
    r.hips.position.y += (0.95 + bob + idle - r.hips.position.y) * k;
    const lean = run * 0.2 + (this.dashing > 0 ? 0.45 : 0);
    r.spine.rotation.x += (lean - r.spine.rotation.x) * k;

    // Arms.
    const atk = this.attackT >= 0;
    if (atk) {
      const step = COMBO[this.comboIdx];
      const t = clamp(this.attackT / step.dur, 0, 1);
      const e = 1 - Math.pow(1 - t, 3);
      if (this.comboIdx === 0) { r.shoulderR.rotation.set(-1.4, 1.2 - e * 2.4, 0); r.spine.rotation.y = 0.6 - e * 1.2; }
      else if (this.comboIdx === 1) { r.shoulderR.rotation.set(-1.4, -1.2 + e * 2.4, 0); r.spine.rotation.y = -0.6 + e * 1.2; }
      else { r.shoulderR.rotation.set(-3.0 + e * 3.4, 0, 0); r.spine.rotation.y = 0; }
      r.elbowR.rotation.x = 0;
      lerpRot(r.shoulderL, 0.5);
    } else {
      const swing = -s * 0.8 * run;
      r.shoulderR.rotation.x += ((this.shotPose > 0 ? -1.2 : -swing) - r.shoulderR.rotation.x) * k;
      r.shoulderR.rotation.y += (0 - r.shoulderR.rotation.y) * k;
      r.shoulderR.rotation.z += (-0.08 - r.shoulderR.rotation.z) * k;
      r.spine.rotation.y += (0 - r.spine.rotation.y) * k;
      r.elbowR.rotation.x += ((this.shotPose > 0 ? -0.3 : -(0.35 + run * 0.5)) - r.elbowR.rotation.x) * k;
      lerpRot(r.shoulderL, air ? -0.9 : swing);
    }
    r.shoulderL.rotation.z += (0.08 - r.shoulderL.rotation.z) * k;
    lerpRot(r.elbowL, -(0.35 + run * 0.6));

    // Head looks along the camera-ish aim, LED visor state colour.
    r.head.rotation.x += ((this.hurtT > 0 ? -0.25 : -lean * 0.5) - r.head.rotation.x) * k;
    const mode = this.ctx.engine.state === 'hacking' ? 1 : this.hurtT > 0 ? 2 : this.dashing > 0 ? 3 : 0;
    const col = this.visorMat.color;
    if (mode === 1) col.setRGB(0.4, 2.6, 0.5);
    else if (mode === 2) col.setRGB(3.0, 0.2, 0.25);
    else if (mode === 3) col.setRGB(2.6, 0.3, 2.2);
    else col.setRGB(0.1, 1.6 + Math.sin(this.animT * 3) * 0.3, 2.2);

    // Footstep dust.
    if (this.grounded && run > 0.5) {
      const stepSign = Math.sign(s);
      if (stepSign !== this.lastStep && stepSign !== 0) {
        this.lastStep = stepSign;
        this.ctx.fx.burst(this.tmp.set(this.pos.x, 0.05, this.pos.z), { color: 0x6688cc, count: 2, speed: 1.2, life: 0.35, size: 0.18, drag: 3 });
      }
    }

    const mat = this.thruster.material as THREE.MeshBasicMaterial;
    mat.opacity = this.dashing > 0 ? 0.9 : THREE.MathUtils.lerp(mat.opacity, wishLen > 0.1 && air ? 0.35 : 0, Math.min(1, dt * 8));
    this.thruster.scale.y = 1 + run * 0.8;
    const flick = this.invuln > 0 && this.dashing <= 0 && Math.floor(this.animT * 30) % 2 === 0;
    this.model.visible = !flick;
    const turn = Math.atan2(Math.sin(this.facing - this.lastFacing), Math.cos(this.facing - this.lastFacing)) / Math.max(dt, 1e-3);
    this.lastFacing = this.facing;
    this.cape.update(dt, this.animT, run, this.vel.y, turn);
    this.blade.scale.x = this.blade.scale.y = this.bladeBase;
    this.bladeGlow.scale.x = this.bladeGlow.scale.y = this.bladeBase;
    // Evolving sword trail: from the second laser tier the swing sheds blade-coloured sparks along its length.
    if (this.attackT >= 0 && this.profile.gear.laser > 0) {
      const len = 0.8 + 1.5 * this.blade.scale.z;
      const f = this.facingDir(this.tmp);
      this.ctx.fx.burst(this.tmp2.set(this.pos.x + f.x * len * 0.6, 1.2, this.pos.z + f.z * len * 0.6), { color: this.trailHex, color2: 0xffffff, count: 1 + this.profile.gear.laser, speed: 2.5, life: 0.3 + 0.06 * this.profile.gear.laser, size: 0.2 + 0.03 * this.profile.gear.laser, drag: 3 });
    }
  }
}
