import * as THREE from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import { CFG, CITY } from '../config';
import type { GameContext, HackMode, HackResult, HackTarget } from '../context';

const S = CITY.S;

export type NpcState = 'walk' | 'flee' | 'talk' | 'idle' | 'frozen' | 'follow';

const FIRST = ['K.', 'M.', 'R.', 'J.', 'T.', 'A.', 'S.', 'N.', 'L.', 'D.', 'V.', 'Z.', 'E.', 'H.'];
const LAST = ['Voss', 'Tanaka', 'Okoye', 'Rivera', 'Kowalski', 'Sato', 'Mercer', 'Duarte', 'Nakamura', 'Ibarra', 'Quill', 'Hale', 'Moreau', 'Ito', 'Blackwood', 'Ramirez'];
const JOBS = ['Courier', 'Noodle vendor', 'Data clerk', 'Mech tech', 'Street medic', 'Corp analyst', 'Netrunner', 'Bartender', 'Drone pilot', 'Fixer', 'Cab driver', 'Dock worker'];
const GREET = ['Evening, runner.', 'Keep it quiet out here.', 'Corps are watching tonight.', 'Got any spare credits?', 'Nice blade. Do not wave it around.', 'Rain never stops in this district.'];
const PANIC = ['¡Aaah!', 'Help!', 'Security!', 'Not me!', 'Run!', 'Please no!'];
const INTEL = [
  'A rival convoy hits the Data Docks at midnight.',
  'Someone is selling ICE-breakers in the Slums.',
  'Security cams only watch their left sweep, the right is blind.',
  'The corp boss never leaves his plaza without three guards.',
  'Public kiosks hold cash caches for anyone who can crack them.',
  'Flyers use low lanes above the north-south streets.',
  'Hack the gate first, the guards only react when you are close.',
];

export class Npc {
  id = '';
  num = 0;
  name = '';
  job = '';
  money = 0;
  intel = '';
  state: NpcState = 'walk';
  stateT = 0;
  axis: 0 | 1 = 0;
  road = 0;
  side: 1 | -1 = 1;
  dir: 1 | -1 = 1;
  along = 0;
  decided = NaN;
  x = 0;
  z = 0;
  rx = 0;
  rz = 0;
  yaw = 0;
  speed = 1.4;
  phase = Math.random() * 10;
  headYaw = 0;
  clothes = new THREE.Color();
  skin = new THREE.Color();
  accent = new THREE.Color();
  contact = 0;
  pinned = false;
  stolen = false;
  interrogated = false;
  barkCd = 0;
  moving = 1;
  colorDirty = true;
}

/** Pedestrians: CPU state machine, rendered as 8 InstancedMeshes (one per body part) regardless of crowd size. */
export class NpcManager {
  readonly list: Npc[] = [];
  private parts: Record<'torso' | 'shoulders' | 'head' | 'armL' | 'armR' | 'legL' | 'legR' | 'visor' | 'stripe', THREE.InstancedMesh>;
  private m = new THREE.Matrix4();
  private base = new THREE.Matrix4();
  private q = new THREE.Quaternion();
  private e = new THREE.Euler();
  private p = new THREE.Vector3();
  private one = new THREE.Vector3(1, 1, 1);
  private tmp = new THREE.Vector3();
  private tmpC = new THREE.Color();
  private firstSpawn = true;
  private colorsChanged = false;

  constructor(private ctx: GameContext, scene: THREE.Scene) {
    const n = CFG.npcCount;
    const skinMat = new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 0.55, metalness: 0.15, envMapIntensity: 0.8 });
    const clothMat = new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 0.5, metalness: 0.45, envMapIntensity: 1.1 });
    const glowMat = new THREE.MeshBasicMaterial({ color: 0xffffff });
    const mk = (geo: THREE.BufferGeometry, mat: THREE.Material): THREE.InstancedMesh => {
      const mesh = new THREE.InstancedMesh(geo, mat, n);
      mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
      mesh.setColorAt(0, this.tmpC.setRGB(1, 1, 1));
      mesh.instanceColor!.setUsage(THREE.DynamicDrawUsage);
      mesh.frustumCulled = false;
      mesh.castShadow = false;
      mesh.count = 0;
      scene.add(mesh);
      return mesh;
    };
    // Geometry is merged per body part so a whole pedestrian is 9 instanced draws for the entire crowd.
    const ni = (g: THREE.BufferGeometry): THREE.BufferGeometry => {
      const out = g.index ? g.toNonIndexed() : g;
      out.deleteAttribute('uv');
      return out;
    };
    const cap = (r: number, len: number): THREE.BufferGeometry => ni(new THREE.CapsuleGeometry(r, len, 3, 6));
    const sph = (r: number, sx = 1, sy = 1, sz = 1): THREE.BufferGeometry => ni(new THREE.SphereGeometry(r, 10, 8).scale(sx, sy, sz));
    const bx = (w: number, h: number, d: number): THREE.BufferGeometry => ni(new THREE.BoxGeometry(w, h, d));
    const at = (g: THREE.BufferGeometry, x: number, y: number, z: number): THREE.BufferGeometry => g.translate(x, y, z);

    // Torso: tapered chest over a slim waist and hips, collar at the neck.
    const torsoGeo = mergeGeometries([
      at(ni(new THREE.CylinderGeometry(0.22, 0.14, 0.46, 8).scale(1, 1, 0.68)), 0, 1.3, 0),
      at(ni(new THREE.CylinderGeometry(0.12, 0.13, 0.16, 8)), 0, 1.0, 0),
      at(bx(0.3, 0.14, 0.2), 0, 0.93, 0),
      at(ni(new THREE.CylinderGeometry(0.09, 0.12, 0.1, 8)), 0, 1.55, 0),
    ])!;
    // Pauldrons: pronounced rounded shoulder caps.
    const shoulderGeo = mergeGeometries([at(sph(0.115, 1.25, 0.85, 1.15), -0.285, 1.48, 0), at(sph(0.115, 1.25, 0.85, 1.15), 0.285, 1.48, 0)])!;
    // Helmet: shell, neck, jaw guard and ear pieces (the LED visor is a separate emissive part).
    const headGeo = mergeGeometries([
      at(sph(0.155, 1, 1.1, 1.05), 0, 1.74, 0),
      at(ni(new THREE.CylinderGeometry(0.05, 0.06, 0.1, 8)), 0, 1.6, 0),
      at(bx(0.13, 0.06, 0.1), 0, 1.65, 0.1),
      at(bx(0.04, 0.09, 0.09), 0.155, 1.73, 0),
      at(bx(0.04, 0.09, 0.09), -0.155, 1.73, 0),
    ])!;
    // Limbs pivot at the shoulder / hip: upper + lower segment, hand or boot included.
    const armGeo = mergeGeometries([at(cap(0.045, 0.24), 0, -0.2, 0), at(cap(0.04, 0.22), 0, -0.5, 0.02), at(sph(0.05), 0, -0.68, 0.03)])!;
    const legGeo = mergeGeometries([at(cap(0.065, 0.3), 0, -0.24, 0), at(cap(0.055, 0.3), 0, -0.6, 0.01), at(bx(0.12, 0.08, 0.26), 0, -0.86, 0.05)])!;

    this.parts = {
      torso: mk(torsoGeo, clothMat),
      shoulders: mk(shoulderGeo, clothMat),
      head: mk(headGeo, skinMat),
      armL: mk(armGeo.clone(), clothMat),
      armR: mk(armGeo, clothMat),
      legL: mk(legGeo.clone(), clothMat),
      legR: mk(legGeo, clothMat),
      visor: mk(bx(0.2, 0.05, 0.05).translate(0, 1.76, 0.14), glowMat),
      stripe: mk(bx(0.42, 0.035, 0.28).translate(0, 1.2, 0), glowMat),
    };
    for (let i = 0; i < n; i++) {
      const npc = new Npc();
      npc.num = i + 1;
      this.list.push(npc);
    }
  }

  // ───────────────────────────── spawning ─────────────────────────────

  private randomizeIdentity(n: Npc): void {
    n.id = `NPC-${String(n.num).padStart(2, '0')}`;
    n.name = `${FIRST[Math.floor(Math.random() * FIRST.length)]} ${LAST[Math.floor(Math.random() * LAST.length)]}`;
    n.job = JOBS[Math.floor(Math.random() * JOBS.length)];
    n.money = 30 + Math.floor(Math.random() * 420);
    n.intel = INTEL[Math.floor(Math.random() * INTEL.length)];
    n.stolen = false;
    n.interrogated = false;
    n.contact = 0;
    n.pinned = false;
    n.speed = 1.1 + Math.random() * 0.8;
    const hue = Math.random();
    n.clothes.setHSL(hue, 0.35 + Math.random() * 0.4, 0.1 + Math.random() * 0.16);
    n.skin.setHSL(0.06 + Math.random() * 0.05, 0.4, 0.22 + Math.random() * 0.4);
    const accents = [0x00f0ff, 0xff2bd6, 0xb6ff00, 0xffc400];
    n.accent.set(accents[Math.floor(Math.random() * accents.length)]).multiplyScalar(2.6);
    n.colorDirty = true;
  }

  private place(n: Npc, minDist: number, maxDist: number): void {
    const pl = this.ctx.player.pos;
    n.axis = Math.random() < 0.5 ? 0 : 1;
    const pp = n.axis === 0 ? pl.z : pl.x;
    const pa = n.axis === 0 ? pl.x : pl.z;
    n.road = Math.round(pp / S + (Math.random() * 2 - 1) * 1.3);
    n.side = Math.random() < 0.5 ? 1 : -1;
    n.dir = Math.random() < 0.5 ? 1 : -1;
    for (let tries = 0; tries < 8; tries++) {
      n.along = pa + (Math.random() * 2 - 1) * maxDist;
      this.syncPos(n);
      const d = Math.hypot(n.x - pl.x, n.z - pl.z);
      if (d >= minDist && d <= maxDist * 1.2) break;
    }
    this.syncPos(n);
    n.rx = n.x;
    n.rz = n.z;
    n.yaw = n.axis === 0 ? (n.dir > 0 ? Math.PI / 2 : -Math.PI / 2) : n.dir > 0 ? 0 : Math.PI;
    n.state = 'walk';
    n.stateT = 0;
    n.decided = NaN;
  }

  private syncPos(n: Npc): void {
    if (n.axis === 0) {
      n.x = n.along;
      n.z = n.road * S + n.side * CITY.WALK;
    } else {
      n.x = n.road * S + n.side * CITY.WALK;
      n.z = n.along;
    }
  }

  /** Re-seeds the whole crowd around the player on the next update. */
  reset(): void {
    this.firstSpawn = true;
  }

  /** Reserves a pedestrian as a stationary mission contact at (x, z). */
  claimContact(x: number, z: number, name: string, missionId: number): Npc {
    const pl = this.ctx.player.pos;
    let best: Npc | null = null;
    let bd = -1;
    for (const n of this.list) {
      if (n.pinned) continue;
      const d = Math.hypot(n.x - pl.x, n.z - pl.z);
      if (d > bd) { bd = d; best = n; }
    }
    const n = best ?? this.list[0];
    this.randomizeIdentity(n);
    n.pinned = true;
    n.contact = missionId;
    n.name = name;
    n.job = 'Informant';
    n.money = 600;
    n.x = n.rx = x;
    n.z = n.rz = z;
    n.state = 'idle';
    n.id = `NPC-C${missionId}`;
    return n;
  }

  releaseContact(n: Npc): void {
    n.pinned = false;
    n.contact = 0;
    n.id = `NPC-${String(n.num).padStart(2, '0')}`;
    this.place(n, 40, 90);
  }

  // ───────────────────────────── simulation ─────────────────────────────

  update(dt: number, time: number): void {
    const { player } = this.ctx;
    const pl = player.pos;
    if (this.firstSpawn) {
      for (const n of this.list) {
        this.randomizeIdentity(n);
        this.place(n, 8, 80);
      }
      this.firstSpawn = false;
    }
    const aggressive = player.attackT >= 0 || player.dashing > 0 || player.shotCd > 0.12;
    let count = 0;
    this.colorsChanged = false;

    for (const n of this.list) {
      n.stateT -= dt;
      n.barkCd = Math.max(0, n.barkCd - dt);
      const dx = pl.x - n.rx;
      const dz = pl.z - n.rz;
      const dist = Math.hypot(dx, dz);

      if (!n.pinned && dist > 100) {
        this.randomizeIdentity(n);
        this.place(n, 40, 85);
      }

      // Reactions.
      if (n.state !== 'frozen' && n.state !== 'follow' && !n.contact) {
        if (aggressive && dist < 9 && n.state !== 'flee') {
          n.state = 'flee';
          n.stateT = 4 + Math.random() * 2;
          if (n.barkCd <= 0) { this.ctx.ui.say(this.tmp.set(n.rx, 2.1, n.rz), PANIC[Math.floor(Math.random() * PANIC.length)], 1.6); n.barkCd = 3; }
        } else if (n.state === 'flee' && n.stateT <= 0) {
          n.state = 'walk';
        } else if (n.state === 'talk' && n.stateT <= 0) {
          n.state = 'walk';
        }
      } else if (n.state === 'frozen' && n.stateT <= 0) {
        n.state = n.contact ? 'idle' : 'walk';
      } else if (n.state === 'follow' && n.stateT <= 0) {
        n.state = 'walk';
        this.snapToSidewalk(n);
      }

      // Movement.
      let targetMoving = 0;
      if (n.state === 'walk' || n.state === 'flee') {
        const spd = n.state === 'flee' ? 5.6 : n.speed;
        if (n.state === 'flee') {
          const pa = n.axis === 0 ? pl.x : pl.z;
          n.dir = n.along >= pa ? 1 : -1;
        }
        n.along += n.dir * spd * dt;
        this.junction(n);
        this.syncPos(n);
        targetMoving = spd / 1.6;
      } else if (n.state === 'follow') {
        const d = Math.max(0.01, dist);
        if (d > 2.5) {
          n.x += (dx / d) * 3.2 * dt;
          n.z += (dz / d) * 3.2 * dt;
          targetMoving = 2;
        }
        this.tmp.set(n.x, 0, n.z);
        this.ctx.city.resolve(this.tmp, 0.35);
        n.x = this.tmp.x;
        n.z = this.tmp.z;
      } else if (n.state === 'talk' || n.state === 'idle') {
        targetMoving = 0;
      }
      n.moving += (targetMoving - n.moving) * Math.min(1, dt * 8);

      // Smooth render position (hides sidewalk corner snaps) and facing.
      const k = Math.min(1, dt * (n.state === 'flee' ? 14 : 8));
      const px = n.rx;
      const pz = n.rz;
      n.rx += (n.x - n.rx) * k;
      n.rz += (n.z - n.rz) * k;
      const vx = n.rx - px;
      const vz = n.rz - pz;
      let targetYaw = n.yaw;
      if (n.state === 'talk' || (n.state === 'idle' && dist < 8)) targetYaw = Math.atan2(dx, dz);
      else if (vx * vx + vz * vz > 1e-7) targetYaw = Math.atan2(vx, vz);
      let dyaw = (targetYaw - n.yaw) % (Math.PI * 2);
      if (dyaw > Math.PI) dyaw -= Math.PI * 2;
      if (dyaw < -Math.PI) dyaw += Math.PI * 2;
      n.yaw += dyaw * Math.min(1, dt * 10);

      // Head glance when the player walks by.
      let wantHead = 0;
      if (dist < 7) {
        let rel = Math.atan2(dx, dz) - n.yaw;
        rel = Math.atan2(Math.sin(rel), Math.cos(rel));
        wantHead = THREE.MathUtils.clamp(rel, -1.0, 1.0);
        if (dist < 3 && n.state === 'walk' && n.barkCd <= 0 && Math.random() < dt * 0.4) {
          this.ctx.ui.say(this.tmp.set(n.rx, 2.1, n.rz), GREET[Math.floor(Math.random() * GREET.length)], 2);
          n.barkCd = 8;
        }
      }
      n.headYaw += (wantHead - n.headYaw) * Math.min(1, dt * 6);
      n.phase += dt * (3 + n.moving * 3.4);

      this.writeInstance(count++, n, time);
    }
    for (const mesh of Object.values(this.parts)) {
      mesh.count = count;
      mesh.instanceMatrix.needsUpdate = true;
      if (mesh.instanceColor && this.colorsChanged) mesh.instanceColor.needsUpdate = true;
    }
  }

  private snapToSidewalk(n: Npc): void {
    // After being puppeteered, rejoin the nearest sidewalk.
    n.axis = Math.random() < 0.5 ? 0 : 1;
    const pp = n.axis === 0 ? n.z : n.x;
    n.road = Math.round(pp / S);
    n.side = pp >= n.road * S ? 1 : -1;
    n.along = n.axis === 0 ? n.x : n.z;
    n.decided = NaN;
    this.syncPos(n);
  }

  /**
   * Intersection logic. East-west walkers may continue or turn onto the cross street (away from the avenue).
   * North-south walkers must turn at avenues (cars drive there), so nobody ever steps onto the carriageway.
   */
  private junction(n: Npc): void {
    const m = Math.round(n.along / S);
    const d = Math.abs(n.along - m * S);
    if (d > 9) { n.decided = NaN; return; }
    if (d > 7.5 || n.decided === m) return;
    n.decided = m;
    if (n.axis === 0) {
      if (Math.random() < 0.38) {
        const sideZ = n.side;
        const sideX: 1 | -1 = n.along >= m * S ? 1 : -1;
        n.axis = 1;
        n.road = m;
        n.side = sideX;
        n.along = n.z;
        n.dir = sideZ;
        n.decided = NaN;
      }
    } else {
      const sideZ: 1 | -1 = n.along >= m * S ? 1 : -1;
      const x = n.x;
      n.axis = 0;
      n.road = m;
      n.side = sideZ;
      n.along = x;
      n.dir = Math.random() < 0.5 ? 1 : -1;
      n.decided = NaN;
    }
  }

  private writeInstance(i: number, n: Npc, time: number): void {
    const bob = Math.abs(Math.sin(n.phase)) * 0.035 * n.moving;
    const swing = Math.sin(n.phase) * 0.75 * Math.min(1, n.moving);
    const flee = n.state === 'flee';
    const talk = n.state === 'talk';
    const breathe = Math.sin(time * 1.6 + n.num) * 0.012;

    this.q.setFromAxisAngle(this.tmp.set(0, 1, 0), n.yaw);
    this.base.compose(this.p.set(n.rx, bob + breathe, n.rz), this.q, this.one);

    const put = (mesh: THREE.InstancedMesh, px: number, py: number, pz: number, rx: number, ry: number, rz: number): void => {
      this.e.set(rx, ry, rz);
      this.q.setFromEuler(this.e);
      this.m.compose(this.p.set(px, py, pz), this.q, this.one).premultiply(this.base);
      mesh.setMatrixAt(i, this.m);
    };
    put(this.parts.torso, 0, 0, 0, 0.06 * n.moving, 0, 0);
    put(this.parts.shoulders, 0, 0, 0, 0.06 * n.moving, 0, 0);
    put(this.parts.head, 0, 0, 0, 0, n.headYaw, 0);
    put(this.parts.visor, 0, 0, 0, 0, n.headYaw, 0);
    put(this.parts.stripe, 0, 0, 0, 0.06 * n.moving, 0, 0);
    put(this.parts.legL, -0.11, 0.9, 0, swing, 0, 0);
    put(this.parts.legR, 0.11, 0.9, 0, -swing, 0, 0);
    const armUp = flee ? -2.4 : 0;
    const gesture = talk ? -1.0 + Math.sin(time * 5 + n.num) * 0.4 : -swing * 0.8;
    put(this.parts.armL, -0.29, 1.5, 0, flee ? armUp + Math.sin(time * 14) * 0.3 : -swing * 0.8, 0, 0.1);
    put(this.parts.armR, 0.29, 1.5, 0, flee ? armUp - Math.sin(time * 14) * 0.3 : gesture, 0, -0.1);

    if (n.colorDirty) {
      this.parts.torso.setColorAt(i, n.clothes);
      this.parts.shoulders.setColorAt(i, this.tmpC.copy(n.clothes).multiplyScalar(1.6));
      this.parts.armL.setColorAt(i, n.clothes);
      this.parts.armR.setColorAt(i, n.clothes);
      this.parts.legL.setColorAt(i, this.tmpC.copy(n.clothes).multiplyScalar(0.7));
      this.parts.legR.setColorAt(i, this.tmpC);
      this.parts.head.setColorAt(i, n.skin);
      this.parts.visor.setColorAt(i, n.accent);
      this.parts.stripe.setColorAt(i, n.accent);
      n.colorDirty = false;
      this.colorsChanged = true;
    }
  }

  // ───────────────────────────── interaction / hacking ─────────────────────────────

  nearest(pos: THREE.Vector3, radius: number): Npc | null {
    let best: Npc | null = null;
    let bd = radius * radius;
    for (const n of this.list) {
      const d = (n.rx - pos.x) ** 2 + (n.rz - pos.z) ** 2;
      if (d < bd) { bd = d; best = n; }
    }
    return best;
  }

  talk(n: Npc): void {
    n.state = 'talk';
    n.stateT = 4;
    this.ctx.ui.say(this.tmp.set(n.rx, 2.1, n.rz), GREET[Math.floor(Math.random() * GREET.length)], 3);
  }

  hackTargets(center: THREE.Vector3, radius: number, out: HackTarget[]): void {
    for (const n of this.list) {
      const dist = Math.hypot(n.rx - center.x, n.rz - center.z);
      if (dist > radius) continue;
      out.push({
        id: n.id,
        kind: 'npc',
        label: `${n.name} // ${n.job}`,
        pos: new THREE.Vector3(n.rx, 1.4, n.rz),
        dist,
        modes: ['hack', 'override', 'interrogate'],
        difficulty: n.contact ? 3 : 1,
        details: [`CRED-CHIP: ${n.money > 0 ? 'DETECTED' : 'EMPTY'}`, `STATE: ${n.state.toUpperCase()}`, n.contact ? 'FLAG: MISSION CONTACT' : 'FLAG: CIVILIAN'],
        apply: (mode) => this.applyHack(n, mode),
      });
    }
  }

  private applyHack(n: Npc, mode: HackMode): HackResult {
    const { player, ui, engine } = this.ctx;
    const lines: string[] = [];
    this.tmp.set(n.rx, 2.1, n.rz);
    if (mode === 'interrogate') {
      n.state = 'talk';
      n.stateT = 6;
      lines.push(`>> ${n.name}: "${n.intel}"`);
      const hint = this.ctx.missions.hint();
      if (hint) lines.push(`>> ${hint}`);
      if (!n.interrogated) {
        n.interrogated = true;
        player.addCredits(15);
        player.addXp(25);
        lines.push('>> +15 CREDITS  +25 XP');
      }
      ui.say(this.tmp, 'I told you everything!', 3);
      if (!n.contact) window.setTimeout(() => { if (!n.pinned && n.state === 'talk') { n.state = 'flee'; n.stateT = 5; } }, 4500);
    } else {
      const take = mode === 'override' ? Math.ceil(n.money * 1.0) : Math.ceil(n.money * 0.6);
      if (take > 0 && !n.stolen) {
        n.money -= take;
        if (n.money <= 0) n.stolen = true;
        player.addCredits(take);
        lines.push(`>> CRED-CHIP DRAINED: +${take} CREDITS`);
      } else {
        lines.push('>> NOTHING LEFT TO STEAL');
      }
      player.addXp(mode === 'override' ? 30 : 15);
      lines.push(mode === 'override' ? '>> CITIZEN UNDER REMOTE CONTROL (12s)' : '>> NEURAL LINK STUNNED (4s)');
      n.state = mode === 'override' ? 'follow' : 'frozen';
      n.stateT = mode === 'override' ? 12 : 4;
      ui.say(this.tmp, mode === 'override' ? '...' : 'ERR_0x7F', 3);
    }
    this.ctx.state.hacks++;
    engine.events.emit('npcHacked', { npc: n, mode });
    return { ok: true, lines };
  }
}
