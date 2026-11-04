import * as THREE from 'three';

/**
 * Soft blob shadows under every character: one InstancedMesh (a single draw call) of radial-gradient quads laid just
 * above the asphalt. Gives NPCs, enemies and the player visual weight so they never look like they float.
 */
export class ContactShadows {
  private mesh: THREE.InstancedMesh;
  private n = 0;
  private cap: number;
  private m = new THREE.Matrix4();
  private p = new THREE.Vector3();
  private s = new THREE.Vector3();
  private q = new THREE.Quaternion();
  private opacity: THREE.InstancedBufferAttribute;

  constructor(scene: THREE.Scene, cap = 96) {
    this.cap = cap;
    const c = document.createElement('canvas');
    c.width = c.height = 64;
    const g = c.getContext('2d')!;
    const grad = g.createRadialGradient(32, 32, 0, 32, 32, 32);
    grad.addColorStop(0, 'rgba(0,0,0,0.85)');
    grad.addColorStop(0.45, 'rgba(0,0,0,0.5)');
    grad.addColorStop(1, 'rgba(0,0,0,0)');
    g.fillStyle = grad;
    g.fillRect(0, 0, 64, 64);
    const tex = new THREE.CanvasTexture(c);

    const geo = new THREE.PlaneGeometry(1, 1).rotateX(-Math.PI / 2);
    this.opacity = new THREE.InstancedBufferAttribute(new Float32Array(cap), 1);
    this.opacity.setUsage(THREE.DynamicDrawUsage);
    geo.setAttribute('aOpacity', this.opacity);
    const mat = new THREE.MeshBasicMaterial({ map: tex, transparent: true, depthWrite: false, polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -2 });
    // Per-instance strength via a tiny shader patch (alpha *= aOpacity).
    mat.onBeforeCompile = (shader) => {
      shader.vertexShader = shader.vertexShader
        .replace('#include <common>', '#include <common>\nattribute float aOpacity;\nvarying float vOp;')
        .replace('#include <begin_vertex>', '#include <begin_vertex>\nvOp = aOpacity;');
      shader.fragmentShader = shader.fragmentShader
        .replace('#include <common>', '#include <common>\nvarying float vOp;')
        .replace('#include <opaque_fragment>', '#include <opaque_fragment>\ngl_FragColor.a *= vOp;');
    };
    this.mesh = new THREE.InstancedMesh(geo, mat, cap);
    this.mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    this.mesh.frustumCulled = false;
    this.mesh.renderOrder = 2;
    this.mesh.count = 0;
    scene.add(this.mesh);
  }

  begin(): void {
    this.n = 0;
  }

  add(x: number, z: number, radius: number, strength = 1): void {
    if (this.n >= this.cap) return;
    this.m.compose(this.p.set(x, 0.035, z), this.q, this.s.set(radius * 2.4, 1, radius * 2.4));
    this.mesh.setMatrixAt(this.n, this.m);
    (this.opacity.array as Float32Array)[this.n] = strength;
    this.n++;
  }

  end(): void {
    this.mesh.count = this.n;
    this.mesh.instanceMatrix.needsUpdate = true;
    this.opacity.needsUpdate = true;
  }
}
