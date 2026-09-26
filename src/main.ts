import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import { EffectComposer } from 'three/examples/jsm/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/examples/jsm/postprocessing/RenderPass.js';
import { UnrealBloomPass } from 'three/examples/jsm/postprocessing/UnrealBloomPass.js';
import { OutputPass } from 'three/examples/jsm/postprocessing/OutputPass.js';
import { CSS2DRenderer } from 'three/examples/jsm/renderers/CSS2DRenderer.js';
import { RoomEnvironment } from 'three/examples/jsm/environments/RoomEnvironment.js';
import {
  RepoStyle,
  SPACING,
  dateAtX,
  layoutRepo,
  xAtDate,
  type CheckResult,
  type CommitDiff,
  type Histogram,
  type Layout,
  type Op,
  type WindowData,
  type WindowQuery,
} from './model';
import { demoRepo } from './demo';
import { DemoSource, DiskSource, describeOp, type DataSource } from './sources';
import { MultiverseView, type GrowRequest, type Stone } from './view';
import { globalUniforms } from './stream';
import { makeGem, makeTipHandle, starfield } from './effects';
import { TimeBar } from './timebar';
import * as ui from './ui';

const { $ } = ui;

// ---------------------------------------------------------------------------
// Settings (per viewer)
// ---------------------------------------------------------------------------

const settings = {
  brightness: 0.85,
  glow: 0.8,
  autoDim: true,
  windowMax: 800,
  nexus: 25,
};
try {
  Object.assign(settings, JSON.parse(localStorage.getItem('gm.settings') ?? '{}'));
} catch {
  /* storage unavailable */
}
const saveSettings = () => {
  try {
    localStorage.setItem('gm.settings', JSON.stringify(settings));
  } catch {
    /* ignore */
  }
};

// ---------------------------------------------------------------------------
// Renderer / scene
// ---------------------------------------------------------------------------

const canvas = $<HTMLCanvasElement>('scene');
const renderer = new THREE.WebGLRenderer({ canvas, antialias: false, powerPreference: 'high-performance' });
const pixelRatio = Math.min(window.devicePixelRatio, 2);
renderer.setPixelRatio(pixelRatio);
renderer.setSize(window.innerWidth, window.innerHeight);
renderer.toneMapping = THREE.ACESFilmicToneMapping;
renderer.toneMappingExposure = 1.05;

const scene = new THREE.Scene();
scene.background = new THREE.Color('#04050b');
const pmrem = new THREE.PMREMGenerator(renderer);
scene.environment = pmrem.fromScene(new RoomEnvironment(), 0.04).texture;
scene.environmentIntensity = 0.6;
scene.add(new THREE.AmbientLight('#8090ff', 0.4));
const key = new THREE.DirectionalLight('#ffe2b8', 1.6);
key.position.set(-10, 20, 15);
scene.add(key);

const stars = starfield();
scene.add(stars);

const camera = new THREE.PerspectiveCamera(50, window.innerWidth / window.innerHeight, 0.1, 6000);

const labelRenderer = new CSS2DRenderer();
labelRenderer.setSize(window.innerWidth, window.innerHeight);
labelRenderer.domElement.className = 'labels';
document.body.appendChild(labelRenderer.domElement);

const composer = new EffectComposer(renderer);
composer.addPass(new RenderPass(scene, camera));
const bloom = new UnrealBloomPass(new THREE.Vector2(window.innerWidth, window.innerHeight), 0.85, 0.45, 0.22);
composer.addPass(bloom);
composer.addPass(new OutputPass());

const view = new MultiverseView(pixelRatio);
scene.add(view.root);

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------

let source: DataSource;
let style: RepoStyle;
let layout: Layout;
let win: WindowData;
let windowQ: WindowQuery = { since: null, until: null, max: settings.windowMax };
let histogram: Histogram | null = null;
let loading = false;

let hidden = new Set<string>();
let soloed: string | null = null;
let showMerged = true;

let hovered: string | null = null;
let hoverStone: Stone | null = null;
let hoverPoint: THREE.Vector3 | null = null;
let pinned: string | null = null;
const stonesShown = new Map<string, number>();
let viewRange: [number, number] = [0, 100];

let diffOpen: { commit: string } | null = null;
const diffCache = new Map<string, CommitDiff>();

const replay = { playing: false, cutoff: null as number | null };

interface Drag {
  stone: Stone;
  plane: THREE.Plane;
  target: string | null;
  line: THREE.Line;
  op: Op | null;
  check: Promise<CheckResult> | null;
  result: CheckResult | null;
}
let drag: Drag | null = null;
const checkCache = new Map<string, Promise<CheckResult>>();

const pointer = new THREE.Vector2(-10, -10);
const pointerPx = { x: 0, y: 0 };
let pointerDirty = false;
let downAt: { x: number; y: number; button: number } | null = null;
const raycaster = new THREE.Raycaster();

interface Flight {
  obj: THREE.Group;
  from: THREE.Vector3;
  ctrl: THREE.Vector3;
  to: THREE.Vector3;
  t: number;
  done: () => void;
}
let flights: Flight[] = [];

interface CamTween {
  p0: THREE.Vector3;
  p1: THREE.Vector3;
  t0: THREE.Vector3;
  t1: THREE.Vector3;
  t: number;
  dur: number;
}
let camTween: CamTween | null = null;

// ---------------------------------------------------------------------------
// Input (registered before OrbitControls so stone drags win over orbiting)
// ---------------------------------------------------------------------------

function setPointer(e: PointerEvent | MouseEvent) {
  pointerPx.x = e.clientX;
  pointerPx.y = e.clientY;
  pointer.set((e.clientX / window.innerWidth) * 2 - 1, -(e.clientY / window.innerHeight) * 2 + 1);
  pointerDirty = true;
}

canvas.addEventListener('pointerdown', (e) => {
  setPointer(e);
  downAt = { x: e.clientX, y: e.clientY, button: e.button };
  if (e.button === 0 && hoverStone && !loading) startDrag(hoverStone, e);
});

canvas.addEventListener('pointermove', (e) => {
  setPointer(e);
  if (drag) moveDrag(e);
});

canvas.addEventListener('pointerup', (e) => {
  setPointer(e);
  const moved = downAt ? Math.hypot(e.clientX - downAt.x, e.clientY - downAt.y) : 99;
  if (drag) {
    const d = drag;
    if (moved < 5) {
      cancelDrag();
      if (d.stone.kind === 'commit') openDiff(d.stone.commit);
      else select(d.stone.branch);
    } else void finishDrag();
  } else if (downAt?.button === 0 && moved < 5) {
    if (hovered) select(hovered === pinned ? null : hovered);
    else {
      select(null);
      closeDiff();
    }
  }
  if (downAt?.button !== 2) downAt = null;
});

canvas.addEventListener('contextmenu', async (e) => {
  e.preventDefault();
  const moved = downAt ? Math.hypot(e.clientX - downAt.x, e.clientY - downAt.y) : 0;
  downAt = null;
  if (moved > 6 || drag || !hovered) return;
  const at = hoverStone?.kind === 'commit' ? hoverStone.commit : hoverPoint ? view.nearestCommit(hovered, hoverPoint) : null;
  if (at) await createBranchAt(at);
});

window.addEventListener('keydown', (e) => {
  const tag = (e.target as HTMLElement).tagName;
  if (tag === 'INPUT' || tag === 'SELECT' || document.querySelector('dialog[open]')) return;
  if (e.key === 'Escape') {
    if (diffOpen) closeDiff();
    else select(null);
    closePopovers();
  }
  if (e.key === 'f' || e.key === 'F') frameAll();
  if (e.key === 'h' || e.key === 'H') frameRecent();
  if (e.key === ' ') {
    e.preventDefault();
    togglePlay();
  }
});

window.addEventListener('resize', () => {
  camera.aspect = window.innerWidth / window.innerHeight;
  camera.updateProjectionMatrix();
  renderer.setSize(window.innerWidth, window.innerHeight);
  composer.setSize(window.innerWidth, window.innerHeight);
  labelRenderer.setSize(window.innerWidth, window.innerHeight);
});

const controls = new OrbitControls(camera, canvas);
controls.enableDamping = true;
controls.dampingFactor = 0.08;
controls.zoomSpeed = 1.2;
controls.minDistance = 2;
controls.maxDistance = 3000;
controls.screenSpacePanning = true;
controls.zoomToCursor = true;
controls.addEventListener('start', () => (camTween = null));

// ---------------------------------------------------------------------------
// Loading
// ---------------------------------------------------------------------------

async function openSource(src: DataSource) {
  source = src;
  style = new RepoStyle();
  hidden = new Set();
  soloed = null;
  pinned = null;
  closeDiff();
  diffCache.clear();
  stopReplay();
  $('write-toggle').classList.toggle('hidden', !src.canWrite);
  $<HTMLInputElement>('write-mode').checked = false;
  histogram = await src.histogram();
  timebar.setHistogram(histogram);
  await loadWindow({ since: null, until: null, max: settings.windowMax }, 'recent');
}

/** Load a slice of history. `frame`: where to put the camera afterwards. */
async function loadWindow(q: WindowQuery, frame: 'recent' | 'keep' | [number, number], grow?: GrowRequest) {
  loading = true;
  document.body.classList.add('loading');
  const keepDate = frame === 'keep' && layout ? dateAtX(layout, controls.target.x) : null;
  const offset = camera.position.clone().sub(controls.target);
  let w: WindowData;
  try {
    w = await source.load(q);
  } catch (e) {
    ui.toast((e as Error).message, 'err');
    return;
  } finally {
    loading = false;
    document.body.classList.remove('loading');
  }
  if (!w.commits.length) {
    ui.toast('No commits in that timeframe', 'err');
    if (layout) return;
  }
  win = w;
  // Pin the window's start so later reloads (after new commits) don't shift everything.
  windowQ = { since: w.since, until: w.until, max: Math.max(q.max, w.commits.length + 400) };
  checkCache.clear();
  layout = layoutRepo(w, style);
  view.setLayout(layout, grow);
  view.setNexusThreshold(settings.nexus);
  applyVisibility();
  stonesShown.clear();
  hovered = null;
  hoverStone = null;
  if (pinned && !view.branch(pinned)) pinned = null;
  if (pinned) view.setHighlight(pinned, true);
  if (replay.cutoff !== null) setCutoff(Math.min(replay.cutoff, layout.maxX));
  if (diffOpen && !layout.commits.has(diffOpen.commit)) closeDiff();
  timebar.setWindow(w.since, w.until ?? latestDate());
  if (w.truncated && q.since) {
    ui.toast(`That timeframe has more than ${q.max.toLocaleString()} commits; showing the newest. Narrow the range to see the rest.`, 'err');
  }
  refreshUi();
  refreshStatus();
  pointerDirty = true;

  if (frame === 'recent') {
    const target = new THREE.Vector3(Math.max(layout.minX + 10, layout.maxX - 20), 0, 0);
    controls.target.copy(target);
    camera.position.copy(target).add(new THREE.Vector3(-22, 9, 28));
    camTween = null;
  } else if (frame === 'keep' && keepDate !== null) {
    controls.target.x = xAtDate(layout, keepDate);
    camera.position.copy(controls.target).add(offset);
    camTween = null;
  } else if (Array.isArray(frame)) {
    frameX(xAtDate(layout, frame[0]), xAtDate(layout, frame[1]));
  }
}

function latestDate() {
  if (!histogram) return Date.now();
  return histogram.start + histogram.counts.length * histogram.bucket;
}

// ---------------------------------------------------------------------------
// Visibility
// ---------------------------------------------------------------------------

function applyVisibility() {
  view.setVisibility(hidden, showMerged);
  if (pinned && !view.isVisible(pinned)) select(null);
}

function toggleBranch(name: string) {
  if (hidden.has(name)) hidden.delete(name);
  else hidden.add(name);
  soloed = null;
  applyVisibility();
  refreshUi();
}

/** Show only this timeline and the timelines it descends from. */
function solo(name: string) {
  if (soloed === name) {
    soloed = null;
    hidden.clear();
  } else {
    soloed = name;
    const keep = new Set<string>([name]);
    for (let b = view.branch(name); b?.base; ) {
      const owner = layout.commits.get(b.base)?.branch;
      if (!owner || keep.has(owner)) break;
      keep.add(owner);
      b = view.branch(owner);
    }
    hidden = new Set(layout.branches.filter((b) => !b.synthetic && !keep.has(b.name)).map((b) => b.name));
    focusBranch(name);
  }
  applyVisibility();
  refreshUi();
}

// ---------------------------------------------------------------------------
// UI glue
// ---------------------------------------------------------------------------

const escapeHtml = ui.esc;

function branchOf(o: THREE.Object3D): string | null {
  const s = o.userData.stream;
  return s ? s.id : null;
}

function select(name: string | null) {
  if (pinned && pinned !== name) view.setHighlight(pinned, false);
  pinned = name;
  if (pinned) view.setHighlight(pinned, true);
  refreshUi();
}

function refreshUi() {
  if (!layout) return;
  ui.renderBranchList(layout.branches, pinned, hidden, soloed, (b) => view.isNexus(b), {
    pick: (name) => {
      if (hidden.has(name)) toggleBranch(name);
      select(name);
      focusBranch(name);
    },
    toggle: toggleBranch,
    solo,
  });
  const b = pinned ? view.branch(pinned) ?? null : null;
  let baseLabel = '';
  if (b?.base) {
    const c = layout.commits.get(b.base)!;
    const owner = view.branch(c.branch)!;
    baseLabel = `${owner.title} @ ${c.id.slice(0, 7)}`;
  }
  ui.showPanel(b, baseLabel, !!b && view.isNexus(b), source.writeMode);
}

function refreshStatus() {
  const live = layout.branches.filter((b) => !b.synthetic).length;
  const mode = !source.canWrite
    ? 'Demo: changes stay in memory.'
    : source.writeMode
      ? '<span class="warn">Write mode: confirmed operations are committed to disk.</span>'
      : 'Simulation: your repository is not modified.';
  ui.setStatus(
    `${escapeHtml(source.label)} · <b>${live}</b> timelines · <b>${layout.commits.size.toLocaleString()}</b> commits loaded` +
      (histogram ? ` of ${histogram.total.toLocaleString()}` : '') +
      `<br><span class="dim">${mode}</span>`,
  );
  const fmt = (d: number) => new Date(d).toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' });
  $('tb-window').textContent = `Loaded ${fmt(win.since)} → ${win.until ? fmt(win.until) : 'now'}`;
}

// ---------------------------------------------------------------------------
// Drag: stones cherry-pick, tip rings merge
// ---------------------------------------------------------------------------

function startDrag(stone: Stone, e: PointerEvent) {
  controls.enabled = false;
  canvas.setPointerCapture(e.pointerId);
  const normal = camera.getWorldDirection(new THREE.Vector3()).negate();
  const plane = new THREE.Plane().setFromNormalAndCoplanarPoint(normal, stone.group.position);
  const color = view.branch(stone.branch)!.color;
  const line = new THREE.Line(
    new THREE.BufferGeometry().setFromPoints([stone.home, stone.home]),
    new THREE.LineBasicMaterial({ color, transparent: true, opacity: 0.8, blending: THREE.AdditiveBlending, toneMapped: false }),
  );
  scene.add(line);
  stone.dragging = true;
  drag = { stone, plane, target: null, line, op: null, check: null, result: null };
  document.body.classList.add('dragging');
}

function moveDrag(e: PointerEvent) {
  const d = drag!;
  raycaster.setFromCamera(pointer, camera);
  const p = raycaster.ray.intersectPlane(d.plane, new THREE.Vector3());
  if (p) {
    d.stone.group.position.copy(p);
    d.line.geometry.setFromPoints([d.stone.home, p]);
  }
  const hit = raycaster.intersectObjects(view.pickables, false).find((h) => branchOf(h.object) !== d.stone.branch);
  const target = hit ? branchOf(hit.object) : null;
  if (target !== d.target) {
    if (d.target) view.setHighlight(d.target, d.target === pinned);
    if (target) view.setHighlight(target, true);
    d.target = target;
    d.result = null;
    d.op = target
      ? d.stone.kind === 'commit'
        ? { kind: 'cherry-pick', commit: d.stone.commit, branch: target }
        : { kind: 'merge', source: d.stone.branch, target }
      : null;
    d.check = d.op ? checkOp(d.op) : null;
    const op = d.op;
    d.check?.then((r) => {
      if (drag !== d || d.op !== op) return;
      d.result = r;
      if (!r.ok && r.conflicts.length && d.target) view.flashNexus(d.target, 1);
      dragTooltip(e.clientX, e.clientY);
    });
  }
  if (d.result && !d.result.ok && d.result.conflicts.length && d.target) view.flashNexus(d.target, 1);
  dragTooltip(e.clientX, e.clientY);
}

function checkOp(op: Op) {
  const key = JSON.stringify(op);
  let p = checkCache.get(key);
  if (!p) {
    p = source.check(op);
    checkCache.set(key, p);
  }
  return p;
}

function dragTooltip(x: number, y: number) {
  const d = drag;
  if (!d) return;
  const verb = d.stone.kind === 'commit' ? `Cherry-pick <code>${d.stone.commit.slice(0, 7)}</code>` : `Merge ${escapeHtml(d.stone.branch)}`;
  if (!d.target) {
    ui.tooltip(`<div class="tt-hint">Drop onto another timeline to ${d.stone.kind === 'commit' ? 'cherry-pick' : 'merge'}</div>`, x, y);
    return;
  }
  const color = view.branch(d.target)!.color;
  let status = '<div class="tt-meta">Checking for conflicts…</div>';
  if (d.result?.error) status = `<div class="tt-warn">${escapeHtml(d.result.error)}</div>`;
  else if (d.result && !d.result.ok)
    status = `<div class="tt-warn">⚠ Nexus event: conflicts in ${d.result.conflicts.slice(0, 4).map(escapeHtml).join(', ')}${d.result.conflicts.length > 4 ? '…' : ''}</div>`;
  else if (d.result) status = '<div class="tt-ok">✓ No conflicts</div>';
  ui.tooltip(`<div class="tt-head" style="--c:${color}"><span class="dot"></span>${verb} → ${escapeHtml(d.target)}</div>${status}`, x, y);
}

function cancelDrag() {
  const d = drag!;
  drag = null;
  controls.enabled = true;
  document.body.classList.remove('dragging');
  d.line.geometry.dispose();
  (d.line.material as THREE.Material).dispose();
  d.line.removeFromParent();
  d.stone.dragging = false;
  if (d.target) view.setHighlight(d.target, d.target === pinned);
  ui.tooltip(null);
  return d;
}

async function finishDrag() {
  const d = cancelDrag();
  if (!d.target || !d.op || !d.check) return;
  const dropPos = d.stone.group.position.clone();
  const res = await d.check;
  if (res.error) return ui.toast(res.error, 'err');
  if (!res.ok) {
    view.flashNexus(d.target, 1);
    view.flashNexus(d.stone.branch, 0.8);
    view.burst(dropPos, '#ff2030', 3.5);
    ui.toast(`Nexus event! Conflicts in ${res.conflicts.slice(0, 3).join(', ')}${res.conflicts.length > 3 ? '…' : ''}. The timeline was not changed.`, 'nexus');
    return;
  }
  const srcColor = view.branch(d.stone.branch)!.color;
  await runOp(d.op, { from: dropPos, color: srcColor, kind: d.stone.kind });
}

// ---------------------------------------------------------------------------
// Operations
// ---------------------------------------------------------------------------

async function runOp(op: Op, anim?: { from: THREE.Vector3; color: string; kind: Stone['kind'] }) {
  if (source.writeMode) {
    const ok = await ui.confirm({
      title: 'Write to the repository?',
      html: `This will change <code>${escapeHtml(source.label)}</code> on disk:`,
      command: describeOp(op),
      ok: 'Write it',
      danger: true,
    });
    if (!ok) return;
  }
  const targetBranch = op.kind === 'branch' ? op.name : op.kind === 'merge' ? op.target : op.branch;
  const oldEnd = view.branch(targetBranch)?.endX;
  let res: { id?: string; message: string };
  try {
    res = await source.apply(op);
  } catch (e) {
    const err = e as Error & { conflicts?: string[] };
    if (err.conflicts?.length) {
      view.flashNexus(targetBranch, 1);
      ui.toast(`Nexus event! Conflicts in ${err.conflicts.slice(0, 3).join(', ')}`, 'nexus');
    } else ui.toast(err.message, 'err');
    return;
  }
  if (histogram) histogram = await source.histogram();
  if (histogram) timebar.setHistogram(histogram);
  diffCache.clear();
  // New commits land at "now": make sure the window reaches the present.
  await loadWindow({ ...windowQ, until: null }, 'keep', op.kind === 'branch' ? { branch: op.name, from: 0 } : undefined);
  const b = view.branch(targetBranch);
  if (!b) return ui.toast(res.message);
  if (op.kind !== 'branch') view.streams.get(targetBranch)?.animateGrow(growFrom(targetBranch, oldEnd));
  const dest = res.id ? layout.commits.get(res.id)?.pos : undefined;

  if (op.kind === 'branch') {
    if (dest) view.burst(dest, b.color, 5);
    select(op.name);
  } else if (dest && anim) {
    fly(anim.from, dest, anim.color, anim.kind, () => {
      view.burst(dest, b.color, op.kind === 'merge' ? 4.5 : 3);
      if (op.kind === 'merge') view.burst(dest, anim.color, 3);
      select(targetBranch);
      showStonesFor(targetBranch, dest);
    });
    followTo(dest);
  } else if (dest) {
    view.burst(dest, b.color, 2.5);
    followTo(dest);
  }
  ui.toast(res.message);
}

/** Fraction of a branch's new length that already existed (for the growth animation). */
function growFrom(name: string, oldEnd: number | undefined) {
  const b = view.branch(name);
  if (!b || oldEnd === undefined) return 0;
  return Math.max(0, Math.min(1, (oldEnd - b.startX) / (b.endX - b.startX)));
}

async function createBranchAt(commitId: string) {
  const c = layout.commits.get(commitId)!;
  const name = await ui.askBranchName(`${view.branch(c.branch)!.title} @ ${c.id.slice(0, 7)} · ${c.message}`, style.nextColor());
  if (!name) return;
  const check = await source.check({ kind: 'branch', name, at: commitId });
  if (check.error) return ui.toast(check.error, 'err');
  await runOp({ kind: 'branch', name, at: commitId });
}

function fly(from: THREE.Vector3, to: THREE.Vector3, color: string, kind: Stone['kind'], done: () => void) {
  const obj = kind === 'commit' ? makeGem(color).group : makeTipHandle(color).group;
  obj.traverse((o) => (o.raycast = () => {}));
  obj.position.copy(from);
  obj.scale.setScalar(1.3);
  scene.add(obj);
  const ctrl = from.clone().lerp(to, 0.5).add(new THREE.Vector3(0, 4 + from.distanceTo(to) * 0.15, 0));
  flights.push({ obj, from, ctrl, to: to.clone(), t: 0, done });
}

// ---------------------------------------------------------------------------
// Diff panel
// ---------------------------------------------------------------------------

async function openDiff(id: string) {
  const c = layout.commits.get(id);
  if (!c) return;
  diffOpen = { commit: id };
  const color = view.branch(c.branch)!.color;
  const cached = diffCache.get(id);
  ui.renderDiff(c, color, cached ?? null);
  $('diff-close')?.addEventListener('click', closeDiff);
  if (cached) return;
  try {
    const d = await source.diff(id);
    diffCache.set(id, d);
    if (diffOpen?.commit === id) ui.renderDiff(c, color, d);
  } catch (e) {
    if (diffOpen?.commit === id) ui.renderDiff(c, color, null, (e as Error).message);
  }
  $('diff-close')?.addEventListener('click', closeDiff);
}

function closeDiff() {
  diffOpen = null;
  ui.hideDiff();
}

// ---------------------------------------------------------------------------
// Camera
// ---------------------------------------------------------------------------

function tweenCamera(target: THREE.Vector3, position: THREE.Vector3, dur = 1.2) {
  camTween = { p0: camera.position.clone(), p1: position, t0: controls.target.clone(), t1: target, t: 0, dur };
}

/** Move the camera so `p` is in view, keeping the current viewing angle and distance. */
function followTo(p: THREE.Vector3) {
  const offset = camera.position.clone().sub(controls.target);
  const target = p.clone().add(new THREE.Vector3(-4, 0, 0));
  tweenCamera(target, target.clone().add(offset), 1.4);
}

function focusBranch(name: string) {
  const b = view.branch(name);
  if (!b) return;
  const tip = b.own.length ? layout.commits.get(b.head)!.pos : b.samples[b.samples.length - 1];
  const target = tip.clone().add(new THREE.Vector3(-6, 0, 0));
  tweenCamera(target, target.clone().add(new THREE.Vector3(-14, 7, 20)));
}

/** Fit the x range [a, b] on screen, keeping the viewing angle. */
function frameX(a: number, b: number) {
  const width = Math.max(8, b - a);
  const target = new THREE.Vector3((a + b) / 2, 0, 0);
  const vfov = THREE.MathUtils.degToRad(camera.fov);
  const hfov = 2 * Math.atan(Math.tan(vfov / 2) * camera.aspect);
  const dist = Math.min(2500, (width / 2 / Math.tan(hfov / 2)) * 1.15 + 6);
  const dir = camera.position.clone().sub(controls.target).normalize();
  // Keep a readable side-on angle so time runs across the screen.
  dir.x = THREE.MathUtils.clamp(dir.x, -0.35, 0.35);
  if (dir.lengthSq() < 0.01) dir.set(0, 0.35, 1);
  dir.normalize();
  tweenCamera(target, target.clone().addScaledVector(dir, dist));
}

function frameRecent() {
  const target = new THREE.Vector3(Math.max(layout.minX + 10, layout.maxX - 20), 0, 0);
  tweenCamera(target, target.clone().add(new THREE.Vector3(-22, 9, 28)));
}

function frameAll() {
  frameX(layout.minX, layout.maxX);
}

/** The x range of the timeline currently on screen. */
function computeViewRange(): [number, number] {
  const n = 160;
  const a0 = layout.minX - 10;
  const b0 = layout.maxX + 10;
  let a = Infinity;
  let b = -Infinity;
  const v = new THREE.Vector3();
  for (let i = 0; i <= n; i++) {
    const x = a0 + ((b0 - a0) * i) / n;
    v.set(x, 0, 0).project(camera);
    if (v.z < 1 && Math.abs(v.x) <= 1.05 && Math.abs(v.y) <= 1.05) {
      a = Math.min(a, x);
      b = Math.max(b, x);
    }
  }
  if (a === Infinity) {
    const x = controls.target.x;
    return [x - 5, x + 5];
  }
  return [a, b];
}

// ---------------------------------------------------------------------------
// Replay
// ---------------------------------------------------------------------------

function setCutoff(x: number | null) {
  replay.cutoff = x;
  view.setCutoff(x);
  timebar.setPlayhead(x === null ? null : dateAtX(layout, x));
}

function togglePlay() {
  if (replay.playing) {
    replay.playing = false;
  } else {
    if (replay.cutoff === null || replay.cutoff >= layout.maxX) {
      // Replay the loaded window from its beginning (scrub the time bar to start elsewhere).
      setCutoff(layout.minX);
      const target = new THREE.Vector3(replay.cutoff! - 8, 0, 0);
      tweenCamera(target, target.clone().add(new THREE.Vector3(-10, 8, 26)), 0.8);
    }
    replay.playing = true;
    closeDiff();
  }
  updatePlayIcon();
}

function stopReplay() {
  replay.playing = false;
  replay.cutoff = null;
  if (layout) setCutoff(null);
  updatePlayIcon();
}

function updatePlayIcon() {
  $('icon-play').style.display = replay.playing ? 'none' : '';
  $('icon-pause').style.display = replay.playing ? '' : 'none';
  $('live').classList.toggle('on', replay.cutoff === null);
}

// ---------------------------------------------------------------------------
// Time bar
// ---------------------------------------------------------------------------

const inWindow = (a: number, b: number) => a >= win.since - 1000 && b <= (win.until ?? Infinity) + 1000;

const timebar = new TimeBar($<HTMLCanvasElement>('timebar'), {
  select(a, b) {
    if (inWindow(a, b)) frameX(xAtDate(layout, a), xAtDate(layout, b));
    else void loadWindow({ since: a, until: b >= latestDate() - 3600_000 ? null : b, max: settings.windowMax }, [a, b]);
  },
  jump(d) {
    if (inWindow(d, d)) {
      const x = xAtDate(layout, d);
      const offset = camera.position.clone().sub(controls.target);
      const target = new THREE.Vector3(x, 0, 0);
      tweenCamera(target, target.clone().add(offset), 0.9);
    } else {
      const span = (win.until ?? latestDate()) - win.since;
      const a = d - span / 2;
      const b = d + span / 2;
      void loadWindow({ since: a, until: b >= latestDate() ? null : b, max: settings.windowMax }, [d - span / 8, d + span / 8]);
    }
  },
  pan(delta) {
    const cx = controls.target.x;
    const dx = xAtDate(layout, dateAtX(layout, cx) + delta) - cx;
    camTween = null;
    controls.target.x += dx;
    camera.position.x += dx;
  },
  resizeWindow(a, b) {
    void loadWindow({ since: a, until: b >= latestDate() - 3600_000 ? null : b, max: settings.windowMax }, 'keep');
  },
  scrub(d) {
    replay.playing = false;
    setCutoff(xAtDate(layout, Math.max(win.since, Math.min(d, win.until ?? Infinity))));
    updatePlayIcon();
  },
});

$('play').addEventListener('click', togglePlay);
$('live').addEventListener('click', () => stopReplay());

// ---------------------------------------------------------------------------
// HUD wiring
// ---------------------------------------------------------------------------

const pathInput = $<HTMLInputElement>('repo-path');
try {
  pathInput.value = localStorage.getItem('gm.repoPath') ?? '';
} catch {
  /* storage unavailable */
}

async function loadRepoFromPath() {
  const path = pathInput.value.trim();
  if (!path) return ui.toast('Enter the path of a local git repository', 'err');
  ui.setStatus('Reading the timeline…');
  const label = path.split(/[\\/]/).filter(Boolean).pop() ?? path;
  const src = new DiskSource(path, label);
  try {
    await src.histogram();
    try {
      localStorage.setItem('gm.repoPath', path);
    } catch {
      /* ignore */
    }
    await openSource(src);
  } catch (err) {
    ui.setStatus('');
    ui.toast((err as Error).message, 'err');
    if (layout) refreshStatus();
  }
}

function loadDemo() {
  const d = demoRepo();
  void openSource(new DemoSource(d.commits, d.branches));
}

$('load-repo').addEventListener('click', loadRepoFromPath);
pathInput.addEventListener('keydown', (e) => e.key === 'Enter' && loadRepoFromPath());
$('load-demo').addEventListener('click', loadDemo);
$('panel-close').addEventListener('click', () => select(null));
$('commit-form').addEventListener('submit', (e) => {
  e.preventDefault();
  const input = $<HTMLInputElement>('commit-msg');
  const msg = input.value.trim();
  if (!msg || !pinned) return;
  input.value = '';
  void runOp({ kind: 'commit', branch: pinned, message: msg });
});
$('branch-search').addEventListener('input', refreshUi);
$('show-all').addEventListener('click', () => {
  hidden.clear();
  soloed = null;
  applyVisibility();
  refreshUi();
});
$<HTMLInputElement>('show-merged').addEventListener('change', (e) => {
  showMerged = (e.target as HTMLInputElement).checked;
  applyVisibility();
});

$<HTMLInputElement>('write-mode').addEventListener('change', async (e) => {
  const box = e.target as HTMLInputElement;
  const disk = source as DiskSource;
  if (box.checked) {
    const ok = await ui.confirm({
      title: 'Turn on write mode?',
      html:
        `Cherry-picks, merges, new branches and commits will be written to <code>${escapeHtml(disk.path)}</code>. ` +
        `You will confirm each one. Branches checked out with uncommitted changes are never touched.` +
        (disk.hasSimulated ? '<br><br>Your simulated changes will be discarded.' : ''),
      ok: 'Enable write mode',
      danger: true,
    });
    if (!ok) {
      box.checked = false;
      return;
    }
    disk.discardSimulated();
  }
  source.writeMode = box.checked;
  document.body.classList.toggle('write-mode', box.checked);
  await loadWindow(windowQ, 'keep');
});

// popovers
function closePopovers() {
  $('settings').classList.add('hidden');
  $('help').classList.add('hidden');
}
for (const [btn, pop] of [
  ['btn-settings', 'settings'],
  ['btn-help', 'help'],
] as const) {
  $(btn).addEventListener('click', (e) => {
    e.stopPropagation();
    const open = $(pop).classList.contains('hidden');
    closePopovers();
    $(pop).classList.toggle('hidden', !open);
  });
}
document.addEventListener('pointerdown', (e) => {
  if (!(e.target as HTMLElement).closest('.popover, .icon-btn')) closePopovers();
});

// settings
const setBrightness = $<HTMLInputElement>('set-brightness');
const setGlow = $<HTMLInputElement>('set-glow');
const setAutodim = $<HTMLInputElement>('set-autodim');
const setWindow = $<HTMLSelectElement>('set-window');
const setNexus = $<HTMLSelectElement>('set-nexus');
setBrightness.value = String(settings.brightness);
setGlow.value = String(settings.glow);
setAutodim.checked = settings.autoDim;
setWindow.value = String(settings.windowMax);
setNexus.value = String(settings.nexus);
setBrightness.addEventListener('input', () => ((settings.brightness = Number(setBrightness.value)), saveSettings()));
setGlow.addEventListener('input', () => ((settings.glow = Number(setGlow.value)), saveSettings()));
setAutodim.addEventListener('change', () => ((settings.autoDim = setAutodim.checked), saveSettings()));
setWindow.addEventListener('change', () => {
  settings.windowMax = Number(setWindow.value);
  saveSettings();
  void loadWindow({ since: null, until: null, max: settings.windowMax }, 'recent');
});
setNexus.addEventListener('change', () => {
  settings.nexus = Number(setNexus.value);
  saveSettings();
  view.setNexusThreshold(settings.nexus);
  refreshUi();
});

// ---------------------------------------------------------------------------
// Loop
// ---------------------------------------------------------------------------

const clock = new THREE.Timer();

function paddedView(): [number, number] {
  const pad = Math.max(20, (viewRange[1] - viewRange[0]) * 0.15);
  return [viewRange[0] - pad, viewRange[1] + pad];
}

function showStonesFor(branch: string, origin: THREE.Vector3 | null) {
  view.showStones(branch, origin, paddedView());
  stonesShown.set(branch, clock.getElapsed());
}

function updateHover() {
  if (drag || !pointerDirty || !layout) return;
  pointerDirty = false;
  raycaster.setFromCamera(pointer, camera);

  let stone: Stone | null = null;
  const sh = raycaster.intersectObjects(view.stoneMeshes(), false)[0];
  if (sh) {
    const ud = sh.object.userData;
    stone = (ud.tipOf ? view.tip(ud.tipOf) : view.stone(ud.stoneOf)) ?? null;
  }

  let branch: string | null = null;
  let point: THREE.Vector3 | null = null;
  if (stone) {
    branch = stone.branch;
    point = sh.point;
  } else {
    const hit = raycaster.intersectObjects(view.pickables, false)[0];
    if (hit) {
      branch = branchOf(hit.object);
      point = hit.point;
    }
  }

  if (branch !== hovered) {
    if (hovered && hovered !== pinned) view.setHighlight(hovered, false);
    if (branch) view.setHighlight(branch, true);
  }
  hovered = branch;
  hoverStone = stone;
  hoverPoint = point;
  canvas.style.cursor = stone ? 'grab' : branch ? 'pointer' : '';

  if (stone?.kind === 'commit') {
    const c = layout.commits.get(stone.commit)!;
    ui.tooltip(ui.commitTooltip(c, view.branch(c.branch)!.color), pointerPx.x, pointerPx.y);
  } else if (stone?.kind === 'tip') {
    const b = view.branch(stone.branch)!;
    ui.tooltip(
      `<div class="tt-head" style="--c:${b.color}"><span class="dot"></span>${escapeHtml(b.name)}</div><div class="tt-hint">Drag this ring onto another timeline to merge</div>`,
      pointerPx.x,
      pointerPx.y,
    );
  } else if (branch) {
    const b = view.branch(branch)!;
    ui.tooltip(ui.branchTooltip(b, 'Click to pin · right-click to branch from here', view.isNexus(b)), pointerPx.x, pointerPx.y);
  } else ui.tooltip(null);
}

let lastFocusKey = '';
function updateStones(now: number) {
  const wanted = new Set<string>();
  if (hovered) wanted.add(hovered);
  if (pinned) wanted.add(pinned);
  if (drag) wanted.add(drag.stone.branch);
  for (const b of wanted) {
    if (!stonesShown.has(b)) showStonesFor(b, hoverPoint);
    stonesShown.set(b, now);
  }
  for (const [b, t] of stonesShown) {
    if (!wanted.has(b) && now - t > 0.7) {
      view.hideStones(b);
      stonesShown.delete(b);
    }
  }
  const key = [...stonesShown.keys()].sort().join('|');
  if (key !== lastFocusKey) {
    lastFocusKey = key;
    view.setFocus(new Set(stonesShown.keys()));
  }
}

let rangeTimer = 0;
function tick() {
  requestAnimationFrame(tick);
  clock.update();
  const dt = Math.min(clock.getDelta(), 0.05);
  const time = clock.getElapsed();
  if (!layout) return;

  if (camTween) {
    camTween.t = Math.min(1, camTween.t + dt / camTween.dur);
    const t = camTween.t;
    const e = t < 0.5 ? 4 * t ** 3 : 1 - (-2 * t + 2) ** 3 / 2;
    camera.position.lerpVectors(camTween.p0, camTween.p1, e);
    controls.target.lerpVectors(camTween.t0, camTween.t1, e);
    if (camTween.t >= 1) camTween = null;
    pointerDirty = true;
  }

  if (replay.playing && replay.cutoff !== null) {
    const speed = Number($<HTMLSelectElement>('speed').value);
    const next = replay.cutoff + dt * speed * SPACING * 2;
    if (next >= layout.maxX + SPACING) stopReplay();
    else {
      setCutoff(next);
      if (!camTween) {
        // follow the leading edge of time
        const dx = (next - 8 - controls.target.x) * Math.min(1, dt * 2.5);
        controls.target.x += dx;
        camera.position.x += dx;
      }
    }
  }
  controls.update();

  // Brightness: settings, dimmed as the camera gets close so stones stay the star of the show.
  const dist = camera.position.distanceTo(controls.target);
  const f = settings.autoDim ? THREE.MathUtils.smoothstep(dist, 4, 45) : 1;
  globalUniforms.uBrightness.value = settings.brightness * (0.3 + 0.7 * f);
  bloom.strength = settings.glow * (0.35 + 0.65 * f);

  flights = flights.filter((fl) => {
    fl.t = Math.min(1, fl.t + dt / 0.9);
    const t = 1 - (1 - fl.t) ** 2;
    const a = fl.from.clone().lerp(fl.ctrl, t);
    const b = fl.ctrl.clone().lerp(fl.to, t);
    fl.obj.position.copy(a.lerp(b, t));
    fl.obj.rotation.y += dt * 8;
    if (fl.t < 1) return true;
    fl.obj.removeFromParent();
    fl.done();
    return false;
  });

  if ((rangeTimer -= dt) <= 0) {
    rangeTimer = 0.1;
    viewRange = computeViewRange();
    const a = dateAtX(layout, viewRange[0]);
    const b = dateAtX(layout, viewRange[1]);
    timebar.setView(a, b);
    const fmt = (d: number) => new Date(d).toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' });
    $('tb-view').textContent = `Viewing ${fmt(a)} → ${fmt(b)}`;
    const important = new Set<string>();
    if (pinned) important.add(pinned);
    if (hovered) important.add(hovered);
    view.declutter(camera, window.innerWidth, window.innerHeight, important);
    if (!drag) for (const b of stonesShown.keys()) view.ensureStoneRange(b, viewRange, paddedView());
  }

  updateHover();
  updateStones(time);
  view.update(time, dt, camera);
  stars.position.copy(camera.position);

  if (diffOpen) {
    const c = layout.commits.get(diffOpen.commit);
    if (c) {
      const p = c.pos.clone().add(new THREE.Vector3(0, 0.95, 0)).project(camera);
      ui.placeDiff(((p.x + 1) / 2) * window.innerWidth, ((1 - p.y) / 2) * window.innerHeight);
    }
  }

  composer.render();
  labelRenderer.render(scene, camera);
  timebar.draw();
}

loadDemo();
tick();

// Dev-only hook for automated visual checks.
if (import.meta.env.DEV) {
  (window as unknown as Record<string, unknown>).__gm = {
    screenOf(commitId: string, lift = 0) {
      const pos = layout.commits.get(commitId)!.pos;
      const p = pos.clone().setY(pos.y + lift).project(camera);
      return { x: ((p.x + 1) / 2) * window.innerWidth, y: ((1 - p.y) / 2) * window.innerHeight };
    },
    screenOfPoint(x: number, y: number, z: number) {
      const p = new THREE.Vector3(x, y, z).project(camera);
      return { x: ((p.x + 1) / 2) * window.innerWidth, y: ((1 - p.y) / 2) * window.innerHeight };
    },
    tipOf(branch: string) {
      const t = view.tip(branch);
      if (!t) return null;
      const p = t.group.position.clone().project(camera);
      return { x: ((p.x + 1) / 2) * window.innerWidth, y: ((1 - p.y) / 2) * window.innerHeight };
    },
    branches: () =>
      layout.branches.map((b) => ({ name: b.name, own: b.own, base: b.base, head: b.head, synthetic: b.synthetic, behind: b.behind })),
    check: (op: Op) => source.check(op),
    state: () => ({ commits: layout.commits.size, since: win.since, until: win.until, cutoff: replay.cutoff, viewRange, brightness: globalUniforms.uBrightness.value }),
    focus: (name: string) => focusBranch(name),
    frameAll,
  };
}
