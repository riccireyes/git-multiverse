import {
  MemoryStore,
  type CheckResult,
  type CommitDiff,
  type Histogram,
  type Op,
  type RawCommit,
  type WindowData,
  type WindowQuery,
} from './model';

export interface DataSource {
  readonly label: string;
  /** True when operations can be written to a real repository. */
  readonly canWrite: boolean;
  writeMode: boolean;
  histogram(): Promise<Histogram>;
  load(q: WindowQuery): Promise<WindowData>;
  check(op: Op): Promise<CheckResult>;
  apply(op: Op): Promise<{ id?: string; message: string }>;
  diff(id: string): Promise<CommitDiff>;
}

const short = (id: string) => id.slice(0, 7);

/** The git command an operation corresponds to, for confirmation dialogs. */
export function describeOp(op: Op) {
  switch (op.kind) {
    case 'branch':
      return `git branch ${op.name} ${short(op.at)}`;
    case 'commit':
      return `git commit --allow-empty -m "${op.message}"   (on ${op.branch})`;
    case 'cherry-pick':
      return `git cherry-pick ${short(op.commit)}   (onto ${op.branch})`;
    case 'merge':
      return `git merge --no-ff ${op.source}   (into ${op.target})`;
  }
}

function describeResult(op: Op) {
  switch (op.kind) {
    case 'branch':
      return `New timeline "${op.name}" branched from ${short(op.at)}`;
    case 'commit':
      return `Committed to ${op.branch}`;
    case 'cherry-pick':
      return `Cherry-picked ${short(op.commit)} onto ${op.branch}`;
    case 'merge':
      return `Merged ${op.source} into ${op.target}`;
  }
}

/** A plausible-looking patch for commits that only exist in memory. */
function simulatedPatch(c: RawCommit, path: string, add: number, del: number) {
  const lines = [`diff --git a/${path} b/${path}`, `--- a/${path}`, `+++ b/${path}`, `@@ -${12 + del},${del + 3} +${12 + add},${add + 3} @@`];
  lines.push(`   // ${path.split('/').pop()}`);
  for (let i = 0; i < Math.min(del, 6); i++) lines.push(`-  legacyTimeline.step(${i}); // before: ${c.message.toLowerCase()}`);
  for (let i = 0; i < Math.min(add, 8); i++) lines.push(`+  sacredTimeline.step(${i}); // ${c.message}`);
  if (add > 8) lines.push(`   … ${add - 8} more lines`);
  lines.push('   return timeline;');
  return lines.join('\n');
}

// ---------------------------------------------------------------------------

export class DemoSource implements DataSource {
  readonly label = 'Demo multiverse';
  readonly canWrite = false;
  writeMode = false;
  private store: MemoryStore;

  constructor(commits: RawCommit[], heads: { name: string; head: string }[]) {
    this.store = new MemoryStore(commits, heads);
  }

  async histogram() {
    return this.store.histogram();
  }

  async load(q: WindowQuery) {
    return this.store.window(q);
  }

  async check(op: Op): Promise<CheckResult> {
    const error = this.store.validate(op);
    if (error) return { ok: false, conflicts: [], error };
    const conflicts = this.store.conflicts(op);
    return { ok: !conflicts.length, conflicts };
  }

  async apply(op: Op) {
    return { id: this.store.apply(op), message: describeResult(op) };
  }

  async diff(id: string): Promise<CommitDiff> {
    const c = this.store.commits.get(id);
    if (!c) return { id, files: [], simulated: true };
    const src = c.cherryOf ? this.store.commits.get(c.cherryOf) ?? c : c;
    return {
      id,
      simulated: true,
      files: (src.files ?? []).map((f) => ({ ...f, patch: simulatedPatch(src, f.path, f.add, f.del) })),
    };
  }
}

// ---------------------------------------------------------------------------

export class DiskSource implements DataSource {
  readonly canWrite = true;
  writeMode = false;
  /** Simulated operations layered over what's on disk (used while write mode is off). */
  private overlay: RawCommit[] = [];
  private overlayHeads = new Map<string, string>();
  private lastWindow: WindowData | null = null;

  constructor(
    readonly path: string,
    readonly label: string,
  ) {}

  private async get<T>(endpoint: string, params: Record<string, string | number | null | undefined>): Promise<T> {
    const qs = new URLSearchParams({ path: this.path });
    for (const [k, v] of Object.entries(params)) if (v !== null && v !== undefined) qs.set(k, String(v));
    const res = await fetch(`/api/${endpoint}?${qs}`, { headers: { 'x-git-multiverse': '1' } });
    const data = await res.json();
    if (!res.ok) throw Object.assign(new Error(data.error ?? 'Request failed'), data);
    return data as T;
  }

  histogram() {
    return this.get<Histogram>('histogram', {});
  }

  get hasSimulated() {
    return this.overlay.length > 0 || this.overlayHeads.size > 0;
  }

  discardSimulated() {
    this.overlay = [];
    this.overlayHeads.clear();
  }

  async load(q: WindowQuery) {
    const w = await this.get<WindowData>('repo', { since: q.since, until: q.until, max: q.max });
    if (this.writeMode) {
      this.lastWindow = w;
      return w;
    }
    // Replay simulated operations on top of the real history.
    const ids = new Set(w.commits.map((c) => c.id));
    for (const c of this.overlay) {
      if (q.until && c.date > q.until) continue;
      if (c.parents.some((p) => ids.has(p) || this.overlay.some((o) => o.id === p))) {
        w.commits.push(c);
        ids.add(c.id);
      }
    }
    for (const [name, head] of this.overlayHeads) {
      if (!ids.has(head)) continue;
      const b = w.branches.find((x) => x.name === name);
      if (b) Object.assign(b, { head, moved: false });
      else w.branches.push({ name, head });
    }
    this.lastWindow = w;
    return w;
  }

  private store() {
    const w = this.lastWindow;
    return new MemoryStore(w?.commits ?? [], w?.branches ?? []);
  }

  private isSimulated(id: string) {
    return this.overlay.some((c) => c.id === id);
  }

  async check(op: Op): Promise<CheckResult> {
    // Branch heads in an old window aren't the real heads; validate against the real ones on disk.
    if (!this.writeMode) {
      const error = this.store().validate(op);
      if (error) return { ok: false, conflicts: [], error };
    }
    const simulated =
      (op.kind === 'cherry-pick' && (this.isSimulated(op.commit) || this.overlayHeads.has(op.branch))) ||
      (op.kind === 'merge' && (this.overlayHeads.has(op.source) || this.overlayHeads.has(op.target)));
    if (op.kind === 'branch' || op.kind === 'commit' || simulated) return { ok: true, conflicts: [] };
    try {
      return await this.get<CheckResult>('check', { op: JSON.stringify(op) });
    } catch (e) {
      return { ok: false, conflicts: [], error: (e as Error).message };
    }
  }

  async apply(op: Op) {
    if (this.writeMode) {
      const res = await fetch('/api/op', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-git-multiverse': '1' },
        body: JSON.stringify({ path: this.path, op }),
      });
      const data = await res.json();
      if (!res.ok) throw Object.assign(new Error(data.error ?? 'Operation failed'), data);
      return data as { id?: string; message: string };
    }
    const store = this.store();
    for (const c of this.overlay) store.commits.set(c.id, c);
    for (const [n, h] of this.overlayHeads) store.heads.set(n, h);
    const before = new Set(store.commits.keys());
    const id = store.apply(op);
    for (const [cid, c] of store.commits) if (!before.has(cid)) this.overlay.push(c);
    const head = op.kind === 'branch' ? op.name : op.kind === 'merge' ? op.target : op.branch;
    this.overlayHeads.set(head, store.heads.get(head)!);
    return { id, message: `${describeResult(op)} (simulated)` };
  }

  async diff(id: string): Promise<CommitDiff> {
    const sim = this.overlay.find((c) => c.id === id);
    if (sim) {
      if (sim.cherryOf && !this.isSimulated(sim.cherryOf)) return { ...(await this.diff(sim.cherryOf)), id };
      return { id, files: [], simulated: true };
    }
    return this.get<CommitDiff>('diff', { id });
  }
}
