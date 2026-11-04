import * as THREE from 'three';

export interface BurstOpts {
  color?: THREE.ColorRepresentation;
  color2?: THREE.ColorRepresentation;
  count?: number;
  speed?: number;
  life?: number;
  size?: number;
  gravity?: number;
  drag?: number;
  /** Emit only inside a cone around this direction. */
  dir?: THREE.Vector3;
  cone?: number;
}

const VERT = /* glsl */ `
  attribute float aSize;
  attribute float aAlpha;
  attribute vec3 aColor;
  uniform float uScale;
  varying float vAlpha;
  varying vec3 vColor;
  void main() {
    vAlpha = aAlpha;
    vColor = aColor;
    vec4 mv = modelViewMatrix * vec4(position, 1.0);
    gl_PointSize = max(0.0, aSize * uScale / max(0.1, -mv.z));
    gl_Position = projectionMatrix * mv;
  }
`;

const FRAG = /* glsl */ `
  varying float vAlpha;
  varying vec3 vColor;
  void main() {
    float d = length(gl_PointCoord - 0.5);
    float a = smoothstep(0.5, 0.0, d);
    a *= a;
    if (a < 0.01) discard;
    gl_FragColor = vec4(vColor * (1.0 + a * 2.0), a * vAlpha);
  }
`;

/** GPU-points particle pool with additive glow. One draw call for every spark in the game. */
export class ParticleSystem {
  private readonly cap: number;
  private head = 0;
  private pos: Float32Array;
  private col: Float32Array;
  private size: Float32Array;
  private alpha: Float32Array;
  private vel: Float32Array;
  private life: Float32Array;
  private maxLife: Float32Array;
  private baseSize: Float32Array;
  private grav: Float32Array;
  private drag: Float32Array;
  private geo = new THREE.BufferGeometry();
  private mat: THREE.ShaderMaterial;
  readonly points: THREE.Points;
  private tmpA = new THREE.Color();
  private tmpB = new THREE.Color();
  private tmpV = new THREE.Vector3();
  /** Seconds until every particle is guaranteed dead; lets update() skip all work when idle. */
  private busy = 0;

  constructor(scene: THREE.Scene, cap: number) {
    this.cap = cap;
    this.pos = new Float32Array(cap * 3);
    this.col = new Float32Array(cap * 3);
    this.size = new Float32Array(cap);
    this.alpha = new Float32Array(cap);
    this.vel = new Float32Array(cap * 3);
    this.life = new Float32Array(cap);
    this.maxLife = new Float32Array(cap).fill(1);
    this.baseSize = new Float32Array(cap);
    this.grav = new Float32Array(cap);
    this.drag = new Float32Array(cap);
    for (let i = 0; i < cap; i++) this.pos[i * 3 + 1] = -9999;

    this.geo.setAttribute('position', new THREE.BufferAttribute(this.pos, 3).setUsage(THREE.DynamicDrawUsage));
    this.geo.setAttribute('aColor', new THREE.BufferAttribute(this.col, 3).setUsage(THREE.DynamicDrawUsage));
    this.geo.setAttribute('aSize', new THREE.BufferAttribute(this.size, 1).setUsage(THREE.DynamicDrawUsage));
    this.geo.setAttribute('aAlpha', new THREE.BufferAttribute(this.alpha, 1).setUsage(THREE.DynamicDrawUsage));
    this.geo.boundingSphere = new THREE.Sphere(new THREE.Vector3(), 1e6);

    this.mat = new THREE.ShaderMaterial({
      uniforms: { uScale: { value: 600 } },
      vertexShader: VERT,
      fragmentShader: FRAG,
      transparent: true,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
    });
    this.points = new THREE.Points(this.geo, this.mat);
    this.points.frustumCulled = false;
    this.points.renderOrder = 10;
    scene.add(this.points);
  }

  /** Keeps point sizes consistent with the drawing-buffer height / FOV. */
  setScale(drawingHeight: number, fovDeg: number): void {
    this.mat.uniforms.uScale.value = drawingHeight / (2 * Math.tan(THREE.MathUtils.degToRad(fovDeg) / 2));
  }

  burst(origin: THREE.Vector3, o: BurstOpts = {}): void {
    const count = o.count ?? 20;
    const speed = o.speed ?? 6;
    const lifeBase = o.life ?? 0.6;
    const sizeBase = o.size ?? 0.25;
    this.tmpA.set(o.color ?? 0xffffff);
    this.tmpB.set(o.color2 ?? o.color ?? 0xffffff);
    for (let n = 0; n < count; n++) {
      const i = this.head;
      this.head = (this.head + 1) % this.cap;
      const v = this.tmpV;
      if (o.dir) {
        const c = o.cone ?? 0.5;
        v.set(o.dir.x + (Math.random() - 0.5) * 2 * c, o.dir.y + (Math.random() - 0.5) * 2 * c, o.dir.z + (Math.random() - 0.5) * 2 * c).normalize();
      } else {
        const u = Math.random() * 2 - 1;
        const t = Math.random() * Math.PI * 2;
        const r = Math.sqrt(1 - u * u);
        v.set(r * Math.cos(t), u, r * Math.sin(t));
      }
      const s = speed * (0.35 + Math.random() * 0.65);
      this.pos[i * 3] = origin.x;
      this.pos[i * 3 + 1] = origin.y;
      this.pos[i * 3 + 2] = origin.z;
      this.vel[i * 3] = v.x * s;
      this.vel[i * 3 + 1] = v.y * s;
      this.vel[i * 3 + 2] = v.z * s;
      const l = lifeBase * (0.6 + Math.random() * 0.8);
      this.life[i] = l;
      if (l > this.busy) this.busy = l;
      this.maxLife[i] = l;
      this.baseSize[i] = sizeBase * (0.6 + Math.random() * 0.8);
      this.grav[i] = o.gravity ?? 0;
      this.drag[i] = o.drag ?? 1.5;
      const k = Math.random();
      this.col[i * 3] = this.tmpA.r + (this.tmpB.r - this.tmpA.r) * k;
      this.col[i * 3 + 1] = this.tmpA.g + (this.tmpB.g - this.tmpA.g) * k;
      this.col[i * 3 + 2] = this.tmpA.b + (this.tmpB.b - this.tmpA.b) * k;
    }
  }

  /** Single trailing spark at a point (cheap helper). */
  spark(origin: THREE.Vector3, color: THREE.ColorRepresentation, size = 0.18, life = 0.35): void {
    this.burst(origin, { color, count: 1, speed: 0.6, life, size, drag: 3 });
  }

  update(dt: number): void {
    if (this.busy <= 0) return;
    this.busy -= dt;
    const { pos, vel, life, maxLife, size, alpha, baseSize, grav, drag } = this;
    for (let i = 0; i < this.cap; i++) {
      const l = life[i];
      if (l <= 0) {
        if (size[i] !== 0) { size[i] = 0; alpha[i] = 0; pos[i * 3 + 1] = -9999; }
        continue;
      }
      life[i] = l - dt;
      const k = Math.max(0, 1 - drag[i] * dt);
      vel[i * 3] *= k;
      vel[i * 3 + 1] = vel[i * 3 + 1] * k - grav[i] * dt;
      vel[i * 3 + 2] *= k;
      pos[i * 3] += vel[i * 3] * dt;
      pos[i * 3 + 1] += vel[i * 3 + 1] * dt;
      pos[i * 3 + 2] += vel[i * 3 + 2] * dt;
      if (pos[i * 3 + 1] < 0.02 && grav[i] > 0) {
        pos[i * 3 + 1] = 0.02;
        vel[i * 3 + 1] *= -0.4;
      }
      const t = Math.max(0, life[i] / maxLife[i]);
      alpha[i] = Math.min(1, t * 2);
      size[i] = baseSize[i] * (0.3 + t * 0.7);
    }
    (this.geo.attributes.position as THREE.BufferAttribute).needsUpdate = true;
    (this.geo.attributes.aColor as THREE.BufferAttribute).needsUpdate = true;
    (this.geo.attributes.aSize as THREE.BufferAttribute).needsUpdate = true;
    (this.geo.attributes.aAlpha as THREE.BufferAttribute).needsUpdate = true;
  }

  clear(): void {
    this.life.fill(0);
    this.busy = 0.001;
  }
}
