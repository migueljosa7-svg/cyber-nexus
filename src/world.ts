import * as THREE from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import { CFG, PALETTES, type Palette } from './config';
import type { GfxRenderer } from './engine/renderer';

interface AABB { minX: number; maxX: number; minZ: number; maxZ: number }

export interface Terminal {
  key: string;
  pos: THREE.Vector3;
  hacked: boolean;
  group: THREE.Group;
  screenMat: THREE.MeshBasicMaterial;
  beamMat: THREE.MeshBasicMaterial;
  ring: THREE.Mesh;
}

interface Chunk {
  key: string;
  cx: number;
  cz: number;
  group: THREE.Group;
  floatGroup: THREE.Group;
  floatPhase: number;
  colliders: AABB[];
  terminals: Terminal[];
  geos: THREE.BufferGeometry[];
  mats: THREE.Material[];
}

export interface Portal {
  group: THREE.Group;
  pos: THREE.Vector3;
  ringA: THREE.Mesh;
  ringB: THREE.Mesh;
  mats: THREE.Material[];
}

const TILE = 4;
const RAIN_AREA = 90;
const RAIN_HEIGHT = 46;

function mulberry32(a: number): () => number {
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Procedural cyberpunk city: streamed chunks of merged geometry, neon, terminals, digital rain and the exit portal. */
export class World {
  private chunks = new Map<string, Chunk>();
  private queue: Array<{ cx: number; cz: number }> = [];
  private lastCx = Infinity;
  private lastCz = Infinity;
  private seed = 1;
  palette: Palette = PALETTES[0];
  private hacked = new Set<string>();
  portal: Portal | null = null;

  private root = new THREE.Group();
  private floor: THREE.Mesh;
  private floorMat: THREE.MeshStandardMaterial;
  private gridTex: THREE.CanvasTexture;
  private windowCanvas: HTMLCanvasElement;
  private windowTex: THREE.CanvasTexture;
  private buildingMat: THREE.MeshStandardMaterial;
  private neonMat: THREE.MeshBasicMaterial;
  private edgeMat: THREE.LineBasicMaterial;

  private rain: THREE.LineSegments;
  private rainPos: Float32Array;
  private rainCol: Float32Array;
  private rainState: Float32Array; // x, y, z, speed, len per drop
  private rainCount: number;

  constructor(scene: THREE.Scene, gfx: GfxRenderer) {
    scene.add(this.root);

    const aniso = Math.min(8, gfx.renderer.capabilities.getMaxAnisotropy());
    this.gridTex = this.makeGridTexture(aniso);
    this.floorMat = new THREE.MeshStandardMaterial({
      color: 0x04050f,
      roughness: 0.3,
      metalness: 0.85,
      emissive: 0x00f0ff,
      emissiveMap: this.gridTex,
      emissiveIntensity: 0.55,
    });
    this.floor = new THREE.Mesh(new THREE.PlaneGeometry(600, 600), this.floorMat);
    this.floor.rotation.x = -Math.PI / 2;
    this.floor.receiveShadow = true;
    this.root.add(this.floor);

    this.windowCanvas = document.createElement('canvas');
    this.windowCanvas.width = 128;
    this.windowCanvas.height = 256;
    this.windowTex = new THREE.CanvasTexture(this.windowCanvas);
    this.windowTex.wrapS = this.windowTex.wrapT = THREE.RepeatWrapping;
    this.windowTex.colorSpace = THREE.SRGBColorSpace;
    this.windowTex.anisotropy = aniso;
    this.buildingMat = new THREE.MeshStandardMaterial({
      color: 0x0b0d1d,
      roughness: 0.45,
      metalness: 0.55,
      emissive: 0xffffff,
      emissiveMap: this.windowTex,
      emissiveIntensity: 1.1,
    });
    this.neonMat = new THREE.MeshBasicMaterial({ vertexColors: true });
    this.edgeMat = new THREE.LineBasicMaterial({ color: 0x00f0ff });

    this.rainCount = CFG.rainCount;
    this.rainPos = new Float32Array(this.rainCount * 6);
    this.rainCol = new Float32Array(this.rainCount * 6);
    this.rainState = new Float32Array(this.rainCount * 5);
    const rg = new THREE.BufferGeometry();
    rg.setAttribute('position', new THREE.BufferAttribute(this.rainPos, 3).setUsage(THREE.DynamicDrawUsage));
    rg.setAttribute('color', new THREE.BufferAttribute(this.rainCol, 3));
    rg.boundingSphere = new THREE.Sphere(new THREE.Vector3(), 1e5);
    this.rain = new THREE.LineSegments(
      rg,
      new THREE.LineBasicMaterial({ vertexColors: true, transparent: true, blending: THREE.AdditiveBlending, depthWrite: false, fog: false }),
    );
    this.rain.frustumCulled = false;
    this.rain.renderOrder = 5;
    scene.add(this.rain);

    this.applyPalette(this.palette);
  }

  // ───────────────────────────── palette & textures ─────────────────────────────

  private makeGridTexture(aniso: number): THREE.CanvasTexture {
    const c = document.createElement('canvas');
    c.width = c.height = 256;
    const g = c.getContext('2d')!;
    g.fillStyle = '#000';
    g.fillRect(0, 0, 256, 256);
    g.strokeStyle = '#fff';
    g.lineWidth = 5;
    g.strokeRect(0, 0, 256, 256);
    g.globalAlpha = 0.25;
    g.lineWidth = 2;
    g.beginPath();
    g.moveTo(128, 0); g.lineTo(128, 256); g.moveTo(0, 128); g.lineTo(256, 128);
    g.stroke();
    const t = new THREE.CanvasTexture(c);
    t.wrapS = t.wrapT = THREE.RepeatWrapping;
    t.repeat.set(600 / TILE, 600 / TILE);
    t.anisotropy = aniso;
    t.colorSpace = THREE.SRGBColorSpace;
    return t;
  }

  private paintWindows(p: Palette): void {
    const g = this.windowCanvas.getContext('2d')!;
    g.fillStyle = '#000';
    g.fillRect(0, 0, 128, 256);
    const cols = ['#' + p.primary.toString(16).padStart(6, '0'), '#' + p.secondary.toString(16).padStart(6, '0'), '#' + p.accent.toString(16).padStart(6, '0'), '#cfe8ff'];
    const rnd = mulberry32(99);
    for (let y = 0; y < 16; y++) {
      for (let x = 0; x < 8; x++) {
        if (rnd() < 0.42) {
          g.fillStyle = cols[Math.floor(rnd() * cols.length)];
          g.globalAlpha = 0.45 + rnd() * 0.55;
          g.fillRect(x * 16 + 3, y * 16 + 4, 10, 8);
        }
      }
    }
    g.globalAlpha = 1;
    this.windowTex.needsUpdate = true;
  }

  private applyPalette(p: Palette): void {
    this.palette = p;
    this.floorMat.emissive.set(p.primary);
    this.edgeMat.color.set(p.primary).multiplyScalar(1.6);
    this.paintWindows(p);
    const a = new THREE.Color(p.primary);
    const b = new THREE.Color(p.accent);
    const col = this.rainCol;
    for (let i = 0; i < this.rainCount; i++) {
      const c = i % 7 === 0 ? b : a;
      col[i * 6] = c.r * 1.1; col[i * 6 + 1] = c.g * 1.1; col[i * 6 + 2] = c.b * 1.1;
      col[i * 6 + 3] = 0; col[i * 6 + 4] = 0; col[i * 6 + 5] = 0;
    }
    (this.rain.geometry.attributes.color as THREE.BufferAttribute).needsUpdate = true;
  }

  // ───────────────────────────── lifecycle ─────────────────────────────

  /** Rebuilds the entire world for a new level/seed and generates the area around `center` synchronously. */
  reset(seed: number, palette: Palette, center: THREE.Vector3): void {
    this.removePortal();
    for (const c of [...this.chunks.values()]) this.disposeChunk(c);
    this.chunks.clear();
    this.queue = [];
    this.hacked.clear();
    this.seed = seed;
    this.applyPalette(palette);
    this.lastCx = Infinity;
    this.lastCz = Infinity;
    const R = CFG.viewRadius;
    const ccx = Math.round(center.x / CFG.chunkSize);
    const ccz = Math.round(center.z / CFG.chunkSize);
    for (let dz = -R; dz <= R; dz++) for (let dx = -R; dx <= R; dx++) this.ensureChunk(ccx + dx, ccz + dz);
    this.lastCx = ccx;
    this.lastCz = ccz;
    this.seedRain(center);
  }

  private seedRain(center: THREE.Vector3): void {
    const s = this.rainState;
    for (let i = 0; i < this.rainCount; i++) {
      s[i * 5] = center.x + (Math.random() - 0.5) * RAIN_AREA * 2;
      s[i * 5 + 1] = Math.random() * RAIN_HEIGHT;
      s[i * 5 + 2] = center.z + (Math.random() - 0.5) * RAIN_AREA * 2;
      s[i * 5 + 3] = 14 + Math.random() * 22;
      s[i * 5 + 4] = 1.2 + Math.random() * 3.2;
    }
  }

  update(dt: number, time: number, p: THREE.Vector3): void {
    const S = CFG.chunkSize;
    const cx = Math.round(p.x / S);
    const cz = Math.round(p.z / S);
    if (cx !== this.lastCx || cz !== this.lastCz) {
      this.lastCx = cx;
      this.lastCz = cz;
      const R = CFG.viewRadius;
      for (const c of [...this.chunks.values()]) {
        if (Math.abs(c.cx - cx) > R + 1 || Math.abs(c.cz - cz) > R + 1) {
          this.disposeChunk(c);
          this.chunks.delete(c.key);
        }
      }
      this.queue = [];
      for (let dz = -R; dz <= R; dz++) for (let dx = -R; dx <= R; dx++) {
        if (!this.chunks.has(`${cx + dx},${cz + dz}`)) this.queue.push({ cx: cx + dx, cz: cz + dz });
      }
      this.queue.sort((a, b) => Math.hypot(a.cx - cx, a.cz - cz) - Math.hypot(b.cx - cx, b.cz - cz));
    }
    for (let n = 0; n < CFG.chunksPerFrame && this.queue.length; n++) {
      const q = this.queue.shift()!;
      this.ensureChunk(q.cx, q.cz);
    }

    this.floor.position.set(Math.round(p.x / TILE) * TILE, 0, Math.round(p.z / TILE) * TILE);

    for (const c of this.chunks.values()) {
      c.floatGroup.position.y = Math.sin(time * 0.4 + c.floatPhase) * 1.6;
      c.floatGroup.rotation.y = Math.sin(time * 0.05 + c.floatPhase) * 0.04;
      for (const t of c.terminals) {
        t.ring.rotation.y += dt * (t.hacked ? 0.4 : 2.2);
        t.ring.position.y = 2.4 + Math.sin(time * 2 + c.floatPhase) * 0.12;
        if (!t.hacked) t.screenMat.color.setRGB(0.1, 1.8 + Math.sin(time * 6) * 0.5, 2.0);
      }
    }
    this.updateRain(dt, p);
    this.updatePortal(dt, time);
  }

  private updateRain(dt: number, p: THREE.Vector3): void {
    const s = this.rainState;
    const pos = this.rainPos;
    const half = RAIN_AREA;
    for (let i = 0; i < this.rainCount; i++) {
      const o = i * 5;
      s[o + 1] -= s[o + 3] * dt;
      if (s[o + 1] < 0) s[o + 1] += RAIN_HEIGHT;
      let dx = s[o] - p.x;
      let dz = s[o + 2] - p.z;
      if (dx > half) { s[o] -= half * 2; dx -= half * 2; } else if (dx < -half) { s[o] += half * 2; dx += half * 2; }
      if (dz > half) { s[o + 2] -= half * 2; dz -= half * 2; } else if (dz < -half) { s[o + 2] += half * 2; dz += half * 2; }
      const j = i * 6;
      pos[j] = s[o]; pos[j + 1] = s[o + 1] + s[o + 4]; pos[j + 2] = s[o + 2];
      pos[j + 3] = s[o]; pos[j + 4] = s[o + 1]; pos[j + 5] = s[o + 2];
    }
    (this.rain.geometry.attributes.position as THREE.BufferAttribute).needsUpdate = true;
  }

  // ───────────────────────────── chunk generation ─────────────────────────────

  private ensureChunk(cx: number, cz: number): void {
    const key = `${cx},${cz}`;
    if (this.chunks.has(key)) return;
    this.chunks.set(key, this.buildChunk(cx, cz, key));
  }

  private neonBox(w: number, h: number, d: number, x: number, y: number, z: number, color: THREE.Color, rotY = 0, intensity = 2.4): THREE.BufferGeometry {
    const g = new THREE.BoxGeometry(w, h, d);
    if (rotY) g.rotateY(rotY);
    g.translate(x, y, z);
    return this.paint(g, color, intensity);
  }

  /** Bakes an HDR vertex colour (values > 1 feed the bloom pass). */
  private paint<T extends THREE.BufferGeometry>(g: T, color: THREE.Color, intensity: number): T {
    const n = g.attributes.position.count;
    const arr = new Float32Array(n * 3);
    for (let i = 0; i < n; i++) {
      arr[i * 3] = color.r * intensity;
      arr[i * 3 + 1] = color.g * intensity;
      arr[i * 3 + 2] = color.b * intensity;
    }
    g.setAttribute('color', new THREE.BufferAttribute(arr, 3));
    return g;
  }

  private buildingGeo(w: number, h: number, d: number, x: number, z: number, baseY = 0): THREE.BoxGeometry {
    const g = new THREE.BoxGeometry(w, h, d);
    const uv = g.attributes.uv as THREE.BufferAttribute;
    const ext: Array<[number, number]> = [[d, h], [d, h], [w, d], [w, d], [w, h], [w, h]];
    for (let f = 0; f < 6; f++) {
      for (let v = 0; v < 4; v++) {
        const i = f * 4 + v;
        uv.setXY(i, (uv.getX(i) * ext[f][0]) / 6, (uv.getY(i) * ext[f][1]) / 10);
      }
    }
    g.translate(x, baseY + h / 2, z);
    return g;
  }

  private buildChunk(cx: number, cz: number, key: string): Chunk {
    const S = CFG.chunkSize;
    const cell = S / 4;
    const rnd = mulberry32((this.seed * 73856093) ^ (cx * 19349663) ^ (cz * 83492791));
    const ox = cx * S;
    const oz = cz * S;
    const pal = this.palette;
    const colP = new THREE.Color(pal.primary);
    const colS = new THREE.Color(pal.secondary);
    const colA = new THREE.Color(pal.accent);
    const pick = () => [colP, colS, colA][Math.floor(rnd() * 3)];

    const solid: THREE.BufferGeometry[] = [];
    const neon: THREE.BufferGeometry[] = [];
    const edges: THREE.BufferGeometry[] = [];
    const colliders: AABB[] = [];
    const slots: Array<{ x: number; z: number; w: number; d: number; h: number } | null> = [];
    const emptySlots: Array<{ x: number; z: number }> = [];

    for (let j = 0; j < 4; j++) {
      for (let i = 0; i < 4; i++) {
        const ccx = ox - S / 2 + cell * (i + 0.5);
        const ccz = oz - S / 2 + cell * (j + 0.5);
        const central = cx === 0 && cz === 0 && (i === 1 || i === 2) && (j === 1 || j === 2);
        if (central || rnd() > 0.52) {
          slots.push(null);
          emptySlots.push({ x: ccx, z: ccz });
          continue;
        }
        const w = 5 + rnd() * 5;
        const d = 5 + rnd() * 5;
        const h = 9 + Math.pow(rnd(), 1.5) * 44;
        const jx = (cell - w) / 2 - 0.8;
        const jz = (cell - d) / 2 - 0.8;
        const x = ccx + (rnd() - 0.5) * 2 * Math.max(0, jx);
        const z = ccz + (rnd() - 0.5) * 2 * Math.max(0, jz);
        const b = this.buildingGeo(w, h, d, x, z);
        solid.push(b);
        edges.push(new THREE.EdgesGeometry(b));
        colliders.push({ minX: x - w / 2, maxX: x + w / 2, minZ: z - d / 2, maxZ: z + d / 2 });
        slots.push({ x, z, w, d, h });

        neon.push(this.neonBox(w + 0.25, 0.3, d + 0.25, x, h, z, pick()));
        const bands = Math.floor(h / 11);
        for (let k = 1; k <= bands; k++) {
          if (rnd() < 0.6) neon.push(this.neonBox(w + 0.15, 0.22, d + 0.15, x, (h / (bands + 1)) * k, z, pick(), 0, 1.8));
        }
        if (rnd() < 0.7) {
          const ah = 3 + rnd() * 6;
          solid.push(new THREE.BoxGeometry(0.25, ah, 0.25).translate(x, h + ah / 2, z));
          neon.push(this.neonBox(0.5, 0.5, 0.5, x, h + ah, z, colS, 0, 4));
        }
      }
    }

    // Skybridges between neighbouring towers.
    for (let j = 0; j < 4; j++) {
      for (let i = 0; i < 4; i++) {
        const a = slots[j * 4 + i];
        if (!a) continue;
        for (const [di, dj] of [[1, 0], [0, 1]] as const) {
          if (i + di > 3 || j + dj > 3) continue;
          const b = slots[(j + dj) * 4 + i + di];
          if (!b || rnd() > 0.45) continue;
          const y = Math.min(a.h, b.h) * (0.45 + rnd() * 0.3);
          const len = Math.hypot(b.x - a.x, b.z - a.z);
          const ang = Math.atan2(b.x - a.x, b.z - a.z);
          const mx = (a.x + b.x) / 2;
          const mz = (a.z + b.z) / 2;
          solid.push(new THREE.BoxGeometry(1.8, 0.35, len).rotateY(ang).translate(mx, y, mz));
          const side = new THREE.Vector3(Math.cos(ang), 0, -Math.sin(ang)).multiplyScalar(0.95);
          neon.push(this.neonBox(0.12, 0.12, len, mx + side.x, y + 0.25, mz + side.z, colS, ang, 3));
          neon.push(this.neonBox(0.12, 0.12, len, mx - side.x, y + 0.25, mz - side.z, colS, ang, 3));
        }
      }
    }

    // Ground neon strips ("traffic lines").
    const strips = 2 + Math.floor(rnd() * 3);
    for (let k = 0; k < strips; k++) {
      const alongX = rnd() < 0.5;
      const len = 14 + rnd() * 28;
      const px = ox + (rnd() - 0.5) * S * 0.9;
      const pz = oz + (rnd() - 0.5) * S * 0.9;
      neon.push(this.neonBox(alongX ? len : 0.28, 0.04, alongX ? 0.28 : len, px, 0.04, pz, pick(), 0, 2.2));
    }

    // Terminals.
    const terminals: Terminal[] = [];
    const mats: THREE.Material[] = [];
    const group = new THREE.Group();
    const forced = cx === 0 && cz === 0;
    if ((forced || rnd() < 0.4) && emptySlots.length) {
      const spot = forced ? { x: ox + 7, z: oz + 7 } : emptySlots[Math.floor(rnd() * emptySlots.length)];
      const t = this.makeTerminal(spot.x, spot.z, key, pal);
      terminals.push(t);
      group.add(t.group);
      mats.push(t.screenMat, t.beamMat);
      colliders.push({ minX: spot.x - 0.7, maxX: spot.x + 0.7, minZ: spot.z - 0.7, maxZ: spot.z + 0.7 });
    }

    // Floating islands with towers.
    const floatSolid: THREE.BufferGeometry[] = [];
    const floatNeon: THREE.BufferGeometry[] = [];
    const islands = rnd() < 0.6 ? 1 + (rnd() < 0.3 ? 1 : 0) : 0;
    for (let k = 0; k < islands; k++) {
      const r = 6 + rnd() * 7;
      const x = ox + (rnd() - 0.5) * S * 0.8;
      const z = oz + (rnd() - 0.5) * S * 0.8;
      const y = 32 + rnd() * 38;
      floatSolid.push(new THREE.CylinderGeometry(r, r * 0.3, 3.2, 10).translate(x, y, z));
      floatNeon.push(this.paint(new THREE.CylinderGeometry(r + 0.1, r + 0.1, 0.25, 24).translate(x, y + 1.62, z), colP, 2.6));
      const tw = 3 + rnd() * 3;
      const th = 5 + rnd() * 14;
      floatSolid.push(this.buildingGeo(tw, th, tw, x + (rnd() - 0.5) * r * 0.6, z + (rnd() - 0.5) * r * 0.6, y + 1.6));
      floatNeon.push(this.neonBox(0.5, 0.5, 0.5, x, y - 3.4, z, pick(), 0, 3));
    }

    const geos: THREE.BufferGeometry[] = [];
    const addMerged = (list: THREE.BufferGeometry[], material: THREE.Material, parent: THREE.Object3D, shadows: boolean, lines = false): void => {
      if (!list.length) return;
      const merged = mergeGeometries(list, false);
      list.forEach((g) => g.dispose());
      if (!merged) return;
      geos.push(merged);
      const obj = lines ? new THREE.LineSegments(merged, material as THREE.LineBasicMaterial) : new THREE.Mesh(merged, material);
      if (shadows) { obj.castShadow = true; obj.receiveShadow = true; }
      parent.add(obj);
    };

    const floatGroup = new THREE.Group();
    addMerged(solid, this.buildingMat, group, true);
    addMerged(edges, this.edgeMat, group, false, true);
    addMerged(neon, this.neonMat, group, false);
    addMerged(floatSolid, this.buildingMat, floatGroup, false);
    addMerged(floatNeon, this.neonMat, floatGroup, false);
    group.add(floatGroup);
    this.root.add(group);

    return { key, cx, cz, group, floatGroup, floatPhase: rnd() * 10, colliders, terminals, geos, mats };
  }

  private makeTerminal(x: number, z: number, chunkKey: string, pal: Palette): Terminal {
    const key = `${chunkKey}:T`;
    const hacked = this.hacked.has(key);
    const group = new THREE.Group();
    group.position.set(x, 0, z);
    const base = new THREE.Mesh(
      new THREE.BoxGeometry(1.3, 1.1, 1.3),
      new THREE.MeshStandardMaterial({ color: 0x10131f, roughness: 0.4, metalness: 0.8 }),
    );
    base.position.y = 0.55;
    base.castShadow = true;
    const screenMat = new THREE.MeshBasicMaterial({ color: new THREE.Color(0.1, 1.8, 2.0) });
    const screen = new THREE.Mesh(new THREE.BoxGeometry(1.1, 0.8, 0.12), screenMat);
    screen.position.set(0, 1.5, 0);
    screen.rotation.x = -0.35;
    const ring = new THREE.Mesh(new THREE.TorusGeometry(1.1, 0.04, 8, 32), new THREE.MeshBasicMaterial({ color: new THREE.Color(pal.accent).multiplyScalar(2.4) }));
    ring.rotation.x = Math.PI / 2;
    ring.position.y = 2.4;
    const beamMat = new THREE.MeshBasicMaterial({ color: new THREE.Color(pal.primary), transparent: true, opacity: 0.16, blending: THREE.AdditiveBlending, depthWrite: false, side: THREE.DoubleSide });
    const beam = new THREE.Mesh(new THREE.CylinderGeometry(0.5, 0.9, 40, 12, 1, true), beamMat);
    beam.position.y = 20;
    group.add(base, screen, ring, beam);
    const t: Terminal = { key, pos: new THREE.Vector3(x, 1, z), hacked, group, screenMat, beamMat, ring };
    if (hacked) this.applyHackedLook(t);
    return t;
  }

  private applyHackedLook(t: Terminal): void {
    t.screenMat.color.setRGB(0.1, 0.35, 0.12);
    t.beamMat.opacity = 0.03;
    (t.ring.material as THREE.MeshBasicMaterial).color.setRGB(0.15, 0.3, 0.15);
  }

  markHacked(t: Terminal): void {
    t.hacked = true;
    this.hacked.add(t.key);
    this.applyHackedLook(t);
  }

  nearestTerminal(p: THREE.Vector3, radius: number): Terminal | null {
    let best: Terminal | null = null;
    let bd = radius * radius;
    for (const c of this.chunks.values()) {
      for (const t of c.terminals) {
        if (t.hacked) continue;
        const dx = t.pos.x - p.x;
        const dz = t.pos.z - p.z;
        const d = dx * dx + dz * dz;
        if (d < bd) { bd = d; best = t; }
      }
    }
    return best;
  }

  private disposeChunk(c: Chunk): void {
    this.root.remove(c.group);
    c.geos.forEach((g) => g.dispose());
    c.mats.forEach((m) => m.dispose());
    for (const t of c.terminals) {
      t.group.traverse((o) => {
        if (o instanceof THREE.Mesh) {
          o.geometry.dispose();
          const m = o.material as THREE.Material;
          m.dispose();
        }
      });
    }
  }

  // ───────────────────────────── collision ─────────────────────────────

  private forNearColliders(x: number, z: number, fn: (b: AABB) => void): void {
    const S = CFG.chunkSize;
    const cx = Math.round(x / S);
    const cz = Math.round(z / S);
    for (let dz = -1; dz <= 1; dz++) {
      for (let dx = -1; dx <= 1; dx++) {
        const c = this.chunks.get(`${cx + dx},${cz + dz}`);
        if (c) for (const b of c.colliders) fn(b);
      }
    }
  }

  isBlocked(x: number, z: number, r: number): boolean {
    let hit = false;
    this.forNearColliders(x, z, (b) => {
      if (hit) return;
      const px = Math.max(b.minX, Math.min(x, b.maxX));
      const pz = Math.max(b.minZ, Math.min(z, b.maxZ));
      const dx = x - px;
      const dz = z - pz;
      if (dx * dx + dz * dz < r * r) hit = true;
    });
    return hit;
  }

  /** Pushes a circle (xz plane) out of every building. Returns true if a correction happened. */
  resolve(pos: THREE.Vector3, r: number): boolean {
    let hit = false;
    this.forNearColliders(pos.x, pos.z, (b) => {
      const px = Math.max(b.minX, Math.min(pos.x, b.maxX));
      const pz = Math.max(b.minZ, Math.min(pos.z, b.maxZ));
      const dx = pos.x - px;
      const dz = pos.z - pz;
      const d2 = dx * dx + dz * dz;
      if (d2 >= r * r) return;
      hit = true;
      if (d2 > 1e-8) {
        const d = Math.sqrt(d2);
        pos.x += (dx / d) * (r - d);
        pos.z += (dz / d) * (r - d);
      } else {
        const left = pos.x - b.minX;
        const right = b.maxX - pos.x;
        const top = pos.z - b.minZ;
        const bottom = b.maxZ - pos.z;
        const m = Math.min(left, right, top, bottom);
        if (m === left) pos.x = b.minX - r;
        else if (m === right) pos.x = b.maxX + r;
        else if (m === top) pos.z = b.minZ - r;
        else pos.z = b.maxZ + r;
      }
    });
    return hit;
  }

  // ───────────────────────────── exit portal ─────────────────────────────

  spawnPortal(pos: THREE.Vector3): void {
    this.removePortal();
    const col = new THREE.Color(this.palette.secondary);
    const group = new THREE.Group();
    group.position.set(pos.x, 0, pos.z);
    const ringMat = new THREE.MeshBasicMaterial({ color: col.clone().multiplyScalar(3) });
    const ringMat2 = new THREE.MeshBasicMaterial({ color: new THREE.Color(this.palette.primary).multiplyScalar(3) });
    const ringA = new THREE.Mesh(new THREE.TorusGeometry(2.6, 0.12, 10, 48), ringMat);
    const ringB = new THREE.Mesh(new THREE.TorusGeometry(2.0, 0.08, 10, 48), ringMat2);
    ringA.position.y = ringB.position.y = 3;
    const discMat = new THREE.MeshBasicMaterial({ color: col, transparent: true, opacity: 0.28, blending: THREE.AdditiveBlending, side: THREE.DoubleSide, depthWrite: false });
    const disc = new THREE.Mesh(new THREE.CircleGeometry(2.5, 32), discMat);
    disc.position.y = 3;
    const beamMat = new THREE.MeshBasicMaterial({ color: col, transparent: true, opacity: 0.2, blending: THREE.AdditiveBlending, side: THREE.DoubleSide, depthWrite: false });
    const beam = new THREE.Mesh(new THREE.CylinderGeometry(1.4, 1.4, 90, 16, 1, true), beamMat);
    beam.position.y = 45;
    group.add(ringA, ringB, disc, beam);
    this.root.add(group);
    this.portal = { group, pos: new THREE.Vector3(pos.x, 0, pos.z), ringA, ringB, mats: [ringMat, ringMat2, discMat, beamMat] };
  }

  removePortal(): void {
    if (!this.portal) return;
    this.root.remove(this.portal.group);
    this.portal.group.traverse((o) => {
      if (o instanceof THREE.Mesh) o.geometry.dispose();
    });
    this.portal.mats.forEach((m) => m.dispose());
    this.portal = null;
  }

  private updatePortal(dt: number, time: number): void {
    const p = this.portal;
    if (!p) return;
    p.ringA.rotation.z += dt * 1.8;
    p.ringB.rotation.z -= dt * 2.6;
    p.ringA.rotation.x = Math.sin(time * 1.2) * 0.25;
    p.ringB.rotation.y = Math.cos(time * 1.4) * 0.25;
    p.group.scale.setScalar(1 + Math.sin(time * 3) * 0.02);
  }
}
