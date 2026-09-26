import * as THREE from 'three';

// ---------------------------------------------------------------------------
// Shared glow sprite texture
// ---------------------------------------------------------------------------

let glowTex: THREE.Texture | null = null;
export function glowTexture() {
  if (glowTex) return glowTex;
  const c = document.createElement('canvas');
  c.width = c.height = 128;
  const g = c.getContext('2d')!;
  const grad = g.createRadialGradient(64, 64, 0, 64, 64, 64);
  grad.addColorStop(0, 'rgba(255,255,255,1)');
  grad.addColorStop(0.2, 'rgba(255,255,255,0.55)');
  grad.addColorStop(0.5, 'rgba(255,255,255,0.12)');
  grad.addColorStop(1, 'rgba(255,255,255,0)');
  g.fillStyle = grad;
  g.fillRect(0, 0, 128, 128);
  glowTex = new THREE.CanvasTexture(c);
  glowTex.colorSpace = THREE.SRGBColorSpace;
  return glowTex;
}

// ---------------------------------------------------------------------------
// Sling-ring portal (marks the point where a timeline branches)
// ---------------------------------------------------------------------------

const portalFrag = /* glsl */ `
  uniform vec3 uColor;
  uniform float uTime;
  uniform float uAlpha;
  varying vec2 vUv;
  float ring(float r, float at, float w) { return smoothstep(w, 0.0, abs(r - at)); }
  void main() {
    vec2 p = vUv * 2.0 - 1.0;
    float r = length(p);
    float a = atan(p.y, p.x);
    float v = ring(r, 0.86, 0.05);
    v += ring(r, 0.7, 0.03) * (0.55 + 0.45 * sin(a * 7.0 + uTime * 3.0));
    v += ring(r, 0.53, 0.035) * step(0.0, sin(a * 3.0 - uTime * 2.2)) * 0.8;
    v += ring(r, 0.78, 0.02) * step(0.55, fract(a * 3.8197 + uTime * 0.4)) * 0.7;
    v += ring(r, 0.36, 0.025) * (0.5 + 0.5 * sin(a * 12.0 - uTime * 5.0));
    // sparks spinning off the rim
    float sp = pow(max(0.0, sin(a * 23.0 + uTime * 9.0)), 30.0) * smoothstep(1.0, 0.86, r) * smoothstep(0.8, 0.9, r);
    v += sp * 2.0;
    v += exp(-r * r * 14.0) * 0.55;
    v *= smoothstep(1.0, 0.94, r);
    vec3 col = mix(uColor, vec3(1.0, 0.95, 0.82), 0.4);
    gl_FragColor = vec4(col * v * uAlpha, 1.0);
  }
`;

const portalGeo = new THREE.PlaneGeometry(1, 1);

export class Portal {
  readonly mesh: THREE.Mesh;
  private u: Record<string, THREE.IUniform>;
  private age = 0;

  constructor(
    color: THREE.Color | string,
    private size: number,
    /** seconds; 0 = persistent */
    private life = 0,
  ) {
    this.u = { uColor: { value: new THREE.Color(color) }, uTime: { value: 0 }, uAlpha: { value: 1 } };
    const mat = new THREE.ShaderMaterial({
      uniforms: this.u,
      vertexShader: `varying vec2 vUv; void main(){ vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position,1.0); }`,
      fragmentShader: portalFrag,
      transparent: true,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
      toneMapped: false,
    });
    this.mesh = new THREE.Mesh(portalGeo, mat);
    this.mesh.scale.setScalar(size);
  }

  /** Returns false when a burst portal has finished. */
  update(time: number, dt: number, camera: THREE.Camera) {
    this.mesh.quaternion.copy(camera.quaternion);
    this.u.uTime.value = time;
    if (this.life > 0) {
      this.age += dt;
      const k = this.age / this.life;
      const e = 1 - Math.pow(1 - Math.min(1, k * 1.8), 3);
      this.mesh.scale.setScalar(this.size * (0.2 + e));
      this.u.uAlpha.value = k < 0.55 ? 1 : Math.max(0, 1 - (k - 0.55) / 0.45);
      if (k >= 1) {
        this.dispose();
        return false;
      }
    } else {
      this.mesh.scale.setScalar(this.size * (1 + Math.sin(time * 2) * 0.04));
    }
    return true;
  }

  dispose() {
    (this.mesh.material as THREE.Material).dispose();
    this.mesh.removeFromParent();
  }
}

// ---------------------------------------------------------------------------
// Infinity stones
// ---------------------------------------------------------------------------

const gemGeo = (() => {
  const g = new THREE.IcosahedronGeometry(0.34, 1);
  g.scale(0.8, 1.15, 0.8);
  return g;
})();

const gemMaterials = new Map<string, THREE.MeshPhysicalMaterial>();
function gemMaterial(color: string) {
  let m = gemMaterials.get(color);
  if (!m) {
    const c = new THREE.Color(color);
    m = new THREE.MeshPhysicalMaterial({
      color: c,
      emissive: c,
      emissiveIntensity: 0.35,
      metalness: 0.75,
      roughness: 0.22,
      clearcoat: 0.15,
      clearcoatRoughness: 0.05,
      flatShading: true,
      specularIntensity: 0.6,
      // drawn over the additive streams so the stone keeps its color instead of washing out
      transparent: true,
      depthTest: false,
      depthWrite: false,
    });
    gemMaterials.set(color, m);
  }
  return m;
}

export function makeGem(color: string) {
  const group = new THREE.Group();
  const mesh = new THREE.Mesh(gemGeo, gemMaterial(color));
  const halo = new THREE.Sprite(
    new THREE.SpriteMaterial({
      map: glowTexture(),
      color: new THREE.Color(color),
      blending: THREE.AdditiveBlending,
      depthWrite: false,
      transparent: true,
      opacity: 0.3,
      toneMapped: false,
    }),
  );
  halo.scale.setScalar(1.9);
  halo.renderOrder = 9;
  mesh.renderOrder = 10;
  halo.raycast = () => {};
  group.add(halo, mesh);
  return { group, mesh, halo };
}

/** Ring at a timeline's tip: drag it onto another timeline to merge. */
const tipGeo = new THREE.TorusGeometry(0.34, 0.055, 10, 48);
const tipPickGeo = new THREE.CircleGeometry(0.45, 24);
const tipInnerGeo = new THREE.TorusGeometry(0.22, 0.02, 6, 36);
export function makeTipHandle(color: string) {
  const group = new THREE.Group();
  const c = new THREE.Color(color).multiplyScalar(1.6);
  const ring = new THREE.Mesh(
    tipGeo,
    new THREE.MeshBasicMaterial({ color: c, toneMapped: false, transparent: true, depthTest: false, depthWrite: false }),
  );
  ring.renderOrder = 10;
  ring.raycast = () => {};
  const inner = new THREE.Mesh(
    tipInnerGeo,
    new THREE.MeshBasicMaterial({ color: '#fff4e0', toneMapped: false, transparent: true, opacity: 0.8, depthTest: false, depthWrite: false }),
  );
  inner.renderOrder = 10;
  inner.raycast = () => {};
  // The ring has a hole; an invisible disc makes the whole handle grabbable.
  const mesh = new THREE.Mesh(tipPickGeo, new THREE.MeshBasicMaterial({ colorWrite: false, depthWrite: false, depthTest: false }));
  const halo = new THREE.Sprite(
    new THREE.SpriteMaterial({ map: glowTexture(), color: new THREE.Color(color), blending: THREE.AdditiveBlending, depthWrite: false, transparent: true, opacity: 0.45 }),
  );
  halo.scale.setScalar(1.6);
  halo.raycast = () => {};
  group.add(halo, ring, inner, mesh);
  for (const m of [ring, inner, mesh]) m.userData.disposable = true;
  return { group, mesh, inner };
}

// ---------------------------------------------------------------------------
// Merge braids: a two-colored knot where timelines weave together
// ---------------------------------------------------------------------------

const braidVert = /* glsl */ `
  attribute vec3 aColorA;
  attribute vec3 aColorB;
  varying vec2 vUv;
  varying vec3 vA;
  varying vec3 vB;
  void main() {
    vUv = uv;
    vA = aColorA;
    vB = aColorB;
    vec4 p = vec4(position, 1.0);
    #ifdef USE_INSTANCING
      p = instanceMatrix * p;
    #endif
    gl_Position = projectionMatrix * modelViewMatrix * p;
  }
`;

const braidFrag = /* glsl */ `
  uniform float uTime;
  uniform float uBrightness;
  varying vec2 vUv;
  varying vec3 vA;
  varying vec3 vB;
  void main() {
    float strand = 0.5 + 0.5 * sin(vUv.x * 6.2831 * 3.0);
    vec3 col = mix(vA, vB, smoothstep(0.3, 0.7, strand));
    float pulse = 0.6 + 0.4 * sin(vUv.x * 40.0 - uTime * 6.0);
    gl_FragColor = vec4(col * pulse * 0.9 * uBrightness, 1.0);
  }
`;

export function makeBraids(items: { pos: THREE.Vector3; colors: [string, string] }[], brightness: THREE.IUniform) {
  const geo = new THREE.TorusKnotGeometry(0.34, 0.035, 120, 6, 2, 5);
  geo.rotateY(Math.PI / 2);
  const a = new Float32Array(items.length * 3);
  const b = new Float32Array(items.length * 3);
  const c = new THREE.Color();
  items.forEach((it, i) => {
    c.set(it.colors[0]).lerp(new THREE.Color(1, 1, 1), 0.25);
    a.set([c.r, c.g, c.b], i * 3);
    c.set(it.colors[1]).lerp(new THREE.Color(1, 1, 1), 0.25);
    b.set([c.r, c.g, c.b], i * 3);
  });
  geo.setAttribute('aColorA', new THREE.InstancedBufferAttribute(a, 3));
  geo.setAttribute('aColorB', new THREE.InstancedBufferAttribute(b, 3));
  const mat = new THREE.ShaderMaterial({
    uniforms: { uTime: { value: 0 }, uBrightness: brightness },
    vertexShader: braidVert,
    fragmentShader: braidFrag,
    transparent: true,
    depthWrite: false,
    blending: THREE.AdditiveBlending,
    toneMapped: false,
  });
  const mesh = new THREE.InstancedMesh(geo, mat, Math.max(1, items.length));
  mesh.count = items.length;
  mesh.raycast = () => {};
  mesh.frustumCulled = false;
  return mesh;
}

// ---------------------------------------------------------------------------
// Background
// ---------------------------------------------------------------------------

export function starfield(count = 5000) {
  const pos = new Float32Array(count * 3);
  const col = new Float32Array(count * 3);
  const c = new THREE.Color();
  for (let i = 0; i < count; i++) {
    const v = new THREE.Vector3().randomDirection().multiplyScalar(500 + Math.random() * 700);
    pos.set([v.x, v.y, v.z], i * 3);
    c.setHSL(0.55 + Math.random() * 0.5, 0.5, 0.35 + Math.random() * 0.5);
    col.set([c.r, c.g, c.b], i * 3);
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  geo.setAttribute('color', new THREE.BufferAttribute(col, 3));
  const mat = new THREE.PointsMaterial({
    size: 1.6,
    sizeAttenuation: false,
    vertexColors: true,
    transparent: true,
    opacity: 0.75,
    depthWrite: false,
  });
  return new THREE.Points(geo, mat);
}

/** Faint drifting dust around the timelines for depth. */
export function dust(bounds: THREE.Box3, count = 1800) {
  const size = bounds.getSize(new THREE.Vector3());
  const pos = new Float32Array(count * 3);
  for (let i = 0; i < count; i++) {
    pos.set(
      [
        bounds.min.x + Math.random() * size.x,
        bounds.min.y + Math.random() * size.y,
        bounds.min.z + Math.random() * size.z,
      ],
      i * 3,
    );
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  const mat = new THREE.PointsMaterial({
    size: 0.08,
    map: glowTexture(),
    color: new THREE.Color('#ffc58a'),
    transparent: true,
    opacity: 0.35,
    depthWrite: false,
    blending: THREE.AdditiveBlending,
  });
  return new THREE.Points(geo, mat);
}
