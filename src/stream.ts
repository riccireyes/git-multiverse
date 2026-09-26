import * as THREE from 'three';

export type StreamKind = 'main' | 'branch' | 'merged' | 'link';

const HOT = new THREE.Color(1, 0.97, 0.92);

const STYLE = {
  main: { core: 0.2, glow: 0.75, spread: 1.25, density: 16, filaments: 8, intensity: 1.0 },
  branch: { core: 0.13, glow: 0.5, spread: 0.85, density: 12, filaments: 5, intensity: 1.0 },
  merged: { core: 0.08, glow: 0.3, spread: 0.45, density: 5, filaments: 1, intensity: 0.6 },
  link: { core: 0.06, glow: 0.25, spread: 0.35, density: 5, filaments: 2, intensity: 0.7 },
} as const;

/** Uniforms shared by every stream (brightness is driven by settings + camera distance). */
export const globalUniforms = {
  uBrightness: { value: 1 },
};

// ---------------------------------------------------------------------------
// Shaders
// ---------------------------------------------------------------------------

// Shared color logic: nexus events pulse the timeline towards red.
const colorChunk = /* glsl */ `
  uniform vec3 uColor;
  uniform vec3 uHot;
  uniform float uNexus;
  uniform float uTime;
  uniform float uBrightness;
  uniform float uDim;
  vec3 baseColor() {
    float pulse = 0.65 + 0.35 * sin(uTime * 6.0);
    return mix(uColor, vec3(1.0, 0.07, 0.04), clamp(uNexus * pulse, 0.0, 1.0));
  }
  vec3 hotColor() {
    return mix(uHot, vec3(1.0, 0.3, 0.25), clamp(uNexus, 0.0, 1.0) * 0.9);
  }
  float gain() { return uBrightness * uDim; }
`;

const particleVert = /* glsl */ `
  uniform sampler2D uPath;
  uniform float uN;
  uniform float uTime;
  uniform float uPixel;
  uniform float uGrow;
  uniform float uHighlight;
  uniform float uFadeIn;
  uniform float uFadeOut;
  uniform float uCore;
  attribute float aT;
  attribute float aSpeed;
  attribute float aRadius;
  attribute float aAngle;
  attribute float aSpin;
  attribute float aSize;
  attribute float aSeed;
  varying float vAlpha;
  varying float vHot;

  vec3 fetchRow(int row, float t) {
    float f = clamp(t, 0.0, 1.0) * (uN - 1.0);
    int i = int(floor(f));
    int j = min(i + 1, int(uN) - 1);
    return mix(texelFetch(uPath, ivec2(i, row), 0).xyz, texelFetch(uPath, ivec2(j, row), 0).xyz, fract(f));
  }

  void main() {
    float t = fract(aT + uTime * aSpeed);
    vec3 P = fetchRow(0, t);
    vec3 N = fetchRow(1, t);
    vec3 B = fetchRow(2, t);
    float r = aRadius * (0.7 + 0.3 * sin(uTime * 1.3 + aSeed * 6.2831));
    r *= 1.0 + uHighlight * 0.35;
    float a = aAngle + uTime * aSpin;
    vec3 pos = P + (N * cos(a) + B * sin(a)) * r;
    vec4 mv = modelViewMatrix * vec4(pos, 1.0);
    gl_Position = projectionMatrix * mv;

    float ends = smoothstep(0.0, uFadeIn, t) * smoothstep(1.0, 1.0 - uFadeOut, t);
    float grown = 1.0 - smoothstep(uGrow - 0.004, uGrow, t);
    float twinkle = 0.55 + 0.45 * sin(uTime * (2.0 + aSeed * 4.0) + aSeed * 40.0);
    vHot = 1.0 - smoothstep(0.0, uCore * 2.5, aRadius);
    vAlpha = ends * grown * twinkle * (1.0 + uHighlight * 0.3);
    gl_PointSize = min(aSize * uPixel * (60.0 / -mv.z), 40.0);
  }
`;

const particleFrag = /* glsl */ `
  ${colorChunk}
  varying float vAlpha;
  varying float vHot;
  void main() {
    float d = length(gl_PointCoord - 0.5);
    float g = smoothstep(0.5, 0.0, d);
    g *= g;
    vec3 col = mix(baseColor(), hotColor(), vHot * 0.45);
    gl_FragColor = vec4(col * g * vAlpha * 0.6 * gain(), 1.0);
  }
`;

const tubeVert = /* glsl */ `
  varying vec2 vUv;
  varying vec3 vN;
  varying vec3 vV;
  void main() {
    vUv = uv;
    vec4 mv = modelViewMatrix * vec4(position, 1.0);
    vN = normalize(normalMatrix * normal);
    vV = normalize(-mv.xyz);
    gl_Position = projectionMatrix * mv;
  }
`;

const tubeFrag = /* glsl */ `
  ${colorChunk}
  uniform float uLen;
  uniform float uPow;
  uniform float uWhite;
  uniform float uIntensity;
  uniform float uGrow;
  uniform float uHighlight;
  uniform float uFadeIn;
  uniform float uFadeOut;
  varying vec2 vUv;
  varying vec3 vN;
  varying vec3 vV;
  void main() {
    if (vUv.x > uGrow) discard;
    float facing = abs(dot(normalize(vN), normalize(vV)));
    float core = pow(facing, uPow);
    float s = vUv.x * uLen;
    float flow = 0.7 + 0.3 * sin(s * 1.1 - uTime * 7.0) * sin(s * 0.31 - uTime * 2.1 + 1.3);
    float ends = smoothstep(0.0, uFadeIn, vUv.x) * smoothstep(1.0, 1.0 - uFadeOut, vUv.x);
    // the growing edge of a timeline burns brighter
    float edge = uGrow < 1.0 ? smoothstep(uGrow - 0.02, uGrow, vUv.x) * 1.5 : 0.0;
    vec3 col = mix(baseColor(), hotColor(), core * uWhite);
    float a = core * (flow + edge) * ends * uIntensity * (1.0 + uHighlight * 0.35);
    gl_FragColor = vec4(col * a * gain(), 1.0);
  }
`;

const filamentFrag = /* glsl */ `
  ${colorChunk}
  uniform float uLen;
  uniform float uSeed;
  uniform float uSpeed;
  uniform float uGrow;
  uniform float uHighlight;
  uniform float uFadeIn;
  uniform float uFadeOut;
  varying vec2 vUv;
  void main() {
    if (vUv.x > uGrow) discard;
    float s = fract(vUv.x * uLen * 0.045 - uTime * uSpeed + uSeed);
    float streak = smoothstep(0.0, 0.08, s) * smoothstep(0.55, 0.1, s);
    float ends = smoothstep(0.0, uFadeIn, vUv.x) * smoothstep(1.0, 1.0 - uFadeOut, vUv.x);
    vec3 col = mix(baseColor(), hotColor(), streak * 0.5);
    gl_FragColor = vec4(col * streak * ends * (1.0 + uHighlight * 0.5) * gain(), 1.0);
  }
`;

// ---------------------------------------------------------------------------

const additive = {
  transparent: true,
  depthWrite: false,
  blending: THREE.AdditiveBlending,
  toneMapped: false,
} as const;

export interface StreamOptions {
  id: string;
  kind: StreamKind;
  color: string;
  samples: THREE.Vector3[];
  fadeIn?: boolean;
  fadeOut?: boolean;
}

/** One glowing timeline: fiery core, halo, flowing particles and spiralling filaments. */
export class Stream {
  readonly group = new THREE.Group();
  readonly curve: THREE.CatmullRomCurve3;
  readonly length: number;
  /** Invisible fat tube used for hover / drop picking. */
  readonly pick: THREE.Mesh;
  readonly color: THREE.Color;
  private shared: Record<string, THREE.IUniform>;
  private disposables: { dispose(): void }[] = [];
  private highlight = 0;
  highlightTarget = 0;
  private dim = 1;
  dimTarget = 1;
  /** Persistent nexus level (divergence) + a decaying flash (conflicts). */
  nexusLevel = 0;
  private flash = 0;
  private grow = 1;
  private growFrom = 1;
  private growT = 1;
  private cutoff = 1;
  /** Arc-length fraction at each input sample, for mapping x -> position along the stream. */
  private sampleX: number[];
  private sampleFrac: number[];

  constructor(
    readonly opts: StreamOptions,
    pixelRatio: number,
  ) {
    const style = STYLE[opts.kind];
    this.color = new THREE.Color(opts.color);
    this.curve = new THREE.CatmullRomCurve3(opts.samples, false, 'centripetal');
    this.length = this.curve.getLength();
    const L = this.length;

    this.sampleX = opts.samples.map((p) => p.x);
    let acc = 0;
    this.sampleFrac = opts.samples.map((p, i) => (i ? (acc += p.distanceTo(opts.samples[i - 1])) : 0) / L);

    const fadeIn = opts.fadeIn === false ? 0.0001 : Math.min(0.3, 2.5 / L);
    const fadeOut = opts.fadeOut === false ? 0.0001 : Math.min(0.3, (opts.kind === 'main' ? 10 : 1.8) / L);

    this.shared = {
      uColor: { value: this.color },
      uHot: { value: this.color.clone().lerp(HOT, opts.kind === 'main' ? 0.5 : 0.6) },
      uTime: { value: 0 },
      uLen: { value: L },
      uGrow: { value: 1.01 },
      uHighlight: { value: 0 },
      uNexus: { value: 0 },
      uDim: { value: 1 },
      uBrightness: globalUniforms.uBrightness,
      uFadeIn: { value: opts.kind === 'main' ? Math.min(0.3, 20 / L) : fadeIn },
      uFadeOut: { value: fadeOut },
    };
    const shared = this.shared;

    // --- path texture (positions, normals, binormals) for GPU particles -----
    const N = Math.min(2048, Math.max(64, Math.ceil(L * 3)));
    const pts = this.curve.getSpacedPoints(N - 1);
    const frames = this.curve.computeFrenetFrames(N - 1, false);
    const data = new Float32Array(N * 3 * 4);
    for (let i = 0; i < N; i++) {
      const rows = [pts[i], frames.normals[i], frames.binormals[i]];
      rows.forEach((v, r) => data.set([v.x, v.y, v.z, 1], (r * N + i) * 4));
    }
    const tex = new THREE.DataTexture(data, N, 3, THREE.RGBAFormat, THREE.FloatType);
    tex.needsUpdate = true;
    this.disposables.push(tex);

    // --- particles -----------------------------------------------------------
    const count = Math.round(Math.min(16000, Math.max(150, L * style.density)));
    const attr = (fn: () => number) => new THREE.BufferAttribute(Float32Array.from({ length: count }, fn), 1);
    const pgeo = new THREE.BufferGeometry();
    pgeo.setAttribute('position', new THREE.BufferAttribute(new Float32Array(count * 3), 3));
    pgeo.setAttribute('aT', attr(Math.random));
    pgeo.setAttribute('aSpeed', attr(() => (1.2 + Math.random() * 2.2) / L));
    pgeo.setAttribute('aRadius', attr(() => style.spread * Math.pow(Math.random(), 2.4)));
    pgeo.setAttribute('aAngle', attr(() => Math.random() * Math.PI * 2));
    pgeo.setAttribute('aSpin', attr(() => (Math.random() - 0.5) * 1.6));
    pgeo.setAttribute('aSize', attr(() => 0.6 + Math.pow(Math.random(), 3) * 2.4));
    pgeo.setAttribute('aSeed', attr(Math.random));
    pgeo.boundingSphere = new THREE.Sphere().setFromPoints(pts);
    pgeo.boundingSphere.radius += style.spread * 2;
    const pmat = new THREE.ShaderMaterial({
      uniforms: { ...shared, uPath: { value: tex }, uN: { value: N }, uPixel: { value: pixelRatio }, uCore: { value: style.core } },
      vertexShader: particleVert,
      fragmentShader: particleFrag,
      ...additive,
    });
    this.group.add(new THREE.Points(pgeo, pmat));
    this.disposables.push(pgeo, pmat);

    // --- core + halo tubes ---------------------------------------------------
    const segs = Math.min(3000, Math.max(48, Math.ceil(L * (opts.kind === 'merged' ? 2 : 4))));
    const radial = opts.kind === 'merged' || opts.kind === 'link' ? 8 : 12;
    const tube = (radius: number, pow: number, white: number, intensity: number) => {
      const geo = new THREE.TubeGeometry(this.curve, segs, radius, radial, false);
      const mat = new THREE.ShaderMaterial({
        uniforms: { ...shared, uPow: { value: pow }, uWhite: { value: white }, uIntensity: { value: intensity } },
        vertexShader: tubeVert,
        fragmentShader: tubeFrag,
        ...additive,
      });
      this.disposables.push(geo, mat);
      this.group.add(new THREE.Mesh(geo, mat));
    };
    tube(style.core, 2.2, 0.55, 1.0 * style.intensity);
    if (opts.kind !== 'merged') tube(style.glow, 3.0, 0.0, 0.1 * style.intensity);

    // --- filaments: thin wisps spiralling around the core ----------------------
    const fN = Math.min(1500, Math.max(48, Math.ceil(L * 2)));
    const fPts = this.curve.getSpacedPoints(fN - 1);
    const fFrames = this.curve.computeFrenetFrames(fN - 1, false);
    for (let k = 0; k < style.filaments; k++) {
      const phase = Math.random() * Math.PI * 2;
      const twist = (0.12 + Math.random() * 0.25) * (Math.random() < 0.5 ? -1 : 1);
      const r0 = style.core * (1.3 + Math.random() * 2.2);
      const wob = Math.random() * 10;
      const helix = fPts.map((p, i) => {
        const s = (i / (fN - 1)) * L;
        const a = phase + s * twist;
        const r = r0 * (0.75 + 0.35 * Math.sin(s * 0.21 + wob));
        return p
          .clone()
          .addScaledVector(fFrames.normals[i], Math.cos(a) * r)
          .addScaledVector(fFrames.binormals[i], Math.sin(a) * r);
      });
      const hc = new THREE.CatmullRomCurve3(helix);
      const geo = new THREE.TubeGeometry(hc, Math.min(3000, fN * 2), opts.kind === 'main' ? 0.016 : 0.012, 3, false);
      const mat = new THREE.ShaderMaterial({
        uniforms: { ...shared, uSeed: { value: Math.random() }, uSpeed: { value: 0.35 + Math.random() * 0.5 } },
        vertexShader: tubeVert,
        fragmentShader: filamentFrag,
        ...additive,
      });
      this.disposables.push(geo, mat);
      this.group.add(new THREE.Mesh(geo, mat));
    }

    // --- picking -------------------------------------------------------------
    const pickGeo = new THREE.TubeGeometry(this.curve, Math.min(800, segs), Math.max(0.45, style.glow), 6, false);
    const pickMat = new THREE.MeshBasicMaterial({ colorWrite: false, depthWrite: false });
    this.pick = new THREE.Mesh(pickGeo, pickMat);
    this.pick.userData.stream = this;
    this.group.add(this.pick);
    this.disposables.push(pickGeo, pickMat);
  }

  get id() {
    return this.opts.id;
  }

  get startX() {
    return this.sampleX[0];
  }

  /** Fraction of the stream (by arc length) that lies at or before world x. */
  fractionAt(x: number) {
    const xs = this.sampleX;
    if (x <= xs[0]) return 0;
    if (x >= xs[xs.length - 1]) return 1;
    let lo = 0;
    let hi = xs.length - 1;
    while (hi - lo > 1) {
      const mid = (lo + hi) >> 1;
      if (xs[mid] <= x) lo = mid;
      else hi = mid;
    }
    const t = (x - xs[lo]) / (xs[hi] - xs[lo]);
    return this.sampleFrac[lo] + (this.sampleFrac[hi] - this.sampleFrac[lo]) * t;
  }

  /** Hide everything after world x (time replay). */
  setCutoffX(x: number | null) {
    this.cutoff = x === null ? 1 : this.fractionAt(x);
    this.group.visible = this.cutoff > 0.0005;
  }

  /** Animate the timeline growing out from its origin (or from a previous length). */
  animateGrow(from = 0) {
    this.growFrom = from;
    this.growT = 0;
  }

  flashNexus(strength = 1) {
    this.flash = Math.max(this.flash, strength);
  }

  update(time: number, dt: number) {
    const k = Math.min(1, dt * 8);
    this.highlight += (this.highlightTarget - this.highlight) * k;
    this.dim += (this.dimTarget - this.dim) * Math.min(1, dt * 5);
    this.flash = Math.max(0, this.flash - dt * 0.8);
    if (this.growT < 1) {
      this.growT = Math.min(1, this.growT + dt / 1.4);
      const e = 1 - Math.pow(1 - this.growT, 3);
      this.grow = this.growFrom + (1 - this.growFrom) * e;
    }
    const g = Math.min(this.grow, this.cutoff);
    const u = this.shared;
    u.uTime.value = time;
    u.uHighlight.value = this.highlight;
    u.uDim.value = this.dim;
    u.uNexus.value = Math.max(this.nexusLevel, this.flash);
    u.uGrow.value = g < 1 ? g : 1.01;
  }

  dispose() {
    for (const d of this.disposables) d.dispose();
    this.group.removeFromParent();
  }
}
