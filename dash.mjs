#!/usr/bin/env node
// repo-dash — a local dev-state dashboard that runs WHERE THE REPO IS. Ties
// together the branch ladder, git worktrees, Claude Code sessions/jobs, and
// running dev servers. Drop this file into any repo — it's self-configuring
// off git + gh, and everything project-specific is an optional env var:
//
//   node dash.mjs           # print a status report
//   node dash.mjs --serve   # serve a live auto-refreshing page (:7799)
//   npx github:weiv/repo-dash --serve   # run without cloning
//
//   DASH_NAME=<string>          display name (default: repo name, title-cased)
//   DASH_LADDER=a,b,c           promotion ladder, first = integration branch
//                                (default: repo's actual default branch, alone)
//   DASH_PREVIEW_URL=<template> per-branch preview link, "{branch}" is replaced
//                                with a slugified branch name (default: none)
//   DASH_DEV_PROCS=<regex>      `ps` pattern for the Dev servers section
//                                (default: vite|webpack-dev-server|next dev|...)
//   FB_URL / FB_KEY             optional remote usage+feedback panel — GETs
//                                `${FB_URL}/dash?format=json&key=${FB_KEY}`
//
// No deps. Reads git + gh (optional) + ~/.claude + ps. Degrades if any is absent.

import { execSync } from 'node:child_process';
import { readdirSync, statSync, existsSync, openSync, readSync, closeSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, basename } from 'node:path';

const sh = (cmd, cwd) => {
  try {
    return execSync(cmd, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], cwd }).trim();
  } catch {
    return '';
  }
};
const n = (cmd, cwd) => Number(sh(cmd, cwd) || 0);

// GitHub repo slug (owner/name) + base URL for ladder links.
const REPO = (sh('git remote get-url origin').match(/github\.com[:/]([^/]+\/[^/.]+)/) || [])[1] || 'unknown/repo';
const GH = `https://github.com/${REPO}`;
const titleCase = (s) => s.replace(/[-_]+/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase());
const DASH_NAME = process.env.DASH_NAME || titleCase(REPO.split('/')[1] || 'repo');

// The promotion ladder — first entry is the "integration" branch everything
// else is measured against (±ahead/behind, cleanup/update candidates).
// Defaults to whatever the repo's actual default branch is, alone.
function defaultBranch() {
  const ref = sh('git symbolic-ref refs/remotes/origin/HEAD'); // refs/remotes/origin/main
  return (ref.match(/refs\/remotes\/origin\/(.+)$/) || [])[1] || sh('git rev-parse --abbrev-ref HEAD') || 'main';
}
const LADDER = process.env.DASH_LADDER
  ? process.env.DASH_LADDER.split(',').map((s) => s.trim()).filter(Boolean)
  : [defaultBranch()];
const BASE_BRANCH = LADDER[0];

// Optional per-branch preview link, e.g. "https://{branch}-myapp.pages.dev".
const sanitizeBranch = (b) => b.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
const PREVIEW_TEMPLATE = process.env.DASH_PREVIEW_URL || '';
const previewUrl = PREVIEW_TEMPLATE ? (b) => PREVIEW_TEMPLATE.replace('{branch}', sanitizeBranch(b)) : null;

// Stable color per session id (no color is stored) → a small hue chip.
const hueOf = (id) => {
  let h = 0;
  for (const c of String(id)) h = (h * 31 + c.charCodeAt(0)) >>> 0;
  return h % 360;
};
const textOf = (c) => {
  const t = typeof c === 'string' ? c : Array.isArray(c) ? c.filter((x) => x.type === 'text').map((x) => x.text).join(' ') : '';
  return String(t).replace(/\s+/g, ' ').trim();
};
const readChunk = (fd, size, bytes, fromEnd) => {
  const len = Math.min(bytes, size);
  if (len <= 0) return '';
  const buf = Buffer.alloc(len);
  const nr = readSync(fd, buf, 0, len, fromEnd ? Math.max(0, size - len) : 0);
  return buf.slice(0, nr).toString('utf8');
};
// A (possibly huge) transcript's descriptive bits: the FIRST user prompt + cwd
// from the head; the LATEST custom name / ai-title / last-prompt from the tail.
function sessionMeta(path) {
  const out = { name: '', title: '', last: '', first: '', cwd: '', branch: '' };
  let fd;
  try {
    fd = openSync(path, 'r');
    const size = statSync(path).size;
    for (const ln of readChunk(fd, size, 65536, false).split('\n')) {
      let o;
      try {
        o = JSON.parse(ln);
      } catch {
        continue;
      }
      if (!out.cwd && o.cwd) out.cwd = o.cwd;
      if (!out.branch && o.gitBranch) out.branch = o.gitBranch;
      if (!out.first && o.type === 'user' && o.message) {
        const t = textOf(o.message.content);
        if (t && !t.startsWith('<')) out.first = t.slice(0, 400);
      }
      if (out.first && out.cwd) break;
    }
    for (const ln of readChunk(fd, size, 262144, true).split('\n')) {
      let o;
      try {
        o = JSON.parse(ln);
      } catch {
        continue; // tail may start mid-line; skip unparseable
      }
      if (o.type === 'custom-title' && o.customTitle) out.name = o.customTitle;
      else if (o.type === 'ai-title' && o.aiTitle) out.title = o.aiTitle;
      else if (o.type === 'last-prompt' && o.lastPrompt) out.last = textOf(o.lastPrompt).slice(0, 400);
    }
  } catch {
    /* unreadable */
  } finally {
    try {
      if (fd !== undefined) closeSync(fd);
    } catch {
      /* already closed */
    }
  }
  return out;
}
const ago = (ms) => {
  const s = Math.max(0, (Date.now() - ms) / 1000);
  if (s < 90) return `${Math.round(s)}s ago`;
  if (s < 5400) return `${Math.round(s / 60)}m ago`;
  if (s < 129600) return `${Math.round(s / 3600)}h ago`;
  return `${Math.round(s / 86400)}d ago`;
};

// Optional deployed-app usage + feedback panel, pulled from ${FB_URL}/dash?format=json.
// Fully opt-in — needs both FB_URL and FB_KEY set; KPI labels are derived from
// whatever keys the endpoint's usage.kpis object returns, no schema required.
const FB_URL = (process.env.FB_URL || '').replace(/\/$/, '');
const FB_KEY = process.env.FB_KEY || '';
const FB_HOST = (() => {
  try {
    return new URL(FB_URL).host;
  } catch {
    return FB_URL;
  }
})();
const kpiLabel = (k) => titleCase(k.replace(/_/g, ' '));
async function remote() {
  if (!FB_KEY || !FB_URL) return null; // opt-in
  try {
    const r = await fetch(`${FB_URL}/dash?format=json&key=${encodeURIComponent(FB_KEY)}`);
    if (!r.ok) return { error: `HTTP ${r.status}` };
    return await r.json();
  } catch (e) {
    return { error: e.message };
  }
}

// ── gather ───────────────────────────────────────────────────────────────────
function ladder() {
  const rows = [];
  const short = (r) => sh(`git rev-parse --short ${r}`);
  const has = (r) => !!sh(`git rev-parse --verify --quiet ${r}`);
  const chain = LADDER.filter((b) => has(`origin/${b}`));
  for (let i = 0; i < chain.length; i++) {
    const b = chain[i];
    const below = chain[i + 1]; // the branch this promotes INTO
    const aheadOfBelow = below ? n(`git rev-list --count origin/${below}..origin/${b}`) : 0;
    rows.push({ branch: b, sha: short(`origin/${b}`), pending: below ? aheadOfBelow : null, below });
  }
  return rows;
}

// Cheap in-memory memoization for gh calls the cleanup-candidate check makes —
// branch merge state doesn't change every 10s, and this page re-collects on
// every request.
const ghCache = new Map();
const cached = (key, ttlMs, fn) => {
  const hit = ghCache.get(key);
  if (hit && Date.now() - hit.t < ttlMs) return hit.v;
  const v = fn();
  ghCache.set(key, { v, t: Date.now() });
  return v;
};
function mergedPrNumber(branch) {
  return cached(`merged:${branch}`, 60000, () => {
    const out = sh(`gh pr list --state merged --head ${branch} --json number --limit 1`);
    if (!out) return null;
    try {
      return JSON.parse(out)[0]?.number ?? null;
    } catch {
      return null;
    }
  });
}

function prs() {
  const out = sh(
    `gh pr list --state open --json number,title,baseRefName,headRefName --limit 30`,
  );
  if (!out) return null; // gh missing / not authed
  try {
    return JSON.parse(out);
  } catch {
    return null;
  }
}

function worktrees() {
  const raw = sh('git worktree list --porcelain');
  const list = [];
  let cur = null;
  for (const line of raw.split('\n')) {
    if (line.startsWith('worktree ')) {
      cur = { path: line.slice(9), branch: '(detached)', locked: false };
      list.push(cur);
    } else if (line.startsWith('branch ') && cur) cur.branch = line.slice(7).replace('refs/heads/', '');
    else if (line === 'locked' && cur) cur.locked = true;
  }
  const base = sh(`git rev-parse --verify --quiet origin/${BASE_BRANCH}`) ? `origin/${BASE_BRANCH}` : 'HEAD';
  for (const w of list) {
    w.sha = sh('git rev-parse --short HEAD', w.path);
    w.dirty = sh('git status --porcelain', w.path).split('\n').filter(Boolean).length;
    w.ahead = n(`git rev-list --count ${base}..HEAD`, w.path);
    w.behind = n(`git rev-list --count HEAD..${base}`, w.path);
    w.lastMs = n('git log -1 --format=%ct', w.path) * 1000;
    w.lastSubj = sh('git log -1 --format=%s', w.path).slice(0, 54);
    w.name = basename(w.path);
    w.isAgent = w.path.includes('/.claude/worktrees/');
    // A preview link only exists for pushed branches.
    w.originExists = w.branch !== '(detached)' && !!sh(`git rev-parse --verify --quiet origin/${w.branch}`);
    w.preview = w.originExists && previewUrl ? previewUrl(w.branch) : '';
  }
  return list;
}

// Longest worktree path that contains cwd — a session's recorded cwd may be a
// subdirectory (e.g. "<worktree>/app"), so match by prefix, not by basename.
function matchWorktree(cwd, worktreeList) {
  if (!cwd) return null;
  let best = null;
  for (const w of worktreeList) {
    if (cwd === w.path || cwd.startsWith(w.path + '/')) {
      if (!best || w.path.length > best.path.length) best = w;
    }
  }
  return best;
}

// Claude Code's project directory is keyed by the exact cwd path a session is
// (or was) running from — non-alphanumeric chars → "-". A session's transcript
// moves to a NEW project slug whenever its cwd changes (e.g. via EnterWorktree),
// so scanning only the main checkout's slug misses every session currently
// working from another worktree — the majority, in a worktree-heavy workflow.
const slugify = (path) => path.replace(/[^a-zA-Z0-9]/g, '-');

function sessions(worktreeList) {
  const jobsDir = join(homedir(), '.claude', 'jobs');
  const jobs = existsSync(jobsDir)
    ? new Set(readdirSync(jobsDir).filter((f) => !f.includes('.')))
    : new Set();
  const meId = (process.env.CLAUDE_JOB_DIR || '').split('/').pop() || '';

  // Scan every known worktree's own slug dir and dedupe by session id, keeping
  // the freshest copy — a session leaves a stale (often empty) subdirectory
  // behind in each slug it moves out of, only the current one has a live .jsonl.
  const dirs = worktreeList.map((w) => join(homedir(), '.claude', 'projects', slugify(w.path)));
  const byId = new Map();
  for (const dir of dirs) {
    if (!existsSync(dir)) continue;
    for (const f of readdirSync(dir)) {
      if (!f.endsWith('.jsonl')) continue;
      const id = f.replace('.jsonl', '');
      const st = statSync(join(dir, f));
      const prev = byId.get(id);
      if (!prev || st.mtimeMs > prev.st.mtimeMs) byId.set(id, { dir, f, st });
    }
  }
  const list = Array.from(byId.entries())
    .map(([id, { dir, f, st }]) => {
      const jobId = id.slice(0, 8);
      const meta = sessionMeta(join(dir, f));
      const wt = matchWorktree(meta.cwd, worktreeList);
      return {
        id,
        short: jobId,
        ms: st.mtimeMs,
        kb: Math.round(st.size / 1024),
        isJob: jobs.has(jobId),
        isMe: meId && jobId === meId,
        name: meta.name, // user's /rename (custom-title)
        title: meta.title, // AI-generated brief description (ai-title)
        last: meta.last, // last prompt
        first: meta.first, // opening prompt
        wt: wt ? wt.name : meta.cwd ? basename(meta.cwd) : '',
        wtPath: wt ? wt.path : '',
        branch: wt ? wt.branch : meta.branch,
        hue: hueOf(id),
      };
    })
    .sort((a, b) => b.ms - a.ms);
  return { list, dirs, jobs: jobs.size };
}

const DEV_PROC_RE = new RegExp(process.env.DASH_DEV_PROCS || 'vite|webpack-dev-server|next dev|http\\.server|nodemon');
function devServers() {
  const out = sh("ps -eo pid,command");
  return out
    .split('\n')
    .filter((l) => DEV_PROC_RE.test(l) && !/grep/.test(l))
    .map((l) => {
      const m = l.trim().match(/^(\d+)\s+(.*)$/);
      const port = (l.match(/--port\s+(\d+)/) || l.match(/:(\d{4,5})/) || [])[1] || '?';
      return { pid: m?.[1], port, cmd: (m?.[2] || '').slice(0, 60) };
    });
}

// Branches that are the ladder itself, or the main checkout, are never
// cleanup/update candidates — only feature/agent worktrees are.
const LADDER_BRANCHES = new Set(LADDER);
function markCleanupAndUpdate(wts) {
  const mainRoot = wts[0]?.path; // `git worktree list` always lists the main checkout first
  for (const w of wts) {
    const isLadder = LADDER_BRANCHES.has(w.branch);
    const isDetached = w.branch === '(detached)';
    const eligible = !isLadder && w.path !== mainRoot && !w.locked && !w.dirty;
    w.cleanupReason = null;
    if (eligible && (w.ahead === 0 || !w.originExists)) {
      const pr = isDetached ? null : mergedPrNumber(w.branch);
      w.cleanupReason = pr
        ? `merged via PR #${pr}`
        : isDetached
          ? 'detached, no unique commits'
          : !w.originExists
            ? 'not on origin, no unique commits'
            : null;
    }
    w.needsUpdate = !isLadder && !isDetached && !w.locked && w.behind > 0 && !w.cleanupReason;
  }
}

async function collect() {
  const wts = worktrees();
  const sess = sessions(wts);
  for (const w of wts) w.activeSessions = sess.list.filter((x) => x.wtPath === w.path);
  markCleanupAndUpdate(wts);
  return {
    now: new Date().toISOString().slice(0, 19).replace('T', ' '),
    ladder: ladder(),
    prs: prs(),
    worktrees: wts,
    sessions: sess,
    servers: devServers(),
    remote: await remote(),
  };
}

// ── CLI report ───────────────────────────────────────────────────────────────
const C = { dim: '\x1b[2m', b: '\x1b[1m', y: '\x1b[33m', g: '\x1b[32m', c: '\x1b[36m', r: '\x1b[0m' };
function printReport(d) {
  console.log(`\n${C.b}${DASH_NAME} · dev dashboard${C.r} ${C.dim}${d.now}${C.r}\n`);

  console.log(`${C.b}Ladder${C.r}  ${C.dim}(${LADDER.join(' → ')})${C.r}`);
  for (const l of d.ladder) {
    const p = l.pending == null ? '' : `  ${C.y}${l.pending} ahead of ${l.below}${C.r}`;
    console.log(`  ${l.branch.padEnd(5)} ${C.dim}${l.sha}${C.r}${p}`);
  }
  if (d.prs) {
    console.log(`\n${C.b}Open PRs${C.r} ${C.dim}(${d.prs.length})${C.r}`);
    for (const p of d.prs)
      console.log(`  ${C.c}#${p.number}${C.r} ${p.title.slice(0, 52).padEnd(52)} ${C.dim}${p.headRefName}→${p.baseRefName}${C.r}`);
  }

  console.log(`\n${C.b}Worktrees${C.r} ${C.dim}(${d.worktrees.length})${C.r}`);
  for (const w of d.worktrees) {
    const flags = [w.locked ? `${C.y}locked${C.r}` : '', w.dirty ? `${C.r}${C.y}${w.dirty} dirty${C.r}` : `${C.g}clean${C.r}`]
      .filter(Boolean)
      .join(' ');
    const rel = w.lastMs ? ago(w.lastMs) : '—';
    console.log(
      `  ${(w.isAgent ? '· ' : '★ ') + w.name.padEnd(34)} ${C.c}${w.branch.padEnd(28)}${C.r} ${C.dim}${w.sha}${C.r} +${w.ahead}/-${w.behind}  ${flags}`,
    );
    console.log(`      ${C.dim}${rel} · ${w.lastSubj}${C.r}`);
    if (w.activeSessions.length) {
      console.log(`      ${C.dim}sessions: ${w.activeSessions.map((s) => s.name || s.short).join(', ')}${C.r}`);
    }
  }

  const cleanup = d.worktrees.filter((w) => w.cleanupReason);
  if (cleanup.length) {
    console.log(`\n${C.b}Cleanup candidates${C.r}`);
    for (const w of cleanup) {
      const cmds = [`git worktree remove ${w.path}`];
      if (w.branch !== '(detached)') cmds.push(`git branch -D ${w.branch}`);
      if (w.originExists) cmds.push(`git push origin --delete ${w.branch}`);
      console.log(`  ${w.name} ${C.dim}(${w.cleanupReason})${C.r}`);
      console.log(`    ${C.dim}${cmds.join(' && ')}${C.r}`);
    }
  }
  const stale = d.worktrees.filter((w) => w.needsUpdate);
  if (stale.length) {
    console.log(`\n${C.b}Needs update${C.r} ${C.dim}(behind ${BASE_BRANCH})${C.r}`);
    for (const w of stale) {
      const note = w.dirty ? ` ${C.y}(${w.dirty} dirty — commit/stash first)${C.r}` : '';
      console.log(`  ${w.name} ${C.dim}${w.behind} behind${C.r}${note}`);
      console.log(`    ${C.dim}cd ${w.path} && git merge origin/${BASE_BRANCH}${C.r}`);
    }
  }

  const s = d.sessions;
  console.log(`\n${C.b}Sessions${C.r} ${C.dim}(${s.list.length} transcripts · ${s.jobs} background jobs)${C.r}`);
  for (const x of s.list.slice(0, 8)) {
    const nm = x.name ? ` ${C.c}${x.name}${C.r}` : '';
    const wtTag = x.wt ? ` ${C.dim}@${x.wt}${x.branch ? ':' + x.branch : ''}${C.r}` : '';
    const tag = [x.isMe ? `${C.g}you${C.r}` : '', x.isJob ? `${C.y}job${C.r}` : ''].filter(Boolean).join(' ');
    console.log(`  ${x.short}${nm}${wtTag}  ${C.dim}${ago(x.ms).padEnd(9)} ${String(x.kb).padStart(5)}KB${C.r}  ${tag}`);
    const brief = x.title || x.first;
    if (brief) console.log(`      ${C.dim}${brief.slice(0, 78)}${C.r}`);
    if (x.last) console.log(`      ${C.dim}↳ ${x.last.slice(0, 72)}${C.r}`);
  }

  if (d.servers.length) {
    console.log(`\n${C.b}Dev servers${C.r}`);
    for (const v of d.servers) console.log(`  ${C.dim}pid ${v.pid}${C.r} :${v.port}  ${C.dim}${v.cmd}${C.r}`);
  }

  const rm = d.remote;
  if (rm && rm.usage && rm.usage.kpis) {
    console.log(`\n${C.b}Usage${C.r} ${C.dim}(${FB_HOST} · 7d)${C.r}`);
    console.log('  ' + Object.entries(rm.usage.kpis).map(([k, v]) => `${kpiLabel(k)} ${C.y}${Math.round(v || 0)}${C.r}`).join('  '));
  }
  if (rm && rm.feedback && rm.feedback.rows && rm.feedback.rows.length) {
    console.log(`\n${C.b}Recent feedback${C.r}`);
    for (const r of rm.feedback.rows.slice(0, 3))
      console.log(`  ${C.dim}${String(r.ts).slice(0, 10)}${C.r} ${String(r.msg).replace(/\n/g, ' ').slice(0, 64)}`);
  }
  if (rm && rm.error) console.log(`\n${C.dim}(remote usage/feedback: ${rm.error})${C.r}`);
  else if (!rm) console.log(`\n${C.dim}(set FB_URL + FB_KEY to include a remote usage/feedback panel)${C.r}`);
  console.log('');
}

// ── serve (live HTML) ────────────────────────────────────────────────────────
function html(d) {
  const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);
  const trunc = (s, nn) => (s && s.length > nn ? esc(s.slice(0, nn)) + '…' : esc(s || ''));
  const link = (href, text) => `<a href="${esc(href)}" rel="noreferrer noopener">${text}</a>`;
  const ladder = d.ladder
    .map(
      (l) =>
        `<tr><td>${link(`${GH}/tree/${encodeURIComponent(l.branch)}`, `<b>${l.branch}</b>`)}</td><td class=dim>${l.sha}</td><td class=n>${
          l.pending == null
            ? ''
            : link(`${GH}/compare/${encodeURIComponent(l.below)}...${encodeURIComponent(l.branch)}`, `${l.pending} ahead of ${l.below}`)
        }</td></tr>`,
    )
    .join('');
  const prs = d.prs
    ? d.prs.map((p) => `<tr><td>${link(`${GH}/pull/${p.number}`, `#${p.number}`)}</td><td>${esc(p.title)}</td><td class=dim>${esc(p.headRefName)}→${esc(p.baseRefName)}</td></tr>`).join('')
    : '<tr><td class=dim colspan=3>gh not available</td></tr>';
  const wtHead = `<thead><tr><th>Worktree</th><th>Branch</th><th>HEAD</th><th class=n>±${esc(BASE_BRANCH)}</th><th>Status</th><th>Preview</th><th>Last commit</th></tr></thead>`;
  const wts = d.worktrees
    .map((w) => {
      const chips = w.activeSessions
        .map((s) => `<span class=chip style="background:hsl(${s.hue},55%,58%)" title="${esc(s.name || s.short)}"></span>`)
        .join('');
      return `<tr><td>${w.isAgent ? '' : '★ '}${esc(w.name)}${chips ? ' ' + chips : ''}</td><td>${w.originExists ? link(`${GH}/tree/${encodeURIComponent(w.branch)}`, esc(w.branch)) : esc(w.branch)}</td><td class=dim>${w.sha}</td><td class=n>+${w.ahead}/-${w.behind}</td><td>${w.locked ? '<span class=lock>locked</span> ' : ''}${w.dirty ? `<span class=dirty>${w.dirty} dirty</span>` : '<span class=clean>clean</span>'}</td><td>${w.preview ? link(w.preview, 'preview ↗') : '<span class=dim>—</span>'}</td><td class=dim>${w.lastMs ? ago(w.lastMs) : '—'}${w.lastSubj ? ' · ' + esc(w.lastSubj) : ''}</td></tr>`;
    })
    .join('');
  // key is a stable id for the collapsed-state script below — title may include
  // a dynamic count, which can't itself be the persistence key.
  const section = (key, title, body) => (body ? `<details data-key="${key}" open><summary>${title}</summary>${body}</details>` : '');
  const cmd = (s) => `<code>${esc(s)}</code>`;
  const cleanupRows = d.worktrees.filter((w) => w.cleanupReason);
  const cleanup = section(
    'cleanup',
    'Cleanup candidates',
    cleanupRows.length
      ? `<table><thead><tr><th>Worktree</th><th>Branch</th><th>Reason</th><th>Command</th></tr></thead><tbody>${cleanupRows
          .map((w) => {
            const cmds = [`git worktree remove ${w.path}`];
            if (w.branch !== '(detached)') cmds.push(`git branch -D ${w.branch}`);
            if (w.originExists) cmds.push(`git push origin --delete ${w.branch}`);
            return `<tr><td>${esc(w.name)}</td><td class=dim>${esc(w.branch)}</td><td class=dim>${esc(w.cleanupReason)}</td><td>${cmd(cmds.join(' && '))}</td></tr>`;
          })
          .join('')}</tbody></table>`
      : '',
  );
  const staleRows = d.worktrees.filter((w) => w.needsUpdate);
  const stale = section(
    'stale',
    `Needs update (behind ${esc(BASE_BRANCH)})`,
    staleRows.length
      ? `<table><thead><tr><th>Worktree</th><th>Branch</th><th class=n>Behind</th><th>Command</th></tr></thead><tbody>${staleRows
          .map((w) => {
            const note = w.dirty ? ` <span class=dirty>${w.dirty} dirty — commit/stash first</span>` : '';
            return `<tr><td>${esc(w.name)}</td><td class=dim>${esc(w.branch)}</td><td class=n>${w.behind}</td><td>${cmd(`cd ${w.path} && git merge origin/${BASE_BRANCH}`)}${note}</td></tr>`;
          })
          .join('')}</tbody></table>`
      : '',
  );
  const sessHead = `<thead><tr><th>Session</th><th>Working on</th><th>Last prompt</th><th>Active</th><th class=n>Size</th></tr></thead>`;
  const sess = d.sessions.list
    .slice(0, 12)
    .map((x) => {
      const chip = `<span class=chip style="background:hsl(${x.hue},55%,58%)"></span>`;
      const doing = x.title || x.first; // AI title, else the opening prompt
      const wtLine = x.wt ? `${esc(x.wt)}${x.branch ? ' · ' + esc(x.branch) : ''}` : '';
      return `<tr><td>${chip}<span class=sname>${esc(x.name || x.short)}</span>${x.isMe ? ' <span class=you>you</span>' : ''}${x.isJob ? ' <span class=job>job</span>' : ''}${wtLine ? `<div class="dim wt">${wtLine}</div>` : ''}</td><td${x.first ? ` title="${esc(x.first)}"` : ''}>${doing ? trunc(doing, 58) : '—'}</td><td class=dim${x.last ? ` title="${esc(x.last)}"` : ''}>${x.last ? trunc(x.last, 46) : '—'}</td><td class=dim>${ago(x.ms)}</td><td class=n>${x.kb}KB</td></tr>`;
    })
    .join('');
  const srv = d.servers.map((v) => `<tr><td class=dim>pid ${v.pid}</td><td>:${v.port}</td><td class=dim>${esc(v.cmd)}</td></tr>`).join('');
  const rm = d.remote;
  const usage =
    rm && rm.usage && rm.usage.kpis
      ? section('usage', `Usage (${esc(FB_HOST)} · 7d)`, `<div class=cards>${Object.entries(rm.usage.kpis).map(([k, v]) => `<span class=kpi><b>${Math.round(v || 0)}</b> ${esc(kpiLabel(k))}</span>`).join('')}</div>`)
      : rm && rm.error
        ? section('usage', 'Usage', `<div class=dim>remote: ${esc(rm.error)}</div>`)
        : '';
  const feed = section(
    'feedback',
    'Recent feedback',
    rm && rm.feedback && rm.feedback.rows && rm.feedback.rows.length
      ? rm.feedback.rows.map((r) => `<div class=fb>${esc(String(r.msg).slice(0, 200))}<div class=dim>${esc(String(r.ts).slice(0, 16))} · ${r.gpu ? 'WebGPU' : 'no-WebGPU'} · ${esc(r.country || '')}</div></div>`).join('')
      : '',
  );
  return `<!doctype html><meta charset=utf-8><meta http-equiv=refresh content=10>
<title>${esc(DASH_NAME)} · dev dashboard</title>
<style>body{margin:0;background:#08090d;color:#e6eaf4;font:13px/1.5 system-ui,sans-serif;padding:22px;max-width:900px}
h1{font-size:17px;margin:0 0 2px}
.dim{color:#8b93a7}table{border-collapse:collapse;width:100%}td{padding:5px 10px;border-bottom:1px solid rgba(255,255,255,.08)}
.n{text-align:right;font-variant-numeric:tabular-nums}.lock{color:#f0a04b}.dirty{color:#f0a04b}.clean{color:#5fbf7f}
.you{color:#5fbf7f}.job{color:#f0a04b}.time{color:#8b93a7}b{color:#f0a04b}
.chip{display:inline-block;width:9px;height:9px;border-radius:2px;margin-right:6px;vertical-align:middle}.sname{font-weight:600;color:#e6eaf4}.wt{font-size:11px;margin-top:1px}
th{text-align:left;color:#a6afc4;font-weight:600;font-size:11px;text-transform:uppercase;letter-spacing:.04em;padding:5px 10px;border-bottom:1px solid rgba(255,255,255,.16)}
a{color:#8ab4ff;text-decoration:none}a:hover{text-decoration:underline}
.cards{display:flex;flex-wrap:wrap;gap:8px;margin:6px 0}.kpi{background:rgba(255,255,255,.05);border:1px solid rgba(255,255,255,.1);border-radius:8px;padding:6px 10px}.kpi b{font-size:16px}
.fb{background:rgba(255,255,255,.04);border:1px solid rgba(255,255,255,.08);border-radius:8px;padding:8px 10px;margin-bottom:6px;white-space:pre-wrap}
code{background:rgba(255,255,255,.06);padding:2px 6px;border-radius:4px;font-size:12px;word-break:break-all}
details{margin:22px 0 6px}
summary{font-size:11px;text-transform:uppercase;letter-spacing:.05em;color:#a6afc4;cursor:pointer;user-select:none}
details[open]>summary{margin-bottom:6px}</style>
<h1>${esc(DASH_NAME)} · dev dashboard</h1><div class=time>${d.now} · auto-refresh 10s</div>
${section('ladder', `Ladder (${esc(LADDER.join('→'))})`, `<table>${ladder}</table>`)}
${section('prs', 'Open PRs', `<table>${prs}</table>`)}
${section('worktrees', `Worktrees (${d.worktrees.length})`, `<table>${wtHead}<tbody>${wts}</tbody></table>`)}
${cleanup}${stale}
${section('sessions', `Sessions (${d.sessions.list.length} · ${d.sessions.jobs} jobs)`, `<table>${sessHead}<tbody>${sess}</tbody></table>`)}
${section('servers', 'Dev servers', srv ? `<table>${srv}</table>` : '')}
${usage}${feed}
<script>(function(){
  var KEY='dash-collapsed:${esc(REPO)}';
  var closed;
  try { closed = new Set(JSON.parse(localStorage.getItem(KEY) || '[]')); } catch { closed = new Set(); }
  document.querySelectorAll('details[data-key]').forEach(function(d){
    if (closed.has(d.dataset.key)) d.removeAttribute('open');
    d.addEventListener('toggle', function(){
      if (d.open) closed.delete(d.dataset.key); else closed.add(d.dataset.key);
      localStorage.setItem(KEY, JSON.stringify(Array.from(closed)));
    });
  });
})();</script>`;
}

async function serve(port) {
  const { createServer } = await import('node:http');
  createServer(async (_, res) => {
    try {
      const body = html(await collect());
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' });
      res.end(body);
    } catch (e) {
      res.writeHead(500);
      res.end(String(e));
    }
  }).listen(port, () => console.log(`dev dashboard → http://localhost:${port}  (refreshes every 10s; Ctrl-C to stop)`));
}

// ── main ─────────────────────────────────────────────────────────────────────
const arg = process.argv[2];
if (arg === '--serve') serve(Number(process.argv[3]) || 7799);
else printReport(await collect());
