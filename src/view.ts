import * as THREE from 'three';
import { CSS2DObject } from 'three/examples/jsm/renderers/CSS2DRenderer.js';
import { SPACING, type LaidBranch, type Layout } from './model';
import { Stream, globalUniforms } from './stream';
import { Portal, dust, makeBraids, makeGem, makeTipHandle } from './effects';

const STONE_LIFT = new THREE.Vector3(0, 0.95, 0);
const MAX_STONES = 240;

export interface Stone {
  kind: 'commit' | 'tip';
  commit: string;
  branch: string;
  group: THREE.Group;
  mesh: THREE.Mesh;
  home: THREE.Vector3;
  x: number;
  scale: number;
  target: number;
  delay: number;
  dragging: boolean;
  phase: number;
  inner?: THREE.Mesh;
}

class StoneSet {
  readonly group = new THREE.Group();
  readonly stones: Stone[] = [];

  constructor(
    branch: LaidBranch,
    layout: Layout,
    origin: THREE.Vector3 | null,
    readonly range: [number, number],
  ) {
    const ox = origin?.x ?? (range[0] + range[1]) / 2;
    const ids = branch.own
      .filter((id) => {
        const x = layout.commits.get(id)!.pos.x;
        return x >= range[0] && x <= range[1];
      })
      .sort((a, b) => Math.abs(layout.commits.get(a)!.pos.x - ox) - Math.abs(layout.commits.get(b)!.pos.x - ox))
      .slice(0, MAX_STONES);
    for (const id of ids) {
      const c = layout.commits.get(id)!;
      const gem = makeGem(branch.color);
      gem.mesh.userData.stoneOf = id;
      this.add({ kind: 'commit', commit: id, branch: branch.name, group: gem.group, mesh: gem.mesh, home: c.pos.clone().add(STONE_LIFT), x: c.pos.x }, c.pos, origin);
    }
    if (!branch.synthetic) {
      const tip = tipPosition(branch, layout);
      const h = makeTipHandle(branch.color);
      h.mesh.userData.tipOf = branch.name;
      this.add({ kind: 'tip', commit: branch.head, branch: branch.name, group: h.group, mesh: h.mesh, inner: h.inner, home: tip, x: tip.x }, tip.clone().sub(STONE_LIFT), origin);
    }
  }

  private add(s: Omit<Stone, 'scale' | 'target' | 'delay' | 'dragging' | 'phase'>, from: THREE.Vector3, origin: THREE.Vector3 | null) {
    s.group.position.copy(from);
    s.group.scale.setScalar(0.0001);
    this.group.add(s.group);
    this.stones.push({
      ...s,
      scale: 0,
      target: 1,
      delay: origin ? Math.min(0.6, s.home.distanceTo(origin) * 0.012) : 0,
      dragging: false,
      phase: Math.random() * Math.PI * 2,
    });
  }

  show(origin: THREE.Vector3 | null) {
    for (const s of this.stones) {
      if (s.target === 1) continue;
      s.target = 1;
      s.delay = origin ? Math.min(0.6, s.home.distanceTo(origin) * 0.012) : 0;
    }
  }

  hide() {
    for (const s of this.stones) {
      s.target = 0;
      s.delay = 0;
    }
  }

  /** Returns false once fully hidden. */
  update(time: number, dt: number, cutoff: number, camera: THREE.Camera) {
    let alive = false;
    for (const s of this.stones) {
      const target = s.x <= cutoff ? s.target : 0;
      if (s.delay > 0) s.delay -= dt;
      else s.scale += (target - s.scale) * Math.min(1, dt * (target ? 7 : 10));
      if (s.target > 0 || s.scale > 0.01 || s.dragging) alive = true;
      s.group.scale.setScalar(Math.max(0.0001, s.scale * (s.dragging ? 1.35 : 1)));
      if (s.kind === 'tip') {
        s.group.quaternion.copy(camera.quaternion);
        s.inner!.rotation.z = time * 1.5;
      } else {
        s.mesh.rotation.y += dt * 0.9;
        s.mesh.rotation.z = Math.sin(time * 0.8 + s.phase) * 0.25;
      }
      if (!s.dragging) {
        const bob = new THREE.Vector3(0, Math.sin(time * 2 + s.phase) * 0.06, 0);
        s.group.position.lerp(bob.add(s.home), Math.min(1, dt * 9));
      }
    }
    return alive;
  }

  dispose() {
    this.group.traverse((o) => {
      if (o instanceof THREE.Sprite) o.material.dispose();
      if (o instanceof THREE.Mesh && o.userData.disposable) {
        (o.material as THREE.Material).dispose();
      }
    });
    this.group.removeFromParent();
  }
}

/** Where a timeline's merge handle floats: just past its newest commit. */
function tipPosition(b: LaidBranch, layout: Layout) {
  if (!b.own.length) return b.samples[b.samples.length - 1].clone().add(STONE_LIFT);
  const head = layout.commits.get(b.head)!.pos;
  return sampleAtX(b, head.x + SPACING * 0.55).add(STONE_LIFT);
}

function sampleAtX(b: LaidBranch, x: number) {
  const s = b.samples;
  if (x <= s[0].x) return s[0].clone();
  for (let i = 1; i < s.length; i++) {
    if (s[i].x >= x) return s[i - 1].clone().lerp(s[i], (x - s[i - 1].x) / Math.max(1e-6, s[i].x - s[i - 1].x));
  }
  return s[s.length - 1].clone();
}

export interface GrowRequest {
  branch: string;
  from: number;
}

export class MultiverseView {
  readonly root = new THREE.Group();
  readonly streams = new Map<string, Stream>();
  layout!: Layout;
  private links: { stream: Stream; from: string; to: string }[] = [];
  private portals: { portal: Portal; branch: string; x: number }[] = [];
  private bursts: Portal[] = [];
  private labels = new Map<string, CSS2DObject>();
  private nodes: THREE.InstancedMesh | null = null;
  private braids: THREE.InstancedMesh | null = null;
  private dustPoints: THREE.Points | null = null;
  private stoneSets = new Map<string, StoneSet>();
  private hidden = new Set<string>();
  private showMerged = true;
  private cutoff: number | null = null;
  private nexusThreshold = 25;

  constructor(private pixelRatio: number) {}

  setLayout(layout: Layout, grow?: GrowRequest) {
    this.clear();
    this.layout = layout;

    for (const b of layout.branches) {
      const kind = b.isMain ? 'main' : b.synthetic ? 'merged' : 'branch';
      const s = new Stream({ id: b.name, kind, color: b.color, samples: b.samples, fadeOut: !b.mergeTarget }, this.pixelRatio);
      this.root.add(s.group);
      this.streams.set(b.name, s);
      if (grow?.branch === b.name) s.animateGrow(grow.from);

      if (!b.isMain && b.base) {
        const portal = new Portal(b.color, b.synthetic ? 0.8 : 1.5);
        portal.mesh.position.copy(layout.commits.get(b.base)!.pos);
        this.root.add(portal.mesh);
        this.portals.push({ portal, branch: b.name, x: layout.commits.get(b.base)!.pos.x });
      }

      if (!b.synthetic) {
        const el = document.createElement('div');
        el.className = 'label' + (b.isMain ? ' main' : '');
        el.style.setProperty('--c', b.color);
        el.textContent = b.name;
        const label = new CSS2DObject(el);
        this.root.add(label);
        this.labels.set(b.name, label);
      }
    }

    for (const l of layout.links) {
      const stream = new Stream({ id: `${l.from}->${l.to}`, kind: 'link', color: l.color, samples: l.samples }, this.pixelRatio);
      stream.pick.removeFromParent();
      this.root.add(stream.group);
      this.links.push({ stream, from: layout.commits.get(l.from)!.branch, to: layout.commits.get(l.to)!.branch });
    }

    const geo = new THREE.SphereGeometry(0.075, 10, 8);
    const mat = new THREE.MeshBasicMaterial({ toneMapped: false });
    this.nodes = new THREE.InstancedMesh(geo, mat, Math.max(1, layout.commits.size));
    const col = new THREE.Color();
    const colorOf = new Map(layout.branches.map((b) => [b.name, b.color]));
    let i = 0;
    for (const c of layout.commits.values()) {
      this.nodes.setColorAt(i++, col.set(colorOf.get(c.branch)!).lerp(new THREE.Color(1, 1, 1), 0.5).multiplyScalar(1.8));
    }
    this.nodes.raycast = () => {};
    this.nodes.frustumCulled = false;
    this.root.add(this.nodes);

    this.braids = makeBraids(layout.merges, globalUniforms.uBrightness);
    this.root.add(this.braids);

    const box = new THREE.Box3();
    for (const b of layout.branches) for (const p of b.samples) box.expandByPoint(p);
    box.expandByVector(new THREE.Vector3(10, 8, 8));
    this.dustPoints = dust(box, Math.min(8000, Math.round((box.max.x - box.min.x) * 10)));
    this.root.add(this.dustPoints);

    this.applyVisibility();
  }

  private clear() {
    for (const s of this.streams.values()) s.dispose();
    for (const l of this.links) l.stream.dispose();
    for (const p of this.portals) p.portal.dispose();
    for (const p of this.bursts) p.dispose();
    for (const l of this.labels.values()) {
      l.element.remove();
      l.removeFromParent();
    }
    for (const s of this.stoneSets.values()) s.dispose();
    for (const m of [this.nodes, this.braids]) {
      if (!m) continue;
      m.geometry.dispose();
      (m.material as THREE.Material).dispose();
      m.removeFromParent();
    }
    if (this.dustPoints) {
      this.dustPoints.geometry.dispose();
      (this.dustPoints.material as THREE.Material).dispose();
      this.dustPoints.removeFromParent();
    }
    this.streams.clear();
    this.links = [];
    this.portals = [];
    this.bursts = [];
    this.labels.clear();
    this.stoneSets.clear();
  }

  // -------------------------------------------------------------------------
  // Visibility: toggles, merged history, time cutoff
  // -------------------------------------------------------------------------

  isVisible(name: string) {
    const b = this.branch(name);
    if (!b) return false;
    if (b.synthetic) return this.showMerged;
    return !this.hidden.has(name);
  }

  setVisibility(hidden: Set<string>, showMerged: boolean) {
    this.hidden = new Set(hidden);
    this.showMerged = showMerged;
    this.applyVisibility();
  }

  /** Show history only up to world x (null = everything). */
  setCutoff(x: number | null) {
    this.cutoff = x;
    this.applyVisibility();
  }

  get cutoffX() {
    return this.cutoff;
  }

  setNexusThreshold(n: number) {
    this.nexusThreshold = n;
    for (const b of this.layout.branches) {
      const s = this.streams.get(b.name);
      if (s) s.nexusLevel = n > 0 && b.behind >= n && b.own.length > 0 ? 0.5 : 0;
    }
  }

  isNexus(b: LaidBranch) {
    return this.nexusThreshold > 0 && b.behind >= this.nexusThreshold && b.own.length > 0;
  }

  private applyVisibility() {
    const cut = this.cutoff ?? Infinity;
    for (const b of this.layout.branches) {
      const s = this.streams.get(b.name)!;
      const vis = this.isVisible(b.name);
      s.setCutoffX(this.cutoff);
      if (!vis) s.group.visible = false;
      const label = this.labels.get(b.name);
      if (label) {
        const tipX = b.own.length ? this.layout.commits.get(b.head)!.pos.x : b.samples[b.samples.length - 1].x;
        const x = Math.min(tipX, cut);
        label.visible = vis && b.startX <= cut;
        label.element.style.display = label.visible ? '' : 'none';
        label.position.copy(sampleAtX(b, x)).add(new THREE.Vector3(0, b.isMain ? 1.4 : 1.0, 0));
      }
      if (!vis) this.hideStones(b.name);
    }
    for (const l of this.links) {
      l.stream.setCutoffX(this.cutoff);
      if (!this.isVisible(l.from) || !this.isVisible(l.to)) l.stream.group.visible = false;
    }
    for (const p of this.portals) p.portal.mesh.visible = this.isVisible(p.branch) && p.x <= cut;

    const m = new THREE.Matrix4();
    const zero = new THREE.Matrix4().makeScale(0, 0, 0);
    if (this.nodes) {
      let i = 0;
      for (const c of this.layout.commits.values()) {
        this.nodes.setMatrixAt(i++, this.isVisible(c.branch) && c.pos.x <= cut ? m.makeTranslation(c.pos) : zero);
      }
      this.nodes.instanceMatrix.needsUpdate = true;
    }
    if (this.braids) {
      this.layout.merges.forEach((mg, i) => {
        const owner = this.layout.commits.get(mg.id)!.branch;
        this.braids!.setMatrixAt(i, this.isVisible(owner) && mg.pos.x <= cut ? m.makeTranslation(mg.pos) : zero);
      });
      this.braids.instanceMatrix.needsUpdate = true;
    }
  }

  // -------------------------------------------------------------------------

  branch(name: string) {
    return this.layout.branches.find((b) => b.name === name);
  }

  get pickables() {
    const out: THREE.Mesh[] = [];
    for (const b of this.layout.branches) {
      if (b.synthetic || !this.isVisible(b.name)) continue;
      const s = this.streams.get(b.name)!;
      if (s.group.visible) out.push(s.pick);
    }
    return out;
  }

  stoneMeshes() {
    const out: THREE.Mesh[] = [];
    for (const set of this.stoneSets.values()) for (const s of set.stones) if (s.target > 0 && s.scale > 0.2) out.push(s.mesh);
    return out;
  }

  stone(commit: string, kind: Stone['kind'] = 'commit'): Stone | undefined {
    for (const set of this.stoneSets.values()) {
      const s = set.stones.find((st) => st.kind === kind && st.commit === commit);
      if (s) return s;
    }
  }

  tip(branch: string): Stone | undefined {
    return this.stoneSets.get(branch)?.stones.find((s) => s.kind === 'tip');
  }

  showStones(branch: string, origin: THREE.Vector3 | null, range: [number, number]) {
    const b = this.branch(branch);
    if (!b || b.synthetic || !this.isVisible(branch)) return;
    let set = this.stoneSets.get(branch);
    if (set) set.show(origin);
    else {
      set = new StoneSet(b, this.layout, origin, range);
      this.stoneSets.set(branch, set);
      this.root.add(set.group);
    }
  }

  /** Rebuild a revealed stone set when the camera has moved past the stretch it was built for. */
  ensureStoneRange(branch: string, view: [number, number], padded: [number, number]) {
    const set = this.stoneSets.get(branch);
    const b = this.branch(branch);
    if (!set || !b || set.stones.some((s) => s.dragging) || set.stones.every((s) => s.target === 0)) return;
    if (set.range[0] <= view[0] && set.range[1] >= view[1]) return;
    set.dispose();
    const next = new StoneSet(b, this.layout, null, padded);
    this.stoneSets.set(branch, next);
    this.root.add(next.group);
  }

  hideStones(branch: string) {
    this.stoneSets.get(branch)?.hide();
  }

  setHighlight(branch: string, on: boolean) {
    const s = this.streams.get(branch);
    if (s) s.highlightTarget = on ? 1 : 0;
    this.labels.get(branch)?.element.classList.toggle('active', on);
  }

  /** Dim timelines so revealed stones stand out. */
  setFocus(branches: Set<string>) {
    for (const [name, s] of this.streams) s.dimTarget = branches.size ? (branches.has(name) ? 0.45 : 0.7) : 1;
    for (const l of this.links) l.stream.dimTarget = branches.size ? 0.6 : 1;
  }

  /** Hide labels that would overlap a more important one on screen. */
  declutter(camera: THREE.Camera, width: number, height: number, important: Set<string>) {
    const placed: [number, number, number, number][] = [];
    const v = new THREE.Vector3();
    const main = this.layout.main;
    const rank = (name: string) => (important.has(name) ? 3 : name === main ? 2 : 1);
    const entries = [...this.labels.entries()].sort(([a], [b]) => rank(b) - rank(a));
    for (const [name, label] of entries) {
      if (!label.visible) continue;
      v.copy(label.position).project(camera);
      const x = ((v.x + 1) / 2) * width;
      const y = ((1 - v.y) / 2) * height;
      const w = name.length * 7.2 + 20;
      const r: [number, number, number, number] = [x - w / 2, y - 11, x + w / 2, y + 11];
      const clash = v.z > 1 || placed.some((p) => r[0] < p[2] && r[2] > p[0] && r[1] < p[3] && r[3] > p[1]);
      label.element.style.opacity = clash ? '0' : '';
      if (!clash) placed.push(r);
    }
  }

  flashNexus(branch: string, strength = 1) {
    this.streams.get(branch)?.flashNexus(strength);
  }

  /** Commit on `branch` closest (along the timeline) to a world point. */
  nearestCommit(branch: string, point: THREE.Vector3) {
    const b = this.branch(branch);
    if (!b) return null;
    const cut = this.cutoff ?? Infinity;
    const candidates = (b.own.length ? b.own : b.base ? [b.base] : []).filter((id) => this.layout.commits.get(id)!.pos.x <= cut);
    let best: string | null = null;
    let bestD = Infinity;
    for (const id of candidates) {
      const d = Math.abs(this.layout.commits.get(id)!.pos.x - point.x);
      if (d < bestD) {
        bestD = d;
        best = id;
      }
    }
    return best;
  }

  burst(pos: THREE.Vector3, color: string, size = 4) {
    const p = new Portal(color, size, 1.3);
    p.mesh.position.copy(pos);
    this.root.add(p.mesh);
    this.bursts.push(p);
  }

  update(time: number, dt: number, camera: THREE.Camera) {
    for (const s of this.streams.values()) s.update(time, dt);
    for (const l of this.links) l.stream.update(time, dt);
    for (const p of this.portals) p.portal.update(time, dt, camera);
    this.bursts = this.bursts.filter((p) => p.update(time, dt, camera));
    if (this.braids) (this.braids.material as THREE.ShaderMaterial).uniforms.uTime.value = time;
    const cut = this.cutoff ?? Infinity;
    for (const [name, set] of this.stoneSets) {
      if (!set.update(time, dt, cut, camera)) {
        set.dispose();
        this.stoneSets.delete(name);
      }
    }
  }
}
