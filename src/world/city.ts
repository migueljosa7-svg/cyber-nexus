import * as THREE from 'three';
import { CFG, CITY, IS_TOUCH, PALETTE, type Palette } from '../config';
import type { GfxRenderer } from '../graphics/renderer';

export interface AABB { minX: number; maxX: number; minZ: number; maxZ: number }
interface BoxInst { x: number; y: number; z: number; sx: number; sy: number; sz: number; seed: number }
interface NeonInst { x: number; y: number; z: number; sx: number; sy: number; sz: number; ry: number; r: number; g: number; b: number }
interface BillInst { x: number; y: number; z: number; w: number; h: number; ry: number; seed: number }

export interface Terminal {
  id: string;
  pos: THREE.Vector3;
  hacked: boolean;
  group: THREE.Group;
  ring: THREE.Mesh;
  screen: THREE.Mesh;
  beam: THREE.Mesh;
}

interface Chunk {
  cx: number;
  cz: number;
  key: number;
  plaza: boolean;
  buildings: BoxInst[];
  neon: NeonInst[];
  lamps: NeonInst[];
  props: NeonInst[];
  bills: BillInst[];
  colliders: AABB[];
  terminals: Terminal[];
}

interface Lot { x: number; z: number; w: number; d: number; h: number; seed: number }

export interface District { id: number; name: string }

const S = CITY.S;
const MAX_BUILDINGS = 6500;
const MAX_NEON = 6000;
const MAX_PROPS = 3200;
const MAX_LAMPS = 1800;
const MAX_BILLS = 150;
const RAIN_AREA = 70;
const RAIN_HEIGHT = 42;
const DISTRICT_NAMES = ['DOWNTOWN', 'NEON ROW', 'CHROME HEIGHTS', 'THE SLUMS', 'DATA DOCKS', 'INDUSTRIAL', 'OLD TOWN', 'SKY GARDENS', 'BLACK MARKET'];
const DISTRICT_HEIGHT = [1.35, 1.0, 1.45, 0.55, 0.7, 0.8, 0.62, 1.1, 0.6];

const keyOf = (cx: number, cz: number): number => (cx + 4096) * 8192 + (cz + 4096);

function mulberry32(a: number): () => number {
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function hash(seed: number, a: number, b: number, c = 0, d = 0): number {
  let h = Math.imul(seed | 0, 0x9e3779b1) ^ Math.imul(a | 0, 0x85ebca6b) ^ Math.imul(b | 0, 0xc2b2ae35) ^ Math.imul(c | 0, 0x27d4eb2f) ^ Math.imul(d | 0, 0x165667b1);
  h = Math.imul(h ^ (h >>> 15), 0x2c1b3c6d);
  h = Math.imul(h ^ (h >>> 12), 0x297a2d39);
  return (h ^ (h >>> 15)) >>> 0;
}

// ───────────────────────────── GLSL ─────────────────────────────

const HASH_GLSL = /* glsl */ `
  float hash11(float p) { p = fract(p * 0.1031); p *= p + 33.33; p *= p + p; return fract(p); }
  float hash21(vec2 p) { vec3 p3 = fract(vec3(p.xyx) * 0.1031); p3 += dot(p3, p3.yzx + 33.33); return fract((p3.x + p3.y) * p3.z); }
`;

const PICK_GLSL = /* glsl */ `
  uniform vec3 uC1;
  uniform vec3 uC2;
  uniform vec3 uC3;
  vec3 pickColor(float t) {
    if (t > 0.93) return vec3(1.0, 0.82, 0.55);
    if (t < 0.42) return uC1;
    if (t < 0.78) return uC2;
    return uC3;
  }
`;

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
  varying vec3 vLocal;
  varying vec3 vNrm;
  varying float vSeed;
  varying vec3 vScale;
  ${HASH_GLSL}
  ${PICK_GLSL}
`;

// Urban facades: concrete panels and dark reflective glass with sparse warm/cool window points, lit shopfronts at
// street level and neon tubes / roof edges only on some towers. Computed per pixel from instance scale: no textures.
const BUILDING_FRAG_COLOR = /* glsl */ `
  float seedH = hash11(vSeed);
  float style = floor(hash11(vSeed * 2.7) * 3.0);
  vec3 aN = abs(vNrm);
  vec3 nEmis = vec3(0.0);
  float winMask = 0.0;
  vec3 baseCol = vec3(0.075, 0.08, 0.095);
  float ledOn = step(0.38, hash11(vSeed * 5.3));
  float edgeOn = step(0.7, hash11(vSeed * 8.1));
  vec3 ledCol = pickColor(seedH * 0.9);
  if (aN.y < 0.5) {
    float uw = aN.x > 0.5 ? vScale.z : vScale.x;
    float u = (aN.x > 0.5 ? vLocal.z : vLocal.x) + uw * 0.5;
    float v = vLocal.y + vScale.y * 0.5;
    float floorH = 3.6;
    float fidx = floor(v / floorH);
    float fy = fract(v / floorH);
    float eU = min(u, uw - u);
    // Concrete panels with per-floor tone and slab/panel seams.
    float pn = hash21(vec2(fidx, floor(u / 3.0)) + vSeed);
    baseCol *= 0.78 + 0.4 * pn;
    float seam = clamp(step(fy, 0.025) + step(fract(u / 3.0), 0.012), 0.0, 1.0);
    baseCol *= 1.0 - 0.45 * seam;
    float win = 0.0;
    if (style == 0.0) {
      // Continuous ribbon glazing, broken into runs of varying length.
      float seg = floor(u / (5.0 + 4.0 * hash11(vSeed * 3.3)));
      float run = step(0.14, hash21(vec2(seg, fidx) + vSeed));
      float band = smoothstep(0.16, 0.2, fy) * (1.0 - smoothstep(0.76, 0.8, fy));
      win = band * step(0.05, fract(u / 1.35)) * run;
    } else if (style == 1.0) {
      // Tall slot windows.
      vec2 f = fract(vec2(u / 2.2, v / floorH));
      vec2 d = abs(f - 0.5);
      win = (1.0 - smoothstep(0.16, 0.2, d.x)) * (1.0 - smoothstep(0.37, 0.41, d.y));
    } else {
      // Curtain wall with a fine grid and spandrel strips.
      vec2 g = fract(vec2(u / 1.5, v / 1.8));
      win = step(0.05, g.x) * step(0.05, g.y) * smoothstep(0.1, 0.14, fy) * (1.0 - smoothstep(0.86, 0.9, fy));
    }
    win *= step(2.4, v);
    float recess = 0.6 + 0.8 * smoothstep(0.15, 0.85, fy);
    baseCol = mix(baseCol, vec3(0.008, 0.013, 0.022) * recess, win);
    winMask = win;
    // Lit rooms: contiguous runs, mostly warm with some cool, a few palette accents.
    float room = hash21(vec2(floor(u / 2.7), fidx) * 1.7 + vSeed * 13.0);
    float lit = step(0.91, room) * step(5.0, v);
    float ct = hash21(vec2(floor(u / 2.7), fidx) + 9.1 + vSeed);
    vec3 lc = ct < 0.55 ? vec3(1.0, 0.72, 0.42) : (ct < 0.88 ? vec3(0.55, 0.78, 1.0) : pickColor(hash21(vec2(fidx, 3.3) + vSeed)));
    float flick = 1.0 - 0.85 * step(0.95, hash21(vec2(floor(u / 2.7), fidx) + 3.0)) * step(0.0, sin(uTime * (5.0 + room * 6.0) + room * 40.0));
    nEmis += lc * win * lit * flick * 0.95;
    // Continuous vertical LED strips, with a slow pulse travelling up the facade.
    float spacing = 4.5 + 5.0 * hash11(vSeed * 6.1);
    float su = abs(fract((u + seedH * 3.0) / spacing) - 0.5) * spacing;
    float strip = (1.0 - smoothstep(0.045, 0.1, su)) * ledOn * step(2.5, v);
    float pulse = 0.65 + 0.35 * sin(v * 0.33 - uTime * 1.8 + vSeed);
    nEmis += ledCol * strip * pulse * 1.8;
    baseCol = mix(baseCol, vec3(0.01), strip * 0.6);
    // Full-height corner light on a few towers.
    nEmis += ledCol * edgeOn * (1.0 - smoothstep(0.03, 0.07, eU)) * 2.1;
    // Street-level shopfront: dark glazing with fine mullions and a soft warm/cool interior glow; neon only as a thin header tube.
    float shop = step(0.45, seedH) * step(0.6, v) * (1.0 - step(3.4, v)) * step(0.35, eU);
    float mull = step(0.12, fract(u / 1.3));
    vec3 shopCol = seedH > 0.72 ? vec3(0.55, 0.78, 1.0) : vec3(1.0, 0.72, 0.42);
    baseCol = mix(baseCol, vec3(0.012, 0.016, 0.024), shop);
    nEmis += shopCol * shop * mull * (0.18 + 0.2 * hash21(vec2(floor(u / 1.3), vSeed)));
    nEmis += ledCol * step(0.45, seedH) * (1.0 - smoothstep(0.03, 0.07, abs(v - 3.55))) * step(0.35, eU) * 1.8;
    // Horizontal sign tube on some towers and a lit parapet.
    float hb = step(0.84, hash11(vSeed * 7.7));
    float hv = vScale.y * (0.35 + 0.4 * hash11(vSeed * 1.9));
    nEmis += pickColor(hash11(vSeed * 4.4) * 0.9) * hb * (1.0 - smoothstep(0.05, 0.12, abs(v - hv))) * step(0.5, eU) * 2.2;
    float rb = step(0.6, hash11(vSeed * 3.9));
    nEmis += ledCol * rb * (1.0 - smoothstep(0.0, 0.12, vScale.y - v)) * 1.5;
  } else if (vNrm.y > 0.5) {
    baseCol = vec3(0.035);
    float eX = 0.5 * vScale.x - abs(vLocal.x);
    float eZ = 0.5 * vScale.z - abs(vLocal.z);
    float rb = step(0.6, hash11(vSeed * 3.9));
    nEmis += ledCol * rb * (1.0 - smoothstep(0.0, 0.18, min(eX, eZ))) * 1.7;
    float rl = step(0.985, hash21(floor(vec2(vLocal.x, vLocal.z) * 0.6) + vSeed));
    nEmis += vec3(1.0, 0.15, 0.12) * rl * 1.6 * step(sin(uTime * 3.0 + vSeed), 0.0);
  }
  diffuseColor.rgb = baseCol;
`;

const BUILDING_FRAG_ROUGH = /* glsl */ `
  roughnessFactor = mix(0.82, 0.06, winMask);
`;

const BUILDING_FRAG_METAL = /* glsl */ `
  metalnessFactor = mix(0.04, 0.92, winMask);
`;

// Streets are drawn analytically from world position: asphalt, sidewalks, lane paint, crosswalks, neon curbs.
const FLOOR_VERT_DECL = /* glsl */ `varying vec2 vWXZ;`;
const FLOOR_VERT_MAIN = /* glsl */ `vWXZ = (modelMatrix * vec4(position, 1.0)).xz;`;
const FLOOR_FRAG_DECL = /* glsl */ `
  uniform float uS;
  varying vec2 vWXZ;
  ${PICK_GLSL}
`;
const FLOOR_FRAG_COLOR = /* glsl */ `
  float mxx = mod(vWXZ.x, uS);
  float mzz = mod(vWXZ.y, uS);
  float dx = min(mxx, uS - mxx);
  float dz = min(mzz, uS - mzz);
  float inCarr = min(step(dx, 4.0) + step(dz, 4.0), 1.0);
  float inWalk = max(step(dx, 7.0), step(dz, 7.0)) * (1.0 - inCarr);
  float inLot = 1.0 - max(inCarr, inWalk);
  diffuseColor.rgb = inCarr * vec3(0.012, 0.013, 0.02) + inWalk * vec3(0.062, 0.064, 0.072) + inLot * vec3(0.03, 0.032, 0.038);
`;
const FLOOR_FRAG_METAL = /* glsl */ `
  metalnessFactor *= mix(1.0, 0.12, inWalk + inLot);
`;
const FLOOR_FRAG_ROUGH = /* glsl */ `
  roughnessFactor = mix(roughnessFactor, max(roughnessFactor, 0.82), inWalk + inLot * 0.8);
  roughnessFactor *= mix(1.0, 0.75, inCarr);
`;
const FLOOR_FRAG_EMIT = /* glsl */ `
  vec3 fe = vec3(0.0);
  float xr = step(dz, 4.0) * step(7.0, dx);
  float zr = step(dx, 4.0) * step(7.0, dz);
  float dd = xr * dz + zr * dx;
  float along = xr * vWXZ.x + zr * vWXZ.y;
  float cl = (xr + zr) * step(0.14, dd) * step(dd, 0.3);
  float el = (xr + zr) * step(3.62, dd) * step(dd, 3.82) * step(0.5, fract(along / 5.0));
  float zebraX = step(4.6, dx) * step(dx, 6.6) * step(dz, 3.7) * step(0.5, fract(vWXZ.y * 0.8));
  float zebraZ = step(4.6, dz) * step(dz, 6.6) * step(dx, 3.7) * step(0.5, fract(vWXZ.x * 0.8));
  fe += vec3(1.0, 0.72, 0.08) * cl * 0.9;
  fe += vec3(0.8, 0.85, 1.0) * (el * 0.55 + (zebraX + zebraZ) * 0.5);
  float curb = (step(abs(dx - 4.0), 0.07) * step(7.0, dz) + step(abs(dz - 4.0), 0.07) * step(7.0, dx));
  fe += uC1 * curb * 1.6;
  vec2 g2 = abs(fract(vWXZ / 2.0) - 0.5);
  fe += vec3(0.5, 0.55, 0.65) * inWalk * step(0.485, max(g2.x, g2.y)) * 0.025;
  vec2 g4 = abs(fract(vWXZ / 4.0) - 0.5);
  fe += vec3(0.4, 0.45, 0.55) * inLot * step(0.49, max(g4.x, g4.y)) * 0.015;
  totalEmissiveRadiance += fe;
`;

const LAMP_VERT_PATCH = /* glsl */ `
  float lampSeed = fract(sin(dot(instanceMatrix[3].xz, vec2(12.9898, 78.233))) * 43758.5453);
  float lampFlick = 1.0 - 0.9 * step(0.93, fract(sin(floor(uTime * (6.0 + lampSeed * 6.0)) * 91.7 + lampSeed * 400.0) * 43758.5453)) * step(0.7, lampSeed);
  vColor *= lampFlick;
`;

const BILL_VERT = /* glsl */ `
  attribute float aSeed;
  uniform float uFogD;
  varying vec2 vUv;
  varying float vSeed;
  varying float vFog;
  void main() {
    vUv = uv;
    vSeed = aSeed;
    vec4 mv = modelViewMatrix * instanceMatrix * vec4(position, 1.0);
    vFog = 1.0 - exp(-pow(uFogD * length(mv.xyz), 2.0));
    gl_Position = projectionMatrix * mv;
  }
`;

const BILL_FRAG = /* glsl */ `
  uniform float uTime;
  varying vec2 vUv;
  varying float vSeed;
  varying float vFog;
  ${HASH_GLSL}
  ${PICK_GLSL}
  void main() {
    vec2 uv = vUv;
    float typ = floor(hash11(vSeed) * 3.0);
    float t = uTime;
    float row = floor(uv.y * 28.0);
    float glitch = step(0.985, hash21(vec2(row, floor(t * 6.0) + vSeed)));
    uv.x += glitch * 0.08 * (hash21(vec2(row, vSeed)) - 0.5);
    vec3 col = vec3(0.0);
    vec2 e = min(uv, 1.0 - uv);
    float frame = 1.0 - smoothstep(0.0, 0.025, min(e.x, e.y));
    col += pickColor(hash11(vSeed * 1.7) * 0.9) * frame * 1.6;
    if (typ < 0.5) {
      vec2 g = vec2(uv.x * 16.0, uv.y * 7.0);
      vec2 c = floor(g);
      vec2 f = fract(g);
      float lit = step(0.42, hash21(c + vSeed * 13.0 + floor(t * 0.5 + c.y) * 0.37));
      float blk = step(0.15, f.x) * step(f.x, 0.85) * step(0.2, f.y) * step(f.y, 0.8);
      col += pickColor(hash21(vec2(c.y, vSeed)) * 0.9) * lit * blk * 1.5;
    } else if (typ < 1.5) {
      vec2 p = (uv - 0.5) * vec2(2.0, 1.1);
      float r = length(p);
      float rings = smoothstep(0.07, 0.0, abs(fract(r * 3.5 - t * 0.45) - 0.5) - 0.38);
      float sweep = smoothstep(0.1, 0.0, abs(atan(p.y, p.x) - mod(t * 1.3, 6.2832) + 3.1416));
      col += pickColor(hash11(vSeed * 5.0) * 0.9) * (rings * 1.1 + sweep * step(r, 0.9) * 1.4);
    } else {
      float bars = step(0.5, fract(uv.x * 9.0 - t * 0.7 + hash11(vSeed)));
      float h = 0.25 + 0.7 * hash21(vec2(floor(uv.x * 9.0 - t * 0.7 + hash11(vSeed)), vSeed));
      col += pickColor(hash11(vSeed * 9.0) * 0.9) * bars * step(uv.y, h) * 1.3;
    }
    col *= 0.82 + 0.18 * sin(uv.y * 240.0 + t * 8.0);
    col *= 0.88 + 0.12 * step(0.12, hash11(floor(t * 12.0) + vSeed));
    float lum = max(max(col.r, col.g), col.b);
    float alpha = max(clamp(lum * 0.8, 0.0, 0.92), 0.1) * (1.0 - vFog);
    gl_FragColor = vec4((col + vec3(0.01, 0.04, 0.07)) * (1.0 - vFog), alpha);
  }
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

/**
 * Procedural metropolis: infinite grid of streets and lots. Skyscrapers, neon, lamps, bridges and billboards are
 * InstancedMeshes whose buffers are rewritten when chunks stream; streets are analytic in the floor shader.
 */
export class City {
  private chunks = new Map<number, Chunk>();
  private queue: Array<{ cx: number; cz: number }> = [];
  private lastCx = Infinity;
  private lastCz = Infinity;
  private seed = 1;
  private dirty = true;
  palette: Palette = PALETTE;
  private hackedTerminals = new Set<string>();
  private dyn = new Map<string, AABB>();
  private dynList: AABB[] = [];

  private root = new THREE.Group();
  private floor: THREE.Mesh;
  private floorMat: THREE.MeshStandardMaterial;

  private buildingMesh: THREE.InstancedMesh;
  private seedAttr: THREE.InstancedBufferAttribute;
  private neonMesh: THREE.InstancedMesh;
  private lampMesh: THREE.InstancedMesh;
  private propMesh: THREE.InstancedMesh;
  private billMesh: THREE.InstancedMesh;
  private billSeed: THREE.InstancedBufferAttribute;
  private uTime = { value: 0 };
  private uC = [new THREE.Color(), new THREE.Color(), new THREE.Color()];
  private rainCenter = new THREE.Vector3();

  private tBaseGeo = new THREE.BoxGeometry(1.1, 1.1, 0.8);
  private tBaseMat = new THREE.MeshStandardMaterial({ color: 0x10131f, roughness: 0.3, metalness: 0.9 });
  private tScreenGeo = new THREE.BoxGeometry(0.9, 0.7, 0.1);
  private tRingGeo = new THREE.TorusGeometry(0.95, 0.035, 6, 28);
  private tBeamGeo = new THREE.CylinderGeometry(0.4, 0.8, 34, 10, 1, true);
  private tScreenMat = new THREE.MeshBasicMaterial({ color: new THREE.Color(0.1, 1.8, 2.0) });
  private tScreenDone = new THREE.MeshBasicMaterial({ color: new THREE.Color(0.1, 0.35, 0.12) });
  private tRingMat = new THREE.MeshBasicMaterial({ color: 0xffffff });
  private tRingDone = new THREE.MeshBasicMaterial({ color: new THREE.Color(0.15, 0.3, 0.15) });
  private tBeamMat = new THREE.MeshBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0.12, blending: THREE.AdditiveBlending, depthWrite: false, side: THREE.DoubleSide, fog: false });

  private tmpM = new THREE.Matrix4();
  private tmpP = new THREE.Vector3();
  private tmpS = new THREE.Vector3();
  private tmpQ = new THREE.Quaternion();
  private tmpC = new THREE.Color();
  private yAxis = new THREE.Vector3(0, 1, 0);

  constructor(scene: THREE.Scene, gfx: GfxRenderer) {
    scene.add(this.root);
    const aniso = Math.min(8, gfx.renderer.capabilities.getMaxAnisotropy());

    // Street surface (analytic) + procedural roughness map for reflective puddles.
    const roughTex = this.makeRoughnessTexture(aniso);
    this.floorMat = new THREE.MeshStandardMaterial({ color: 0x0a0c16, roughness: 1, roughnessMap: roughTex, metalness: 0.7, envMapIntensity: 0.9 });
    this.floorMat.onBeforeCompile = (shader) => {
      shader.uniforms.uS = { value: S };
      shader.uniforms.uC1 = { value: this.uC[0] };
      shader.uniforms.uC2 = { value: this.uC[1] };
      shader.uniforms.uC3 = { value: this.uC[2] };
      shader.vertexShader = shader.vertexShader
        .replace('#include <common>', `#include <common>\n${FLOOR_VERT_DECL}`)
        .replace('#include <begin_vertex>', `#include <begin_vertex>\n${FLOOR_VERT_MAIN}`);
      shader.fragmentShader = shader.fragmentShader
        .replace('#include <common>', `#include <common>\n${FLOOR_FRAG_DECL}`)
        .replace('#include <color_fragment>', `#include <color_fragment>\n${FLOOR_FRAG_COLOR}`)
        .replace('#include <roughnessmap_fragment>', `#include <roughnessmap_fragment>\n${FLOOR_FRAG_ROUGH}`)
        .replace('#include <metalnessmap_fragment>', `#include <metalnessmap_fragment>\n${FLOOR_FRAG_METAL}`)
        .replace('#include <emissivemap_fragment>', `#include <emissivemap_fragment>\n${FLOOR_FRAG_EMIT}`);
    };
    this.floor = new THREE.Mesh(new THREE.PlaneGeometry(640, 640), this.floorMat);
    this.floor.rotation.x = -Math.PI / 2;
    this.floor.receiveShadow = !IS_TOUCH;
    this.root.add(this.floor);

    // Skyscrapers.
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
        .replace('#include <color_fragment>', `#include <color_fragment>\n${BUILDING_FRAG_COLOR}`)
        .replace('#include <roughnessmap_fragment>', `#include <roughnessmap_fragment>\n${BUILDING_FRAG_ROUGH}`)
        .replace('#include <metalnessmap_fragment>', `#include <metalnessmap_fragment>\n${BUILDING_FRAG_METAL}`)
        .replace('#include <emissivemap_fragment>', '#include <emissivemap_fragment>\n totalEmissiveRadiance += nEmis;');
    };
    const unit = new THREE.BoxGeometry(1, 1, 1);
    this.seedAttr = new THREE.InstancedBufferAttribute(new Float32Array(MAX_BUILDINGS), 1);
    this.seedAttr.setUsage(THREE.DynamicDrawUsage);
    unit.setAttribute('aSeed', this.seedAttr);
    this.buildingMesh = this.makeInstanced(unit, bMat, MAX_BUILDINGS);

    // Static neon (HDR, feeds bloom) and flickering lamp heads.
    this.neonMesh = this.makeInstanced(new THREE.BoxGeometry(1, 1, 1), new THREE.MeshBasicMaterial({ color: 0xffffff }), MAX_NEON);
    this.neonMesh.setColorAt(0, this.tmpC.setRGB(1, 1, 1));
    this.neonMesh.instanceColor!.setUsage(THREE.DynamicDrawUsage);

    const lampMat = new THREE.MeshBasicMaterial({ color: 0xffffff });
    lampMat.onBeforeCompile = (shader) => {
      shader.uniforms.uTime = this.uTime;
      shader.vertexShader = shader.vertexShader
        .replace('#include <common>', '#include <common>\nuniform float uTime;')
        .replace('#include <color_vertex>', `#include <color_vertex>\n${LAMP_VERT_PATCH}`);
    };
    this.lampMesh = this.makeInstanced(new THREE.BoxGeometry(1, 1, 1), lampMat, MAX_LAMPS);
    this.lampMesh.setColorAt(0, this.tmpC.setRGB(1, 1, 1));
    this.lampMesh.instanceColor!.setUsage(THREE.DynamicDrawUsage);

    // Holographic billboards.
    const billGeo = new THREE.PlaneGeometry(1, 1);
    this.billSeed = new THREE.InstancedBufferAttribute(new Float32Array(MAX_BILLS), 1);
    this.billSeed.setUsage(THREE.DynamicDrawUsage);
    billGeo.setAttribute('aSeed', this.billSeed);
    const billMat = new THREE.ShaderMaterial({
      vertexShader: BILL_VERT,
      fragmentShader: BILL_FRAG,
      uniforms: { uTime: this.uTime, uFogD: { value: 0.0125 }, uC1: { value: this.uC[0] }, uC2: { value: this.uC[1] }, uC3: { value: this.uC[2] } },
      transparent: true,
      blending: THREE.AdditiveBlending,
      depthWrite: false,
      side: THREE.DoubleSide,
    });
    this.billMesh = this.makeInstanced(billGeo, billMat, MAX_BILLS);
    this.billMesh.renderOrder = 4;
    // Street furniture (planters, benches, vending machines, bollards): lit PBR boxes tinted per instance.
    this.propMesh = this.makeInstanced(new THREE.BoxGeometry(1, 1, 1), new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 0.6, metalness: 0.55, envMapIntensity: 0.8 }), MAX_PROPS);
    this.propMesh.setColorAt(0, this.tmpC.setRGB(1, 1, 1));
    this.propMesh.instanceColor!.setUsage(THREE.DynamicDrawUsage);
    this.root.add(this.buildingMesh, this.neonMesh, this.lampMesh, this.propMesh, this.billMesh);

    // Digital rain, animated entirely on the GPU.
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
    const rainMat = new THREE.ShaderMaterial({
      vertexShader: RAIN_VERT,
      fragmentShader: RAIN_FRAG,
      uniforms: { uCenter: { value: this.rainCenter }, uTime: this.uTime, uArea: { value: RAIN_AREA }, uH: { value: RAIN_HEIGHT }, uC1: { value: this.uC[0] }, uC2: { value: this.uC[2] } },
      transparent: true,
      blending: THREE.AdditiveBlending,
      depthWrite: false,
    });
    const rain = new THREE.LineSegments(rg, rainMat);
    rain.frustumCulled = false;
    rain.renderOrder = 5;
    scene.add(rain);

    this.applyPalette(this.palette);
  }

  private makeInstanced(geo: THREE.BufferGeometry, mat: THREE.Material, count: number): THREE.InstancedMesh {
    const m = new THREE.InstancedMesh(geo, mat, count);
    m.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    m.frustumCulled = false;
    m.count = 0;
    return m;
  }

  private makeRoughnessTexture(aniso: number): THREE.CanvasTexture {
    const SZ = 256;
    const c = document.createElement('canvas');
    c.width = c.height = SZ;
    const g = c.getContext('2d')!;
    g.fillStyle = '#8a8a8a';
    g.fillRect(0, 0, SZ, SZ);
    const rnd = mulberry32(4242);
    for (let i = 0; i < 70; i++) {
      const x = rnd() * SZ, y = rnd() * SZ, r = 10 + rnd() * 38;
      const grad = g.createRadialGradient(x, y, 0, x, y, r);
      const dark = rnd() < 0.65;
      grad.addColorStop(0, dark ? 'rgba(20,20,20,0.95)' : 'rgba(210,210,210,0.7)');
      grad.addColorStop(1, 'rgba(128,128,128,0)');
      g.fillStyle = grad;
      for (const ox of [-SZ, 0, SZ]) for (const oy of [-SZ, 0, SZ]) {
        g.beginPath();
        g.arc(x + ox, y + oy, r, 0, Math.PI * 2);
        g.fill();
      }
    }
    const img = g.getImageData(0, 0, SZ, SZ);
    for (let i = 0; i < img.data.length; i += 4) {
      const n = (Math.random() - 0.5) * 22;
      img.data[i] += n; img.data[i + 1] += n; img.data[i + 2] += n;
    }
    g.putImageData(img, 0, 0);
    const t = new THREE.CanvasTexture(c);
    t.wrapS = t.wrapT = THREE.RepeatWrapping;
    t.repeat.set(640 / 20, 640 / 20);
    t.anisotropy = aniso;
    return t;
  }

  private applyPalette(p: Palette): void {
    this.palette = p;
    this.uC[0].set(p.primary);
    this.uC[1].set(p.secondary);
    this.uC[2].set(p.accent);
    this.tRingMat.color.set(p.accent).multiplyScalar(2.6);
    this.tBeamMat.color.set(p.primary);
  }

  // ───────────────────────────── queries ─────────────────────────────

  districtAt(x: number, z: number): District {
    const cx = Math.floor(x / S);
    const cz = Math.floor(z / S);
    const id = hash(this.seed, Math.floor(cx / 3), Math.floor(cz / 3), 7) % 9;
    return { id: id + 1, name: DISTRICT_NAMES[id] };
  }

  isPlaza(cx: number, cz: number): boolean {
    if (cx === 0 && cz === 0) return true;
    return hash(this.seed, cx, cz, 99) / 4294967296 < 0.2;
  }

  /** Centre of the plaza lot in chunk (cx, cz). */
  plazaCenter(cx: number, cz: number, out = new THREE.Vector3()): THREE.Vector3 {
    return out.set((cx + 0.5) * S, 0, (cz + 0.5) * S);
  }

  /** Random plaza whose distance from `from` lies in [minD, maxD]; deterministic grid scan + rng. */
  findPlaza(from: THREE.Vector3, minD: number, maxD: number, rnd: () => number): THREE.Vector3 | null {
    const cx0 = Math.floor(from.x / S);
    const cz0 = Math.floor(from.z / S);
    const R = Math.ceil(maxD / S) + 1;
    const found: THREE.Vector3[] = [];
    for (let dz = -R; dz <= R; dz++) {
      for (let dx = -R; dx <= R; dx++) {
        const cx = cx0 + dx;
        const cz = cz0 + dz;
        if (!this.isPlaza(cx, cz)) continue;
        const c = this.plazaCenter(cx, cz);
        const d = Math.hypot(c.x - from.x, c.z - from.z);
        if (d >= minD && d <= maxD) found.push(c);
      }
    }
    return found.length ? found[Math.floor(rnd() * found.length)] : null;
  }

  forEachTerminal(fn: (t: Terminal) => void): void {
    for (const c of this.chunks.values()) for (const t of c.terminals) fn(t);
  }

  markTerminalHacked(t: Terminal): void {
    t.hacked = true;
    this.hackedTerminals.add(t.id);
    t.screen.material = this.tScreenDone;
    t.ring.material = this.tRingDone;
    t.beam.visible = false;
  }

  addCollider(id: string, box: AABB): void {
    this.dyn.set(id, box);
    this.dynList = [...this.dyn.values()];
  }

  removeCollider(id: string): void {
    if (this.dyn.delete(id)) this.dynList = [...this.dyn.values()];
  }

  // ───────────────────────────── lifecycle ─────────────────────────────

  /** Regenerates the city around `center` synchronously (used for the loading screen). */
  reset(seed: number, center: THREE.Vector3): void {
    for (const c of this.chunks.values()) this.unloadChunk(c);
    this.chunks.clear();
    this.queue = [];
    this.hackedTerminals.clear();
    this.dyn.clear();
    this.dynList = [];
    this.seed = seed;
    const R = CFG.viewRadius;
    const ccx = Math.floor(center.x / S);
    const ccz = Math.floor(center.z / S);
    for (let dz = -R; dz <= R; dz++) for (let dx = -R; dx <= R; dx++) this.ensureChunk(ccx + dx, ccz + dz);
    this.lastCx = ccx;
    this.lastCz = ccz;
    this.dirty = true;
    this.rebuildInstances();
  }

  update(dt: number, time: number, p: THREE.Vector3): void {
    const cx = Math.floor(p.x / S);
    const cz = Math.floor(p.z / S);
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
    // Chunk generation is pure math (no geometry creation), so a couple per frame are free.
    for (let n = 0; n < 2 && this.queue.length; n++) {
      const q = this.queue.shift()!;
      this.ensureChunk(q.cx, q.cz);
    }
    if (this.dirty) this.rebuildInstances();

    this.uTime.value = time;
    this.rainCenter.copy(p);
    this.floor.position.set(Math.round(p.x / 20) * 20, 0, Math.round(p.z / 20) * 20);

    const pulse = 1.7 + Math.sin(time * 6) * 0.5;
    this.tScreenMat.color.setRGB(0.1, pulse, pulse + 0.2);
    for (const c of this.chunks.values()) {
      for (const t of c.terminals) {
        const dd = Math.hypot(t.pos.x - p.x, t.pos.z - p.z);
        t.ring.visible = dd < 45;
        t.beam.visible = !t.hacked && dd < 110;
        t.ring.rotation.y += dt * (t.hacked ? 0.4 : 2.2);
        t.ring.position.y = 2.1 + Math.sin(time * 2 + c.cx) * 0.1;
      }
    }
  }

  // ───────────────────────────── instance buffers ─────────────────────────────

  private rebuildInstances(): void {
    this.dirty = false;
    const m = this.tmpM;
    const q = this.tmpQ;
    const pos = this.tmpP;
    const sc = this.tmpS;
    const seeds = this.seedAttr.array as Float32Array;
    const billSeeds = this.billSeed.array as Float32Array;
    let nb = 0, nn = 0, nl = 0, nbill = 0, np = 0;
    for (const c of this.chunks.values()) {
      q.identity();
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
      for (const l of c.lamps) {
        if (nl >= MAX_LAMPS) break;
        m.compose(pos.set(l.x, l.y, l.z), q, sc.set(l.sx, l.sy, l.sz));
        this.lampMesh.setMatrixAt(nl, m);
        this.lampMesh.setColorAt(nl, this.tmpC.setRGB(l.r, l.g, l.b));
        nl++;
      }
      for (const pr of c.props) {
        if (np >= MAX_PROPS) break;
        m.compose(pos.set(pr.x, pr.y, pr.z), q, sc.set(pr.sx, pr.sy, pr.sz));
        this.propMesh.setMatrixAt(np, m);
        this.propMesh.setColorAt(np, this.tmpC.setRGB(pr.r, pr.g, pr.b));
        np++;
      }
      for (const b of c.bills) {
        if (nbill >= MAX_BILLS) break;
        q.setFromAxisAngle(this.yAxis, b.ry);
        m.compose(pos.set(b.x, b.y, b.z), q, sc.set(b.w, b.h, 1));
        this.billMesh.setMatrixAt(nbill, m);
        billSeeds[nbill++] = b.seed;
      }
    }
    this.buildingMesh.count = nb;
    this.neonMesh.count = nn;
    this.lampMesh.count = nl;
    this.propMesh.count = np;
    this.propMesh.instanceMatrix.needsUpdate = true;
    if (this.propMesh.instanceColor) this.propMesh.instanceColor.needsUpdate = true;
    this.billMesh.count = nbill;
    this.buildingMesh.instanceMatrix.needsUpdate = true;
    this.seedAttr.needsUpdate = true;
    this.neonMesh.instanceMatrix.needsUpdate = true;
    if (this.neonMesh.instanceColor) this.neonMesh.instanceColor.needsUpdate = true;
    this.lampMesh.instanceMatrix.needsUpdate = true;
    if (this.lampMesh.instanceColor) this.lampMesh.instanceColor.needsUpdate = true;
    this.billMesh.instanceMatrix.needsUpdate = true;
    this.billSeed.needsUpdate = true;
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

  /** Deterministic lot (independent of chunk load order, so bridges can reference neighbouring chunks). */
  private lotAt(cx: number, cz: number, i: number, j: number): Lot | null {
    const plaza = this.isPlaza(cx, cz);
    if (plaza && i === 1 && (j === 1 || j === 2)) return null;
    const rnd = mulberry32(hash(this.seed, cx, cz, i * 3 + j + 1, 5));
    if (rnd() > 0.9) return null;
    const lot = (S - 2 * CITY.LOT_INSET) / 3;
    const x0 = cx * S + CITY.LOT_INSET + lot * i;
    const z0 = cz * S + CITY.LOT_INSET + lot * j;
    const dist = this.districtAt((cx + 0.5) * S, (cz + 0.5) * S);
    const dh = DISTRICT_HEIGHT[dist.id - 1];
    const w = 9 + rnd() * 5.5;
    const d = 9 + rnd() * 5.5;
    const x = x0 + lot / 2 + (rnd() - 0.5) * 2 * Math.max(0, (lot - w) / 2 - 0.4);
    const z = z0 + lot / 2 + (rnd() - 0.5) * 2 * Math.max(0, (lot - d) / 2 - 0.4);
    // Skyline: per-chunk height bias plus occasional spires and low blocks give an asymmetric Blade-Runner profile.
    const chunkMod = 0.72 + 0.7 * (hash(this.seed, cx, cz, 31) / 4294967296);
    let h = (14 + Math.pow(rnd(), 1.4) * 52) * dh * chunkMod;
    const tier = rnd();
    if (tier < 0.13) h *= 1.9 + rnd() * 1.3;
    else if (tier < 0.3) h *= 0.55;
    h = Math.min(Math.max(h, 9), 200);
    return { x, z, w, d, h, seed: 1 + rnd() * 900 };
  }

  private buildChunk(cx: number, cz: number, key: number): Chunk {
    const rnd = mulberry32(hash(this.seed, cx, cz, 1, 1));
    const x0 = cx * S;
    const z0 = cz * S;
    const pal = this.palette;
    const cols = [new THREE.Color(pal.primary), new THREE.Color(pal.secondary), new THREE.Color(pal.accent)];
    const dark = new THREE.Color(0.03, 0.03, 0.05);
    const chunk: Chunk = { cx, cz, key, plaza: this.isPlaza(cx, cz), buildings: [], neon: [], lamps: [], props: [], bills: [], colliders: [], terminals: [] };
    const neon = (sx: number, sy: number, sz: number, x: number, y: number, z: number, c: THREE.Color, k: number, ry = 0): void => {
      chunk.neon.push({ x, y, z, sx, sy, sz, ry, r: c.r * k, g: c.g * k, b: c.b * k });
    };
    const pick = (): THREE.Color => cols[Math.floor(rnd() * 3)];

    // Buildings on a 3x3 lot grid.
    const lots: Array<Lot | null> = [];
    for (let j = 0; j < 3; j++) {
      for (let i = 0; i < 3; i++) {
        const lot = this.lotAt(cx, cz, i, j);
        lots.push(lot);
        if (!lot) continue;
        chunk.buildings.push({ x: lot.x, y: lot.h / 2, z: lot.z, sx: lot.w, sy: lot.h, sz: lot.d, seed: lot.seed });
        chunk.colliders.push({ minX: lot.x - lot.w / 2, maxX: lot.x + lot.w / 2, minZ: lot.z - lot.d / 2, maxZ: lot.z + lot.d / 2 });
        this.addRelief(chunk, lot, rnd);
        if (rnd() < 0.7) {
          const ah = 3 + rnd() * 7;
          neon(0.22, ah, 0.22, lot.x, lot.h + ah / 2, lot.z, dark, 1);
          neon(0.6, 0.6, 0.6, lot.x, lot.h + ah, lot.z, cols[1], 4.5);
        }
        // Facade billboard facing the street (outer lots only).
        if (rnd() < 0.13) {
          const face = i === 0 ? [-1, 0] : i === 2 ? [1, 0] : j === 0 ? [0, -1] : j === 2 ? [0, 1] : null;
          if (face) {
            const half = face[0] !== 0 ? lot.w / 2 : lot.d / 2;
            const width = Math.min(9, (face[0] !== 0 ? lot.d : lot.w) - 1.5);
            chunk.bills.push({
              x: lot.x + face[0] * (half + 0.15), y: Math.min(lot.h * 0.62, 30), z: lot.z + face[1] * (half + 0.15),
              w: width, h: width * 0.5, ry: Math.atan2(face[0], face[1]), seed: 1 + rnd() * 900,
            });
          }
        }
        // Giant rooftop hologram.
        if (lot.h > 34 && rnd() < 0.05) {
          const a = Math.floor(rnd() * 4) * (Math.PI / 2);
          chunk.bills.push({ x: lot.x, y: lot.h + 9, z: lot.z, w: 18, h: 10, ry: a, seed: 1 + rnd() * 900 });
          neon(lot.w * 0.8, 0.3, 0.3, lot.x, lot.h + 3.8, lot.z, pick(), 3, a);
        }
      }
    }

    // Elevated walkways: inside the chunk, and across the roads on the north and west edges.
    const bridge = (a: Lot, b: Lot, alongZ: boolean): void => {
      const y = Math.max(11, Math.min(a.h, b.h) * (0.4 + rnd() * 0.3));
      if (y > Math.min(a.h, b.h) - 2) return;
      const len = alongZ ? Math.abs(b.z - a.z) : Math.abs(b.x - a.x);
      const mx = (a.x + b.x) / 2;
      const mz = (a.z + b.z) / 2;
      const ang = alongZ ? 0 : Math.PI / 2;
      neon(2.2, 0.35, len, mx, y, mz, dark, 1, ang);
      const ox = alongZ ? 1.05 : 0;
      const oz = alongZ ? 0 : 1.05;
      neon(0.12, 0.12, len, mx + ox, y + 0.3, mz + oz, cols[1], 3.4, ang);
      neon(0.12, 0.12, len, mx - ox, y + 0.3, mz - oz, cols[1], 3.4, ang);
    };
    for (let j = 0; j < 3; j++) {
      for (let i = 0; i < 3; i++) {
        const a = lots[j * 3 + i];
        if (!a) continue;
        if (i < 2) { const b = lots[j * 3 + i + 1]; if (b && rnd() < 0.3 && Math.abs(a.z - b.z) < 2.5) bridge(a, b, false); }
        if (j < 2) { const b = lots[(j + 1) * 3 + i]; if (b && rnd() < 0.3 && Math.abs(a.x - b.x) < 2.5) bridge(a, b, true); }
      }
    }
    for (let k = 0; k < 3; k++) {
      const a = lots[k];
      const b = this.lotAt(cx, cz - 1, k, 2);
      if (a && b && hash(this.seed, cx, cz, k, 11) % 100 < 28 && Math.abs(a.x - b.x) < 2.5) bridge(a, b, true);
      const a2 = lots[k * 3];
      const b2 = this.lotAt(cx - 1, cz, 2, k);
      if (a2 && b2 && hash(this.seed, cx, cz, k, 12) % 100 < 28 && Math.abs(a2.z - b2.z) < 2.5) bridge(a2, b2, false);
    }

    // Street lamps along the sidewalks of the north (z0) and west (x0) roads, with light pools and flickering heads.
    for (const side of [-1, 1]) {
      for (let k = 0; k < 4; k++) {
        const t = 8 + k * 16;
        const lx = x0 + t;
        const lz = z0 + side * 6.4;
        this.addLamp(chunk, lx, lz, pick());
        const px = x0 + side * 6.4;
        const pz = z0 + t;
        this.addLamp(chunk, px, pz, pick());
      }
    }

    // Plaza paving frame.
    if (chunk.plaza) {
      const c = this.plazaCenter(cx, cz);
      for (const [sx, sz, w, d] of [[0, -7.6, 15.6, 0.25], [0, 7.6, 15.6, 0.25], [-7.6, 0, 0.25, 15.6], [7.6, 0, 0.25, 15.6]] as const) {
        neon(w, 0.04, d, c.x + sx, 0.05, c.z + sz, cols[0], 1.1);
      }
    }

    // Public hacking kiosks on the north sidewalk.
    if (rnd() < 0.34) {
      const kx = x0 + 16 + 16 * Math.floor(rnd() * 3);
      const kz = z0 - 6.7;
      chunk.terminals.push(this.makeTerminal(kx, kz, `TRM-${(cx & 255).toString(16).toUpperCase().padStart(2, '0')}${(cz & 255).toString(16).toUpperCase().padStart(2, '0')}`));
      chunk.colliders.push({ minX: kx - 0.6, maxX: kx + 0.6, minZ: kz - 0.5, maxZ: kz + 0.5 });
      this.root.add(chunk.terminals[0].group);
    }
    this.addStreetProps(chunk, rnd, x0, z0, cols);
    return chunk;
  }

  /** Depth and silhouette detail for a tower: cornices, roof ledge, corner columns and a stepped crown. */
  private addRelief(chunk: Chunk, lot: Lot, rnd: () => number): void {
    const { x, z, w, d, h } = lot;
    const add = (px: number, py: number, pz: number, sx: number, sy: number, sz: number): void => {
      chunk.buildings.push({ x: px, y: py, z: pz, sx, sy, sz, seed: 1 + rnd() * 900 });
    };
    // Projecting cornices every few floors.
    const floors = Math.floor(h / 14);
    for (let k = 1; k <= Math.min(2, floors); k++) {
      if (rnd() < 0.7) add(x, (h / (Math.min(2, floors) + 1)) * k + rnd() * 3, z, w + 0.8, 0.6, d + 0.8);
    }
    // Roof ledge.
    add(x, h + 0.45, z, w + 0.55, 0.9, d + 0.55);
    // Corner columns for depth on some towers.
    if (rnd() < 0.4) {
      for (const sx of [-1, 1]) for (const sz of [-1, 1]) add(x + sx * (w / 2 + 0.1), h / 2, z + sz * (d / 2 + 0.1), 0.7, h, 0.7);
    }
    // Stepped crown.
    if (h > 26 && rnd() < 0.55) {
      add(x, h + 4.2, z, w * 0.72, 6.6, d * 0.72);
      add(x, h + 9.2, z, w * 0.4, 3.4, d * 0.4);
    }
  }

  /** Small instanced furniture along the sidewalks: planters, benches, vending machines, bollards, neon signs, vents. */
  private addStreetProps(chunk: Chunk, rnd: () => number, x0: number, z0: number, cols: THREE.Color[]): void {
    const concrete = new THREE.Color(0.2, 0.21, 0.24);
    const metal = new THREE.Color(0.09, 0.1, 0.13);
    const lampTs = [8, 24, 40, 56];
    const kioskTs = [16, 32, 48];
    const prop = (x: number, y: number, z: number, sx: number, sy: number, sz: number, c: THREE.Color, k = 1): void => {
      chunk.props.push({ x, y, z, sx, sy, sz, ry: 0, r: c.r * k, g: c.g * k, b: c.b * k });
    };
    const glow = (x: number, y: number, z: number, sx: number, sy: number, sz: number, c: THREE.Color, k: number): void => {
      chunk.neon.push({ x, y, z, sx, sy, sz, ry: 0, r: c.r * k, g: c.g * k, b: c.b * k });
    };
    const hit = (x: number, z: number, hx: number, hz: number): void => {
      chunk.colliders.push({ minX: x - hx, maxX: x + hx, minZ: z - hz, maxZ: z + hz });
    };
    for (const axis of [0, 1] as const) {
      for (const side of [-1, 1] as const) {
        let t = 10 + rnd() * 4;
        while (t < 54) {
          const nearLamp = lampTs.some((l) => Math.abs(l - t) < 3.2);
          const nearKiosk = axis === 0 && side === -1 && kioskTs.some((k) => Math.abs(k - t) < 3);
          if (!nearLamp && !nearKiosk) {
            // Local frame: a = along the street, c = lateral distance from the centreline (outer edge ~6.5).
            const at = (a: number, c: number): [number, number] => (axis === 0 ? [x0 + a, z0 + side * c] : [x0 + side * c, z0 + a]);
            const box = (a: number, c: number, y: number, len: number, wid: number, hgt: number, col: THREE.Color, k = 1): void => {
              const [px, pz] = at(a, c);
              prop(px, y, pz, axis === 0 ? len : wid, hgt, axis === 0 ? wid : len, col, k);
            };
            const gl = (a: number, c: number, y: number, len: number, wid: number, hgt: number, col: THREE.Color, k: number): void => {
              const [px, pz] = at(a, c);
              glow(px, y, pz, axis === 0 ? len : wid, hgt, axis === 0 ? wid : len, col, k);
            };
            const col = cols[Math.floor(rnd() * 3)];
            const r = rnd();
            if (r < 0.2) {
              // Low concrete planter wall with a neon cap.
              box(t, 6.45, 0.28, 2.6, 0.75, 0.56, concrete);
              gl(t, 6.45, 0.6, 2.62, 0.2, 0.05, col, 1.8);
              const [px, pz] = at(t, 6.45);
              hit(px, pz, axis === 0 ? 1.3 : 0.38, axis === 0 ? 0.38 : 1.3);
            } else if (r < 0.34) {
              // Bench.
              box(t, 6.5, 0.26, 1.7, 0.5, 0.1, metal);
              box(t, 6.72, 0.55, 1.7, 0.08, 0.5, metal);
              box(t - 0.7, 6.5, 0.12, 0.1, 0.4, 0.24, metal);
              box(t + 0.7, 6.5, 0.12, 0.1, 0.4, 0.24, metal);
              gl(t, 6.45, 0.33, 1.6, 0.06, 0.03, col, 1.4);
              const [px, pz] = at(t, 6.5);
              hit(px, pz, axis === 0 ? 0.85 : 0.3, axis === 0 ? 0.3 : 0.85);
            } else if (r < 0.52) {
              // Vending machine with a glowing front.
              box(t, 6.45, 0.95, 0.95, 0.8, 1.9, metal);
              gl(t, 6.03, 1.2, 0.72, 0.05, 1.2, col, 1.6);
              gl(t, 6.03, 0.35, 0.72, 0.05, 0.3, cols[(cols.indexOf(col) + 1) % 3], 1.2);
              const [px, pz] = at(t, 6.45);
              hit(px, pz, axis === 0 ? 0.48 : 0.42, axis === 0 ? 0.42 : 0.48);
            } else if (r < 0.7) {
              // Row of bollards with neon caps near the kerb.
              for (let k = -1; k <= 1; k++) {
                box(t + k * 1.3, 4.35, 0.4, 0.16, 0.16, 0.8, metal);
                gl(t + k * 1.3, 4.35, 0.84, 0.2, 0.2, 0.06, col, 3.2);
              }
            } else if (r < 0.86) {
              // Hanging bionic-clinic style neon blade sign.
              const [px, pz] = at(t, 6.55);
              prop(px, 3.4, pz, axis === 0 ? 0.1 : 0.6, 0.08, axis === 0 ? 0.6 : 0.1, metal);
              const [sx2, sz2] = at(t, 6.2);
              chunk.lamps.push({ x: sx2, y: 3.9, z: sz2, sx: axis === 0 ? 0.1 : 0.6, sy: 1.1, sz: axis === 0 ? 0.6 : 0.1, ry: 0, r: col.r * 2.2, g: col.g * 2.2, b: col.b * 2.2 });
            } else {
              // Utility vent / trash unit with a status LED.
              box(t, 6.5, 0.5, 0.9, 0.7, 1.0, metal);
              gl(t, 6.12, 0.85, 0.12, 0.04, 0.1, new THREE.Color(1, 0.3, 0.1), 3);
              const [px, pz] = at(t, 6.5);
              hit(px, pz, axis === 0 ? 0.45 : 0.35, axis === 0 ? 0.35 : 0.45);
            }
          }
          t += 5 + rnd() * 7;
        }
      }
    }
  }

  private addLamp(chunk: Chunk, x: number, z: number, c: THREE.Color): void {
    const dark = new THREE.Color(0.03, 0.03, 0.05);
    chunk.neon.push({ x, y: 3.2, z, sx: 0.18, sy: 6.4, sz: 0.18, ry: 0, r: dark.r, g: dark.g, b: dark.b });
    chunk.lamps.push({ x, y: 6.5, z, sx: 0.9, sy: 0.2, sz: 0.9, ry: 0, r: c.r * 5, g: c.g * 5, b: c.b * 5 });
    chunk.colliders.push({ minX: x - 0.25, maxX: x + 0.25, minZ: z - 0.25, maxZ: z + 0.25 });
  }

  private makeTerminal(x: number, z: number, id: string): Terminal {
    const hacked = this.hackedTerminals.has(id);
    const group = new THREE.Group();
    group.position.set(x, 0, z);
    const base = new THREE.Mesh(this.tBaseGeo, this.tBaseMat);
    base.position.y = 0.55;
    const screen = new THREE.Mesh(this.tScreenGeo, hacked ? this.tScreenDone : this.tScreenMat);
    screen.position.y = 1.35;
    screen.rotation.x = -0.35;
    const ring = new THREE.Mesh(this.tRingGeo, hacked ? this.tRingDone : this.tRingMat);
    ring.rotation.x = Math.PI / 2;
    ring.position.y = 2.1;
    const beam = new THREE.Mesh(this.tBeamGeo, this.tBeamMat);
    beam.position.y = 17;
    beam.visible = !hacked;
    group.add(base, screen, ring, beam);
    return { id, pos: new THREE.Vector3(x, 1, z), hacked, group, ring, screen, beam };
  }

  // ───────────────────────────── collision (AABB vs circle, allocation-free) ─────────────────────────────

  isBlocked(x: number, z: number, r: number): boolean {
    const cx = Math.floor(x / S);
    const cz = Math.floor(z / S);
    const r2 = r * r;
    for (let dz = -1; dz <= 1; dz++) {
      for (let dx = -1; dx <= 1; dx++) {
        const c = this.chunks.get(keyOf(cx + dx, cz + dz));
        if (!c) continue;
        const list = c.colliders;
        for (let i = 0; i < list.length; i++) if (this.hits(list[i], x, z, r2)) return true;
      }
    }
    for (let i = 0; i < this.dynList.length; i++) if (this.hits(this.dynList[i], x, z, r2)) return true;
    return false;
  }

  private hits(b: AABB, x: number, z: number, r2: number): boolean {
    const px = x < b.minX ? b.minX : x > b.maxX ? b.maxX : x;
    const pz = z < b.minZ ? b.minZ : z > b.maxZ ? b.maxZ : z;
    const dx = x - px;
    const dz = z - pz;
    return dx * dx + dz * dz < r2;
  }

  /** Pushes a circle (xz plane) out of every collider. Returns true if a correction happened. */
  resolve(pos: THREE.Vector3, r: number): boolean {
    const cx = Math.floor(pos.x / S);
    const cz = Math.floor(pos.z / S);
    let hit = false;
    for (let dz = -1; dz <= 1; dz++) {
      for (let dx = -1; dx <= 1; dx++) {
        const c = this.chunks.get(keyOf(cx + dx, cz + dz));
        if (!c) continue;
        const list = c.colliders;
        for (let i = 0; i < list.length; i++) if (this.push(list[i], pos, r)) hit = true;
      }
    }
    for (let i = 0; i < this.dynList.length; i++) if (this.push(this.dynList[i], pos, r)) hit = true;
    return hit;
  }

  private push(b: AABB, pos: THREE.Vector3, r: number): boolean {
    const px = pos.x < b.minX ? b.minX : pos.x > b.maxX ? b.maxX : pos.x;
    const pz = pos.z < b.minZ ? b.minZ : pos.z > b.maxZ ? b.maxZ : pos.z;
    const ddx = pos.x - px;
    const ddz = pos.z - pz;
    const d2 = ddx * ddx + ddz * ddz;
    if (d2 >= r * r) return false;
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
    return true;
  }
}
