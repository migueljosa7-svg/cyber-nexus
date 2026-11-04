import * as THREE from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import { CFG, CITY, PALETTE } from '../config';
import type { GameContext } from '../context';

const S = CITY.S;
/** Length of the wrap-around window along each road (vehicles recycle outside the fog). */
const L = 300;
/** Vehicles are assigned to road residue classes mod PER so every road near the player is always populated. */
const PER = 5;
const SPEED_AMP = 0.3;
const SPEED_W = 0.7;

export interface Vehicle {
  id: string;
  fly: boolean;
  axis: 0 | 1;
  dir: 1 | -1;
  cls: number;
  speed: number;
  phase: number;
  wob: number;
  y: number;
  /** Freeze window: [fs, fs+dur) the vehicle stands still; `shift` accumulates finished stops. */
  fs: number;
  dur: number;
  shift: number;
  mesh: THREE.InstancedMesh;
  local: number;
  // cached pose (CPU mirror of the vertex shader)
  x: number;
  y3: number;
  z: number;
  yaw: number;
  brake: boolean;
  frozen: boolean;
}

const VERT_DECL = /* glsl */ `
  attribute float aPart;
  attribute vec4 aA;
  attribute vec4 aB;
  attribute vec3 aF;
  attribute vec3 aTint;
  uniform float uTime;
  uniform vec3 uPlayer;
  uniform float uS;
  varying float vPart;
  varying float vBrake;
  varying vec3 vTint;
`;

const VERT_POSE = /* glsl */ `
  float axisV = aA.x;
  float dirV = aA.y;
  float clsV = aA.z;
  float flyY = aA.w;
  float te = uTime < aF.x ? uTime - aF.z : (uTime < aF.x + aF.y ? aF.x - aF.z : uTime - aF.y - aF.z);
  float sdist = aB.x * (te + ${SPEED_AMP.toFixed(2)} * (cos(aB.z) - cos(${SPEED_W.toFixed(2)} * te + aB.z)) / ${SPEED_W.toFixed(2)});
  float pAlong = aB.y * ${L.toFixed(1)} + dirV * sdist;
  float pa = axisV < 0.5 ? uPlayer.x : uPlayer.z;
  float pp = axisV < 0.5 ? uPlayer.z : uPlayer.x;
  float kRoad = clsV + ${PER.toFixed(1)} * floor((pp / uS - clsV) / ${PER.toFixed(1)} + 0.5);
  float perp = kRoad * uS + dirV * 2.0;
  float aPos = mod(pAlong - pa + ${(L / 2).toFixed(1)}, ${L.toFixed(1)}) - ${(L / 2).toFixed(1)} + pa;
  vec3 wpos = axisV < 0.5 ? vec3(aPos, 0.0, perp) : vec3(perp, 0.0, aPos);
  wpos.y = flyY > 0.5 ? flyY + sin(uTime * 1.7 + aB.z) * 0.35 : 0.42;
  float yawV = axisV < 0.5 ? (dirV > 0.0 ? 1.5707963 : -1.5707963) : (dirV > 0.0 ? 0.0 : 3.1415926);
  float cyV = cos(yawV);
  float syV = sin(yawV);
  mat3 rotYV = mat3(cyV, 0.0, -syV, 0.0, 1.0, 0.0, syV, 0.0, cyV);
  objectNormal = rotYV * objectNormal;
  bool frozenV = uTime >= aF.x && uTime < aF.x + aF.y;
  vBrake = (frozenV || cos(${SPEED_W.toFixed(2)} * te + aB.z) < -0.4) ? 1.0 : 0.0;
  vPart = aPart;
  vTint = aTint;
`;

const FRAG_DECL = /* glsl */ `
  uniform float uTime;
  varying float vPart;
  varying float vBrake;
  varying vec3 vTint;
`;

const FRAG_ROUGH = /* glsl */ `
  roughnessFactor = (vPart > 0.5 && vPart < 1.5) ? 0.06 : 0.32;
`;

const FRAG_EMIT = /* glsl */ `
  vec3 emV = vec3(0.0);
  if (abs(vPart - 2.0) < 0.5) emV = vec3(2.8, 2.6, 2.2);
  else if (abs(vPart - 3.0) < 0.5) emV = vec3(1.0, 0.04, 0.06) * (1.2 + vBrake * 6.0);
  else if (abs(vPart - 4.0) < 0.5) emV = vTint * 2.4;
  else if (abs(vPart - 5.0) < 0.5) emV = vTint * 3.2 * (0.8 + 0.2 * sin(uTime * 30.0));
  totalEmissiveRadiance += emV;
`;

function part(g: THREE.BufferGeometry, id: number): THREE.BufferGeometry {
  g.setAttribute('aPart', new THREE.BufferAttribute(new Float32Array(g.attributes.position.count).fill(id), 1));
  return g;
}

function box(w: number, h: number, d: number, x: number, y: number, z: number, id: number): THREE.BufferGeometry {
  return part(new THREE.BoxGeometry(w, h, d).translate(x, y, z), id);
}

function buildCarGeometry(): THREE.BufferGeometry {
  return mergeGeometries([
    box(1.9, 0.5, 4.4, 0, 0.3, 0, 0),
    box(1.55, 0.42, 2.1, 0, 0.78, -0.25, 1),
    box(0.45, 0.14, 0.06, 0.62, 0.38, 2.2, 2),
    box(0.45, 0.14, 0.06, -0.62, 0.38, 2.2, 2),
    box(1.6, 0.12, 0.06, 0, 0.5, -2.2, 3),
    box(1.75, 0.05, 4.0, 0, 0.04, 0, 4),
    box(1.6, 0.06, 0.5, 0, 0.95, -2.0, 0),
  ])!;
}

function buildFlyerGeometry(): THREE.BufferGeometry {
  return mergeGeometries([
    box(2.0, 0.55, 5.4, 0, 0, 0, 0),
    box(0.8, 0.3, 2.8, 1.5, -0.05, -0.4, 0),
    box(0.8, 0.3, 2.8, -1.5, -0.05, -0.4, 0),
    box(1.2, 0.1, 1.2, 0.95, 0, -0.4, 0),
    box(1.2, 0.1, 1.2, -0.95, 0, -0.4, 0),
    box(1.3, 0.45, 1.9, 0, 0.5, 0.4, 1),
    box(0.5, 0.14, 0.06, 0.6, 0.05, 2.7, 2),
    box(0.5, 0.14, 0.06, -0.6, 0.05, 2.7, 2),
    box(1.5, 0.12, 0.06, 0, 0.1, -2.7, 3),
    box(0.5, 0.4, 0.3, 0.7, 0, -2.85, 5),
    box(0.5, 0.4, 0.3, -0.7, 0, -2.85, 5),
    box(2.6, 0.05, 4.6, 0, -0.3, 0, 4),
  ])!;
}

/**
 * Autonomous traffic. Every vehicle's position is a closed-form function of time evaluated in the vertex shader
 * (zero per-car CPU work for rendering). The same formula is mirrored in TypeScript for collision / hacking.
 * Ground cars drive the east-west avenues; hover vehicles fly in layered lanes above every road.
 */
export class Traffic {
  readonly vehicles: Vehicle[] = [];
  private groundMesh: THREE.InstancedMesh;
  private flyMesh: THREE.InstancedMesh;
  private freezeAttrs = new Map<THREE.InstancedMesh, THREE.InstancedBufferAttribute>();
  private uniforms = { uTime: { value: 0 }, uPlayer: { value: new THREE.Vector3() }, uS: { value: S } };
  private time = 0;
  private hitCd = 0;
  private tmp = new THREE.Vector3();

  constructor(private ctx: GameContext, scene: THREE.Scene) {
    const nG = CFG.groundCars;
    const nF = CFG.flyers;
    this.groundMesh = this.makeMesh(buildCarGeometry(), nG, 0);
    this.flyMesh = this.makeMesh(buildFlyerGeometry(), nF, 1);
    scene.add(this.groundMesh, this.flyMesh);
  }

  private makeMaterial(): THREE.MeshStandardMaterial {
    const mat = new THREE.MeshStandardMaterial({ color: 0x14151d, roughness: 0.32, metalness: 0.85, envMapIntensity: 1.3 });
    mat.onBeforeCompile = (shader) => {
      Object.assign(shader.uniforms, this.uniforms);
      shader.vertexShader = shader.vertexShader
        .replace('#include <common>', `#include <common>\n${VERT_DECL}`)
        .replace('#include <beginnormal_vertex>', `#include <beginnormal_vertex>\n${VERT_POSE}`)
        .replace('#include <begin_vertex>', 'vec3 transformed = rotYV * position + wpos;');
      shader.fragmentShader = shader.fragmentShader
        .replace('#include <common>', `#include <common>\n${FRAG_DECL}`)
        .replace('#include <roughnessmap_fragment>', `#include <roughnessmap_fragment>\n${FRAG_ROUGH}`)
        .replace('#include <emissivemap_fragment>', `#include <emissivemap_fragment>\n${FRAG_EMIT}`);
    };
    return mat;
  }

  private makeMesh(geo: THREE.BufferGeometry, count: number, kind: 0 | 1): THREE.InstancedMesh {
    const fly = kind === 1;
    const aA = new Float32Array(count * 4);
    const aB = new Float32Array(count * 4);
    const aF = new Float32Array(count * 3);
    const aT = new Float32Array(count * 3);
    const mesh = new THREE.InstancedMesh(geo, this.makeMaterial(), count);
    const ident = new THREE.Matrix4();
    const palette = [new THREE.Color(PALETTE.primary), new THREE.Color(PALETTE.secondary), new THREE.Color(PALETTE.accent)];

    // Lane buckets: (class, direction[, axis]) each get an even spread of cars at one shared speed so nobody overtakes.
    const buckets = fly ? PER * 2 * 2 : PER * 2;
    const perBucket = new Array<number>(buckets).fill(0);
    for (let i = 0; i < count; i++) perBucket[i % buckets]++;
    const seen = new Array<number>(buckets).fill(0);

    for (let i = 0; i < count; i++) {
      mesh.setMatrixAt(i, ident);
      const b = i % buckets;
      const cls = b % PER;
      const dirBit = Math.floor(b / PER) % 2;
      const axis = (fly ? Math.floor(b / (PER * 2)) : 0) as 0 | 1;
      const dir: 1 | -1 = dirBit ? 1 : -1;
      const laneSpeed = (fly ? 15 : 9) + ((b * 7919) % 100) / 100 * (fly ? 14 : 8);
      const idx = seen[b]++;
      const phase = (idx + Math.random() * 0.6 + 0.2) / perBucket[b];
      const wob = Math.random() * Math.PI * 2;
      const flyY = fly ? (axis === 0 ? 6.2 + dirBit * 2.2 : 4.0 + dirBit * 6.2) : 0;
      aA.set([axis, dir, cls, flyY], i * 4);
      aB.set([laneSpeed, phase, wob, 0], i * 4);
      aF.set([1e9, 0, 0], i * 3);
      const c = palette[Math.floor(Math.random() * 3)];
      aT.set([c.r, c.g, c.b], i * 3);
      this.vehicles.push({
        id: `${fly ? 'FLY' : 'CAR'}-${String(this.vehicles.length + 1).padStart(2, '0')}`,
        fly, axis, dir, cls, speed: laneSpeed, phase, wob, y: flyY, fs: 1e9, dur: 0, shift: 0,
        mesh, local: i, x: 0, y3: 0, z: 0, yaw: 0, brake: false, frozen: false,
      });
    }
    const attr = (arr: Float32Array, n: number, dynamic = false): THREE.InstancedBufferAttribute => {
      const a = new THREE.InstancedBufferAttribute(arr, n);
      if (dynamic) a.setUsage(THREE.DynamicDrawUsage);
      return a;
    };
    geo.setAttribute('aA', attr(aA, 4));
    geo.setAttribute('aB', attr(aB, 4));
    const fa = attr(aF, 3, true);
    geo.setAttribute('aF', fa);
    geo.setAttribute('aTint', attr(aT, 3));
    this.freezeAttrs.set(mesh, fa);
    mesh.frustumCulled = false;
    mesh.instanceMatrix.needsUpdate = true;
    return mesh;
  }

  // ───────────────────────────── CPU mirror of the shader ─────────────────────────────

  private pose(v: Vehicle, t: number, px: number, pz: number): void {
    let te: number;
    if (t < v.fs) te = t - v.shift;
    else if (t < v.fs + v.dur) te = v.fs - v.shift;
    else te = t - v.dur - v.shift;
    const sdist = v.speed * (te + (SPEED_AMP * (Math.cos(v.wob) - Math.cos(SPEED_W * te + v.wob))) / SPEED_W);
    const pAlong = v.phase * L + v.dir * sdist;
    const pa = v.axis === 0 ? px : pz;
    const pp = v.axis === 0 ? pz : px;
    const k = v.cls + PER * Math.floor((pp / S - v.cls) / PER + 0.5);
    const perp = k * S + v.dir * 2;
    const m = (((pAlong - pa + L / 2) % L) + L) % L;
    const a = m - L / 2 + pa;
    if (v.axis === 0) { v.x = a; v.z = perp; v.yaw = v.dir > 0 ? Math.PI / 2 : -Math.PI / 2; }
    else { v.x = perp; v.z = a; v.yaw = v.dir > 0 ? 0 : Math.PI; }
    v.y3 = v.fly ? v.y + Math.sin(t * 1.7 + v.wob) * 0.35 : 0.42;
    v.frozen = t >= v.fs && t < v.fs + v.dur;
    v.brake = v.frozen || Math.cos(SPEED_W * te + v.wob) < -0.4;
  }

  update(dt: number, time: number): void {
    this.time = time;
    const { player } = this.ctx;
    this.uniforms.uTime.value = time;
    this.uniforms.uPlayer.value.copy(player.pos);
    this.hitCd = Math.max(0, this.hitCd - dt);
    const px = player.pos.x;
    const pz = player.pos.z;
    for (const v of this.vehicles) {
      this.pose(v, time, px, pz);
      if (v.fly || player.dead) continue;
      // Axis-aligned box of the car (heading is along an axis) vs the player circle.
      const hx = v.axis === 0 ? 2.3 : 1.1;
      const hz = v.axis === 0 ? 1.1 : 2.3;
      const dx = px - v.x;
      const dz = pz - v.z;
      if (Math.abs(dx) > hx + 1 || Math.abs(dz) > hz + 1 || player.pos.y > 1.6) continue;
      const cx = Math.max(-hx, Math.min(hx, dx));
      const cz = Math.max(-hz, Math.min(hz, dz));
      const ox = dx - cx;
      const oz = dz - cz;
      const r = 0.55;
      if (ox * ox + oz * oz >= r * r) continue;
      // Solid: push the player out along the shallowest axis.
      const penX = hx + r - Math.abs(dx);
      const penZ = hz + r - Math.abs(dz);
      if (penX < penZ) player.pos.x += Math.sign(dx || 1) * penX;
      else player.pos.z += Math.sign(dz || 1) * penZ;
      if (!v.frozen && this.hitCd <= 0 && player.dashing <= 0) {
        this.hitCd = 1.1;
        player.takeDamage(16, this.tmp.set(v.x, 0, v.z));
        player.vel.x += Math.sign(dx || 1) * (v.axis === 0 ? 3 : 8);
        player.vel.z += Math.sign(dz || 1) * (v.axis === 0 ? 8 : 3);
        this.ctx.audio.honk();
        this.ctx.fx.burst(this.tmp.set(player.pos.x, 0.8, player.pos.z), { color: 0xffaa33, color2: 0xffffff, count: 22, speed: 9, life: 0.4, size: 0.2, gravity: 10 });
      }
    }
  }

  // ───────────────────────────── hacking / queries ─────────────────────────────

  /** Vehicles whose horizontal distance to `center` is within `radius` (poses are refreshed every frame). */
  scan(center: THREE.Vector3, radius: number, out: Vehicle[]): void {
    const r2 = radius * radius;
    for (const v of this.vehicles) {
      const dx = v.x - center.x;
      const dz = v.z - center.z;
      if (dx * dx + dz * dz <= r2) out.push(v);
    }
  }

  /** Stops a vehicle in place for `seconds` (brake lights on) and then lets it resume where it stopped. */
  freeze(v: Vehicle, seconds: number): void {
    const t = this.time;
    if (t >= v.fs && t < v.fs + v.dur) {
      v.dur = t - v.fs + seconds;
    } else {
      v.shift += v.dur;
      v.fs = t;
      v.dur = seconds;
    }
    const a = this.freezeAttrs.get(v.mesh)!;
    a.setXYZ(v.local, v.fs, v.dur, v.shift);
    a.needsUpdate = true;
  }
}
