import { execFile } from 'node:child_process';
import { existsSync, statSync } from 'node:fs';
import { resolve } from 'node:path';
import type { IncomingMessage, ServerResponse } from 'node:http';
import type { Plugin } from 'vite';

// Bridge between the browser and local repositories.
// Reads are free; writes (POST /api/op) only happen when the UI's write mode is on and the user
// confirmed the operation. Writes never touch a working tree except to fast-forward a clean,
// checked-out branch: new commits are built with `merge-tree` / `commit-tree`.

const US = '\x1f';
const RS = '\x1e';
const EMPTY_TREE = '4b825dc642cb6eb9a060e54bf8d69288fbee4904';
const MAX_PATCH = 400_000;

interface Run {
  code: number;
  stdout: string;
  stderr: string;
}

function run(cwd: string, args: string[], env?: Record<string, string>): Promise<Run> {
  return new Promise((ok) => {
    execFile(
      'git',
      args,
      { cwd, maxBuffer: 64 * 1024 * 1024, env: env ? { ...process.env, ...env } : process.env },
      (err, stdout, stderr) => {
        const code = err ? (typeof (err as NodeJS.ErrnoException).code === 'number' ? Number((err as NodeJS.ErrnoException).code) : 1) : 0;
        ok({ code, stdout, stderr });
      },
    );
  });
}

async function git(cwd: string, args: string[], env?: Record<string, string>) {
  const r = await run(cwd, args, env);
  if (r.code !== 0) throw new Error(r.stderr.trim() || `git ${args[0]} failed`);
  return r.stdout;
}

class HttpError extends Error {
  constructor(
    readonly status: number,
    message: string,
    readonly extra: Record<string, unknown> = {},
  ) {
    super(message);
  }
}

// ---------------------------------------------------------------------------
// Reads
// ---------------------------------------------------------------------------

async function branchRefs(dir: string) {
  const out = await git(dir, [
    'for-each-ref',
    'refs/heads',
    `--format=%(refname:short)${US}%(objectname)${US}%(committerdate:unix)`,
  ]);
  return out
    .split('\n')
    .filter(Boolean)
    .map((l) => {
      const [name, head, at] = l.split(US);
      return { name, head, date: Number(at) * 1000 };
    });
}

async function worktrees(dir: string) {
  const out = await git(dir, ['worktree', 'list', '--porcelain']);
  const map = new Map<string, string>(); // branch -> worktree path
  let path = '';
  for (const line of out.split('\n')) {
    if (line.startsWith('worktree ')) path = line.slice(9);
    if (line.startsWith('branch refs/heads/')) map.set(line.slice(18), path);
  }
  return map;
}

async function readWindow(dir: string, since: number | null, until: number | null, max: number) {
  const args = ['log', '--branches', '--date-order', `-n${max + 1}`, `--format=%H${US}%P${US}%an${US}%ct${US}%s${RS}`];
  if (since) args.push(`--max-age=${Math.floor(since / 1000)}`);
  if (until) args.push(`--min-age=${Math.ceil(until / 1000)}`);
  const log = await git(dir, args);
  let commits = log
    .split(RS)
    .map((r) => r.trim())
    .filter(Boolean)
    .map((r) => {
      const [id, parents, author, at, message] = r.split(US);
      return { id, parents: parents ? parents.split(' ') : [], author, date: Number(at) * 1000, message };
    });
  const truncated = commits.length > max;
  if (truncated) commits = commits.slice(0, max);
  const ids = new Set(commits.map((c) => c.id));

  // A branch whose tip is newer than the window is shown by its newest first-parent commit inside it.
  const refs = await branchRefs(dir);
  const branches: { name: string; head: string; moved?: boolean }[] = [];
  await Promise.all(
    refs.map(async (r) => {
      if (ids.has(r.head)) return branches.push({ name: r.name, head: r.head });
      if (until && r.date > until) {
        const h = (await run(dir, ['rev-list', '-1', '--first-parent', `--min-age=${Math.ceil(until / 1000)}`, r.head])).stdout.trim();
        if (h && ids.has(h)) branches.push({ name: r.name, head: h, moved: true });
      }
    }),
  );

  let current = '';
  const cur = await run(dir, ['rev-parse', '--abbrev-ref', 'HEAD']);
  if (cur.code === 0) current = cur.stdout.trim();
  const checkedOut = [...(await worktrees(dir)).keys()];
  const oldest = commits.length ? commits[commits.length - 1].date : Date.now();
  return {
    path: dir,
    commits,
    branches,
    current,
    checkedOut,
    since: truncated || !since ? oldest : since,
    until,
    truncated,
  };
}

const histCache = new Map<string, { key: string; value: unknown }>();
async function histogram(dir: string) {
  const refs = await branchRefs(dir);
  const key = refs.map((r) => r.head).join(',');
  const hit = histCache.get(dir);
  if (hit?.key === key) return hit.value;
  const out = await git(dir, ['log', '--branches', '--format=%ct']);
  const times = out.split('\n').filter(Boolean).map((s) => Number(s) * 1000);
  const value = bucketize(times);
  histCache.set(dir, { key, value });
  return value;
}

function bucketize(times: number[]) {
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

async function diff(dir: string, id: string) {
  const base = ['diff-tree', '-r', '--root', '-m', '--first-parent', '--no-commit-id', '-M'];
  const numstat = await git(dir, [...base, '--numstat', id]);
  const patchOut = await git(dir, [...base, '-p', '--no-color', '--no-ext-diff', id]);
  const truncated = patchOut.length > MAX_PATCH;
  const patch = truncated ? patchOut.slice(0, MAX_PATCH) : patchOut;
  const patches = new Map<string, string>();
  const parts = patch.split(/^(?=diff --git )/m);
  for (const p of parts) {
    const m = /^diff --git a\/(.*?) b\/(.*)$/m.exec(p);
    if (m) patches.set(m[2], p);
  }
  const files = numstat
    .split('\n')
    .filter(Boolean)
    .map((l) => {
      const [a, d, ...rest] = l.split('\t');
      const path = rest[rest.length - 1];
      return { path, add: a === '-' ? 0 : Number(a), del: d === '-' ? 0 : Number(d), binary: a === '-', patch: patches.get(path) };
    });
  return { id, files, truncated };
}

// ---------------------------------------------------------------------------
// Operations
// ---------------------------------------------------------------------------

type Op =
  | { kind: 'branch'; name: string; at: string }
  | { kind: 'commit'; branch: string; message: string }
  | { kind: 'cherry-pick'; commit: string; branch: string }
  | { kind: 'merge'; source: string; target: string };

const rev = async (dir: string, r: string) => (await git(dir, ['rev-parse', '--verify', '--quiet', `${r}^{commit}`])).trim();
const headOf = (dir: string, branch: string) => rev(dir, `refs/heads/${branch}`);

/** 3-way merge in the object database only. Returns the tree or the conflicted paths. */
async function mergeTree(dir: string, ours: string, theirs: string, mergeBase?: string) {
  const args = ['merge-tree', '--write-tree', '--name-only', '--no-messages'];
  if (mergeBase) args.push(`--merge-base=${mergeBase}`);
  args.push(ours, theirs);
  const r = await run(dir, args);
  const lines = r.stdout.split('\n');
  if (r.code === 0) return { tree: lines[0].trim(), conflicts: [] as string[] };
  if (r.code === 1) {
    const conflicts: string[] = [];
    for (const l of lines.slice(1)) {
      if (!l.trim()) break;
      conflicts.push(l.trim());
    }
    return { tree: '', conflicts: [...new Set(conflicts)] };
  }
  throw new Error(r.stderr.trim() || 'merge-tree failed');
}

const isAncestor = async (dir: string, a: string, b: string) =>
  (await run(dir, ['merge-base', '--is-ancestor', a, b])).code === 0;

async function cherryTree(dir: string, commit: string, branch: string) {
  const info = (await git(dir, ['show', '-s', `--format=%P`, commit])).trim().split(' ').filter(Boolean);
  if (info.length > 1) throw new HttpError(400, 'Merge commits cannot be cherry-picked');
  const parent = info[0] ?? EMPTY_TREE;
  const head = await headOf(dir, branch);
  if (await isAncestor(dir, commit, head)) throw new HttpError(400, `${commit.slice(0, 7)} is already part of ${branch}`);
  const res = await mergeTree(dir, head, commit, parent);
  if (res.tree && res.tree === (await git(dir, ['rev-parse', `${head}^{tree}`])).trim()) {
    throw new HttpError(400, `${branch} already has the changes from ${commit.slice(0, 7)}`);
  }
  return { ...res, head };
}

async function mergeHeads(dir: string, source: string, target: string) {
  if (source === target) throw new HttpError(400, 'A timeline cannot merge into itself');
  const t = await headOf(dir, target);
  const s = await headOf(dir, source);
  if (await isAncestor(dir, s, t)) throw new HttpError(400, `${source} is already merged into ${target}`);
  return { t, s };
}

async function check(dir: string, op: Op) {
  try {
    if (op.kind === 'cherry-pick') {
      const { conflicts } = await cherryTree(dir, op.commit, op.branch);
      return { ok: !conflicts.length, conflicts };
    }
    if (op.kind === 'merge') {
      const { t, s } = await mergeHeads(dir, op.source, op.target);
      const { conflicts } = await mergeTree(dir, t, s);
      return { ok: !conflicts.length, conflicts };
    }
    return { ok: true, conflicts: [] };
  } catch (e) {
    return { ok: false, conflicts: [], error: (e as Error).message };
  }
}

/** Move a branch to `next` (a descendant of `prev`) without disturbing anyone's work. */
async function advance(dir: string, branch: string, prev: string, next: string) {
  const wt = (await worktrees(dir)).get(branch);
  if (!wt) {
    await git(dir, ['update-ref', '-m', 'git-multiverse', `refs/heads/${branch}`, next, prev]);
    return;
  }
  const dirty = (await git(wt, ['status', '--porcelain', '--untracked-files=no'])).trim();
  if (dirty) {
    throw new HttpError(409, `${branch} is checked out in ${wt} with uncommitted changes. Commit or stash them first.`);
  }
  await git(wt, ['merge', '--ff-only', '--quiet', next]);
}

async function apply(dir: string, op: Op): Promise<{ id?: string; message: string }> {
  switch (op.kind) {
    case 'branch': {
      await git(dir, ['check-ref-format', '--branch', op.name]);
      await git(dir, ['branch', '--', op.name, await rev(dir, op.at)]);
      return { id: op.at, message: `Created ${op.name}` };
    }
    case 'commit': {
      const head = await headOf(dir, op.branch);
      const tree = (await git(dir, ['rev-parse', `${head}^{tree}`])).trim();
      const id = (await git(dir, ['commit-tree', tree, '-p', head, '-m', op.message])).trim();
      await advance(dir, op.branch, head, id);
      return { id, message: `Committed to ${op.branch}` };
    }
    case 'cherry-pick': {
      const { tree, conflicts, head } = await cherryTree(dir, op.commit, op.branch);
      if (conflicts.length) throw new HttpError(409, 'Cherry-pick conflicts', { conflicts });
      const meta = (await git(dir, ['show', '-s', `--format=%an${US}%ae${US}%ad`, '--date=raw', op.commit])).trim().split(US);
      const body = (await git(dir, ['show', '-s', '--format=%B', op.commit])).trimEnd();
      const id = (
        await git(dir, ['commit-tree', tree, '-p', head, '-m', `${body}\n\n(cherry picked from commit ${op.commit})`], {
          GIT_AUTHOR_NAME: meta[0],
          GIT_AUTHOR_EMAIL: meta[1],
          GIT_AUTHOR_DATE: meta[2],
        })
      ).trim();
      await advance(dir, op.branch, head, id);
      return { id, message: `Cherry-picked ${op.commit.slice(0, 7)} onto ${op.branch}` };
    }
    case 'merge': {
      const { t: target, s: source } = await mergeHeads(dir, op.source, op.target);
      const { tree, conflicts } = await mergeTree(dir, target, source);
      if (conflicts.length) throw new HttpError(409, 'Merge conflicts', { conflicts });
      const msg = `Merge branch '${op.source}' into ${op.target}`;
      const id = (await git(dir, ['commit-tree', tree, '-p', target, '-p', source, '-m', msg])).trim();
      await advance(dir, op.target, target, id);
      return { id, message: `Merged ${op.source} into ${op.target}` };
    }
  }
}

// ---------------------------------------------------------------------------
// HTTP
// ---------------------------------------------------------------------------

function repoDir(p: string | null | undefined) {
  const dir = resolve(p ?? process.cwd());
  if (!existsSync(dir) || !statSync(dir).isDirectory()) throw new HttpError(400, `Folder not found: ${dir}`);
  return dir;
}

function readBody(req: IncomingMessage): Promise<any> {
  return new Promise((ok, fail) => {
    let data = '';
    req.on('data', (c) => {
      data += c;
      if (data.length > 1e6) req.destroy();
    });
    req.on('end', () => {
      try {
        ok(JSON.parse(data || '{}'));
      } catch (e) {
        fail(e);
      }
    });
  });
}

const num = (v: string | null) => (v ? Number(v) : null);

async function handle(req: IncomingMessage, res: ServerResponse) {
  const url = new URL(req.url ?? '', 'http://localhost');
  // Custom header forces a CORS preflight, so other websites can't drive this API.
  if (req.headers['x-git-multiverse'] !== '1') throw new HttpError(403, 'Missing client header');
  const q = url.searchParams;
  switch (url.pathname) {
    case '/repo':
      return readWindow(repoDir(q.get('path')), num(q.get('since')), num(q.get('until')), Math.min(5000, num(q.get('max')) ?? 800));
    case '/histogram':
      return histogram(repoDir(q.get('path')));
    case '/diff':
      return diff(repoDir(q.get('path')), q.get('id') ?? '');
    case '/check': {
      const body = JSON.parse(q.get('op') ?? '{}') as Op;
      return check(repoDir(q.get('path')), body);
    }
    case '/op': {
      if (req.method !== 'POST') throw new HttpError(405, 'POST only');
      const body = await readBody(req);
      return apply(repoDir(body.path), body.op as Op);
    }
  }
  throw new HttpError(404, 'Not found');
}

export function gitApi(): Plugin {
  return {
    name: 'git-multiverse-api',
    configureServer(server) {
      server.middlewares.use('/api', async (req, res) => {
        res.setHeader('Content-Type', 'application/json');
        try {
          res.end(JSON.stringify(await handle(req, res)));
        } catch (e) {
          const err = e as HttpError;
          res.statusCode = err.status ?? 400;
          res.end(JSON.stringify({ error: err.message, ...(err.extra ?? {}) }));
        }
      });
    },
  };
}
