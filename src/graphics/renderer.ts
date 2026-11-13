import * as THREE from 'three';
import { EffectComposer } from 'three/examples/jsm/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/examples/jsm/postprocessing/RenderPass.js';
import { UnrealBloomPass } from 'three/examples/jsm/postprocessing/UnrealBloomPass.js';
import { ShaderPass } from 'three/examples/jsm/postprocessing/ShaderPass.js';
import { OutputPass } from 'three/examples/jsm/postprocessing/OutputPass.js';
import { CFG, IS_TOUCH, TIER_PROFILES, type Palette } from '../config';

/** Cinematic grade: chromatic aberration, film grain, scanlines, vignette, glitch bands and damage tint. */
const POST_SHADER = {
  uniforms: {
    tDiffuse: { value: null as THREE.Texture | null },
    uTime: { value: 0 },
    uGlitch: { value: 0 },
    uHurt: { value: 0 },
    uAberration: { value: 0.0004 },
    uGrain: { value: 0.01 },
  },
  vertexShader: /* glsl */ `
    varying vec2 vUv;
    void main() { vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }
  `,
  fragmentShader: /* glsl */ `
    uniform sampler2D tDiffuse;
    uniform float uTime;
    uniform float uGlitch;
    uniform float uHurt;
    uniform float uAberration;
    uniform float uGrain;
    varying vec2 vUv;
    float hash(float n) { return fract(sin(n) * 43758.5453123); }
    float hash2(vec2 p) { return fract(sin(dot(p, vec2(12.9898, 78.233))) * 43758.5453); }
    void main() {
      vec2 uv = vUv;
      float g = uGlitch;
      if (g > 0.001) {
        float band = floor(uv.y * 24.0 + floor(uTime * 18.0));
        if (hash(band) > 1.0 - g * 0.55) uv.x += (hash(band + 7.0) - 0.5) * 0.18 * g;
      }
      vec2 dir = uv - 0.5;
      float dist = dot(dir, dir);
      float ab = (uAberration + g * 0.012 + uHurt * 0.006) * (1.0 + dist * 4.0);
      vec3 col;
      col.r = texture2D(tDiffuse, uv + dir * ab).r;
      col.g = texture2D(tDiffuse, uv).g;
      col.b = texture2D(tDiffuse, uv - dir * ab).b;
      float vig = smoothstep(0.95, 0.25, length(dir) * 1.25);
      col *= mix(0.68, 1.0, vig);
      col += vec3(1.0, 0.05, 0.1) * uHurt * (1.0 - vig) * 1.4;
      // Fine film grain, refreshed at 12 Hz so it reads as filmic texture, never as flicker.
      float n = hash2(gl_FragCoord.xy + floor(uTime * 12.0) * 37.0) - 0.5;
      col += n * uGrain * (1.0 - clamp(dot(col, vec3(0.33)), 0.0, 1.0) * 0.6);
      gl_FragColor = vec4(col, 1.0);
    }
  `,
};

enum Tier { Low = 0, Medium = 1, High = 2 }

export const QUALITY_KEY = 'cybernexus_quality';
export type QualitySetting = 'auto' | 'low' | 'medium' | 'high';
export function readQualitySetting(): QualitySetting {
  try {
    const v = localStorage.getItem(QUALITY_KEY);
    return v === 'low' || v === 'medium' || v === 'high' ? v : 'auto';
  } catch { return 'auto'; }
}

export type BloomMode = 'full' | 'reduced' | 'off';

/** WebGL renderer, scene, camera, lights, sky, procedural environment reflections and the post chain. */
export class GfxRenderer {
  readonly renderer: THREE.WebGLRenderer;
  readonly scene = new THREE.Scene();
  readonly camera: THREE.PerspectiveCamera;
  readonly sun: THREE.DirectionalLight;
  readonly hemi: THREE.HemisphereLight;
  readonly composer: EffectComposer;
  readonly gpuName: string;
  private bloom: UnrealBloomPass;
  private post: ShaderPass;
  private sky: THREE.Mesh;
  private skyMat: THREE.ShaderMaterial;
  private stars: THREE.Points;
  private pmrem: THREE.PMREMGenerator;
  private envRT: THREE.WebGLRenderTarget | null = null;
  private resizeCbs: Array<() => void> = [];
  private maxPixelRatio: number;
  private tier: Tier;
  private baseBloom: number;
  private shadowsSupported: boolean;
  private strongGpu = false;
  private rim: THREE.DirectionalLight | null = null;
  private palette: Palette | null = null;
  private starMat!: THREE.PointsMaterial;
  private tmpA = new THREE.Color();
  private tmpB = new THREE.Color();
  /** Sun elevation (-1..1) of the current time of day. */
  sunHeight = -0.5;

  pixelRatio: number;
  bloomMode: BloomMode = 'full';
  glitch = 0;
  hurt = 0;

  constructor(readonly canvas: HTMLCanvasElement) {
    this.renderer = new THREE.WebGLRenderer({ canvas, antialias: false, powerPreference: 'high-performance', stencil: false, alpha: false });
    const gl = this.renderer.getContext();
    const dbg = gl.getExtension('WEBGL_debug_renderer_info');
    this.gpuName = dbg ? String(gl.getParameter(dbg.UNMASKED_RENDERER_WEBGL)) : 'unknown';
    // Quality preset: ?q=low|medium|high, or the menu setting; otherwise guessed from the GPU name.
    const q = new URLSearchParams(location.search).get('q') ?? readQualitySetting();
    const integrated = /intel.*(uhd|iris|hd graphics|xe)|radeon\(tm\) graphics|radeon graphics|vega \d|swiftshader|llvmpipe|microsoft basic/i.test(this.gpuName);
    const discrete = !integrated && /nvidia|geforce|rtx|gtx|quadro|radeon (rx|pro|vii)|intel.*arc|apple (m\d|gpu)/i.test(this.gpuName);
    // Strong GPUs (RTX, RX 5000+, Apple M-series) get 4x MSAA and native resolution; other discrete GPUs 2x.
    this.strongGpu = /rtx|radeon rx ?[5-9]\d{3}|radeon pro|apple m\d/i.test(this.gpuName);
    const auto = IS_TOUCH ? Tier.Low : discrete ? Tier.High : Tier.Medium;
    this.tier = q === 'low' ? Tier.Low : q === 'medium' ? Tier.Medium : q === 'high' ? Tier.High : auto;
    this.shadowsSupported = this.tier !== Tier.Low;
    Object.assign(CFG, TIER_PROFILES[this.tier]);
    this.maxPixelRatio = this.computeMaxRatio();
    this.pixelRatio = this.maxPixelRatio;
    this.renderer.setPixelRatio(this.pixelRatio);
    this.renderer.setSize(window.innerWidth, window.innerHeight, false);
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;
    this.renderer.shadowMap.enabled = this.shadowsSupported;
    this.renderer.shadowMap.type = THREE.PCFShadowMap;
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
    this.renderer.toneMappingExposure = 0.95;
    this.renderer.info.autoReset = false;

    this.scene.background = new THREE.Color(0x05061a);
    this.scene.fog = new THREE.FogExp2(0x05061a, 0.0125);
    this.scene.environmentIntensity = 0.45;

    this.camera = new THREE.PerspectiveCamera(70, window.innerWidth / window.innerHeight, 0.15, 520);
    this.camera.position.set(0, 6, 12);

    this.hemi = new THREE.HemisphereLight(0x5a6bff, 0x120620, 0.55);
    this.scene.add(this.hemi);

    // Directional light: only characters cast shadows, so a high-resolution map over a tight frustum is cheap.
    this.sun = new THREE.DirectionalLight(0x9db4ff, 1.6);
    this.sun.castShadow = this.shadowsSupported;
    const sm = 1024;
    this.sun.shadow.mapSize.set(sm, sm);
    const sc = this.sun.shadow.camera;
    sc.left = -26; sc.right = 26; sc.top = 26; sc.bottom = -26; sc.near = 1; sc.far = 130;
    this.sun.shadow.bias = -0.0006;
    this.sun.shadow.normalBias = 0.04;
    this.scene.add(this.sun, this.sun.target);

    if (this.tier !== Tier.Low) {
      const rim = new THREE.DirectionalLight(0xff2bd6, 0.55);
      rim.position.set(-40, 20, -30);
      this.scene.add(rim);
      this.rim = rim;
    }

    this.skyMat = new THREE.ShaderMaterial({
      side: THREE.BackSide,
      depthWrite: false,
      fog: false,
      uniforms: {
        uTop: { value: new THREE.Color(0x02030c) },
        uMid: { value: new THREE.Color(0x120a3a) },
        uLow: { value: new THREE.Color(0x3a0b4f) },
      },
      vertexShader: /* glsl */ `varying vec3 vP; void main(){ vP = normalize(position); gl_Position = projectionMatrix * modelViewMatrix * vec4(position,1.0); }`,
      fragmentShader: /* glsl */ `
        uniform vec3 uTop; uniform vec3 uMid; uniform vec3 uLow; varying vec3 vP;
        void main(){
          float h = clamp(vP.y, -0.2, 1.0);
          vec3 c = mix(uLow, uMid, smoothstep(-0.2, 0.25, h));
          c = mix(c, uTop, smoothstep(0.2, 0.9, h));
          gl_FragColor = vec4(c, 1.0);
        }`,
    });
    this.sky = new THREE.Mesh(new THREE.SphereGeometry(450, 20, 12), this.skyMat);
    this.sky.renderOrder = -10;
    this.sky.frustumCulled = false;
    this.scene.add(this.sky);

    const starCount = IS_TOUCH ? 250 : 600;
    const sp = new Float32Array(starCount * 3);
    for (let i = 0; i < starCount; i++) {
      const u = Math.random() * 0.95 + 0.05;
      const t = Math.random() * Math.PI * 2;
      const r = Math.sqrt(1 - u * u);
      sp.set([Math.cos(t) * r * 420, u * 420, Math.sin(t) * r * 420], i * 3);
    }
    const sg = new THREE.BufferGeometry();
    sg.setAttribute('position', new THREE.BufferAttribute(sp, 3));
    this.starMat = new THREE.PointsMaterial({ color: 0xbfd0ff, size: 1.4, sizeAttenuation: false, fog: false, transparent: true, opacity: 0.8, depthWrite: false });
    this.stars = new THREE.Points(sg, this.starMat);
    this.stars.frustumCulled = false;
    this.scene.add(this.stars);

    this.pmrem = new THREE.PMREMGenerator(this.renderer);

    // MSAA on a half-float HDR target is expensive: only worth it on discrete GPUs.
    const samples = this.tier === Tier.High ? (this.strongGpu ? 4 : 2) : 0;
    const rt = new THREE.WebGLRenderTarget(1, 1, { type: THREE.HalfFloatType, samples });
    this.composer = new EffectComposer(this.renderer, rt);
    this.composer.setPixelRatio(this.pixelRatio);
    this.composer.setSize(window.innerWidth, window.innerHeight);
    this.composer.addPass(new RenderPass(this.scene, this.camera));
    this.baseBloom = this.tier === Tier.Low ? 0.26 : 0.34;
    this.bloom = new UnrealBloomPass(new THREE.Vector2(256, 256), this.baseBloom, 0.3, 1.35);
    this.composer.addPass(this.bloom);
    this.post = new ShaderPass(POST_SHADER);
    this.composer.addPass(this.post);
    this.composer.addPass(new OutputPass());
    this.applyBloomSize();

    window.addEventListener('resize', this.onResize);
    window.addEventListener('orientationchange', () => window.setTimeout(this.onResize, 200));
  }

  get qualityLabel(): string {
    return ['LOW', 'MEDIUM', 'HIGH'][this.tier];
  }

  onResizeCallback(cb: () => void): void {
    this.resizeCbs.push(cb);
    cb();
  }

  private applyBloomSize(): void {
    const k = this.bloomMode === 'reduced' ? 0.18 : 0.33;
    this.bloom.setSize(Math.max(64, window.innerWidth * this.pixelRatio * k), Math.max(64, window.innerHeight * this.pixelRatio * k));
  }

  /** Largest render scale allowed for the current tier: device ratio, tier cap and a total-pixel budget. */
  private computeMaxRatio(): number {
    const budget = this.tier === Tier.High ? (this.strongGpu ? 9e6 : 4.5e6) : this.tier === Tier.Medium ? 1.9e6 : 1.2e6;
    const cap = this.tier === Tier.High ? 2 : 1.25;
    const fit = Math.sqrt(budget / Math.max(1, window.innerWidth * window.innerHeight));
    return Math.max(0.55, Math.min(window.devicePixelRatio || 1, cap, fit));
  }

  private onResize = (): void => {
    this.maxPixelRatio = this.computeMaxRatio();
    this.pixelRatio = Math.min(this.pixelRatio, this.maxPixelRatio);
    const w = window.innerWidth;
    const h = window.innerHeight;
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
    this.renderer.setPixelRatio(this.pixelRatio);
    this.renderer.setSize(w, h, false);
    this.composer.setPixelRatio(this.pixelRatio);
    this.composer.setSize(w, h);
    this.applyBloomSize();
    this.resizeCbs.forEach((cb) => cb());
  };

  get drawingHeight(): number {
    return window.innerHeight * this.pixelRatio;
  }

  /** Pre-compiles every shader program so the first gameplay frames do not hitch. */
  async warmup(): Promise<void> {
    await this.renderer.compileAsync(this.scene, this.camera);
    this.composer.render(0);
  }

  /** Window interior ray-cast range in metres per quality tier. */
  get interiorRange(): number {
    return this.tier === Tier.High ? 120 : this.tier === Tier.Medium ? 65 : 40;
  }

  /** Night-city palette + procedural neon environment map (real reflections on metal and glass). */
  setTheme(p: Palette): void {
    this.palette = p;
    this.buildEnvironment(p);
    this.setTimeOfDay(0.8);
  }

  /**
   * Day/night cycle. `t` in [0,1): 0 = midnight, 0.25 = sunrise, 0.5 = noon, 0.75 = sunset.
   * Drives sky, fog, sun/moon light and direction, exposure, reflections, stars and bloom.
   * Returns the daylight factor (0..1) and fog density for the city shaders.
   */
  setTimeOfDay(t: number): { day: number; fog: number } {
    const p = this.palette;
    const sunH = Math.sin((t - 0.25) * Math.PI * 2);
    this.sunHeight = sunH;
    const sm = (a: number, b: number, x: number): number => { const k = Math.min(1, Math.max(0, (x - a) / (b - a))); return k * k * (3 - 2 * k); };
    const day = sm(-0.12, 0.32, sunH);
    const twi = Math.max(0, 1 - Math.abs(sunH) / 0.32) * (0.4 + 0.6 * (1 - Math.abs(day - 0.5) * 2));
    const nightFog = p ? this.tmpA.set(p.fog) : this.tmpA.set(0x05061a);

    // sky gradient
    const top = this.skyMat.uniforms.uTop.value as THREE.Color;
    const mid = this.skyMat.uniforms.uMid.value as THREE.Color;
    const low = this.skyMat.uniforms.uLow.value as THREE.Color;
    top.set(0x02030c).lerp(this.tmpB.set(0x3d7be0), day);
    mid.copy(nightFog);
    if (p) mid.lerp(this.tmpB.set(p.primary), 0.18);
    mid.lerp(this.tmpB.set(0x8dbbf2), day).lerp(this.tmpB.set(0xff8a4a), twi * 0.35);
    low.copy(nightFog);
    if (p) low.lerp(this.tmpB.set(p.secondary), 0.35);
    low.lerp(this.tmpB.set(0xcfe2f4), day).lerp(this.tmpB.set(0xff7a3a), twi * 0.7);

    // fog = horizon colour so distant buildings melt into the sky
    const fogC = (this.scene.fog as THREE.FogExp2).color;
    fogC.copy(low).multiplyScalar(0.55 + 0.35 * day);
    (this.scene.background as THREE.Color).copy(fogC);
    const fogD = 0.0125 - 0.0058 * day;
    (this.scene.fog as THREE.FogExp2).density = fogD;

    // lights
    this.hemi.color.set(p ? p.primary : 0x00f0ff).lerp(this.tmpB.set(0x4455ff), 0.5).lerp(this.tmpB.set(0xbcd2ff), day);
    this.hemi.groundColor.set(p ? p.secondary : 0xff2bd6).multiplyScalar(0.18).lerp(this.tmpB.set(0x4a4136), day);
    this.hemi.intensity = 0.55 + 0.75 * day;
    this.sun.color.set(0x9db4ff).lerp(this.tmpB.set(0xfff1da), day).lerp(this.tmpB.set(0xff9a58), twi * 0.6);
    this.sun.intensity = 1.5 + 1.7 * day;
    if (this.rim) this.rim.intensity = 0.55 * (1 - day) + 0.05;
    this.scene.environmentIntensity = 0.45 + 0.5 * day;
    this.renderer.toneMappingExposure = 0.95 - 0.1 * day;
    this.starMat.opacity = 0.8 * (1 - day);
    this.stars.visible = this.starMat.opacity > 0.01;
    const bloomMul = this.bloomMode === 'full' ? 1 : 0.6;
    this.bloom.strength = this.baseBloom * bloomMul * (1 - 0.5 * day);
    this.sunAng = t * Math.PI * 2;
    return { day, fog: fogD };
  }
  private sunAng = 0;

  private buildEnvironment(p: Palette): void {
    const env = new THREE.Scene();
    env.background = new THREE.Color(p.fog).multiplyScalar(0.6);
    const panel = new THREE.PlaneGeometry(1, 1);
    const mats: THREE.Material[] = [];
    const add = (color: number, k: number, x: number, y: number, z: number, sx: number, sy: number): void => {
      const mat = new THREE.MeshBasicMaterial({ color: new THREE.Color(color).multiplyScalar(k), side: THREE.DoubleSide });
      mats.push(mat);
      const m = new THREE.Mesh(panel, mat);
      m.position.set(x, y, z);
      m.scale.set(sx, sy, 1);
      m.lookAt(0, 0, 0);
      env.add(m);
    };
    add(p.primary, 3, 12, 6, 8, 10, 3);
    add(p.secondary, 3, -12, 8, -6, 12, 3);
    add(p.accent, 2.4, 0, 14, -12, 14, 2);
    add(p.primary, 1.8, -10, 3, 12, 8, 2);
    add(p.secondary, 1.8, 10, 2, -12, 8, 2);
    add(0xffffff, 1, 0, 18, 0, 6, 6);
    const rt = this.pmrem.fromScene(env, 0.03);
    this.envRT?.dispose();
    this.envRT = rt;
    this.scene.environment = rt.texture;
    mats.forEach((m) => m.dispose());
    panel.dispose();
  }

  /** Keeps the (small) character shadow frustum centred on the action. */
  followShadow(target: THREE.Vector3): void {
    this.sun.target.position.set(target.x, 0, target.z);
    // Smooth max (no kink when the sun crosses the horizon) keeps the shadow direction continuous.
    const h = 0.25 + (0.75 * Math.log1p(Math.exp(6 * this.sunHeight))) / 6;
    this.sun.position.set(target.x + Math.cos(this.sunAng) * 38, 26 + 30 * h, target.z + 18);
    this.sun.target.updateMatrixWorld();
  }

  /** Lowers quality one notch: resolution first, then bloom, then shadows. Returns a description or null. */
  stepDown(): string | null {
    if (this.pixelRatio > 0.55) {
      this.pixelRatio = Math.max(0.55, this.pixelRatio - 0.15);
      this.onResize();
      return `resolution x${this.pixelRatio.toFixed(2)}`;
    }
    if (this.bloomMode === 'full') {
      this.bloomMode = 'reduced';
      this.bloom.strength = this.baseBloom * 0.6;
      this.applyBloomSize();
      return 'bloom reduced';
    }
    if (this.bloomMode === 'reduced') {
      this.bloomMode = 'off';
      this.bloom.enabled = false;
      return 'bloom off';
    }
    if (this.renderer.shadowMap.enabled) {
      this.renderer.shadowMap.enabled = false;
      this.sun.castShadow = false;
      this.refreshMaterials();
      return 'shadows off';
    }
    return null;
  }

  /** Recovers quality one notch (reverse order of stepDown). */
  stepUp(): string | null {
    if (this.shadowsSupported && !this.renderer.shadowMap.enabled) {
      this.renderer.shadowMap.enabled = true;
      this.sun.castShadow = true;
      this.refreshMaterials();
      return 'shadows on';
    }
    if (this.bloomMode === 'off') {
      this.bloomMode = 'reduced';
      this.bloom.enabled = true;
      return 'bloom reduced';
    }
    if (this.bloomMode === 'reduced') {
      this.bloomMode = 'full';
      this.bloom.strength = this.baseBloom;
      this.applyBloomSize();
      return 'bloom full';
    }
    if (this.pixelRatio < this.maxPixelRatio) {
      this.pixelRatio = Math.min(this.maxPixelRatio, this.pixelRatio + 0.1);
      this.onResize();
      return `resolution x${this.pixelRatio.toFixed(2)}`;
    }
    return null;
  }

  private refreshMaterials(): void {
    this.scene.traverse((o) => {
      const mat = (o as THREE.Mesh).material as THREE.Material | THREE.Material[] | undefined;
      if (!mat) return;
      if (Array.isArray(mat)) mat.forEach((m) => (m.needsUpdate = true));
      else mat.needsUpdate = true;
    });
  }

  render(dt: number, time: number): void {
    this.glitch = Math.max(0, this.glitch - dt * 2.2);
    this.hurt = Math.max(0, this.hurt - dt * 2.4);
    const u = this.post.uniforms;
    u.uTime.value = time;
    // Glitch is hit feedback only: capped so it can never look like a rendering fault.
    u.uGlitch.value = Math.min(this.glitch, 0.3);
    u.uHurt.value = this.hurt;
    this.sky.position.copy(this.camera.position);
    this.stars.position.copy(this.camera.position);
    this.renderer.info.reset();
    this.composer.render(dt);
  }

  get stats(): { calls: number; tris: number } {
    return { calls: this.renderer.info.render.calls, tris: this.renderer.info.render.triangles };
  }
}
