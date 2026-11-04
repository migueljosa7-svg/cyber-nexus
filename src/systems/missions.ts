import * as THREE from 'three';
import type { GameContext, HackMode, HackResult, HackTarget } from '../context';
import type { Enemy, EnemyKind } from '../enemies';
import type { Npc } from '../world/npcs';

export type MissionType = 'hack' | 'assassinate' | 'steal' | 'interrogate';

export interface Objective {
  id: string;
  text: string;
  done: boolean;
  optional?: boolean;
}

export interface Mission {
  id: number;
  type: MissionType;
  title: string;
  briefing: string;
  districtName: string;
  districtId: number;
  site: THREE.Vector3;
  safe: THREE.Vector3 | null;
  difficulty: number;
  rewardCredits: number;
  rewardXp: number;
  objectives: Objective[];
  /** True while nobody has spotted the player (stealth bonus). */
  stealth: boolean;
  state: 'offered' | 'active' | 'complete' | 'failed';
  targetName: string;
}

export interface MissionMarker {
  id: string;
  pos: THREE.Vector3;
  label: string;
  color: string;
  kind: 'mission' | 'scan' | 'safe';
}

export interface MissionLogData {
  title: string;
  district: string;
  lines: Array<{ text: string; done: boolean; optional: boolean }>;
  reward: string;
}

interface CamObj {
  id: string;
  group: THREE.Group;
  cone: THREE.Mesh;
  baseYaw: number;
  phase: number;
  disabledUntil: number;
  pos: THREE.Vector3;
}

/** Runtime objects for the mission site; rebuilt whenever the player approaches, persistent flags live in `Flags`. */
interface Site {
  group: THREE.Group;
  doorMesh: THREE.Mesh | null;
  doorId: string;
  doorPos: THREE.Vector3;
  cams: CamObj[];
  caseMesh: THREE.Mesh | null;
  casePos: THREE.Vector3;
  termGroup: THREE.Group | null;
  termId: string;
  termPos: THREE.Vector3;
  contact: Npc | null;
  leader: Enemy | null;
  colliders: string[];
  doorSlide: number;
}

interface Flags {
  doorOpen: boolean;
  termHacked: boolean;
  caseTaken: boolean;
  leaderDead: boolean;
  guardsCleared: boolean;
  alerted: boolean;
  camsDisabled: Set<string>;
}

const LEADER_NAMES = ['Director Hayashi', 'CEO Marlowe', 'Overseer Kade', 'Chairman Vex', 'Warden Orlov', 'Syndic Reyes'];
const CONTACT_NAMES = ['"Moth"', '"Glass"', '"Sparrow"', '"Echo"', '"Wren"', '"Static"'];
const H = 7.2;
const SPAWN_DIST = 115;
const DESPAWN_DIST = 195;

const clamp = THREE.MathUtils.clamp;

export class MissionManager {
  active: Mission | null = null;
  offers: Mission[] = [];
  /** 0..1 camera detection meter (HUD). */
  detection = 0;

  private nextId = 1;
  private site: Site | null = null;
  private flags: Flags = this.freshFlags();
  private cleanupT = 0;
  private completedMission: Mission | null = null;
  private tmp = new THREE.Vector3();
  private rnd = Math.random;

  // shared site resources (created once)
  private boxGeo = new THREE.BoxGeometry(1, 1, 1);
  private fenceMat = new THREE.MeshStandardMaterial({ color: 0x0a0d18, roughness: 0.3, metalness: 0.9, envMapIntensity: 1.2 });
  private neonMat = new THREE.MeshBasicMaterial({ color: new THREE.Color(0.1, 1.8, 2.2) });
  private lockedMat = new THREE.MeshBasicMaterial({ color: new THREE.Color(2.8, 0.25, 0.3) });
  private openMat = new THREE.MeshBasicMaterial({ color: new THREE.Color(0.3, 2.6, 0.5) });
  private padGeo = new THREE.RingGeometry(5.2, 5.6, 40);
  private padMat = new THREE.MeshBasicMaterial({ color: new THREE.Color(2.4, 0.4, 2.0), side: THREE.DoubleSide, transparent: true, opacity: 0.9 });
  private coneGeo = new THREE.ConeGeometry(7, 24, 16, 1, true).translate(0, -12, 0).rotateX(-Math.PI / 2);
  private coneMat = new THREE.MeshBasicMaterial({ color: new THREE.Color(2.2, 0.2, 0.25), transparent: true, opacity: 0.12, blending: THREE.AdditiveBlending, depthWrite: false, side: THREE.DoubleSide, fog: false });
  private camBodyGeo = new THREE.BoxGeometry(0.5, 0.4, 0.8);
  private beamGeo = new THREE.CylinderGeometry(0.5, 1.0, 60, 10, 1, true);
  private beamMat = new THREE.MeshBasicMaterial({ color: new THREE.Color(1.6, 1.2, 0.1), transparent: true, opacity: 0.15, blending: THREE.AdditiveBlending, depthWrite: false, side: THREE.DoubleSide, fog: false });
  private safeBeamMat = new THREE.MeshBasicMaterial({ color: new THREE.Color(0.2, 2.0, 0.6), transparent: true, opacity: 0.18, blending: THREE.AdditiveBlending, depthWrite: false, side: THREE.DoubleSide, fog: false });
  private safeBeam: THREE.Mesh;
  private root = new THREE.Group();

  constructor(private ctx: GameContext, scene: THREE.Scene) {
    scene.add(this.root);
    this.safeBeam = new THREE.Mesh(this.beamGeo, this.safeBeamMat);
    this.safeBeam.visible = false;
    this.root.add(this.safeBeam);

    const ev = ctx.engine.events;
    ev.on('enemyKilled', ({ enemy }) => this.onKill(enemy));
    ev.on('terminalHacked', ({ id }) => {
      const m = this.active;
      if (m && this.site && id === this.site.termId) {
        this.flags.termHacked = true;
        this.complete(m, 'hack');
      }
    });
    ev.on('doorOpened', ({ id }) => {
      if (this.site && id === this.site.doorId) {
        this.flags.doorOpen = true;
        if (this.active) this.setDone(this.active, 'gate');
      }
    });
    ev.on('npcHacked', ({ npc, mode }) => {
      const m = this.active;
      if (m && m.type === 'interrogate' && mode === 'interrogate' && npc.contact === m.id) this.complete(m, 'talk');
    });
    ev.on('alert', () => {
      const m = this.active;
      if (m && this.site) this.raiseAlert(m, 'GUARDIAS ALERTADOS');
    });
  }

  private freshFlags(): Flags {
    return { doorOpen: false, termHacked: false, caseTaken: false, leaderDead: false, guardsCleared: false, alerted: false, camsDisabled: new Set() };
  }

  // ───────────────────────────── generation ─────────────────────────────

  private pickName(list: string[]): string {
    return list[Math.floor(this.rnd() * list.length)];
  }

  generate(): Mission | null {
    const { city, player } = this.ctx;
    const from = player.pos;
    let plaza = city.findPlaza(from, 110, 340, this.rnd) ?? city.findPlaza(from, 50, 520, this.rnd);
    if (!plaza) return null;
    // Avoid stacking offers on the same plaza.
    for (let tries = 0; tries < 6; tries++) {
      const clash = this.offers.some((o) => o.site.distanceTo(plaza!) < 30) || (this.active && this.active.site.distanceTo(plaza!) < 30);
      if (!clash) break;
      plaza = city.findPlaza(from, 80, 520, this.rnd) ?? plaza;
    }
    const level = player.profile.level;
    const difficulty = clamp(1 + Math.floor((level - 1) / 2) + Math.floor(this.rnd() * 3) - 1, 1, 8);
    const types: MissionType[] = ['hack', 'assassinate', 'steal', 'interrogate'];
    const type = types[Math.floor(this.rnd() * types.length)];
    const d = city.districtAt(plaza.x, plaza.z);
    const id = this.nextId++;
    const targetName = type === 'assassinate' ? this.pickName(LEADER_NAMES) : type === 'interrogate' ? this.pickName(CONTACT_NAMES) : '';
    let safe: THREE.Vector3 | null = null;
    if (type === 'steal') safe = city.findPlaza(plaza, 140, 340, this.rnd) ?? plaza.clone().add(new THREE.Vector3(220, 0, 0));

    const base = 200 + difficulty * 110 + Math.floor(this.rnd() * 120);
    const mult = type === 'assassinate' ? 1.4 : type === 'steal' ? 1.25 : type === 'hack' ? 1.0 : 0.8;
    const objectives: Objective[] = [{ id: 'reach', text: `Dirígete al Distrito ${d.id} · ${d.name}`, done: false }];
    let title = '';
    let briefing = '';
    switch (type) {
      case 'hack':
        title = `Hackear terminal central en el Distrito ${d.id}`;
        briefing = `Un complejo de ${d.name} esconde un núcleo de datos corporativo. Abre la puerta, esquiva a los guardias y descifra la terminal central.`;
        objectives.push({ id: 'gate', text: 'Abre la puerta del complejo (/hack DOOR)', done: false });
        objectives.push({ id: 'hack', text: 'Hackea la terminal central (/hack TRM)', done: false });
        objectives.push({ id: 'guards', text: 'Neutraliza a los guardias (bonus)', done: false, optional: true });
        break;
      case 'assassinate':
        title = `Eliminar al líder de la corporación rival`;
        briefing = `${targetName} dirige las operaciones de la corporación rival en ${d.name}. Va escoltado. No habrá testigos.`;
        objectives.push({ id: 'leader', text: `Elimina a ${targetName}`, done: false });
        break;
      case 'steal':
        title = 'Robar un maletín de datos y escapar sin ser detectado';
        briefing = `Un maletín con credenciales vale una fortuna. Hay cámaras: /override las apaga. Si te detectan, los guardias caerán sobre ti.`;
        objectives.push({ id: 'enter', text: 'Entra al complejo (puerta o evita las cámaras)', done: false });
        objectives.push({ id: 'case', text: 'Roba el maletín de datos', done: false });
        objectives.push({ id: 'escape', text: 'Escapa al refugio seguro', done: false });
        objectives.push({ id: 'stealth', text: 'Sin ser detectado (bonus ×1.5)', done: false, optional: true });
        break;
      case 'interrogate':
        title = 'Interrogar al informante';
        briefing = `${targetName} sabe quién mueve los hilos en ${d.name}. Llega hasta él, sortea a sus escoltas y /interrogate.`;
        objectives.push({ id: 'talk', text: `Interroga a ${targetName} (/interrogate)`, done: false });
        break;
    }
    return {
      id, type, title, briefing, districtName: d.name, districtId: d.id, site: plaza.clone(), safe, difficulty,
      rewardCredits: Math.round(base * mult), rewardXp: Math.round((90 + difficulty * 45) * mult), objectives,
      stealth: true, state: 'offered', targetName,
    };
  }

  generateOffers(n = 3): void {
    this.offers = [];
    for (let i = 0; i < n; i++) {
      const m = this.generate();
      if (m) this.offers.push(m);
    }
  }

  accept(index: number): Mission | null {
    const m = this.offers[index];
    if (!m) return null;
    if (this.active) this.abort(true);
    // A just-finished mission may still own the scene (cleanup delay): clear it before the new site spawns.
    this.teardownSite();
    this.offers.splice(index, 1);
    m.state = 'active';
    this.active = m;
    this.flags = this.freshFlags();
    this.detection = 0;
    this.completedMission = null;
    this.ctx.engine.events.emit('missionStarted', { mission: m });
    this.ctx.ui.toast(`MISIÓN: ${m.title}`, 'info');
    return m;
  }

  abort(silent = false): void {
    const m = this.active;
    if (!m) return;
    m.state = 'failed';
    this.teardownSite();
    this.active = null;
    if (!silent) this.ctx.engine.events.emit('missionFailed', { mission: m, reason: 'ABORTED' });
    if (!silent) this.ctx.ui.toast('MISIÓN ABANDONADA', 'warn');
    if (!this.offers.length) this.generateOffers();
  }

  /** Drops the runtime site (guards, colliders) so it is rebuilt on the next approach. */
  refreshSite(): void {
    this.teardownSite();
  }

  /** Clears everything for a new game. */
  reset(): void {
    this.teardownSite();
    this.active = null;
    this.offers = [];
    this.flags = this.freshFlags();
    this.completedMission = null;
  }

  hint(): string | null {
    const m = this.active;
    if (!m) return null;
    const p = this.ctx.player.pos;
    const target = this.currentTarget(m) ?? m.site;
    const dx = target.x - p.x;
    const dz = target.z - p.z;
    const dirs = ['E', 'SE', 'S', 'SW', 'W', 'NW', 'N', 'NE'];
    const idx = Math.round(((Math.atan2(dz, dx) + Math.PI * 2) % (Math.PI * 2)) / (Math.PI / 4)) % 8;
    return `INTEL: objetivo a ${Math.round(Math.hypot(dx, dz))} m al ${dirs[idx]}`;
  }

  // ───────────────────────────── objectives ─────────────────────────────

  private obj(m: Mission, id: string): Objective | undefined {
    return m.objectives.find((o) => o.id === id);
  }

  private setDone(m: Mission, id: string): void {
    const o = this.obj(m, id);
    if (!o || o.done) return;
    o.done = true;
    this.ctx.ui.toast(`✔ ${o.text}`, 'ok');
    this.ctx.audio.pickup();
  }

  private requiredDone(m: Mission): boolean {
    return m.objectives.every((o) => o.optional || o.done);
  }

  private complete(m: Mission, finalId: string): void {
    const reach = this.obj(m, 'reach');
    if (reach) reach.done = true;
    this.setDone(m, finalId);
    if (m.type === 'steal' && finalId !== 'escape') return;
    if (!this.requiredDone(m)) return;
    this.finish(m);
  }

  private finish(m: Mission): void {
    const { player, ui, audio, state, engine } = this.ctx;
    const bonusStealth = m.type === 'steal' && m.stealth;
    if (bonusStealth) this.setDone(m, 'stealth');
    const credits = Math.round(m.rewardCredits * (bonusStealth ? 1.5 : 1));
    const xp = Math.round(m.rewardXp * (bonusStealth ? 1.25 : 1));
    player.addCredits(credits);
    player.addXp(xp);
    m.state = 'complete';
    state.missionsDone++;
    audio.success();
    ui.toast(`MISIÓN COMPLETADA  +¢${credits}  +${xp} XP`, 'ok');
    engine.events.emit('missionCompleted', { mission: m });
    this.completedMission = m;
    this.cleanupT = 6;
    this.active = null;
    this.generateOffers();
  }

  private onKill(e: Enemy): void {
    const m = this.active;
    if (!m || !this.site) return;
    if (this.site.leader === e) {
      this.flags.leaderDead = true;
      this.complete(m, 'leader');
      return;
    }
    if (e.tag === `m${m.id}` && this.ctx.enemies.count(e.tag) === 0 && !this.flags.guardsCleared) {
      this.flags.guardsCleared = true;
      this.setDone(m, 'guards');
    }
  }

  private raiseAlert(m: Mission, reason: string): void {
    if (this.flags.alerted) return;
    this.flags.alerted = true;
    m.stealth = false;
    this.ctx.ui.toast(`⚠ ${reason}`, 'err');
    this.ctx.audio.error();
    this.ctx.gfx.glitch = 0.6;
    this.ctx.enemies.alertTag(`m${m.id}`);
    if (m.type === 'steal' && this.site) {
      const c = m.site;
      for (let i = 0; i < 2 + Math.floor(m.difficulty / 2); i++) {
        const a = this.rnd() * Math.PI * 2;
        this.ctx.enemies.spawnAt(i % 3 === 2 && m.difficulty > 2 ? 'hacker' : 'agent', c.x + Math.cos(a) * 14, c.z + 18 + Math.sin(a) * 4, { tag: `m${m.id}`, aggro: true });
      }
    }
  }

  private currentTarget(m: Mission): THREE.Vector3 | null {
    const next = m.objectives.find((o) => !o.done && !o.optional);
    if (!next) return null;
    const s = this.site;
    switch (next.id) {
      case 'reach': return m.site;
      case 'gate': case 'enter': return s ? s.doorPos : m.site;
      case 'hack': return s && s.termGroup ? s.termPos : m.site;
      case 'leader': return s && s.leader && !s.leader.dead ? s.leader.pos : m.site;
      case 'case': return s ? s.casePos : m.site;
      case 'escape': return m.safe;
      case 'talk': return s && s.contact ? this.tmp.set(s.contact.rx, 0, s.contact.rz) : m.site;
      default: return m.site;
    }
  }

  // ───────────────────────────── site lifecycle ─────────────────────────────

  private teardownSite(): void {
    const s = this.site;
    const m = this.active;
    if (s) {
      for (const id of s.colliders) this.ctx.city.removeCollider(id);
      this.root.remove(s.group);
      if (s.contact) this.ctx.npcs.releaseContact(s.contact);
    }
    if (m) this.ctx.enemies.removeTag(`m${m.id}`);
    else if (this.completedMission) this.ctx.enemies.removeTag(`m${this.completedMission.id}`);
    this.site = null;
    this.safeBeam.visible = false;
    this.detection = 0;
  }

  private mkBox(group: THREE.Group, mat: THREE.Material, x: number, y: number, z: number, sx: number, sy: number, sz: number): THREE.Mesh {
    const mesh = new THREE.Mesh(this.boxGeo, mat);
    mesh.position.set(x, y, z);
    mesh.scale.set(sx, sy, sz);
    group.add(mesh);
    return mesh;
  }

  private spawnSite(m: Mission): void {
    const { city, enemies, npcs } = this.ctx;
    const c = m.site;
    const group = new THREE.Group();
    const site: Site = {
      group, doorMesh: null, doorId: `DOOR-${m.id}`, doorPos: this.tmp.set(c.x, 0, c.z + H).clone(), cams: [], caseMesh: null,
      casePos: new THREE.Vector3(c.x, 1.2, c.z), termGroup: null, termId: `TRM-C${m.id}`, termPos: new THREE.Vector3(c.x, 1, c.z - 2), contact: null,
      leader: null, colliders: [], doorSlide: this.flags.doorOpen ? 1 : 0,
    };

    // Landing pad ring.
    const pad = new THREE.Mesh(this.padGeo, this.padMat);
    pad.rotation.x = -Math.PI / 2;
    pad.position.set(c.x, 0.07, c.z);
    group.add(pad);

    const compound = m.type === 'hack' || m.type === 'steal';
    if (compound) {
      const fence = (id: string, x: number, z: number, sx: number, sz: number): void => {
        this.mkBox(group, this.fenceMat, x, 2.25, z, sx, 4.5, sz);
        this.mkBox(group, this.neonMat, x, 4.55, z, sx + 0.05, 0.12, sz + 0.05);
        const box = { minX: x - sx / 2, maxX: x + sx / 2, minZ: z - sz / 2, maxZ: z + sz / 2 };
        city.addCollider(`m${m.id}:${id}`, box);
        site.colliders.push(`m${m.id}:${id}`);
      };
      fence('N', c.x, c.z - H, H * 2 + 0.5, 0.5);
      fence('W', c.x - H, c.z, 0.5, H * 2 + 0.5);
      fence('E', c.x + H, c.z, 0.5, H * 2 + 0.5);
      fence('SL', c.x - (H + 2) / 2 - 0.0, c.z + H, H - 2, 0.5);
      fence('SR', c.x + (H + 2) / 2 + 0.0, c.z + H, H - 2, 0.5);
      // Hackable gate.
      site.doorMesh = this.mkBox(group, this.flags.doorOpen ? this.openMat : this.lockedMat, c.x, 2.25, c.z + H, 4, 4.5, 0.4);
      if (!this.flags.doorOpen) {
        city.addCollider(`m${m.id}:door`, { minX: c.x - 2, maxX: c.x + 2, minZ: c.z + H - 0.3, maxZ: c.z + H + 0.3 });
        site.colliders.push(`m${m.id}:door`);
      } else {
        site.doorMesh.position.y = 7;
      }
    }

    if (m.type === 'hack') {
      const g = new THREE.Group();
      g.position.set(c.x, 0, c.z - 2);
      this.mkBox(g, this.fenceMat, 0, 0.6, 0, 1.8, 1.2, 1.8);
      const col = this.mkBox(g, this.flags.termHacked ? this.openMat : this.neonMat, 0, 2.6, 0, 0.9, 2.8, 0.9);
      col.name = 'core';
      const ring = new THREE.Mesh(new THREE.TorusGeometry(1.5, 0.05, 6, 32), this.neonMat);
      ring.rotation.x = Math.PI / 2;
      ring.position.y = 4.4;
      ring.name = 'ring';
      g.add(ring);
      const beam = new THREE.Mesh(this.beamGeo, this.beamMat);
      beam.position.y = 30;
      g.add(beam);
      group.add(g);
      site.termGroup = g;
      city.addCollider(`m${m.id}:term`, { minX: c.x - 0.9, maxX: c.x + 0.9, minZ: c.z - 2.9, maxZ: c.z - 1.1 });
      site.colliders.push(`m${m.id}:term`);
    }

    if (m.type === 'steal') {
      const caseM = this.mkBox(group, this.neonMat, c.x, 1.25, c.z - 2, 0.7, 0.45, 0.95);
      this.mkBox(group, this.fenceMat, c.x, 0.5, c.z - 2, 1.1, 1.0, 1.1);
      const beam = new THREE.Mesh(this.beamGeo, this.beamMat);
      beam.position.set(c.x, 30, c.z - 2);
      group.add(beam);
      site.caseMesh = this.flags.caseTaken ? null : caseM;
      if (this.flags.caseTaken) caseM.visible = false;
      site.casePos.set(c.x, 1.25, c.z - 2);
      // Rotating security cameras on two fence corners.
      const corners: Array<[number, number, number]> = [[-H + 0.6, -H + 0.6, Math.PI / 4], [H - 0.6, -H + 0.6, (3 * Math.PI) / 4]];
      corners.forEach(([dx, dz, yaw], i) => {
        const cg = new THREE.Group();
        cg.position.set(c.x + dx, 4.8, c.z + dz);
        const body = new THREE.Mesh(this.camBodyGeo, this.fenceMat);
        const lens = new THREE.Mesh(this.boxGeo, this.lockedMat);
        lens.scale.set(0.2, 0.2, 0.1);
        lens.position.z = 0.45;
        const cone = new THREE.Mesh(this.coneGeo, this.coneMat);
        cg.add(body, lens, cone);
        group.add(cg);
        const id = `CAM-${m.id}${'AB'[i]}`;
        site.cams.push({ id, group: cg, cone, baseYaw: yaw, phase: i * 1.7, disabledUntil: this.flags.camsDisabled.has(id) ? Infinity : 0, pos: cg.position.clone() });
      });
    }

    if (m.type === 'interrogate') {
      site.contact = npcs.claimContact(c.x, c.z, m.targetName, m.id);
    }

    this.root.add(group);
    this.site = site;

    // Guards (not respawned once cleared).
    if (!this.flags.guardsCleared && !(m.type === 'assassinate' && this.flags.leaderDead)) {
      const n = Math.min(8, 2 + Math.floor(m.difficulty / 2) + (m.type === 'assassinate' ? 2 : 0));
      const tag = `m${m.id}`;
      for (let i = 0; i < n; i++) {
        const a = (i / n) * Math.PI * 2 + this.rnd();
        const r = compound ? 3 + this.rnd() * 3 : 5 + this.rnd() * 4;
        const kind: EnemyKind = m.difficulty >= 5 && i % 4 === 3 ? 'brute' : m.difficulty >= 3 && i % 3 === 2 ? 'hacker' : 'agent';
        const guardCompound = compound && m.type === 'steal';
        enemies.spawnAt(kind, c.x + Math.cos(a) * (guardCompound ? r + 12 : r), c.z + Math.sin(a) * (guardCompound ? r + 12 : r), {
          tag, aggro: false, aggroRange: m.type === 'steal' ? 13 : 24,
        });
      }
      if (m.type === 'assassinate') {
        site.leader = enemies.spawnAt('brute', c.x, c.z - 1, {
          tag, name: m.targetName, leader: true, scale: 1.3, hpMul: 1.8 + m.difficulty * 0.25, dmgMul: 1.1, aggro: false, aggroRange: 28,
        });
      }
    }
    if (m.safe) {
      this.safeBeam.position.set(m.safe.x, 30, m.safe.z);
    }
  }

  // ───────────────────────────── update ─────────────────────────────

  update(dt: number, time: number): void {
    const { player, ui } = this.ctx;
    const pp = player.pos;
    const m = this.active;

    if (this.completedMission && !m) {
      this.cleanupT -= dt;
      if (this.cleanupT <= 0) {
        this.teardownSite();
        this.completedMission = null;
      }
    }
    if (!m) return;

    const d = Math.hypot(m.site.x - pp.x, m.site.z - pp.z);
    if (!this.site && d < SPAWN_DIST) this.spawnSite(m);
    else if (this.site && d > DESPAWN_DIST && !this.flags.caseTaken) this.teardownSite();

    if (d < 28) this.setDone(m, 'reach');
    const site = this.site;

    if (site) {
      // Animate objects.
      if (site.doorMesh) {
        const target = this.flags.doorOpen ? 1 : 0;
        site.doorSlide += (target - site.doorSlide) * Math.min(1, dt * 3);
        site.doorMesh.position.y = 2.25 + site.doorSlide * 5;
        site.doorMesh.material = this.flags.doorOpen ? this.openMat : this.lockedMat;
      }
      if (site.termGroup) {
        const ring = site.termGroup.getObjectByName('ring');
        if (ring) ring.rotation.z += dt * 2;
      }
      if (site.caseMesh) site.caseMesh.rotation.y += dt * 1.5;

      if (m.type === 'steal') this.updateSteal(m, site, dt, time);
      if (m.type === 'steal' && !this.flags.alerted) {
        // Guards who notice the player count as detection.
      }
      if (m.type === 'hack') {
        const inside = Math.abs(pp.x - m.site.x) < H && Math.abs(pp.z - m.site.z) < H;
        if (inside) this.setDone(m, 'gate');
      }
    }

    if (m.type === 'steal' && this.obj(m, 'escape') && this.flags.caseTaken && m.safe) {
      const ds = Math.hypot(m.safe.x - pp.x, m.safe.z - pp.z);
      this.safeBeam.visible = true;
      if (ds < 7) this.complete(m, 'escape');
    }
    ui.setDetection(this.detection);
  }

  private updateSteal(m: Mission, site: Site, dt: number, time: number): void {
    const { player } = this.ctx;
    const pp = player.pos;
    const inside = Math.abs(pp.x - m.site.x) < H && Math.abs(pp.z - m.site.z) < H;
    if (inside) this.setDone(m, 'enter');

    // Camera sweeps and detection cones.
    let seen = false;
    for (const cam of site.cams) {
      const off = time < cam.disabledUntil ? 0 : 1;
      const yaw = cam.baseYaw + Math.sin(time * 0.8 + cam.phase) * 1.0;
      cam.group.rotation.y = yaw;
      cam.cone.visible = off === 1;
      if (!off) continue;
      const dx = pp.x - cam.pos.x;
      const dz = pp.z - cam.pos.z;
      const dist = Math.hypot(dx, dz);
      if (dist > 24 || player.dead) continue;
      let rel = Math.atan2(dx, dz) - yaw;
      rel = Math.atan2(Math.sin(rel), Math.cos(rel));
      if (Math.abs(rel) < 0.42) seen = true;
    }
    this.detection = clamp(this.detection + (seen ? 0.55 : -0.2) * dt, 0, 1);
    if (this.detection >= 1 && !this.flags.alerted) this.raiseAlert(m, 'DETECTADO POR LAS CÁMARAS');

    // Pick up the case by walking over it.
    if (site.caseMesh && !this.flags.caseTaken && Math.hypot(pp.x - site.casePos.x, pp.z - site.casePos.z) < 1.8) {
      this.flags.caseTaken = true;
      site.caseMesh.visible = false;
      site.caseMesh = null;
      this.setDone(m, 'case');
      this.ctx.audio.success();
      this.ctx.ui.toast('MALETÍN ASEGURADO — ¡ESCAPA!', 'warn');
      this.ctx.shake(0.3);
      if (!this.flags.alerted) {
        // Securing the case triggers a silent alarm: reinforcements arrive.
        this.ctx.enemies.alertTag(`m${m.id}`);
      }
    }
  }

  // ───────────────────────────── HUD / hacking integration ─────────────────────────────

  markers(out: MissionMarker[]): void {
    const m = this.active;
    if (!m) return;
    const t = this.currentTarget(m);
    if (!t) return;
    const isSafe = m.type === 'steal' && !!m.safe && t === m.safe;
    out.push({ id: `m${m.id}`, pos: t.clone(), label: isSafe ? 'REFUGIO' : m.type.toUpperCase(), color: isSafe ? '#33ff88' : '#ffc400', kind: isSafe ? 'safe' : 'mission' });
  }

  logData(): MissionLogData | null {
    const m = this.active;
    if (!m) return null;
    return {
      title: m.title,
      district: `DISTRITO ${m.districtId} · ${m.districtName}`,
      lines: m.objectives.map((o) => ({ text: o.text, done: o.done, optional: !!o.optional })),
      reward: `¢${m.rewardCredits}  ·  ${m.rewardXp} XP`,
    };
  }

  /** Objects the console can scan: gate, central terminal and cameras of the active site. */
  hackTargets(center: THREE.Vector3, radius: number, out: HackTarget[]): void {
    const m = this.active;
    const s = this.site;
    if (!m || !s) return;
    const { engine, player, city } = this.ctx;
    const push = (t: Omit<HackTarget, 'dist'>): void => {
      const dist = Math.hypot(t.pos.x - center.x, t.pos.z - center.z);
      if (dist <= radius) out.push({ ...t, dist });
    };
    if (s.doorMesh && !this.flags.doorOpen) {
      push({
        id: s.doorId, kind: 'door', label: 'SECURITY GATE', pos: s.doorPos.clone().setY(2), modes: ['hack', 'override'], difficulty: m.difficulty > 4 ? 3 : 1,
        details: ['STATE: LOCKED', 'ICE: LEVEL ' + (1 + Math.floor(m.difficulty / 2))],
        apply: (mode: HackMode): HackResult => {
          this.flags.doorOpen = true;
          city.removeCollider(`m${m.id}:door`);
          engine.events.emit('doorOpened', { id: s.doorId });
          player.addXp(mode === 'override' ? 30 : 20);
          this.ctx.state.hacks++;
          return { ok: true, lines: ['>> GATE ACTUATORS OVERRIDDEN', '>> ACCESS GRANTED'] };
        },
      });
    }
    if (m.type === 'hack' && s.termGroup && !this.flags.termHacked) {
      push({
        id: s.termId, kind: 'terminal', label: 'CENTRAL CORE', pos: s.termPos.clone().setY(2), modes: ['hack', 'override'], difficulty: 2 + Math.floor(m.difficulty / 2),
        details: ['TYPE: CORPORATE DATA CORE', 'ICE: HEAVY'],
        apply: (): HackResult => {
          this.flags.termHacked = true;
          const core = s.termGroup?.getObjectByName('core') as THREE.Mesh | undefined;
          if (core) core.material = this.openMat;
          player.addXp(40);
          this.ctx.state.hacks++;
          engine.events.emit('terminalHacked', { id: s.termId });
          return { ok: true, lines: ['>> CORE DECRYPTED', '>> EXFILTRATING DATA ...', '>> TRANSFER COMPLETE'] };
        },
      });
    }
    for (const cam of s.cams) {
      if (this.ctx.engine.clock < cam.disabledUntil) continue;
      push({
        id: cam.id, kind: 'camera', label: 'SECURITY CAMERA', pos: cam.pos.clone(), modes: ['hack', 'override'], difficulty: 1 + Math.floor(m.difficulty / 3),
        details: ['SWEEP: ACTIVE', 'RANGE: 24m'],
        apply: (mode: HackMode): HackResult => {
          const secs = mode === 'override' ? 90 : 30;
          cam.disabledUntil = this.ctx.engine.clock + secs;
          if (mode === 'override') cam.disabledUntil = Infinity;
          this.flags.camsDisabled.add(cam.id);
          engine.events.emit('cameraDisabled', { id: cam.id });
          player.addXp(15);
          this.ctx.state.hacks++;
          return { ok: true, lines: [`>> CAMERA FEED LOOPED (${mode === 'override' ? 'PERMANENT' : secs + 's'})`] };
        },
      });
    }
  }
}
