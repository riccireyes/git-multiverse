import type { CommitDiff, LaidBranch, LaidCommit } from './model';

export const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;

export const esc = (s: string) =>
  s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);

const fmtDate = (d: number) => new Date(d).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' });

export function setStatus(html: string) {
  $('status').innerHTML = html;
}

export interface BranchListHandlers {
  pick(name: string): void;
  toggle(name: string): void;
  solo(name: string): void;
}

export function renderBranchList(
  branches: LaidBranch[],
  selected: string | null,
  hidden: Set<string>,
  soloed: string | null,
  isNexus: (b: LaidBranch) => boolean,
  h: BranchListHandlers,
) {
  const list = $('branch-list');
  const filter = ($<HTMLInputElement>('branch-search').value ?? '').trim().toLowerCase();
  list.innerHTML = '';
  const live = branches.filter((b) => !b.synthetic);
  for (const b of live) {
    if (filter && !b.name.toLowerCase().includes(filter)) continue;
    const li = document.createElement('li');
    li.style.setProperty('--c', b.color);
    const off = hidden.has(b.name);
    li.className = [b.name === selected ? 'selected' : '', off ? 'off' : ''].join(' ');
    const nexus = isNexus(b);
    li.innerHTML = `
      <button class="eye" title="${off ? 'Show' : 'Hide'} this timeline">${off ? eyeOff : eyeOn}</button>
      <span class="dot"></span>
      <span class="name">${esc(b.name)}</span>
      ${nexus ? `<span class="nexus" title="Nexus event: ${b.behind} commits behind main">⚠</span>` : ''}
      <span class="count">${b.own.length}</span>
      <button class="solo ${soloed === b.name ? 'on' : ''}" title="Focus on this timeline">◎</button>`;
    li.title = b.name;
    li.querySelector<HTMLButtonElement>('.eye')!.onclick = (e) => {
      e.stopPropagation();
      h.toggle(b.name);
    };
    li.querySelector<HTMLButtonElement>('.solo')!.onclick = (e) => {
      e.stopPropagation();
      h.solo(b.name);
    };
    li.onclick = () => h.pick(b.name);
    list.appendChild(li);
  }
  $('timeline-count').textContent = String(live.length);
}

const eyeOn = `<svg viewBox="0 0 24 24" width="14" height="14"><path fill="none" stroke="currentColor" stroke-width="2" d="M1 12s4-7 11-7 11 7 11 7-4 7-11 7S1 12 1 12z"/><circle cx="12" cy="12" r="3" fill="currentColor"/></svg>`;
const eyeOff = `<svg viewBox="0 0 24 24" width="14" height="14"><path fill="none" stroke="currentColor" stroke-width="2" d="M3 3l18 18M10.6 5.1A11 11 0 0 1 12 5c7 0 11 7 11 7a18 18 0 0 1-3.2 4M6.6 6.6C3.2 8.6 1 12 1 12s4 7 11 7a10 10 0 0 0 5.4-1.6"/></svg>`;

export function showPanel(branch: LaidBranch | null, baseLabel: string, nexus: boolean, writeMode: boolean) {
  const panel = $('branch-panel');
  if (!branch) {
    panel.classList.add('hidden');
    return;
  }
  panel.classList.remove('hidden');
  panel.style.setProperty('--c', branch.color);
  $('panel-name').textContent = branch.name;
  $('panel-meta').innerHTML =
    `${branch.own.length} commit${branch.own.length === 1 ? '' : 's'} on this timeline` +
    (baseLabel ? `<br>branched from <code>${esc(baseLabel)}</code>` : '') +
    (branch.mergeTarget ? '<br>merged back' : '') +
    (nexus ? `<br><span class="warn">⚠ Nexus event: ${branch.behind} commits behind main</span>` : '');
  $<HTMLInputElement>('commit-msg').placeholder = writeMode ? 'Empty commit message…' : 'New commit message…';
}

export function commitTooltip(c: LaidCommit, color: string) {
  return `
    <div class="tt-head" style="--c:${color}"><span class="dot"></span><code>${c.id.slice(0, 7)}</code><span>${esc(c.branch.startsWith('merged:') ? 'merged history' : c.branch)}</span></div>
    <div class="tt-msg">${esc(c.message)}</div>
    <div class="tt-meta">${esc(c.author)} · ${fmtDate(c.date)}</div>
    ${c.cherryOf ? `<div class="tt-meta">cherry-picked from <code>${c.cherryOf.slice(0, 7)}</code></div>` : ''}
    ${c.parents.length > 1 ? `<div class="tt-meta">merge commit</div>` : ''}
    <div class="tt-hint">Click for changes · drag onto a timeline to cherry-pick</div>`;
}

export function branchTooltip(b: LaidBranch, hint: string, nexus: boolean) {
  return `
    <div class="tt-head" style="--c:${b.color}"><span class="dot"></span><span>${esc(b.title)}</span></div>
    <div class="tt-meta">${b.own.length} commit${b.own.length === 1 ? '' : 's'}${b.mergeTarget ? ' · merged' : ''}</div>
    ${nexus ? `<div class="tt-warn">⚠ Nexus event: ${b.behind} commits behind main</div>` : ''}
    <div class="tt-hint">${hint}</div>`;
}

export function tooltip(html: string | null, x = 0, y = 0) {
  const el = $('tooltip');
  if (!html) {
    el.classList.add('hidden');
    return;
  }
  el.innerHTML = html;
  el.classList.remove('hidden');
  const pad = 16;
  el.style.left = `${Math.min(window.innerWidth - el.offsetWidth - 8, x + pad)}px`;
  el.style.top = `${Math.min(window.innerHeight - el.offsetHeight - 8, y + pad)}px`;
}

let toastTimer = 0;
export function toast(msg: string, kind: 'ok' | 'err' | 'nexus' = 'ok') {
  const el = $('toast');
  el.textContent = msg;
  el.className = `toast show ${kind}`;
  clearTimeout(toastTimer);
  toastTimer = window.setTimeout(() => (el.className = 'toast'), kind === 'ok' ? 3200 : 5200);
}

export function askBranchName(fromLabel: string, color: string): Promise<string | null> {
  const dlg = $('branch-dialog') as HTMLDialogElement;
  const input = $<HTMLInputElement>('branch-name');
  $('branch-from').innerHTML = `Diverging from <code>${esc(fromLabel)}</code>`;
  dlg.style.setProperty('--c', color);
  input.value = '';
  dlg.showModal();
  input.focus();
  return new Promise((resolve) => {
    dlg.addEventListener(
      'close',
      () => {
        const name = input.value.trim().replace(/\s+/g, '-');
        resolve(dlg.returnValue === 'ok' && name ? name : null);
      },
      { once: true },
    );
  });
}

export function confirm(opts: { title: string; html: string; command?: string; ok: string; danger?: boolean }): Promise<boolean> {
  const dlg = $('confirm-dialog') as HTMLDialogElement;
  $('confirm-title').textContent = opts.title;
  $('confirm-text').innerHTML = opts.html;
  const cmd = $('confirm-cmd');
  cmd.textContent = opts.command ?? '';
  cmd.style.display = opts.command ? '' : 'none';
  const ok = $<HTMLButtonElement>('confirm-ok');
  ok.textContent = opts.ok;
  ok.classList.toggle('danger', !!opts.danger);
  dlg.returnValue = '';
  dlg.showModal();
  // Destructive confirmations start on Cancel so Enter never writes by accident.
  if (opts.danger) dlg.querySelector<HTMLButtonElement>('button[value=cancel]')?.focus();
  return new Promise((resolve) => dlg.addEventListener('close', () => resolve(dlg.returnValue === 'ok'), { once: true }));
}

// ---------------------------------------------------------------------------
// Diff panel
// ---------------------------------------------------------------------------

export function renderDiff(c: LaidCommit, color: string, diff: CommitDiff | null, error?: string) {
  const el = $('diff-panel');
  el.style.setProperty('--c', color);
  const head = `
    <div class="diff-head">
      <span class="dot"></span><code>${c.id.slice(0, 10)}</code>
      <button class="icon" id="diff-close" title="Close (Esc)">×</button>
    </div>
    <div class="diff-msg">${esc(c.message)}</div>
    <div class="tt-meta">${esc(c.author)} · ${fmtDate(c.date)}${c.parents.length > 1 ? ' · merge (vs first parent)' : ''}</div>`;
  let body: string;
  if (error) body = `<div class="tt-warn">${esc(error)}</div>`;
  else if (!diff) body = `<div class="diff-loading">Reading the timeline…</div>`;
  else if (!diff.files.length) body = `<div class="tt-meta diff-empty">No file changes${diff.simulated ? ' (simulated commit)' : ''}.</div>`;
  else {
    const add = diff.files.reduce((s, f) => s + f.add, 0);
    const del = diff.files.reduce((s, f) => s + f.del, 0);
    body = `
      <div class="diff-sum"><b>${diff.files.length}</b> file${diff.files.length === 1 ? '' : 's'} · <span class="add">+${add}</span> <span class="del">−${del}</span>${diff.simulated ? ' · <i>simulated</i>' : ''}</div>
      <ul class="files">${diff.files
        .map((f, i) => {
          const total = Math.max(1, f.add + f.del);
          const bar = `<span class="bar"><i class="a" style="width:${(f.add / total) * 100}%"></i><i class="d" style="width:${(f.del / total) * 100}%"></i></span>`;
          return `<li>
            <details ${i === 0 && diff.files.length <= 3 ? 'open' : ''}>
              <summary><span class="path" title="${esc(f.path)}">${esc(f.path)}</span>${f.binary ? '<span class="tt-meta">binary</span>' : `<span class="add">+${f.add}</span><span class="del">−${f.del}</span>${bar}`}</summary>
              ${f.patch ? `<pre class="patch">${colorPatch(f.patch)}</pre>` : '<div class="tt-meta">No preview</div>'}
            </details>
          </li>`;
        })
        .join('')}</ul>
      ${diff.truncated ? '<div class="tt-meta">Patch truncated.</div>' : ''}`;
  }
  el.innerHTML = head + body;
  el.classList.remove('hidden');
}

function colorPatch(p: string) {
  return p
    .split('\n')
    .filter((l) => !l.startsWith('diff --git') && !l.startsWith('index '))
    .slice(0, 400)
    .map((l) => {
      const cls = l.startsWith('+++') || l.startsWith('---') ? 'meta' : l.startsWith('+') ? 'add' : l.startsWith('-') ? 'del' : l.startsWith('@@') ? 'hunk' : '';
      return `<span class="${cls}">${esc(l) || ' '}</span>`;
    })
    .join('\n');
}

export function hideDiff() {
  $('diff-panel').classList.add('hidden');
}

/** Keep the diff panel beside its stone (screen coords), clamped to the viewport. */
export function placeDiff(x: number, y: number) {
  const el = $('diff-panel');
  const w = el.offsetWidth;
  const h = el.offsetHeight;
  let left = x + 36;
  if (left + w > window.innerWidth - 270) left = x - w - 36;
  left = Math.max(12, Math.min(window.innerWidth - w - 12, left));
  const top = Math.max(12, Math.min(window.innerHeight - h - 120, y - 60));
  el.style.left = `${left}px`;
  el.style.top = `${top}px`;
}
