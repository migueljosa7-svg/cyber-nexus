import * as THREE from 'three';
import { EffectComposer } from 'three/examples/jsm/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/examples/jsm/postprocessing/RenderPass.js';
import { UnrealBloomPass } from 'three/examples/jsm/postprocessing/UnrealBloomPass.js';
import { ShaderPass } from 'three/examples/jsm/postprocessing/ShaderPass.js';
import { OutputPass } from 'three/examples/jsm/postprocessing/OutputPass.js';
import { CFG, IS_TOUCH, type Palette } from '../config';

const POST_SHADER = {
  uniforms: {
    tDiffuse: { value: null as THREE.Texture | null },
    uTime: { value: 0 },
    uGlitch: { value: 0 },
    uHurt: { value: 0 },
    uAberration: { value: 0.0014 },
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
    varying vec2 vUv;
    float hash(float n) { return fract(sin(n) * 43758.5453123); }
    void main() {
      vec2 uv = vUv;
      float g = uGlitch;
      if (g > 0.001) {
        float band = floor(uv.y * 24.0 + floor(uTime * 18.0));
        float h = hash(band);
        if (h > 1.0 - g * 0.55) uv.x += (hash(band + 7.0) - 0.5) * 0.18 * g;
      }
      vec2 dir = (uv - 0.5);
      float dist = dot(dir, dir);
      float ab = uAberration + g * 0.012 + uHurt * 0.006;
      vec3 col;
      col.r = texture2D(tDiffuse, uv + dir * ab * (1.0 + dist * 4.0)).r;
      col.g = texture2D(tDiffuse, uv).g;
      col.b = texture2D(tDiffuse, uv - dir * ab * (1.0 + dist * 4.0)).b;
      float scan = 0.96 + 0.04 * sin(uv.y * 900.0 + uTime * 6.0);
      col *= scan;
      float vig = smoothstep(0.95, 0.25, length(dir) * 1.25);
      col *= mix(0.55, 1.0, vig);
      col += vec3(1.0, 0.05, 0.1) * uHurt * (1.0 - vig) * 1.4;
      col = mix(col, col.gbr * 1.2, step(1.0 - g * 0.08, hash(floor(uv.y * 60.0) + floor(uTime * 30.0))) * g);
      gl_FragColor = vec4(col, 1.0);
    }
  `,
};

/** Owns the WebGL renderer, scene, camera, lights, sky and the post-processing chain. */
export class GfxRenderer {
  readonly renderer: THREE.WebGLRenderer;
  readonly scene = new THREE.Scene();
  readonly camera: THREE.PerspectiveCamera;
  readonly sun: THREE.DirectionalLight;
  readonly hemi: THREE.HemisphereLight;
  readonly composer: EffectComposer;
  private bloom: UnrealBloomPass;
  private post: ShaderPass;
  private sky: THREE.Mesh;
  private skyMat: THREE.ShaderMaterial;
  private stars: THREE.Points;
  private resizeCbs: Array<() => void> = [];
  private pixelRatio: number;
  private maxPixelRatio: number;
  private fpsAvg = 60;
  private lowTimer = 0;
  private highTimer = 0;

  glitch = 0;
  hurt = 0;

  constructor(readonly canvas: HTMLCanvasElement) {
    this.renderer = new THREE.WebGLRenderer({ canvas, antialias: false, powerPreference: 'high-performance', stencil: false });
    this.maxPixelRatio = Math.min(window.devicePixelRatio || 1, CFG.maxPixelRatio);
    this.pixelRatio = this.maxPixelRatio;
    this.renderer.setPixelRatio(this.pixelRatio);
    this.renderer.setSize(window.innerWidth, window.innerHeight, false);
    this.renderer.shadowMap.enabled = true;
    this.renderer.shadowMap.type = THREE.PCFShadowMap;
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
    this.renderer.toneMappingExposure = 1.05;

    this.scene.background = new THREE.Color(0x05061a);
    this.scene.fog = new THREE.FogExp2(0x05061a, 0.011);

    this.camera = new THREE.PerspectiveCamera(70, window.innerWidth / window.innerHeight, 0.1, 600);
    this.camera.position.set(0, 6, 12);

    this.hemi = new THREE.HemisphereLight(0x5a6bff, 0x120620, 0.9);
    this.scene.add(this.hemi);

    this.sun = new THREE.DirectionalLight(0x9db4ff, 1.5);
    this.sun.position.set(30, 60, 20);
    this.sun.castShadow = true;
    this.sun.shadow.mapSize.set(CFG.shadowMapSize, CFG.shadowMapSize);
    const sc = this.sun.shadow.camera;
    sc.left = -48; sc.right = 48; sc.top = 48; sc.bottom = -48; sc.near = 1; sc.far = 160;
    this.sun.shadow.bias = -0.0006;
    this.sun.shadow.normalBias = 0.04;
    this.scene.add(this.sun, this.sun.target);

    const rim = new THREE.DirectionalLight(0xff2bd6, 0.5);
    rim.position.set(-40, 20, -30);
    this.scene.add(rim);

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
    this.sky = new THREE.Mesh(new THREE.SphereGeometry(400, 24, 16), this.skyMat);
    this.sky.renderOrder = -10;
    this.scene.add(this.sky);

    const starCount = IS_TOUCH ? 300 : 700;
    const sp = new Float32Array(starCount * 3);
    for (let i = 0; i < starCount; i++) {
      const u = Math.random() * 0.95 + 0.05;
      const t = Math.random() * Math.PI * 2;
      const r = Math.sqrt(1 - u * u);
      sp.set([Math.cos(t) * r * 380, u * 380, Math.sin(t) * r * 380], i * 3);
    }
    const sg = new THREE.BufferGeometry();
    sg.setAttribute('position', new THREE.BufferAttribute(sp, 3));
    this.stars = new THREE.Points(sg, new THREE.PointsMaterial({ color: 0xbfd0ff, size: 1.4, sizeAttenuation: false, fog: false, transparent: true, opacity: 0.8, depthWrite: false }));
    this.scene.add(this.stars);

    const rt = new THREE.WebGLRenderTarget(1, 1, { type: THREE.HalfFloatType, samples: IS_TOUCH ? 0 : 4 });
    this.composer = new EffectComposer(this.renderer, rt);
    this.composer.setPixelRatio(this.pixelRatio);
    this.composer.setSize(window.innerWidth, window.innerHeight);
    this.composer.addPass(new RenderPass(this.scene, this.camera));
    this.bloom = new UnrealBloomPass(new THREE.Vector2(window.innerWidth, window.innerHeight), IS_TOUCH ? 0.7 : 0.95, 0.7, 0.82);
    this.composer.addPass(this.bloom);
    this.post = new ShaderPass(POST_SHADER);
    this.composer.addPass(this.post);
    this.composer.addPass(new OutputPass());

    window.addEventListener('resize', this.onResize);
    window.addEventListener('orientationchange', () => window.setTimeout(this.onResize, 200));
  }

  onResizeCallback(cb: () => void): void {
    this.resizeCbs.push(cb);
    cb();
  }

  private onResize = (): void => {
    const w = window.innerWidth;
    const h = window.innerHeight;
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
    this.renderer.setPixelRatio(this.pixelRatio);
    this.renderer.setSize(w, h, false);
    this.composer.setPixelRatio(this.pixelRatio);
    this.composer.setSize(w, h);
    this.resizeCbs.forEach((cb) => cb());
  };

  get drawingHeight(): number {
    return window.innerHeight * this.pixelRatio;
  }

  setTheme(p: Palette): void {
    const fog = new THREE.Color(p.fog);
    (this.scene.background as THREE.Color).copy(fog);
    (this.scene.fog as THREE.FogExp2).color.copy(fog);
    this.skyMat.uniforms.uMid.value.set(p.fog).lerp(new THREE.Color(p.primary), 0.18);
    this.skyMat.uniforms.uLow.value.set(p.fog).lerp(new THREE.Color(p.secondary), 0.35);
    this.hemi.color.set(p.primary).lerp(new THREE.Color(0x4455ff), 0.5);
    this.hemi.groundColor.set(p.secondary).multiplyScalar(0.18);
  }

  /** Keeps the shadow frustum centred on the action. */
  followShadow(target: THREE.Vector3): void {
    this.sun.target.position.set(target.x, 0, target.z);
    this.sun.position.set(target.x + 30, 60, target.z + 20);
    this.sun.target.updateMatrixWorld();
  }

  /** Dynamic resolution: drops pixel ratio when FPS sags, recovers slowly when healthy. */
  private adaptQuality(rawDt: number): void {
    if (rawDt <= 0) return;
    this.fpsAvg += (1 / rawDt - this.fpsAvg) * 0.05;
    if (this.fpsAvg < 46) {
      this.lowTimer += rawDt;
      this.highTimer = 0;
    } else if (this.fpsAvg > 58) {
      this.highTimer += rawDt;
      this.lowTimer = 0;
    } else {
      this.lowTimer = 0;
      this.highTimer = 0;
    }
    if (this.lowTimer > 1.5 && this.pixelRatio > 0.7) {
      this.pixelRatio = Math.max(0.7, this.pixelRatio - 0.15);
      this.lowTimer = 0;
      this.onResize();
    } else if (this.highTimer > 8 && this.pixelRatio < this.maxPixelRatio) {
      this.pixelRatio = Math.min(this.maxPixelRatio, this.pixelRatio + 0.1);
      this.highTimer = 0;
      this.onResize();
    }
  }

  render(dt: number, time: number, rawDt: number): void {
    this.glitch = Math.max(0, this.glitch - dt * 2.2);
    this.hurt = Math.max(0, this.hurt - dt * 2.4);
    const u = this.post.uniforms;
    u.uTime.value = time;
    u.uGlitch.value = this.glitch;
    u.uHurt.value = this.hurt;
    this.sky.position.copy(this.camera.position);
    this.stars.position.copy(this.camera.position);
    this.composer.render(dt);
    this.adaptQuality(rawDt);
  }
}
