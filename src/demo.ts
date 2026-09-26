import type { FileChange, RawCommit } from './model';

// A deterministic, multi-year history: long-lived main/develop, a stream of feature branches that get
// merged and deleted, periodic releases, hotfixes, and a handful of live timelines at the present.

function rng(seed: number) {
  return () => {
    seed |= 0;
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const AREAS: Record<string, string[]> = {
  loom: ['src/loom/weaver.ts', 'src/loom/threads.ts', 'src/loom/scheduler.ts', 'src/loom/throughput.ts'],
  tva: ['src/tva/monitor.ts', 'src/tva/minutemen.ts', 'src/tva/pruning.ts', 'src/tva/reset-charge.ts'],
  quantum: ['src/quantum/tunnel.ts', 'src/quantum/gps.ts', 'src/quantum/dilation.ts', 'src/quantum/pym.ts'],
  stones: ['src/stones/registry.ts', 'src/stones/gauntlet.ts', 'src/stones/return.ts', 'src/stones/soul.ts'],
  nexus: ['src/nexus/detector.ts', 'src/nexus/alerts.ts', 'src/nexus/variants.ts'],
  core: ['src/core/timeline.ts', 'src/core/causality.ts', 'src/core/paradox.ts', 'package.json', 'README.md'],
  ui: ['web/timeline-view.tsx', 'web/theme.css', 'web/miss-minutes.tsx'],
};
const AREA_NAMES = Object.keys(AREAS);

const VERBS = ['Add', 'Fix', 'Refactor', 'Improve', 'Harden', 'Tune', 'Document', 'Simplify', 'Cache', 'Test'];
const NOUNS = [
  'temporal event log',
  'branch pruning',
  'nexus detection',
  'variant registry',
  'reset charge timing',
  'causality engine',
  'paradox guards',
  'loom throughput',
  'quantum GPS',
  'Pym particle budget',
  'time door auth',
  'stone registry',
  'multiverse telemetry',
  'Minutemen dispatch',
  'timeline rendering',
  'time-slip handling',
];
const FEATURES = [
  'time-heist',
  'quantum-tunnel',
  'variant-tracker',
  'pruning-v2',
  'loom-sharding',
  'temporal-cache',
  'minutes-assistant',
  'gauntlet-api',
  'soul-exchange',
  'time-door',
  'branch-telemetry',
  'causality-graph',
  'nexus-alerts',
  'paradox-sandbox',
  'loki-tracker',
];
const AUTHORS = ['Bruce B.', 'The Ancient One', 'Tony S.', 'Natasha R.', 'Scott L.', 'Nebula', 'Mobius M.', 'Ravonna R.', 'Sylvie', 'Ouroboros'];

export function demoRepo(): { commits: RawCommit[]; branches: { name: string; head: string }[] } {
  const r = rng(616);
  const pick = <T>(a: T[]) => a[Math.floor(r() * a.length)];
  const commits: RawCommit[] = [];
  const heads: Record<string, string> = {};
  const focus: Record<string, string> = {};
  const featCount: Record<string, number> = {};
  let n = 0;
  let t = Date.parse('2019-04-26T10:00:00Z');
  const end = Date.parse('2026-09-18T12:00:00Z');

  const files = (area: string): FileChange[] => {
    const pool = AREAS[area];
    const k = 1 + Math.floor(r() * 2);
    const out = new Set<string>();
    for (let i = 0; i < k; i++) out.add(r() < 0.8 ? pick(pool) : pick(AREAS.core));
    return [...out].map((path) => ({ path, add: 1 + Math.floor(r() * 40), del: Math.floor(r() * 18) }));
  };
  const hash = () => {
    let s = '';
    for (let i = 0; i < 40; i++) s += Math.floor(r() * 16).toString(16);
    return s;
  };
  const commit = (branch: string, message: string, area: string, mergeFrom?: string) => {
    const parents = [heads[branch], mergeFrom ? heads[mergeFrom] : undefined].filter(Boolean) as string[];
    const id = hash();
    commits.push({ id, parents, message, author: AUTHORS[n++ % AUTHORS.length], date: t, files: mergeFrom ? [] : files(area) });
    heads[branch] = id;
    return id;
  };
  const tick = (min: number, max: number) => (t += (min + r() * (max - min)) * 3600_000);
  const merge = (into: string, from: string) => commit(into, `Merge branch '${from}' into ${into}`, 'core', from);

  commit('main', 'Initial commit: the Big Bang', 'core');
  tick(4, 20);
  commit('main', 'Scaffold Sacred Timeline service', 'core');
  heads.develop = heads.main;

  const features: string[] = [];
  let release = 0;
  let sinceRelease = 0;
  let featureNo = 0;

  // A variant nobody kept up to date: months behind main by the present (a nexus event).
  let stale = false;

  // Leave the last few weeks for the hand-written story below.
  while (t < end - 21 * 86400_000) {
    tick(6, 44);
    if (!stale && t > end - 150 * 86400_000) {
      stale = true;
      heads['variant/sokovia-accords'] = heads.main;
      commit('variant/sokovia-accords', 'Draft registration of enhanced variants', 'nexus');
      tick(10, 30);
      commit('variant/sokovia-accords', 'Add oversight council hooks', 'tva');
      continue;
    }
    const roll = r();
    if (roll < 0.22) {
      commit('develop', `${pick(VERBS)} ${pick(NOUNS)}`, pick(AREA_NAMES));
      sinceRelease++;
    } else if (roll < 0.3 && features.length < 5) {
      const name = `feature/${FEATURES[featureNo % FEATURES.length]}${featureNo >= FEATURES.length ? `-${Math.floor(featureNo / FEATURES.length) + 1}` : ''}`;
      featureNo++;
      heads[name] = heads.develop;
      focus[name] = pick(AREA_NAMES);
      featCount[name] = 0;
      features.push(name);
    } else if (roll < 0.72 && features.length) {
      const f = pick(features);
      commit(f, `${pick(VERBS)} ${pick(NOUNS)}`, focus[f]);
      featCount[f]++;
    } else if (roll < 0.84 && features.length) {
      const f = features[0];
      if (featCount[f] >= 2) {
        merge('develop', f);
        delete heads[f];
        features.shift();
        sinceRelease++;
      }
    } else if (roll < 0.88) {
      heads['hotfix/tmp'] = heads.main;
      commit('hotfix/tmp', `Hotfix: ${pick(NOUNS)}`, pick(AREA_NAMES));
      tick(1, 6);
      merge('main', 'hotfix/tmp');
      merge('develop', 'hotfix/tmp');
      delete heads['hotfix/tmp'];
    } else if (sinceRelease > 28) {
      release++;
      const rel = `release/${1 + Math.floor(release / 4)}.${release % 4}`;
      heads[rel] = heads.develop;
      commit(rel, `Freeze ${rel.slice(8)}`, 'core');
      tick(4, 30);
      commit(rel, `Release notes for ${rel.slice(8)}`, 'core');
      tick(2, 10);
      merge('main', rel);
      merge('develop', rel);
      delete heads[rel];
      sinceRelease = 0;
    }
  }

  // Wrap up any in-flight features so the story starts from a clean multiverse.
  for (const f of features) {
    tick(4, 12);
    if (featCount[f]) merge('develop', f);
    delete heads[f];
  }

  // --- The present: a few live timelines from the story -------------------------------------
  const branch = (name: string, from: string) => (heads[name] = heads[from]);
  const step = (b: string, msg: string, area: string) => {
    tick(3, 9);
    commit(b, msg, area);
  };
  step('develop', 'Set up TVA branch monitor', 'tva');
  branch('release/endgame', 'develop');
  step('release/endgame', 'Freeze APIs for Endgame', 'core');
  branch('feature/quantum-realm', 'develop');
  step('feature/quantum-realm', 'Add quantum tunnel calibration', 'quantum');
  step('main', 'Configure CI for all realities', 'core');
  step('release/endgame', 'Fix portal alignment on Titan', 'stones');
  step('feature/quantum-realm', 'Handle time dilation in subatomic zone', 'quantum');
  tick(2, 6);
  merge('main', 'release/endgame');
  step('main', 'Tag v5.0: whatever it takes', 'core');
  branch('experiment/what-if', 'main');
  step('experiment/what-if', 'Prototype Captain Carter variant', 'nexus');
  step('feature/quantum-realm', 'Add GPS for the quantum realm', 'quantum');
  step('develop', 'Add multiverse telemetry', 'tva');
  branch('feature/nexus-event', 'develop');
  step('feature/nexus-event', 'Detect unauthorized branching', 'nexus');
  step('experiment/what-if', 'Zombie-proof the auth layer', 'core');
  step('feature/quantum-realm', 'Return the stones to their timelines', 'stones');
  step('main', 'Security: lock down time door', 'core');
  step('feature/nexus-event', 'Alert Minutemen on divergence', 'tva');
  step('develop', 'Improve loom throughput', 'loom');
  step('main', 'Performance: faster reset charges', 'tva');

  return { commits, branches: Object.entries(heads).map(([name, head]) => ({ name, head })) };
}
