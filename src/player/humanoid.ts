import * as THREE from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';

/**
 * Procedural humanoid: one continuous skinned body (no floating primitives), layered clothing (hoodie, trousers,
 * boots, gloves, hair), five armour tiers and a cloth-simulated cape. Everything is generated at load time:
 * no asset downloads, ~3k vertices, ~8 draw calls for the body.
 *
 * Rest pose: standing, arms hanging, facing +Z, feet on y = 0, ~1.85 m tall.
 */

export interface HumanoidRig {
  hips: THREE.Bone;
  spine: THREE.Bone;
  head: THREE.Bone;
  shoulderL: THREE.Bone;
  shoulderR: THREE.Bone;
  elbowL: THREE.Bone;
  elbowR: THREE.Bone;
  hipL: THREE.Bone;
  hipR: THREE.Bone;
  kneeL: THREE.Bone;
  kneeR: THREE.Bone;
}

export interface HumanoidMaterials {
  skin: THREE.Material;
  hoodie: THREE.Material;
  pants: THREE.Material;
  dark: THREE.Material;
  hair: THREE.Material;
  armor: THREE.Material;
  glow: THREE.Material;
  glow2: THREE.Material;
  visor: THREE.Material;
  cape: THREE.Material;
}

export interface Humanoid {
  rig: HumanoidRig;
  /** Skinned meshes: [0] body, then one per armour tier (toggle `.visible`). */
  body: THREE.SkinnedMesh;
  tiers: THREE.SkinnedMesh[];
  cape: Cape;
}

type Skin = Array<[number, number]>;
type SkinFn = (y: number) => Skin;

const B = { hips: 0, spine: 1, head: 2, shL: 3, elL: 4, shR: 5, elR: 6, hipL: 7, knL: 8, hipR: 9, knR: 10 } as const;
const clamp01 = (x: number): number => Math.min(1, Math.max(0, x));

/** Adds skinIndex/skinWeight attributes from a per-vertex-height weighting function. */
function skinGeo(geo: THREE.BufferGeometry, fn: SkinFn): THREE.BufferGeometry {
  const pos = geo.attributes.position;
  const idx = new Uint16Array(pos.count * 4);
  const w = new Float32Array(pos.count * 4);
  for (let i = 0; i < pos.count; i++) {
    const s = fn(pos.getY(i)).filter((e) => e[1] > 1e-4).sort((a, b) => b[1] - a[1]).slice(0, 4);
    let sum = 0;
    for (const e of s) sum += e[1];
    for (let k = 0; k < 4; k++) {
      idx[i * 4 + k] = s[k] ? s[k][0] : 0;
      w[i * 4 + k] = s[k] ? s[k][1] / sum : 0;
    }
  }
  geo.setAttribute('skinIndex', new THREE.BufferAttribute(idx, 4));
  geo.setAttribute('skinWeight', new THREE.BufferAttribute(w, 4));
  if (!geo.attributes.uv) geo.setAttribute('uv', new THREE.BufferAttribute(new Float32Array(pos.count * 2), 2));
  return geo;
}

const rigid = (bone: number): SkinFn => () => [[bone, 1]];

/** Surface of revolution from [radius, y] points (ascending y, closed with r = 0 at both ends), squashed in Z. */
function lathe(points: Array<[number, number]>, zRatio: number, cx: number, cz: number, fn: SkinFn, segs = 14): THREE.BufferGeometry {
  const g = new THREE.LatheGeometry(points.map(([r, y]) => new THREE.Vector2(Math.max(r, 0.0001), y)), segs);
  g.scale(1, 1, zRatio);
  g.translate(cx, 0, cz);
  return skinGeo(g, fn);
}

function ellipsoid(cx: number, cy: number, cz: number, rx: number, ry: number, rz: number, fn: SkinFn, segs = 12): THREE.BufferGeometry {
  const g = new THREE.SphereGeometry(1, segs, Math.max(6, Math.round(segs * 0.7)));
  g.scale(rx, ry, rz);
  g.translate(cx, cy, cz);
  return skinGeo(g, fn);
}

function box(cx: number, cy: number, cz: number, sx: number, sy: number, sz: number, bone: number, rx = 0, ry = 0, rz = 0): THREE.BufferGeometry {
  const g = new THREE.BoxGeometry(sx, sy, sz);
  if (rx || ry || rz) g.applyMatrix4(new THREE.Matrix4().makeRotationFromEuler(new THREE.Euler(rx, ry, rz)));
  g.translate(cx, cy, cz);
  return skinGeo(g, rigid(bone));
}

function xform(g: THREE.BufferGeometry, fn: SkinFn, x: number, y: number, z: number, rx = 0, ry = 0, rz = 0): THREE.BufferGeometry {
  if (rx || ry || rz) g.applyMatrix4(new THREE.Matrix4().makeRotationFromEuler(new THREE.Euler(rx, ry, rz)));
  g.translate(x, y, z);
  return skinGeo(g, fn);
}

// ───────────────────────────── bone weighting by region ─────────────────────────────

const torsoSkin: SkinFn = (y) => { const s = clamp01((y - 0.93) / 0.14); return [[B.hips, 1 - s], [B.spine, s]]; };
const neckSkin: SkinFn = (y) => { const h = clamp01((y - 1.6) / 0.06); return [[B.spine, 1 - h], [B.head, h]]; };

function armSkin(sh: number, el: number): SkinFn {
  return (y) => {
    const e = clamp01((1.27 - y) / 0.1);
    const s = clamp01((y - 1.46) / 0.12) * 0.55;
    return [[B.spine, s], [sh, (1 - e) * (1 - s)], [el, e * (1 - s)]];
  };
}

function legSkin(hip: number, kn: number): SkinFn {
  return (y) => {
    const k = clamp01((0.52 - y) / 0.1);
    const h = clamp01((y - 0.86) / 0.1) * 0.55;
    return [[B.hips, h], [hip, (1 - k) * (1 - h)], [kn, k * (1 - h)]];
  };
}

/** Radius profile from sparse [y, r] keys, closed with small end caps. Returns [r, y] with ascending y. */
function prof(keys: Array<[number, number]>): Array<[number, number]> {
  const [y0, r0] = keys[0];
  const [y1, r1] = keys[keys.length - 1];
  return [[0, y0 - 0.012], [r0 * 0.6, y0 - 0.004], ...keys.map(([y, r]) => [r, y] as [number, number]), [r1 * 0.6, y1 + 0.004], [0, y1 + 0.012]];
}

// ───────────────────────────── builder ─────────────────────────────

function makeSkinned(geos: THREE.BufferGeometry[], mats: THREE.Material[], skeleton: THREE.Skeleton, root: THREE.Bone): THREE.SkinnedMesh {
  const merged = mergeGeometries(geos, true);
  if (!merged) throw new Error('humanoid: merge failed');
  const mesh = new THREE.SkinnedMesh(merged, mats);
  mesh.add(root);
  mesh.bind(skeleton, new THREE.Matrix4());
  mesh.castShadow = true;
  mesh.frustumCulled = false;
  return mesh;
}

export function buildHumanoid(m: HumanoidMaterials): Humanoid {
  // ── skeleton (positions are parent-relative; world rest pose is what the meshes below are modelled in)
  const bone = (x: number, y: number, z: number): THREE.Bone => { const b = new THREE.Bone(); b.position.set(x, y, z); return b; };
  const hips = bone(0, 0.95, 0);
  const spine = bone(0, 0.1, 0);
  const head = bone(0, 0.57, 0);
  const shoulderL = bone(-0.215, 0.45, 0);
  const elbowL = bone(0, -0.28, 0);
  const shoulderR = bone(0.215, 0.45, 0);
  const elbowR = bone(0, -0.28, 0);
  const hipL = bone(-0.1, -0.06, 0);
  const kneeL = bone(0, -0.43, 0);
  const hipR = bone(0.1, -0.06, 0);
  const kneeR = bone(0, -0.43, 0);
  hips.add(spine, hipL, hipR);
  spine.add(head, shoulderL, shoulderR);
  shoulderL.add(elbowL);
  shoulderR.add(elbowR);
  hipL.add(kneeL);
  hipR.add(kneeR);
  const bones = [hips, spine, head, shoulderL, elbowL, shoulderR, elbowR, hipL, kneeL, hipR, kneeR];
  hips.updateMatrixWorld(true);
  const skeleton = new THREE.Skeleton(bones);

  const armL = armSkin(B.shL, B.elL);
  const armR = armSkin(B.shR, B.elR);
  const legL = legSkin(B.hipL, B.knL);
  const legR = legSkin(B.hipR, B.knR);

  // ── SKIN: neck, head, face details, hands
  const skin: THREE.BufferGeometry[] = [];
  skin.push(lathe(prof([[1.58, 0.058], [1.66, 0.05], [1.72, 0.052]]), 1, 0, 0.005, neckSkin, 12));
  skin.push(ellipsoid(0, 1.785, 0.012, 0.105, 0.125, 0.118, rigid(B.head), 16));
  skin.push(ellipsoid(0, 1.735, 0.082, 0.082, 0.07, 0.05, rigid(B.head), 10)); // jaw / cheeks
  skin.push(ellipsoid(0, 1.765, 0.128, 0.016, 0.024, 0.02, rigid(B.head), 8)); // nose
  skin.push(ellipsoid(-0.108, 1.775, 0.0, 0.014, 0.028, 0.02, rigid(B.head), 8)); // ears
  skin.push(ellipsoid(0.108, 1.775, 0.0, 0.014, 0.028, 0.02, rigid(B.head), 8));
  skin.push(ellipsoid(-0.215, 0.9, 0.012, 0.042, 0.075, 0.034, rigid(B.elL), 10)); // hands
  skin.push(ellipsoid(0.215, 0.9, 0.012, 0.042, 0.075, 0.034, rigid(B.elR), 10));

  // ── HOODIE: torso, sleeves, hood, kangaroo pocket
  const hood: THREE.BufferGeometry[] = [];
  hood.push(lathe(prof([[0.9, 0.172], [1.0, 0.152], [1.1, 0.15], [1.3, 0.19], [1.46, 0.2], [1.56, 0.17], [1.62, 0.085]]), 0.62, 0, 0, torsoSkin, 18));
  for (const [sx, sk] of [[-1, armL], [1, armR]] as const) {
    hood.push(lathe(prof([[0.9, 0.05], [0.96, 0.048], [1.1, 0.056], [1.25, 0.062], [1.4, 0.07], [1.52, 0.085]]), 1, sx * 0.215, 0, sk, 12));
  }
  hood.push(ellipsoid(0, 1.66, -0.045, 0.13, 0.085, 0.12, rigid(B.spine), 12)); // hood bundle at the nape
  hood.push(box(0, 1.1, 0.108, 0.3, 0.12, 0.05, B.spine)); // kangaroo pocket
  const pants: THREE.BufferGeometry[] = [];
  for (const [sx, sk] of [[-1, legL], [1, legR]] as const) {
    pants.push(lathe(prof([[0.07, 0.052], [0.12, 0.055], [0.3, 0.07], [0.46, 0.08], [0.62, 0.09], [0.8, 0.106], [0.93, 0.11]]), 1.0, sx * 0.1, 0, sk, 14));
  }
  pants.push(lathe(prof([[0.86, 0.175], [0.96, 0.178]]), 0.64, 0, 0, torsoSkin, 18));

  // ── DARK (boots, gloves, belt)
  const dark: THREE.BufferGeometry[] = [];
  for (const [sx, sk, kn] of [[-1, legL, B.knL], [1, legR, B.knR]] as const) {
    dark.push(lathe(prof([[0.03, 0.064], [0.14, 0.066], [0.27, 0.074]]), 1.0, sx * 0.1, 0.0, sk, 12)); // boot shaft
    dark.push(ellipsoid(sx * 0.1, 0.045, 0.06, 0.062, 0.045, 0.135, rigid(kn), 10)); // boot toe
    dark.push(box(sx * 0.1, 0.012, 0.015, 0.125, 0.026, 0.3, kn)); // sole
  }
  for (const [sx, sk] of [[-1, armL], [1, armR]] as const) {
    dark.push(lathe(prof([[0.84, 0.04], [0.9, 0.05], [0.97, 0.048]]), 1, sx * 0.215, 0.012, sk, 10)); // glove cuff
  }
  dark.push(box(0, 1.0, 0, 0.36, 0.04, 0.22, B.hips)); // belt

  // ── HAIR + visor + LED details
  const hair: THREE.BufferGeometry[] = [];
  const hairCap = new THREE.SphereGeometry(1, 16, 8, 0, Math.PI * 2, 0, Math.PI * 0.62);
  hair.push(xform(hairCap.scale(0.112, 0.13, 0.126), rigid(B.head), 0, 1.795, 0));
  hair.push(ellipsoid(0, 1.8, -0.09, 0.1, 0.1, 0.07, rigid(B.head), 10));
  const visor = [box(0, 1.79, 0.108, 0.17, 0.034, 0.03, B.head)];
  const glow: THREE.BufferGeometry[] = [
    box(0, 1.34, 0.113, 0.1, 0.1, 0.02, B.spine), // chest core
    box(0, 1.56, 0.0, 0.2, 0.014, 0.12, B.spine), // collar line
    box(-0.1, 0.17, 0.065, 0.1, 0.02, 0.02, B.knL), box(0.1, 0.17, 0.065, 0.1, 0.02, 0.02, B.knR), // shin lights
    box(-0.215, 1.0, 0.0, 0.11, 0.014, 0.11, B.elL), box(0.215, 1.0, 0.0, 0.11, 0.014, 0.11, B.elR), // cuff lines
  ];
  const glow2: THREE.BufferGeometry[] = [
    box(-0.118, 1.775, 0.0, 0.012, 0.05, 0.05, B.head), box(0.118, 1.775, 0.0, 0.012, 0.05, 0.05, B.head),
    box(0, 1.2, -0.125, 0.18, 0.012, 0.02, B.spine), box(0, 1.14, -0.125, 0.18, 0.012, 0.02, B.spine),
  ];

  const bodyGeos = [skin, hood, pants, dark, hair, visor, glow, glow2];
  const bodyMats = [m.skin, m.hoodie, m.pants, m.dark, m.hair, m.visor, m.glow, m.glow2];
  const merged = bodyGeos.map((l) => mergeGeometries(l, false)!);
  const body = makeSkinned(merged, bodyMats, skeleton, hips);

  // ── ARMOUR TIERS (each is one skinned mesh over the same skeleton: armour + glow2 + glow)
  const tierGeo = (armor: THREE.BufferGeometry[], g1: THREE.BufferGeometry[], g2: THREE.BufferGeometry[]): THREE.SkinnedMesh => {
    const a = mergeGeometries(armor, false)!;
    const b = mergeGeometries(g1.length ? g1 : [box(0, 0, 0, 0.001, 0.001, 0.001, B.hips)], false)!;
    const c = g2.length ? mergeGeometries(g2, false)! : null;
    const list = c ? [a, b, c] : [a, b];
    const mesh = new THREE.SkinnedMesh(mergeGeometries(list, true)!, c ? [m.armor, m.glow, m.glow2] : [m.armor, m.glow]);
    mesh.frustumCulled = false;
    mesh.castShadow = true;
    mesh.bind(skeleton, new THREE.Matrix4());
    mesh.visible = false;
    return mesh;
  };
  const pauldron = (sx: number, sh: number): THREE.BufferGeometry =>
    xform(new THREE.SphereGeometry(1, 14, 8, 0, Math.PI * 2, 0, Math.PI * 0.55).scale(0.125, 0.085, 0.13), rigid(sh), sx * 0.235, 1.53, 0, 0, 0, sx * -0.35);
  const t1 = tierGeo(
    [pauldron(-1, B.shL), pauldron(1, B.shR),
      xform(new THREE.CylinderGeometry(0.058, 0.05, 0.16, 12), rigid(B.elL), -0.215, 1.02, 0), xform(new THREE.CylinderGeometry(0.058, 0.05, 0.16, 12), rigid(B.elR), 0.215, 1.02, 0)],
    [box(-0.235, 1.6, 0, 0.17, 0.012, 0.15, B.shL, 0, 0, 0.35), box(0.235, 1.6, 0, 0.17, 0.012, 0.15, B.shR, 0, 0, -0.35)], []);
  const t2 = tierGeo(
    [xform(new THREE.SphereGeometry(1, 16, 10).scale(0.19, 0.17, 0.085), rigid(B.spine), 0, 1.36, 0.075),
      xform(new THREE.SphereGeometry(1, 14, 8).scale(0.16, 0.08, 0.08), rigid(B.hips), 0, 1.05, 0.1),
      xform(new THREE.SphereGeometry(1, 10, 8).scale(0.072, 0.07, 0.075), rigid(B.knL), -0.1, 0.47, 0.03),
      xform(new THREE.SphereGeometry(1, 10, 8).scale(0.072, 0.07, 0.075), rigid(B.knR), 0.1, 0.47, 0.03)],
    [], [box(0, 1.36, 0.155, 0.22, 0.016, 0.01, B.spine), box(0, 1.3, 0.158, 0.16, 0.012, 0.01, B.spine)]);
  const spike = (sx: number, sh: number): THREE.BufferGeometry =>
    xform(new THREE.ConeGeometry(0.035, 0.24, 8), rigid(sh), sx * 0.27, 1.68, 0, 0, 0, sx * -0.5);
  const t3 = tierGeo(
    [xform(new THREE.SphereGeometry(1, 14, 8, 0, Math.PI * 2, 0, Math.PI * 0.5).scale(0.122, 0.08, 0.126), rigid(B.head), 0, 1.84, 0.005),
      box(0, 1.76, 0.12, 0.2, 0.01, 0.02, B.head)],
    [], [spike(-1, B.shL), spike(1, B.shR), box(0, 1.9, -0.02, 0.02, 0.07, 0.2, B.head)]);
  const wing = (sx: number): THREE.BufferGeometry => box(sx * 0.17, 1.3, -0.17, 0.035, 0.46, 0.14, B.spine, 0, 0, sx * -0.28);
  const t4 = tierGeo(
    [wing(-1), wing(1), box(0, 1.28, -0.13, 0.16, 0.3, 0.06, B.spine)],
    [box(-0.2, 1.3, -0.245, 0.012, 0.4, 0.012, B.spine, 0, 0, 0.28), box(0.2, 1.3, -0.245, 0.012, 0.4, 0.012, B.spine, 0, 0, -0.28)], []);
  const halo = xform(new THREE.TorusGeometry(0.27, 0.016, 8, 36).rotateX(Math.PI / 2), rigid(B.head), 0, 2.05, 0);
  const t5 = tierGeo(
    [xform(new THREE.CylinderGeometry(0.06, 0.07, 0.07, 10), rigid(B.spine), 0, 1.62, 0)],
    [halo], [box(-0.1, 2.02, 0, 0.016, 0.14, 0.016, B.head), box(0.1, 2.02, 0, 0.016, 0.14, 0.016, B.head)]);
  const tiers = [t1, t2, t3, t4, t5];
  tiers.forEach((t) => body.add(t));

  const cape = new Cape(m.cape);
  spine.add(cape.mesh);

  return { rig: { hips, spine, head, shoulderL, shoulderR, elbowL, elbowR, hipL, hipR, kneeL, kneeR }, body, tiers, cape };
}

/** Cloth cape simulated on the CPU (a 7×9 grid): trails behind the runner, flutters with speed, hangs when idle. */
export class Cape {
  readonly mesh: THREE.Mesh;
  visible = false;
  private geo: THREE.PlaneGeometry;
  private cols = 6;
  private rows = 8;
  private lag = 0;

  constructor(mat: THREE.Material) {
    this.geo = new THREE.PlaneGeometry(0.46, 1.05, this.cols, this.rows);
    this.mesh = new THREE.Mesh(this.geo, mat);
    this.mesh.frustumCulled = false;
    this.mesh.castShadow = true;
    this.mesh.visible = false;
  }

  /** `speed` 0..1.4 (run intensity), `vy` vertical velocity, `turn` angular velocity (rad/s). */
  update(dt: number, t: number, speed: number, vy: number, turn: number): void {
    this.mesh.visible = this.visible;
    if (!this.visible) return;
    this.lag += (clampTo(turn, -3, 3) * 0.12 - this.lag) * Math.min(1, dt * 6);
    const pos = this.geo.attributes.position as THREE.BufferAttribute;
    const cols = this.cols;
    const rows = this.rows;
    for (let r = 0; r <= rows; r++) {
      const k = r / rows;
      for (let c = 0; c <= cols; c++) {
        const i = r * (cols + 1) + c;
        const u = c / cols - 0.5;
        // Anchored at the shoulders (y = 1.58), hangs down; further down = more drag, flutter and trailing.
        const y = 0.53 - k * 1.02; // spine-local: shoulders at +0.53
        const trail = k * k * (0.12 + speed * 0.42) + k * Math.max(0, vy) * 0.01;
        const flutter = Math.sin(t * (7 + speed * 6) + k * 5 + u * 4) * 0.035 * k * (0.3 + speed);
        const x = u * (0.46 + k * 0.14) + this.lag * k * k;
        pos.setXYZ(i, x, y, -0.17 - trail - flutter - k * 0.04);
      }
    }
    pos.needsUpdate = true;
    this.geo.computeVertexNormals();
  }
}

const clampTo = (v: number, a: number, b: number): number => Math.min(b, Math.max(a, v));
