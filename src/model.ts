import { Vector2, Vector3 } from 'three';

// ---------------------------------------------------------------------------
// Data exchanged with sources
// ---------------------------------------------------------------------------

export interface FileChange {
  path: string;
  add: number;
  del: number;
  binary?: boolean;
  patch?: string;
}

export interface RawCommit {
  id: string;
  parents: string[];
  message: string;
  author: string;
  date: number;
  cherryOf?: string;
  files?: FileChange[];
}

export interface RepoData {
  path?: string;
  commits: RawCommit[];
  /** moved: the real head is newer than the window; this is the newest commit inside it. */
  branches: { name: string; head: string; moved?: boolean }[];
  current?: string;
  checkedOut?: string[];
}

export interface WindowData extends RepoData {
  since: number;
  until: number | null;
  truncated: boolean;
}

export interface WindowQuery {
  since?: number | null;
  until?: number | null;
  max: number;
}

export interface Histogram {
  start: number;
  bucket: number;
  counts: number[];
  total: number;
}

export type Op =
  | { kind: 'branch'; name: string; at: string }
  | { kind: 'commit'; branch: string; message: string }
  | { kind: 'cherry-pick'; commit: string; branch: string }
  | { kind: 'merge'; source: string; target: string };

export interface CheckResult {
  ok: boolean;
  conflicts: string[];
  error?: string;
}

export interface CommitDiff {
  id: string;
  files: FileChange[];
  truncated?: boolean;
  simulated?: boolean;
}

// ---------------------------------------------------------------------------
// Laid-out data (what the 3D view consumes)
// ---------------------------------------------------------------------------

export interface LaidCommit extends RawCommit {
  order: number;
  branch: string;
  pos: Vector3;
}

export interface LaidBranch {
  name: string;
  /** Human-facing name (synthetic timelines get one from their merge message). */
  title: string;
  color: string;
  lane: number;
  isMain: boolean;
  /** Branch deleted after being merged: reconstructed from merge parents. */
  synthetic: boolean;
  head: string;
  base: string | null;
  own: string[];
  mergeTarget: string | null;
  startX: number;
  endX: number;
  samples: Vector3[];
  /** Commits on main (in this window) that this timeline has not caught up with. */
  behind: number;
}

export interface LaidLink {
  from: string;
  to: string;
  color: string;
  samples: Vector3[];
}

export interface LaidMerge {
  id: string;
  pos: Vector3;
  colors: [string, string];
}

export interface Layout {
  commits: Map<string, LaidCommit>;
  branches: LaidBranch[];
  links: LaidLink[];
  merges: LaidMerge[];
  minX: number;
  maxX: number;
  main: string;
  /** Monotonic x/date pairs for mapping between space and time. */
  xs: number[];
  dates: number[];
}

export const SPACING = 2.4;
export const MAIN_COLOR = '#ff9a2e';
const PALETTE = [
  '#3d7bff',
  '#b04dff',
  '#26f08c',
  '#ff3355',
  '#22d3ee',
  '#ff5fd2',
  '#a3ff3d',
  '#7c6cff',
  '#ffd23d',
  '#ff7b54',
];
const MERGED_PALETTE = ['#6f8bd8', '#a07cd6', '#5fc79a', '#d97b8e', '#5fb8c9', '#c98bd0'];

const smooth = (t: number) => {
  const c = Math.min(1, Math.max(0, t));
  return c * c * (3 - 2 * c);
};

export function laneOffset(k: number): Vector2 {
  if (k === 0) return new Vector2(0, 0);
  const ring = Math.floor((k - 1) / 6);
  const idx = (k - 1) % 6;
  const angles = [90, -90, 30, -150, 150, -30];
  const a = ((angles[idx] + ring * 30) * Math.PI) / 180;
  const r = 5 + ring * 4;
  return new Vector2(Math.sin(a) * r * 0.85, Math.cos(a) * r);
}

export function randomId() {
  let s = '';
  for (let i = 0; i < 40; i++) s += Math.floor(Math.random() * 16).toString(16);
  return s;
}

const MAIN_NAMES = ['main', 'master', 'trunk'];

export function mainBranchOf(names: string[], current?: string) {
  return MAIN_NAMES.find((n) => names.includes(n)) ?? (current && names.includes(current) ? current : names[0]);
}

/** Readable name for a timeline reconstructed from a merge commit message. */
function mergedTitle(message: string | undefined) {
  if (!message) return null;
  const m =
    /Merge (?:remote-tracking )?branch '([^']+)'/.exec(message) ??
    /Merge pull request #\d+ from [^/\s]+\/(\S+)/.exec(message) ??
    /Merge branch (\S+)/.exec(message);
  return m ? m[1] : null;
}

// ---------------------------------------------------------------------------
// Persistent per-repository styling (colors / lanes stay put across reloads)
// ---------------------------------------------------------------------------

export class RepoStyle {
  private colors = new Map<string, string>();
  readonly lanes = new Map<string, number>();

  colorFor(name: string, isMain = false) {
    if (isMain) return MAIN_COLOR;
    let c = this.colors.get(name);
    if (!c) {
      c = this.nextColor();
      this.colors.set(name, c);
    }
    return c;
  }

  nextColor() {
    return PALETTE[this.colors.size % PALETTE.length];
  }
}

// ---------------------------------------------------------------------------
// In-memory store: used for the demo and for simulated (non-written) operations
// ---------------------------------------------------------------------------

export class MemoryStore {
  readonly commits = new Map<string, RawCommit>();
  readonly heads = new Map<string, string>();

  constructor(commits: RawCommit[], heads: { name: string; head: string }[]) {
    for (const c of commits) this.commits.set(c.id, c);
    for (const h of heads) this.heads.set(h.name, h.head);
  }

  ancestors(id: string) {
    const seen = new Set<string>();
    const stack = [id];
    while (stack.length) {
      const c = stack.pop()!;
      if (seen.has(c) || !this.commits.has(c)) continue;
      seen.add(c);
      for (const p of this.commits.get(c)!.parents) stack.push(p);
    }
    return seen;
  }

  contains(head: string, id: string) {
    return this.ancestors(head).has(id);
  }

  mergeBase(a: string, b: string) {
    const anc = this.ancestors(a);
    const queue = [b];
    const seen = new Set<string>();
    while (queue.length) {
      const c = queue.shift()!;
      if (anc.has(c)) return c;
      if (seen.has(c)) continue;
      seen.add(c);
      for (const p of this.commits.get(c)?.parents ?? []) queue.push(p);
    }
    return null;
  }

  /** Commits reachable from `head` but not from `base`. */
  since(head: string, base: string | null) {
    const exclude = base ? this.ancestors(base) : new Set<string>();
    return [...this.ancestors(head)].filter((id) => !exclude.has(id)).map((id) => this.commits.get(id)!);
  }

  private nextDate() {
    let max = 0;
    for (const c of this.commits.values()) max = Math.max(max, c.date);
    return Math.max(Date.now(), max + 1000);
  }

  /** Why an operation can't happen, or null. */
  validate(op: Op): string | null {
    switch (op.kind) {
      case 'branch':
        if (!op.name) return 'A timeline needs a name';
        if (this.heads.has(op.name)) return `Timeline "${op.name}" already exists`;
        if (!/^[\w./-]+$/.test(op.name) || op.name.includes('..') || op.name.endsWith('/'))
          return `"${op.name}" is not a valid branch name`;
        return null;
      case 'commit':
        return this.heads.has(op.branch) ? null : `Unknown timeline "${op.branch}"`;
      case 'cherry-pick': {
        const src = this.commits.get(op.commit);
        const head = this.heads.get(op.branch);
        if (!src || !head) return 'Nothing to cherry-pick';
        if (src.parents.length > 1) return 'Merge commits cannot be cherry-picked';
        if (this.contains(head, op.commit)) return `${op.commit.slice(0, 7)} is already part of ${op.branch}`;
        return null;
      }
      case 'merge': {
        const s = this.heads.get(op.source);
        const t = this.heads.get(op.target);
        if (!s || !t) return 'Unknown timeline';
        if (op.source === op.target) return 'A timeline cannot merge into itself';
        if (this.contains(t, s)) return `${op.source} is already merged into ${op.target}`;
        return null;
      }
    }
  }

  /** Approximate conflicts: files touched on both sides since they diverged. */
  conflicts(op: Op): string[] {
    const touched = (cs: RawCommit[]) => new Set(cs.flatMap((c) => (c.files ?? []).map((f) => f.path)));
    if (op.kind === 'cherry-pick') {
      const head = this.heads.get(op.branch)!;
      const src = this.commits.get(op.commit)!;
      const base = this.mergeBase(head, op.commit);
      const theirs = touched([src]);
      const ours = touched(this.since(head, base));
      return [...theirs].filter((f) => ours.has(f));
    }
    if (op.kind === 'merge') {
      const t = this.heads.get(op.target)!;
      const s = this.heads.get(op.source)!;
      const base = this.mergeBase(t, s);
      const ours = touched(this.since(t, base));
      const theirs = touched(this.since(s, base));
      return [...theirs].filter((f) => ours.has(f));
    }
    return [];
  }

  apply(op: Op): string | undefined {
    const err = this.validate(op);
    if (err) throw new Error(err);
    const add = (c: Omit<RawCommit, 'id' | 'date'>) => {
      const id = randomId();
      this.commits.set(id, { ...c, id, date: this.nextDate() });
      return id;
    };
    switch (op.kind) {
      case 'branch':
        this.heads.set(op.name, op.at);
        return op.at;
      case 'commit': {
        const id = add({ parents: [this.heads.get(op.branch)!], message: op.message, author: 'You', files: [] });
        this.heads.set(op.branch, id);
        return id;
      }
      case 'cherry-pick': {
        const src = this.commits.get(op.commit)!;
        const id = add({
          parents: [this.heads.get(op.branch)!],
          message: src.message,
          author: src.author,
          cherryOf: op.commit,
          files: src.files,
        });
        this.heads.set(op.branch, id);
        return id;
      }
      case 'merge': {
        const id = add({
          parents: [this.heads.get(op.target)!, this.heads.get(op.source)!],
          message: `Merge branch '${op.source}' into ${op.target}`,
          author: 'You',
          files: [],
        });
        this.heads.set(op.target, id);
        return id;
      }
    }
  }

  /** Cut a time window out of the full history. */
  window(q: WindowQuery): WindowData {
    let list = [...this.commits.values()]
      .filter((c) => (!q.since || c.date >= q.since) && (!q.until || c.date <= q.until))
      .sort((a, b) => b.date - a.date);
    const truncated = list.length > q.max;
    if (truncated) list = list.slice(0, q.max);
    const ids = new Set(list.map((c) => c.id));
    const branches: { name: string; head: string; moved?: boolean }[] = [];
    for (const [name, head] of this.heads) {
      let h: string | undefined = head;
      while (h && !ids.has(h)) {
        const c = this.commits.get(h);
        if (!c || (q.since && c.date < q.since)) {
          h = undefined;
          break;
        }
        h = c.parents[0];
      }
      if (h) branches.push(h === head ? { name, head: h } : { name, head: h, moved: true });
    }
    const oldest = list.length ? list[list.length - 1].date : Date.now();
    return {
      commits: list,
      branches,
      current: 'main',
      since: truncated || !q.since ? oldest : q.since,
      until: q.until ?? null,
      truncated,
    };
  }

  histogram(): Histogram {
    const times = [...this.commits.values()].map((c) => c.date);
    return bucketize(times);
  }
}

export function bucketize(times: number[]): Histogram {
  if (!times.length) return { start: Date.now(), bucket: 86400000, counts: [], total: 0 };
  let min = Infinity;
  let max = -Infinity;
  for (const t of times) {
    if (t < min) min = t;
    if (t > max) max = t;
  }
  const DAY = 86400000;
  const span = Math.max(DAY, max - min);
  const bucket = span < 90 * DAY ? DAY / 4 : span < 2 * 365 * DAY ? DAY : span < 10 * 365 * DAY ? 7 * DAY : 30 * DAY;
  const start = Math.floor(min / bucket) * bucket;
  const counts = new Array(Math.floor((max - start) / bucket) + 1).fill(0);
  for (const t of times) counts[Math.floor((t - start) / bucket)]++;
  return { start, bucket, counts, total: times.length };
}

// ---------------------------------------------------------------------------
// Layout
// ---------------------------------------------------------------------------

export function layoutRepo(data: RepoData, style: RepoStyle): Layout {
  const all = new Map<string, RawCommit>();
  for (const c of data.commits) all.set(c.id, c);
  const heads = new Map<string, string>();
  for (const b of data.branches) if (all.has(b.head)) heads.set(b.name, b.head);
  const names = [...heads.keys()];
  const mainName = mainBranchOf(names, data.current) ?? '';
  const firstParent = (id: string): string | null => {
    const p = all.get(id)?.parents[0];
    return p && all.has(p) ? p : null;
  };
  const ancestors = (id: string) => {
    const seen = new Set<string>();
    const stack = [id];
    while (stack.length) {
      const c = stack.pop()!;
      if (seen.has(c) || !all.has(c)) continue;
      seen.add(c);
      for (const p of all.get(c)!.parents) stack.push(p);
    }
    return seen;
  };

  // Long-lived branches claim shared history first.
  const tier = (n: string) =>
    n === mainName ? -1 : /^(develop|dev|development|next|staging)$/.test(n) ? 0 : /^(release|hotfix)[/-]/.test(n) ? 1 : 2;
  const chainLen = (head: string) => {
    let n = 0;
    for (let c: string | null = head; c; c = firstParent(c)) n++;
    return n;
  };
  const priority = names.sort((a, b) => tier(a) - tier(b) || chainLen(heads.get(b)!) - chainLen(heads.get(a)!));

  // 1. Topological order (parents first, chronological where possible).
  const order = new Map<string, number>();
  const sorted = [...all.values()].sort((a, b) => a.date - b.date);
  for (const root of sorted) {
    const stack: [string, boolean][] = [[root.id, false]];
    while (stack.length) {
      const [id, done] = stack.pop()!;
      if (order.has(id)) continue;
      if (done) {
        order.set(id, order.size);
        continue;
      }
      stack.push([id, true]);
      const ps = all.get(id)!.parents.filter((p) => all.has(p) && !order.has(p));
      for (let i = ps.length - 1; i >= 0; i--) stack.push([ps[i], false]);
    }
  }
  const xOf = (id: string) => order.get(id)! * SPACING;
  const byOrder = [...order.keys()].sort((a, b) => order.get(a)! - order.get(b)!);

  // 2. Ownership: each timeline claims its first-parent chain.
  const claim = new Map<string, string>();
  interface Draft {
    name: string;
    title: string;
    head: string;
    own: string[];
    base: string | null;
    synthetic: boolean;
  }
  const drafts: Draft[] = [];
  const walk = (name: string, title: string, head: string, synthetic: boolean) => {
    const own: string[] = [];
    for (let c: string | null = head; c && !claim.has(c); c = firstParent(c)) {
      claim.set(c, name);
      own.push(c);
    }
    own.reverse();
    const base = own.length ? firstParent(own[0]) : head;
    drafts.push({ name, title, head, own, base, synthetic });
  };
  const moved = new Set(data.branches.filter((b) => b.moved).map((b) => b.name));
  for (const name of priority) {
    walk(name, name, heads.get(name)!, false);
    const d = drafts[drafts.length - 1];
    if (!d.own.length && moved.has(name) && name !== mainName) drafts.pop();
  }

  let changed = true;
  while (changed) {
    changed = false;
    for (const id of byOrder) {
      if (!claim.has(id)) continue;
      for (const p of all.get(id)!.parents.slice(1)) {
        if (all.has(p) && !claim.has(p)) {
          const title = mergedTitle(all.get(id)!.message) ?? `merged ${p.slice(0, 7)}`;
          walk(`merged:${p}`, title, p, true);
          changed = true;
        }
      }
    }
  }
  // Commits not reachable from any branch head within the window (e.g. window-edge leftovers).
  for (const id of [...byOrder].reverse()) if (!claim.has(id)) walk(`merged:${id}`, `detached ${id.slice(0, 7)}`, id, true);

  const mergedInto = new Map<string, string>();
  for (const id of byOrder) for (const p of all.get(id)!.parents.slice(1)) if (!mergedInto.has(p)) mergedInto.set(p, id);

  let maxX = 0;
  for (const v of order.values()) maxX = Math.max(maxX, v * SPACING);
  const minX = 0;

  // 3. Extents + lanes.
  interface Placed extends Draft {
    startX: number;
    endX: number;
    mergeTarget: string | null;
    lane: number;
    color: string;
  }
  let synthColor = 0;
  const placed: Placed[] = drafts.map((d) => {
    const isMain = d.name === mainName;
    const mergeTarget = !isMain && d.own.length ? mergedInto.get(d.head) ?? null : null;
    let startX: number;
    let endX: number;
    if (isMain) {
      startX = minX - 30;
      endX = maxX + 12;
    } else {
      startX = d.base ? xOf(d.base) : xOf(d.own[0]) - SPACING * 2;
      if (mergeTarget) endX = xOf(mergeTarget);
      else if (d.own.length) endX = xOf(d.head) + SPACING * 0.7;
      else endX = startX + SPACING * 3.5;
    }
    const color = d.synthetic ? MERGED_PALETTE[synthColor++ % MERGED_PALETTE.length] : style.colorFor(d.name, isMain);
    return { ...d, startX, endX, mergeTarget, lane: isMain ? 0 : -1, color };
  });

  const occupied: [number, number][][] = [[]];
  const fits = (k: number, a: number, b: number) => (occupied[k] ?? []).every(([s, e]) => b < s - SPACING || a > e + SPACING);
  const reserve = (k: number, a: number, b: number) => (occupied[k] ??= []).push([a, b]);
  // Live timelines pick lanes first so they stay close to main; merged history fills in around them.
  const laneOrder = [...placed].sort((a, b) => Number(a.synthetic) - Number(b.synthetic) || a.startX - b.startX);
  for (const p of laneOrder) {
    if (p.lane === 0) continue;
    const a = p.startX;
    const b = p.mergeTarget || p.synthetic ? p.endX : Infinity;
    const prev = style.lanes.get(p.name);
    let k = prev !== undefined && prev > 0 && fits(prev, a, b) ? prev : 1;
    if (k !== prev) while (!fits(k, a, b)) k++;
    p.lane = k;
    reserve(k, a, b);
    if (!p.synthetic) style.lanes.set(p.name, k);
  }

  // 4. Paths: every timeline is a smooth function of x.
  const byName = new Map(placed.map((p) => [p.name, p]));
  const offsetCache = new Map<string, (x: number) => Vector2>();
  const offsetFn = (p: Placed, depth = 0): ((x: number) => Vector2) => {
    const cached = offsetCache.get(p.name);
    if (cached) return cached;
    const lane = laneOffset(p.lane);
    if (p.lane === 0 || depth > 6) return () => lane.clone();
    const ownerOffset = (id: string | null, fallback: Vector2) => {
      const owner = id ? byName.get(claim.get(id)!) : undefined;
      if (!owner || owner === p) return fallback;
      return offsetFn(owner, depth + 1)(xOf(id!));
    };
    const from = ownerOffset(p.base, lane);
    const to = p.mergeTarget ? ownerOffset(p.mergeTarget, lane) : lane;
    const span = p.endX - p.startX;
    const T = p.mergeTarget ? Math.min(SPACING * 3, span / 2) : Math.min(SPACING * 3, span * 0.8);
    const fn = (x: number) => {
      let o = from.clone().lerp(lane, smooth((x - p.startX) / T));
      if (p.mergeTarget) o = o.lerp(to, smooth((x - (p.endX - T)) / T));
      return o;
    };
    offsetCache.set(p.name, fn);
    return fn;
  };
  const at = (p: Placed, x: number) => {
    const o = offsetFn(p)(x);
    return new Vector3(x, o.x, o.y);
  };
  const sample = (a: number, b: number, f: (x: number) => Vector3) => {
    const n = Math.max(24, Math.ceil((b - a) / (SPACING / 4)));
    return Array.from({ length: n + 1 }, (_, i) => f(a + ((b - a) * i) / n));
  };

  const commits = new Map<string, LaidCommit>();
  for (const [id, o] of order) {
    const owner = byName.get(claim.get(id)!)!;
    commits.set(id, { ...all.get(id)!, order: o, branch: owner.name, pos: at(owner, o * SPACING) });
  }

  // 5. Divergence from main (nexus events).
  const mainAnc = mainName ? ancestors(heads.get(mainName)!) : new Set<string>();

  const branches: LaidBranch[] = placed.map((p) => {
    let behind = 0;
    if (!p.synthetic && p.name !== mainName && !p.mergeTarget) {
      const anc = ancestors(p.head);
      for (const id of mainAnc) if (!anc.has(id)) behind++;
    }
    return {
      name: p.name,
      title: p.title,
      color: p.color,
      lane: p.lane,
      isMain: p.name === mainName,
      synthetic: p.synthetic,
      head: p.head,
      base: p.base,
      own: p.own,
      mergeTarget: p.mergeTarget,
      startX: p.startX,
      endX: p.endX,
      samples: sample(p.startX, p.endX, (x) => at(p, x)),
      behind,
    };
  });

  // 6. Merge links + braids.
  const links: LaidLink[] = [];
  const merges: LaidMerge[] = [];
  for (const c of commits.values()) {
    const extra = c.parents.slice(1).filter((pid) => commits.has(pid));
    if (extra.length) {
      const src = commits.get(extra[0])!;
      merges.push({ id: c.id, pos: c.pos, colors: [byName.get(c.branch)!.color, byName.get(src.branch)!.color] });
    }
    for (const pid of extra) {
      const src = commits.get(pid)!;
      const owner = byName.get(src.branch)!;
      if (owner.head === pid && owner.mergeTarget === c.id) continue;
      const a = src.pos;
      const b = c.pos;
      const f = (x: number) => {
        const t = smooth((x - a.x) / Math.max(1e-3, b.x - a.x));
        return new Vector3(x, a.y + (b.y - a.y) * t, a.z + (b.z - a.z) * t);
      };
      links.push({ from: pid, to: c.id, color: owner.color, samples: sample(a.x, b.x, f) });
    }
  }

  // 7. Space <-> time mapping.
  const xs: number[] = [];
  const dates: number[] = [];
  let running = -Infinity;
  for (const id of byOrder) {
    running = Math.max(running, all.get(id)!.date);
    xs.push(xOf(id));
    dates.push(running);
  }

  return { commits, branches, links, merges, minX, maxX, main: mainName, xs, dates };
}

export function dateAtX(l: Layout, x: number) {
  const { xs, dates } = l;
  if (!xs.length) return Date.now();
  if (x <= xs[0]) return dates[0];
  if (x >= xs[xs.length - 1]) return dates[dates.length - 1];
  const i = Math.min(xs.length - 2, Math.floor(x / SPACING));
  const t = (x - xs[i]) / (xs[i + 1] - xs[i]);
  return dates[i] + (dates[i + 1] - dates[i]) * t;
}

export function xAtDate(l: Layout, d: number) {
  const { xs, dates } = l;
  if (!xs.length) return 0;
  if (d <= dates[0]) return xs[0];
  if (d >= dates[dates.length - 1]) return xs[xs.length - 1];
  let lo = 0;
  let hi = dates.length - 1;
  while (hi - lo > 1) {
    const mid = (lo + hi) >> 1;
    if (dates[mid] <= d) lo = mid;
    else hi = mid;
  }
  const span = dates[hi] - dates[lo];
  return xs[lo] + (span > 0 ? ((d - dates[lo]) / span) * (xs[hi] - xs[lo]) : 0);
}
