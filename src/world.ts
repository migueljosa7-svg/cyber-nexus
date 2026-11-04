import * as THREE from 'three';
import { CFG, IS_TOUCH, PALETTES, type Palette } from './config';
import type { GfxRenderer } from './engine/renderer';

interface AABB { minX: number; maxX: number; minZ: number; maxZ: number }
interface BoxInst { x: number; y: number; z: number; sx: number; sy: number; sz: number; seed: number }
interface NeonInst { x: number; y: number; z: number; sx: number; sy: number; sz: number; ry: number; r: number; g: number; b: number }
interface PlatInst { x: number; y: number; z: number; r: number; h: number }

export interface Terminal {
  key: string;
  pos: THREE.Vector3;
  hacked: boolean;
  group: THREE.Group;
  screen: THREE.Mesh;
  ring: THREE.Mesh;
  beam: THREE.Mesh;
}

interface Chunk {
  cx: number;
  cz: number;
  key: number;
  buildings: BoxInst[];
  neon: NeonInst[];
  plats: PlatInst[];
  colliders: AABB[];
  terminals: Terminal[];
}

export interface Portal {
  group: THREE.Group;
  pos: THREE.Vector3;
  ringA: THREE.Mesh;
  ringB: THREE.Mesh;
  mats: THREE.Material[];
}

const TILE = 4;
const MAX_BUILDINGS = 1100;
const MAX_NEON = 2200;
const MAX_PLATS = 80;
const RAIN_AREA = 70;
const RAIN_HEIGHT = 42;

const keyOf = (cx: number, cz: number): number => (cx + 2048) * 4096 + (cz + 2048);

function mulberry32(a: number): () => number {
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// ───────────────────────────── GLSL ─────────────────────────────

const BUILDING_VERT_DECL = /* glsl */ `
  attribute float aSeed;
  varying vec3 vLocal;
  varying vec3 vNrm;
  varying float vSeed;
  varying vec3 vScale;
`;

const BUILDING_VERT_MAIN = /* glsl */ `
  vec3 sc = vec3(length(instanceMatrix[0].xyz), length(instanceMatrix[1].xyz), length(instanceMatrix[2].xyz));
  vLocal = position * sc;
  vNrm = normal;
  vSeed = aSeed;
  vScale = sc;
`;

const BUILDING_FRAG_DECL = /* glsl */ `
  uniform float uTime;
  uniform vec3 uC1;
  uniform vec3 uC2;
  uniform vec3 uC3;
  varying vec3 vLocal;
  varying vec3 vNrm;
  varying float vSeed;
  varying vec3 vScale;
  float hash11(float p) { p = fract(p * 0.1031); p *= p + 33.33; p *= p + p; return fract(p); }
  float hash21(vec2 p) { vec3 p3 = fract(vec3(p.xyx) * 0.1031); p3 += dot(p3, p3.yzx + 33.33); return fract((p3.x + p3.y) * p3.z); }
  vec3 pickColor(float t) {
    if (t > 0.93) return vec3(1.0, 0.82, 0.55);
    if (t < 0.42) return uC1;
    if (t < 0.78) return uC2;
    return uC3;
  }
`;

// Computes procedural windows + neon trim per instance; no textures, no extra geometry.
const BUILDING_FRAG_PATTERN = /* glsl */ `
  float seedH = hash11(vSeed);
  vec3 aN = abs(vNrm);
  vec3 nEmis = vec3(0.0);
  float winMask = 0.0;
  if (aN.y < 0.5) {
    float uw = aN.x > 0.5 ? vScale.z : vScale.x;
    float u = (aN.x > 0.5 ? vLocal.z : vLocal.x) + uw * 0.5;
    float v = vLocal.y + vScale.y * 0.5;
    vec2 wsz = vec2(1.15, 0.9);
    vec2 cell = floor(vec2(u, v) / wsz);
    vec2 f = fract(vec2(u, v) / wsz);
    float w = smoothstep(0.12, 0.2, f.x) * (1.0 - smoothstep(0.8, 0.88, f.x)) * smoothstep(0.16, 0.26, f.y) * (1.0 - smoothstep(0.72, 0.82, f.y));
    float rr = hash21(cell + vSeed * 17.0);
    float lit = step(0.52, rr) * step(2.4, v);
    float flick = 1.0 - 0.8 * step(0.93, hash21(cell + 3.0)) * step(0.0, sin(uTime * 7.0 + rr * 40.0));
    vec3 wc = pickColor(hash21(cell * 1.7 + vSeed));
    nEmis += wc * w * lit * flick * (0.7 + rr * 0.9);
    winMask = w * (0.35 + 0.65 * lit);
    float eU = min(u, uw - u);
    float vertEdge = 1.0 - smoothstep(0.0, 0.09, eU);
    float topEdge = 1.0 - smoothstep(0.0, 0.2, vScale.y - v);
    float bf = fract((v + seedH * 14.0) / 14.0);
    float band = step(0.45, hash11(vSeed * 3.1)) * smoothstep(0.0, 0.01, bf) * (1.0 - smoothstep(0.012, 0.024, bf));
    vec3 ec = pickColor(seedH * 0.92);
    nEmis += ec * (vertEdge * 0.9 + topEdge * 1.4 + band * 1.0) * 1.9;
  } else if (vNrm.y > 0.5) {
    float eX = 0.5 * vScale.x - abs(vLocal.x);
    float eZ = 0.5 * vScale.z - abs(vLocal.z);
    float e = 1.0 - smoothstep(0.0, 0.34, min(eX, eZ));
    nEmis += pickColor(seedH * 0.92) * e * 2.2;
  }
  roughnessFactor = mix(roughnessFactor, 0.1, winMask);
`;

const RAIN_VERT = /* glsl */ `
  attribute vec4 aRnd;
  attribute float aTail;
  uniform vec3 uCenter;
  uniform float uTime;
  uniform float uArea;
  uniform float uH;
  varying float vFade;
  varying float vAccent;
  void main() {
    vec2 base = aRnd.xy * uArea * 2.0;
    vec2 p = mod(base - uCenter.xz + uArea, uArea * 2.0) - uArea;
    float speed = 14.0 + aRnd.z * 22.0;
    float phase = fract(aRnd.x * 91.7 + aRnd.y * 57.3) * uH;
    float len = 1.2 + fract(aRnd.z * 13.1) * 3.4;
    float y = mod(phase - uTime * speed, uH);
    vec3 wp = vec3(uCenter.x + p.x, y + (1.0 - aTail) * len, uCenter.z + p.y);
    vFade = (1.0 - aTail) * (1.0 - smoothstep(uArea * 0.55, uArea, length(p)));
    vAccent = step(0.86, aRnd.z);
    gl_Position = projectionMatrix * viewMatrix * vec4(wp, 1.0);
  }
`;

const RAIN_FRAG = /* glsl */ `
  uniform vec3 uC1;
  uniform vec3 uC2;
  varying float vFade;
  varying float vAccent;
  void main() { gl_FragColor = vec4(mix(uC1, uC2, vAccent) * vFade * 1.4, 1.0); }
`;

/** Procedural cyberpunk city. Everything repeated is instanced; chunk streaming only rewrites instance buffers. */
export class World {
  private chunks = new Map<number, Chunk>();
  private queue: Array<{ cx: number; cz: number }> = [];
  private lastCx = Infinity;
  private lastCz = Infinity;
  private seed = 1;
  private dirty = true;
  palette: Palette = PALETTES[0];
  private hacked = new Set<string>();
  portal: Portal | null = null;

  private root = new THREE.Group();
  private floor: THREE.Mesh;
  private floorMat: THREE.MeshStandardMaterial;

  private buildingMesh: THREE.InstancedMesh;
  private seedAttr: THREE.InstancedBufferAttribute;
  private neonMesh: THREE.InstancedMesh;
  private platMesh: THREE.InstancedMesh;
  private uTime = { value: 0 };
  private uC = [new THREE.Color(), new THREE.Color(), new THREE.Color()];

  private rainMat: THREE.ShaderMaterial;
  private rainCenter = new THREE.Vector3();

  // shared terminal resources
  private tBaseGeo = new THREE.BoxGeometry(1.3, 1.1, 1.3);
  private tBaseMat = new THREE.MeshStandardMaterial({ color: 0x10131f, roughness: 0.3, metalness: 0.9 });
  private tScreenGeo = new THREE.BoxGeometry(1.1, 0.8, 0.12);
  private tRingGeo = new THREE.TorusGeometry(1.1, 0.04, 6, 28);
  private tBeamGeo = new THREE.CylinderGeometry(0.5, 0.9, 40, 10, 1, true);
  private tScreenMat = new THREE.MeshBasicMaterial({ color: new THREE.Color(0.1, 1.8, 2.0) });
  private tScreenDone = new THREE.MeshBasicMaterial({ color: new THREE.Color(0.1, 0.35, 0.12) });
  private tRingMat = new THREE.MeshBasicMaterial({ color: 0xffffff });
  private tRingDone = new THREE.MeshBasicMaterial({ color: new THREE.Color(0.15, 0.3, 0.15) });
  private tBeamMat = new THREE.MeshBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0.14, blending: THREE.AdditiveBlending, depthWrite: false, side: THREE.DoubleSide, fog: false });

  private tmpM = new THREE.Matrix4();
  private tmpP = new THREE.Vector3();
  private tmpS = new THREE.Vector3();
  private tmpQ = new THREE.Quaternion();
  private tmpC = new THREE.Color();
  private yAxis = new THREE.Vector3(0, 1, 0);

  constructor(scene: THREE.Scene, gfx: GfxRenderer) {
    scene.add(this.root);
    const aniso = Math.min(8, gfx.renderer.capabilities.getMaxAnisotropy());

    // Floor: emissive neon grid + procedural roughness (wet asphalt) + environment reflections.
    const gridTex = this.makeGridTexture(aniso);
    const roughTex = this.makeRoughnessTexture(aniso);
    this.floorMat = new THREE.MeshStandardMaterial({
      color: 0x0a0c16,
      roughness: 1,
      roughnessMap: roughTex,
      metalness: 0.75,
      emissive: 0x00f0ff,
      emissiveMap: gridTex,
      emissiveIntensity: 0.45,
      envMapIntensity: 0.6,
    });
    this.floor = new THREE.Mesh(new THREE.PlaneGeometry(600, 600), this.floorMat);
    this.floor.rotation.x = -Math.PI / 2;
    this.floor.receiveShadow = !IS_TOUCH;
    this.root.add(this.floor);

    // Buildings: one InstancedMesh, windows/neon trim computed in the shader.
    const bMat = new THREE.MeshStandardMaterial({ color: 0x090b16, roughness: 0.55, metalness: 0.7, envMapIntensity: 0.7 });
    bMat.onBeforeCompile = (shader) => {
      shader.uniforms.uTime = this.uTime;
      shader.uniforms.uC1 = { value: this.uC[0] };
      shader.uniforms.uC2 = { value: this.uC[1] };
      shader.uniforms.uC3 = { value: this.uC[2] };
      shader.vertexShader = shader.vertexShader
        .replace('#include <common>', `#include <common>\n${BUILDING_VERT_DECL}`)
        .replace('#include <begin_vertex>', `#include <begin_vertex>\n${BUILDING_VERT_MAIN}`);
      shader.fragmentShader = shader.fragmentShader
        .replace('#include <common>', `#include <common>\n${BUILDING_FRAG_DECL}`)
        .replace('#include <roughnessmap_fragment>', `#include <roughnessmap_fragment>\n${BUILDING_FRAG_PATTERN}`)
        .replace('#include <emissivemap_fragment>', '#include <emissivemap_fragment>\n totalEmissiveRadiance += nEmis;');
    };
    const unit = new THREE.BoxGeometry(1, 1, 1);
    this.seedAttr = new THREE.InstancedBufferAttribute(new Float32Array(MAX_BUILDINGS), 1);
    this.seedAttr.setUsage(THREE.DynamicDrawUsage);
    unit.setAttribute('aSeed', this.seedAttr);
    this.buildingMesh = new THREE.InstancedMesh(unit, bMat, MAX_BUILDINGS);
    this.buildingMesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    this.buildingMesh.frustumCulled = false;
    this.buildingMesh.count = 0;

    // Neon trims, bridges, lamps, ground strips: unlit HDR boxes (feed the bloom).
    this.neonMesh = new THREE.InstancedMesh(new THREE.BoxGeometry(1, 1, 1), new THREE.MeshBasicMaterial({ color: 0xffffff }), MAX_NEON);
    this.neonMesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    this.neonMesh.setColorAt(0, this.tmpC.setRGB(1, 1, 1));
    this.neonMesh.instanceColor!.setUsage(THREE.DynamicDrawUsage);
    this.neonMesh.frustumCulled = false;
    this.neonMesh.count = 0;

    // Floating island platforms.
    const platGeo = new THREE.CylinderGeometry(1, 0.32, 1, 12);
    this.platMesh = new THREE.InstancedMesh(platGeo, new THREE.MeshStandardMaterial({ color: 0x0b0d18, roughness: 0.4, metalness: 0.85, envMapIntensity: 1.2 }), MAX_PLATS);
    this.platMesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    this.platMesh.frustumCulled = false;
    this.platMesh.count = 0;
    this.root.add(this.buildingMesh, this.neonMesh, this.platMesh);

    // Digital rain: fully GPU animated line segments (zero per-frame CPU work).
    const n = CFG.rainCount;
    const pos = new Float32Array(n * 6);
    const rnd = new Float32Array(n * 8);
    const tail = new Float32Array(n * 2);
    for (let i = 0; i < n; i++) {
      const a = Math.random(), b = Math.random(), c = Math.random(), d = Math.random();
      for (let k = 0; k < 2; k++) {
        rnd.set([a, b, c, d], (i * 2 + k) * 4);
        tail[i * 2 + k] = k;
      }
    }
    const rg = new THREE.BufferGeometry();
    rg.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    rg.setAttribute('aRnd', new THREE.BufferAttribute(rnd, 4));
    rg.setAttribute('aTail', new THREE.BufferAttribute(tail, 1));
    this.rainMat = new THREE.ShaderMaterial({
      vertexShader: RAIN_VERT,
      fragmentShader: RAIN_FRAG,
      uniforms: {
        uCenter: { value: this.rainCenter },
        uTime: this.uTime,
        uArea: { value: RAIN_AREA },
        uH: { value: RAIN_HEIGHT },
        uC1: { value: this.uC[0] },
        uC2: { value: this.uC[2] },
      },
      transparent: true,
      blending: THREE.AdditiveBlending,
      depthWrite: false,
    });
    const rain = new THREE.LineSegments(rg, this.rainMat);
    rain.frustumCulled = false;
    rain.renderOrder = 5;
    scene.add(rain);

    this.applyPalette(this.palette);
  }

  // ───────────────────────────── procedural textures ─────────────────────────────

  private makeGridTexture(aniso: number): THREE.CanvasTexture {
    const c = document.createElement('canvas');
    c.width = c.height = 256;
    const g = c.getContext('2d')!;
    g.fillStyle = '#000';
    g.fillRect(0, 0, 256, 256);
    g.strokeStyle = '#fff';
    g.lineWidth = 4;
    g.strokeRect(0, 0, 256, 256);
    g.globalAlpha = 0.18;
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

  private makeRoughnessTexture(aniso: number): THREE.CanvasTexture {
    const S = 256;
    const c = document.createElement('canvas');
    c.width = c.height = S;
    const g = c.getContext('2d')!;
    g.fillStyle = '#8a8a8a';
    g.fillRect(0, 0, S, S);
    const rnd = mulberry32(4242);
    for (let i = 0; i < 70; i++) {
      const x = rnd() * S, y = rnd() * S, r = 10 + rnd() * 38;
      const grad = g.createRadialGradient(x, y, 0, x, y, r);
      const dark = rnd() < 0.65;
      grad.addColorStop(0, dark ? 'rgba(20,20,20,0.95)' : 'rgba(210,210,210,0.7)');
      grad.addColorStop(1, 'rgba(128,128,128,0)');
      g.fillStyle = grad;
      for (const ox of [-S, 0, S]) for (const oy of [-S, 0, S]) {
        g.beginPath();
        g.arc(x + ox, y + oy, r, 0, Math.PI * 2);
        g.fill();
      }
    }
    const img = g.getImageData(0, 0, S, S);
    for (let i = 0; i < img.data.length; i += 4) {
      const n = (Math.random() - 0.5) * 22;
      img.data[i] += n; img.data[i + 1] += n; img.data[i + 2] += n;
    }
    g.putImageData(img, 0, 0);
    const t = new THREE.CanvasTexture(c);
    t.wrapS = t.wrapT = THREE.RepeatWrapping;
    t.repeat.set(600 / 20, 600 / 20);
    t.anisotropy = aniso;
    return t;
  }

  private applyPalette(p: Palette): void {
    this.palette = p;
    this.uC[0].set(p.primary);
    this.uC[1].set(p.secondary);
    this.uC[2].set(p.accent);
    this.floorMat.emissive.set(p.primary);
    this.tRingMat.color.set(p.accent).multiplyScalar(2.6);
    this.tBeamMat.color.set(p.primary);
  }

  // ───────────────────────────── lifecycle ─────────────────────────────

  /** Rebuilds the whole city for a new level and generates the area around `center` synchronously. */
  reset(seed: number, palette: Palette, center: THREE.Vector3): void {
    this.removePortal();
    for (const c of this.chunks.values()) this.unloadChunk(c);
    this.chunks.clear();
    this.queue = [];
    this.hacked.clear();
    this.seed = seed;
    this.applyPalette(palette);
    const R = CFG.viewRadius;
    const ccx = Math.round(center.x / CFG.chunkSize);
    const ccz = Math.round(center.z / CFG.chunkSize);
    for (let dz = -R; dz <= R; dz++) for (let dx = -R; dx <= R; dx++) this.ensureChunk(ccx + dx, ccz + dz);
    this.lastCx = ccx;
    this.lastCz = ccz;
    this.dirty = true;
    this.rebuildInstances();
  }

  update(dt: number, time: number, p: THREE.Vector3): void {
    const S = CFG.chunkSize;
    const cx = Math.round(p.x / S);
    const cz = Math.round(p.z / S);
    if (cx !== this.lastCx || cz !== this.lastCz) {
      this.lastCx = cx;
      this.lastCz = cz;
      const R = CFG.viewRadius;
      for (const [k, c] of this.chunks) {
        if (Math.abs(c.cx - cx) > R + 1 || Math.abs(c.cz - cz) > R + 1) {
          this.unloadChunk(c);
          this.chunks.delete(k);
        }
      }
      this.queue.length = 0;
      for (let dz = -R; dz <= R; dz++) for (let dx = -R; dx <= R; dx++) {
        if (!this.chunks.has(keyOf(cx + dx, cz + dz))) this.queue.push({ cx: cx + dx, cz: cz + dz });
      }
      this.queue.sort((a, b) => Math.hypot(a.cx - cx, a.cz - cz) - Math.hypot(b.cx - cx, b.cz - cz));
    }
    // Chunk generation is pure math now (no geometry), so a few per frame are free.
    for (let n = 0; n < 3 && this.queue.length; n++) {
      const q = this.queue.shift()!;
      this.ensureChunk(q.cx, q.cz);
    }
    if (this.dirty) this.rebuildInstances();

    this.uTime.value = time;
    this.rainCenter.copy(p);
    this.floor.position.set(Math.round(p.x / TILE) * TILE, 0, Math.round(p.z / TILE) * TILE);

    const pulse = 1.7 + Math.sin(time * 6) * 0.5;
    this.tScreenMat.color.setRGB(0.1, pulse, pulse + 0.2);
    for (const c of this.chunks.values()) {
      for (const t of c.terminals) {
        t.ring.rotation.y += dt * (t.hacked ? 0.4 : 2.2);
        t.ring.position.y = 2.4 + Math.sin(time * 2 + c.cx) * 0.12;
      }
    }
    this.updatePortal(dt, time);
  }

  // ───────────────────────────── instance buffers ─────────────────────────────

  private rebuildInstances(): void {
    this.dirty = false;
    const m = this.tmpM;
    const q = this.tmpQ;
    const pos = this.tmpP;
    const sc = this.tmpS;
    let nb = 0, nn = 0, np = 0;
    const seeds = this.seedAttr.array as Float32Array;
    q.identity();
    for (const c of this.chunks.values()) {
      for (const b of c.buildings) {
        if (nb >= MAX_BUILDINGS) break;
        m.compose(pos.set(b.x, b.y, b.z), q, sc.set(b.sx, b.sy, b.sz));
        this.buildingMesh.setMatrixAt(nb, m);
        seeds[nb++] = b.seed;
      }
      for (const n of c.neon) {
        if (nn >= MAX_NEON) break;
        q.setFromAxisAngle(this.yAxis, n.ry);
        m.compose(pos.set(n.x, n.y, n.z), q, sc.set(n.sx, n.sy, n.sz));
        this.neonMesh.setMatrixAt(nn, m);
        this.neonMesh.setColorAt(nn, this.tmpC.setRGB(n.r, n.g, n.b));
        nn++;
      }
      q.identity();
      for (const pl of c.plats) {
        if (np >= MAX_PLATS) break;
        m.compose(pos.set(pl.x, pl.y, pl.z), q, sc.set(pl.r, pl.h, pl.r));
        this.platMesh.setMatrixAt(np++, m);
      }
    }
    this.buildingMesh.count = nb;
    this.neonMesh.count = nn;
    this.platMesh.count = np;
    this.buildingMesh.instanceMatrix.needsUpdate = true;
    this.seedAttr.needsUpdate = true;
    this.neonMesh.instanceMatrix.needsUpdate = true;
    if (this.neonMesh.instanceColor) this.neonMesh.instanceColor.needsUpdate = true;
    this.platMesh.instanceMatrix.needsUpdate = true;
  }

  // ───────────────────────────── chunk generation ─────────────────────────────

  private ensureChunk(cx: number, cz: number): void {
    const key = keyOf(cx, cz);
    if (this.chunks.has(key)) return;
    this.chunks.set(key, this.buildChunk(cx, cz, key));
    this.dirty = true;
  }

  private unloadChunk(c: Chunk): void {
    for (const t of c.terminals) this.root.remove(t.group);
    this.dirty = true;
  }

  private buildChunk(cx: number, cz: number, key: number): Chunk {
    const S = CFG.chunkSize;
    const cell = S / 4;
    const rnd = mulberry32((this.seed * 73856093) ^ (cx * 19349663) ^ (cz * 83492791));
    const ox = cx * S;
    const oz = cz * S;
    const pal = this.palette;
    const cols = [new THREE.Color(pal.primary), new THREE.Color(pal.secondary), new THREE.Color(pal.accent)];
    const chunk: Chunk = { cx, cz, key, buildings: [], neon: [], plats: [], colliders: [], terminals: [] };
    const neon = (sx: number, sy: number, sz: number, x: number, y: number, z: number, c: THREE.Color, k: number, ry = 0): void => {
      chunk.neon.push({ x, y, z, sx, sy, sz, ry, r: c.r * k, g: c.g * k, b: c.b * k });
    };
    const pick = (): THREE.Color => cols[Math.floor(rnd() * 3)];

    const slots: Array<{ x: number; z: number; w: number; d: number; h: number } | null> = [];
    const empty: Array<{ x: number; z: number }> = [];

    for (let j = 0; j < 4; j++) {
      for (let i = 0; i < 4; i++) {
        const ccx = ox - S / 2 + cell * (i + 0.5);
        const ccz = oz - S / 2 + cell * (j + 0.5);
        const central = cx === 0 && cz === 0 && (i === 1 || i === 2) && (j === 1 || j === 2);
        if (central || rnd() > 0.55) {
          slots.push(null);
          empty.push({ x: ccx, z: ccz });
          continue;
        }
        const w = 5 + rnd() * 5;
        const d = 5 + rnd() * 5;
        const h = 10 + Math.pow(rnd(), 1.5) * 46;
        const x = ccx + (rnd() - 0.5) * 2 * Math.max(0, (cell - w) / 2 - 0.8);
        const z = ccz + (rnd() - 0.5) * 2 * Math.max(0, (cell - d) / 2 - 0.8);
        chunk.buildings.push({ x, y: h / 2, z, sx: w, sy: h, sz: d, seed: 1 + rnd() * 900 });
        chunk.colliders.push({ minX: x - w / 2, maxX: x + w / 2, minZ: z - d / 2, maxZ: z + d / 2 });
        slots.push({ x, z, w, d, h });
        if (rnd() < 0.7) {
          const ah = 3 + rnd() * 7;
          neon(0.22, ah, 0.22, x, h + ah / 2, z, new THREE.Color(0.03, 0.03, 0.05), 1);
          neon(0.6, 0.6, 0.6, x, h + ah, z, cols[1], 4.5);
        }
        // Tiered crown for the tallest towers.
        if (h > 34 && rnd() < 0.6) {
          chunk.buildings.push({ x, y: h + 3, z, sx: w * 0.55, sy: 6, sz: d * 0.55, seed: 1 + rnd() * 900 });
        }
      }
    }

    // Skybridges: dark deck + two glowing rails.
    for (let j = 0; j < 4; j++) {
      for (let i = 0; i < 4; i++) {
        const a = slots[j * 4 + i];
        if (!a) continue;
        for (const [di, dj] of [[1, 0], [0, 1]] as const) {
          if (i + di > 3 || j + dj > 3) continue;
          const b = slots[(j + dj) * 4 + i + di];
          if (!b || rnd() > 0.5) continue;
          const y = Math.min(a.h, b.h) * (0.45 + rnd() * 0.3);
          const len = Math.hypot(b.x - a.x, b.z - a.z);
          const ang = Math.atan2(b.x - a.x, b.z - a.z);
          const mx = (a.x + b.x) / 2;
          const mz = (a.z + b.z) / 2;
          const sx = Math.cos(ang) * 0.95;
          const sz = -Math.sin(ang) * 0.95;
          neon(1.9, 0.35, len, mx, y, mz, new THREE.Color(0.02, 0.02, 0.04), 1, ang);
          neon(0.12, 0.12, len, mx + sx, y + 0.25, mz + sz, cols[1], 3.4, ang);
          neon(0.12, 0.12, len, mx - sx, y + 0.25, mz - sz, cols[1], 3.4, ang);
        }
      }
    }

    // Ground traffic lines.
    const strips = 2 + Math.floor(rnd() * 3);
    for (let k = 0; k < strips; k++) {
      const alongX = rnd() < 0.5;
      const len = 14 + rnd() * 28;
      neon(alongX ? len : 0.28, 0.04, alongX ? 0.28 : len, ox + (rnd() - 0.5) * S * 0.9, 0.04, oz + (rnd() - 0.5) * S * 0.9, pick(), 2.4);
    }

    // Street lamps with light pools, placed in open plots.
    const lampCount = Math.min(empty.length, 2 + Math.floor(rnd() * 3));
    for (let k = 0; k < lampCount; k++) {
      const e = empty[Math.floor(rnd() * empty.length)];
      const lx = e.x + (rnd() - 0.5) * cell * 0.7;
      const lz = e.z + (rnd() - 0.5) * cell * 0.7;
      const c = pick();
      neon(0.18, 6.4, 0.18, lx, 3.2, lz, new THREE.Color(0.03, 0.03, 0.05), 1);
      neon(0.9, 0.2, 0.9, lx, 6.5, lz, c, 5);
      neon(4.2, 0.03, 4.2, lx, 0.03, lz, c, 0.55);
      chunk.colliders.push({ minX: lx - 0.25, maxX: lx + 0.25, minZ: lz - 0.25, maxZ: lz + 0.25 });
    }

    // Terminal.
    const forced = cx === 0 && cz === 0;
    if ((forced || rnd() < 0.4) && empty.length) {
      const spot = forced ? { x: ox + 7, z: oz + 7 } : empty[Math.floor(rnd() * empty.length)];
      const t = this.makeTerminal(spot.x, spot.z, `${cx},${cz}:T`);
      chunk.terminals.push(t);
      this.root.add(t.group);
      chunk.colliders.push({ minX: spot.x - 0.7, maxX: spot.x + 0.7, minZ: spot.z - 0.7, maxZ: spot.z + 0.7 });
    }

    // Floating islands.
    const islands = rnd() < 0.6 ? 1 + (rnd() < 0.3 ? 1 : 0) : 0;
    for (let k = 0; k < islands; k++) {
      const r = 6 + rnd() * 7;
      const x = ox + (rnd() - 0.5) * S * 0.8;
      const z = oz + (rnd() - 0.5) * S * 0.8;
      const y = 32 + rnd() * 38;
      chunk.plats.push({ x, y, z, r, h: 3.2 });
      const tw = 3 + rnd() * 3;
      const th = 5 + rnd() * 14;
      chunk.buildings.push({ x: x + (rnd() - 0.5) * r * 0.6, y: y + 1.6 + th / 2, z: z + (rnd() - 0.5) * r * 0.6, sx: tw, sy: th, sz: tw, seed: 1 + rnd() * 900 });
      for (let n = 0; n < 6; n++) {
        const a = (n / 6) * Math.PI * 2;
        neon(0.5, 0.35, 0.5, x + Math.cos(a) * (r - 0.4), y + 1.7, z + Math.sin(a) * (r - 0.4), cols[0], 4.5);
      }
      neon(0.8, 0.8, 0.8, x, y - 1.9, z, pick(), 4);
    }
    return chunk;
  }

  private makeTerminal(x: number, z: number, key: string): Terminal {
    const hacked = this.hacked.has(key);
    const group = new THREE.Group();
    group.position.set(x, 0, z);
    const base = new THREE.Mesh(this.tBaseGeo, this.tBaseMat);
    base.position.y = 0.55;
    const screen = new THREE.Mesh(this.tScreenGeo, hacked ? this.tScreenDone : this.tScreenMat);
    screen.position.y = 1.5;
    screen.rotation.x = -0.35;
    const ring = new THREE.Mesh(this.tRingGeo, hacked ? this.tRingDone : this.tRingMat);
    ring.rotation.x = Math.PI / 2;
    ring.position.y = 2.4;
    const beam = new THREE.Mesh(this.tBeamGeo, this.tBeamMat);
    beam.position.y = 20;
    beam.visible = !hacked;
    group.add(base, screen, ring, beam);
    return { key, pos: new THREE.Vector3(x, 1, z), hacked, group, screen, ring, beam };
  }

  markHacked(t: Terminal): void {
    t.hacked = true;
    this.hacked.add(t.key);
    t.screen.material = this.tScreenDone;
    t.ring.material = this.tRingDone;
    t.beam.visible = false;
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

  // ───────────────────────────── collision (AABB / circle, allocation-free) ─────────────────────────────

  isBlocked(x: number, z: number, r: number): boolean {
    const S = CFG.chunkSize;
    const cx = Math.round(x / S);
    const cz = Math.round(z / S);
    const r2 = r * r;
    for (let dz = -1; dz <= 1; dz++) {
      for (let dx = -1; dx <= 1; dx++) {
        const c = this.chunks.get(keyOf(cx + dx, cz + dz));
        if (!c) continue;
        const list = c.colliders;
        for (let i = 0; i < list.length; i++) {
          const b = list[i];
          const px = x < b.minX ? b.minX : x > b.maxX ? b.maxX : x;
          const pz = z < b.minZ ? b.minZ : z > b.maxZ ? b.maxZ : z;
          const ddx = x - px;
          const ddz = z - pz;
          if (ddx * ddx + ddz * ddz < r2) return true;
        }
      }
    }
    return false;
  }

  /** Pushes a circle (xz plane) out of every building. Returns true if a correction happened. */
  resolve(pos: THREE.Vector3, r: number): boolean {
    const S = CFG.chunkSize;
    const cx = Math.round(pos.x / S);
    const cz = Math.round(pos.z / S);
    let hit = false;
    for (let dz = -1; dz <= 1; dz++) {
      for (let dx = -1; dx <= 1; dx++) {
        const c = this.chunks.get(keyOf(cx + dx, cz + dz));
        if (!c) continue;
        const list = c.colliders;
        for (let i = 0; i < list.length; i++) {
          const b = list[i];
          const px = pos.x < b.minX ? b.minX : pos.x > b.maxX ? b.maxX : pos.x;
          const pz = pos.z < b.minZ ? b.minZ : pos.z > b.maxZ ? b.maxZ : pos.z;
          const ddx = pos.x - px;
          const ddz = pos.z - pz;
          const d2 = ddx * ddx + ddz * ddz;
          if (d2 >= r * r) continue;
          hit = true;
          if (d2 > 1e-8) {
            const d = Math.sqrt(d2);
            pos.x += (ddx / d) * (r - d);
            pos.z += (ddz / d) * (r - d);
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
        }
      }
    }
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
    const ringA = new THREE.Mesh(new THREE.TorusGeometry(2.6, 0.12, 8, 40), ringMat);
    const ringB = new THREE.Mesh(new THREE.TorusGeometry(2.0, 0.08, 8, 40), ringMat2);
    ringA.position.y = ringB.position.y = 3;
    const discMat = new THREE.MeshBasicMaterial({ color: col, transparent: true, opacity: 0.28, blending: THREE.AdditiveBlending, side: THREE.DoubleSide, depthWrite: false });
    const disc = new THREE.Mesh(new THREE.CircleGeometry(2.5, 28), discMat);
    disc.position.y = 3;
    const beamMat = new THREE.MeshBasicMaterial({ color: col, transparent: true, opacity: 0.2, blending: THREE.AdditiveBlending, side: THREE.DoubleSide, depthWrite: false, fog: false });
    const beam = new THREE.Mesh(new THREE.CylinderGeometry(1.4, 1.4, 90, 14, 1, true), beamMat);
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
