// Command Center — local dashboard for projects, tasks, Claude Code skills and ideas.
// Runs only on 127.0.0.1 because it can launch programs on your PC.
const express = require('express');
const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');
const { spawn, exec, execFile } = require('child_process');
let notifier = null;
try { notifier = require('node-notifier'); } catch { /* optional */ }

const PORT = Number(process.env.PORT) || 4321;
const BASE_URL = `http://localhost:${PORT}`;
const ROOT = __dirname;
const DATA_FILE = path.join(ROOT, 'data', 'db.json');
const HOME = os.homedir();
const CLAUDE_DIR = path.join(HOME, '.claude');
const IS_WIN = process.platform === 'win32';
const STATUS_START = '<!-- status:start -->';
const STATUS_END = '<!-- status:end -->';
const CC_START = '<!-- command-center:start -->';
const CC_END = '<!-- command-center:end -->';
const STATUSES = ['idea', 'planning', 'development', 'live', 'paused', 'archived'];

// ---------- storage ----------
const DEFAULT_DB = {
  projects: [],
  tasks: [],
  ideas: { items: [], updatedAt: null, focus: '' },
  settings: { githubToken: '', staleDays: 7, notifyIntervalMin: 60, editorCommand: 'code', integrationInstalled: false },
  nudges: {}
};
function loadDb() {
  try {
    const raw = JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'));
    return {
      ...DEFAULT_DB, ...raw,
      settings: { ...DEFAULT_DB.settings, ...(raw.settings || {}) },
      ideas: { ...DEFAULT_DB.ideas, ...(raw.ideas || {}) },
      nudges: raw.nudges || {}
    };
  } catch { return JSON.parse(JSON.stringify(DEFAULT_DB)); }
}
let db = loadDb();
function save() {
  fs.mkdirSync(path.dirname(DATA_FILE), { recursive: true });
  const tmp = DATA_FILE + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(db, null, 2));
  fs.renameSync(tmp, DATA_FILE);
}
const newId = () => crypto.randomBytes(6).toString('hex');
const nowIso = () => new Date().toISOString();
const localYmd = (d = new Date()) => {
  const z = n => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${z(d.getMonth() + 1)}-${z(d.getDate())}`;
};

// ---------- helpers ----------
function git(cwd, args) {
  return new Promise(res => execFile('git', args, { cwd, timeout: 5000, windowsHide: true },
    (err, out) => res(err ? null : String(out).trim())));
}
async function gitInfo(p) {
  if (!p || !fs.existsSync(path.join(p, '.git'))) return null;
  const [log, branch, status, remote] = await Promise.all([
    git(p, ['log', '-1', '--format=%cI|%s']),
    git(p, ['rev-parse', '--abbrev-ref', 'HEAD']),
    git(p, ['status', '--porcelain']),
    git(p, ['remote', 'get-url', 'origin'])
  ]);
  const [date, ...msg] = (log || '').split('|');
  return {
    lastCommitAt: date || null,
    lastCommitMsg: msg.join('|') || null,
    branch,
    uncommitted: status ? status.split('\n').filter(Boolean).length : 0,
    remote: remote || null
  };
}
function repoFromRemote(url) {
  if (!url) return null;
  const m = url.match(/github\.com[:/]([^/]+)\/(.+?)(\.git)?$/i);
  return m ? `${m[1]}/${m[2]}` : null;
}

function readContext(p) {
  if (!p) return null;
  const f = path.join(p, 'CLAUDE.md');
  if (!fs.existsSync(f)) return { hasClaudeMd: false };
  const text = fs.readFileSync(f, 'utf8');
  const out = { hasClaudeMd: true, hasStatusBlock: false, modifiedAt: fs.statSync(f).mtime.toISOString() };
  const s = text.indexOf(STATUS_START), e = text.indexOf(STATUS_END);
  if (s >= 0 && e > s) {
    out.hasStatusBlock = true;
    const block = text.slice(s + STATUS_START.length, e);
    for (const line of block.split(/\r?\n/)) {
      const m = line.match(/^\s*[-*]?\s*\**(Phase|Progress|Next|Blockers|Updated|Summary)\**\s*:\s*(.+)$/i);
      if (m) out[m[1].toLowerCase()] = m[2].trim();
    }
    if (out.progress) {
      const n = parseInt(out.progress, 10);
      if (!isNaN(n)) { out.progressPct = Math.max(0, Math.min(100, n)); out.progressSource = 'status'; }
    }
  }
  const done = (text.match(/^\s*[-*] \[x\]/gim) || []).length;
  const open = (text.match(/^\s*[-*] \[ \]/gm) || []).length;
  out.checklist = { done, total: done + open };
  // An untouched template (0%) shouldn't hide real checklist progress.
  if ((out.progressPct == null || (out.progressPct === 0 && !out.summary)) && done + open > 0) {
    out.progressPct = Math.round(done * 100 / (done + open));
    out.progressSource = 'checklist';
  }
  return out;
}

// ---------- project setup (skills.json + tools/bootstrap.py, used by youtube-pipeline and instagram-pipeline) ----------
// A project that lists its skills, tools and models in skills.json gets a "Setup: N to install" chip and an Install button.
let PY = null;
function pythonCmd() {
  if (PY !== null) return Promise.resolve(PY);
  const tryOne = (cmd) => new Promise(res => execFile(cmd, ['--version'], { timeout: 5000, windowsHide: true }, err => res(err ? null : cmd)));
  return (async () => { PY = (await tryOne('python')) || (IS_WIN ? await tryOne('py') : await tryOne('python3')) || ''; return PY; })();
}
const setupCache = new Map(); // path -> { at, info }
function hasSetup(dir) { return !!dir && fs.existsSync(path.join(dir, 'skills.json')) && fs.existsSync(path.join(dir, 'tools', 'bootstrap.py')); }
async function checkSetup(dir) {
  const py = await pythonCmd();
  if (!py) return { hasSetup: true, ok: false, error: 'Python not found' };
  return new Promise(res => execFile(py, [path.join('tools', 'bootstrap.py'), '--json'], { cwd: dir, timeout: 30000, windowsHide: true },
    (err, stdout) => {
      try {
        const j = JSON.parse(stdout);
        const missing = j.items.filter(i => !i.ok && !i.optional).map(i => i.name);
        res({ hasSetup: true, ok: !missing.length, missing, optionalMissing: j.items.filter(i => !i.ok && i.optional).map(i => i.name) });
      } catch { res({ hasSetup: true, ok: false, error: (err && err.message || 'setup check failed').slice(0, 200) }); }
    }));
}
function setupInfo(dir) {
  if (!hasSetup(dir)) return null;
  const c = setupCache.get(dir);
  if (!c || Date.now() - c.at > 10 * 60 * 1000) {
    if (!c || !c.pending) {
      setupCache.set(dir, { ...(c || {}), pending: true, at: c ? c.at : 0 });
      checkSetup(dir).then(info => setupCache.set(dir, { at: Date.now(), info })).catch(() => setupCache.delete(dir));
    }
  }
  return c && c.info ? c.info : { hasSetup: true, checking: true };
}

function statusTemplate(phase = 'Planning') {
  return `${STATUS_START}
## Status
- Phase: ${phase}
- Progress: 0%
- Summary: 
- Next: 
- Blockers: none
- Updated: ${localYmd()}
${STATUS_END}
`;
}

function parseFrontmatter(text) {
  const m = text.match(/^---\r?\n([\s\S]*?)\r?\n---/);
  const fm = {};
  if (!m) return fm;
  const lines = m[1].split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    const mm = lines[i].match(/^([A-Za-z_-]+):\s*(.*)$/);
    if (!mm) continue;
    let v = mm[2].trim();
    if (['>', '|', '>-', '|-', ''].includes(v)) {
      const parts = [];
      while (i + 1 < lines.length && /^\s+\S/.test(lines[i + 1])) parts.push(lines[++i].trim());
      v = parts.join(' ');
    }
    fm[mm[1]] = v.replace(/^["']|["']$/g, '');
  }
  return fm;
}
function findFiles(dir, name, depth, acc = []) {
  if (depth < 0) return acc;
  let ents;
  try { ents = fs.readdirSync(dir, { withFileTypes: true }); } catch { return acc; }
  for (const e of ents) {
    const fp = path.join(dir, e.name);
    if (e.isDirectory()) {
      if (e.name === 'node_modules' || e.name === '.git') continue;
      findFiles(fp, name, depth - 1, acc);
    } else if (e.name === name) acc.push(fp);
  }
  return acc;
}
function listMd(dir) {
  try { return fs.readdirSync(dir).filter(f => f.endsWith('.md')).map(f => path.join(dir, f)); } catch { return []; }
}
function skillEntry(file, scope, source) {
  let fm = {};
  try { fm = parseFrontmatter(fs.readFileSync(file, 'utf8')); } catch {}
  return {
    name: fm.name || path.basename(path.dirname(file)),
    description: fm.description || '',
    scope, source, path: file
  };
}
function collectInstallPaths(obj, acc = []) {
  if (!obj || typeof obj !== 'object') return acc;
  for (const [k, v] of Object.entries(obj)) {
    if (k === 'installPath' && typeof v === 'string') acc.push(v);
    else collectInstallPaths(v, acc);
  }
  return acc;
}
function pluginNameFromPath(file) {
  const segs = file.split(/[\\/]/);
  const i = segs.lastIndexOf('skills');
  let name = segs[i - 1] || 'plugin';
  if (/^\d+\.\d|^[0-9a-f]{7,}$/i.test(name)) name = segs[i - 2] || name;
  return name;
}
function scanSkills() {
  const out = { skills: [], commands: [], agents: [] };
  for (const f of findFiles(path.join(CLAUDE_DIR, 'skills'), 'SKILL.md', 3)) out.skills.push(skillEntry(f, 'global', 'Your skills'));

  // Plugins: prefer the installed list; fall back to scanning the cache.
  let pluginRoots = [];
  try {
    const j = JSON.parse(fs.readFileSync(path.join(CLAUDE_DIR, 'plugins', 'installed_plugins.json'), 'utf8'));
    pluginRoots = collectInstallPaths(j);
  } catch {}
  if (!pluginRoots.length) pluginRoots = [path.join(CLAUDE_DIR, 'plugins', 'cache')];
  const seen = new Set();
  for (const root of pluginRoots) {
    for (const f of findFiles(root, 'SKILL.md', 8)) {
      const e = skillEntry(f, 'plugin', pluginNameFromPath(f));
      const key = e.source + '/' + e.name;
      if (seen.has(key)) continue;
      seen.add(key); out.skills.push(e);
    }
    for (const f of listMd(path.join(root, 'commands'))) out.commands.push({ ...skillEntry(f, 'plugin', path.basename(root)), name: '/' + path.basename(f, '.md') });
    for (const f of listMd(path.join(root, 'agents'))) out.agents.push({ ...skillEntry(f, 'plugin', path.basename(root)), name: path.basename(f, '.md') });
  }
  for (const p of db.projects) {
    if (!p.path) continue;
    for (const f of findFiles(path.join(p.path, '.claude', 'skills'), 'SKILL.md', 3)) out.skills.push(skillEntry(f, 'project', p.name));
    for (const f of listMd(path.join(p.path, '.claude', 'commands'))) out.commands.push({ ...skillEntry(f, 'project', p.name), name: '/' + path.basename(f, '.md') });
    for (const f of listMd(path.join(p.path, '.claude', 'agents'))) out.agents.push({ ...skillEntry(f, 'project', p.name), name: path.basename(f, '.md') });
  }
  for (const f of listMd(path.join(CLAUDE_DIR, 'commands'))) out.commands.push({ ...skillEntry(f, 'global', 'Your commands'), name: '/' + path.basename(f, '.md') });
  for (const f of listMd(path.join(CLAUDE_DIR, 'agents'))) out.agents.push({ ...skillEntry(f, 'global', 'Your agents'), name: path.basename(f, '.md') });
  return out;
}

function openUrl(url) {
  if (IS_WIN) spawn('cmd', ['/c', 'start', '', url], { detached: true, stdio: 'ignore', windowsHide: true }).unref();
  else spawn(process.platform === 'darwin' ? 'open' : 'xdg-open', [url], { detached: true, stdio: 'ignore' }).unref();
}
function notify(title, message, hash = '') {
  if (!notifier) return false;
  notifier.notify({ title, message, wait: true, appID: 'Command Center' }, (err, response) => {
    if (!err && response && String(response).toLowerCase().includes('activate')) openUrl(BASE_URL + '/' + hash);
  });
  return true;
}

// ---------- Claude Code CLI runner ----------
const jobs = {};
function runClaude({ prompt, cwd, args = [] }) {
  return new Promise((resolve, reject) => {
    const child = spawn('claude', ['-p', '--output-format', 'json', ...args], { cwd: cwd || ROOT, shell: true, windowsHide: true });
    let out = '', err = '';
    const timer = setTimeout(() => { try { child.kill(); } catch {} reject(new Error('Timed out after 15 minutes')); }, 15 * 60 * 1000);
    child.stdout.on('data', d => out += d);
    child.stderr.on('data', d => err += d);
    child.on('error', e => { clearTimeout(timer); reject(e); });
    child.on('close', code => {
      clearTimeout(timer);
      let parsed = null;
      try { parsed = JSON.parse(out); } catch {}
      if (parsed && parsed.is_error) return reject(new Error(parsed.result || 'Claude returned an error'));
      if (code !== 0 && !parsed) {
        const msg = err.trim() || out.trim() || `claude exited with code ${code}`;
        return reject(new Error(/not recognized|not found/i.test(msg) ? 'The "claude" command was not found. Install the Claude Code CLI and make sure it runs in a terminal.' : msg));
      }
      resolve(parsed ? (parsed.result ?? '') : out);
    });
    child.stdin.write(prompt);
    child.stdin.end();
  });
}
function startJob(key, fn) {
  if (jobs[key] && jobs[key].state === 'running') return jobs[key];
  jobs[key] = { state: 'running', startedAt: nowIso() };
  fn().then(r => { jobs[key] = { state: 'done', finishedAt: nowIso(), result: r }; })
    .catch(e => { jobs[key] = { state: 'error', finishedAt: nowIso(), error: e.message }; });
  return jobs[key];
}

// ---------- GitHub ----------
const ghCache = new Map();
async function gh(pathname) {
  const t = db.settings.githubToken;
  if (!t) throw new Error('Add a GitHub token in Settings first.');
  const r = await fetch('https://api.github.com' + pathname, {
    headers: { Authorization: `Bearer ${t}`, Accept: 'application/vnd.github+json', 'User-Agent': 'command-center' }
  });
  if (!r.ok) throw new Error(`GitHub responded ${r.status}${r.status === 401 ? ' (check your token)' : ''}`);
  return r.json();
}
async function repoInfo(fullName) {
  if (!fullName || !db.settings.githubToken) return null;
  const c = ghCache.get(fullName);
  if (c && Date.now() - c.at < 10 * 60 * 1000) return c.data;
  try {
    const r = await gh(`/repos/${fullName}`);
    const data = { url: r.html_url, private: r.private, pushedAt: r.pushed_at, openIssues: r.open_issues_count, stars: r.stargazers_count, language: r.language, description: r.description };
    ghCache.set(fullName, { at: Date.now(), data });
    return data;
  } catch { return null; }
}

// ---------- tasks ----------
function taskState(t) {
  if (t.completedAt) return { overdue: false, stale: false };
  const today = localYmd();
  const overdue = !!t.dueDate && t.dueDate < today;
  const last = new Date(t.lastActivityAt || t.createdAt).getTime();
  const ageDays = (Date.now() - last) / 86400000;
  return { overdue, stale: overdue || ageDays > Number(db.settings.staleDays || 7), ageDays: Math.floor(ageDays) };
}
function checkStaleTasks(force = false) {
  const stale = db.tasks.filter(t => !t.completedAt && taskState(t).stale);
  const due = force ? stale : stale.filter(t => {
    const last = db.nudges[t.id];
    return !last || Date.now() - new Date(last).getTime() > 20 * 3600 * 1000;
  });
  if (!due.length) return 0;
  due.forEach(t => db.nudges[t.id] = nowIso());
  save();
  const names = due.slice(0, 3).map(t => '• ' + t.title).join('\n');
  const more = due.length > 3 ? `\n…and ${due.length - 3} more` : '';
  notify(due.length === 1 ? 'A task needs attention' : `${due.length} tasks need attention`, names + more, '#tasks');
  return due.length;
}

// ---------- Claude integration (global CLAUDE.md + project index) ----------
function writeProjectsIndex() {
  if (!db.settings.integrationInstalled) return;
  const lines = [
    '# My projects (auto-generated by Command Center, do not edit by hand)',
    '',
    `Last updated: ${localYmd()}. Use this to know what else the user is building and to reuse ideas, code and conventions across projects.`,
    ''
  ];
  for (const p of db.projects.filter(p => p.status !== 'archived')) {
    const ctx = readContext(p.path) || {};
    lines.push(`## ${p.name}${p.active ? ' (currently active)' : ''}`);
    lines.push(`- Status: ${p.status}${ctx.phase ? `, phase: ${ctx.phase}` : ''}${ctx.progressPct != null ? `, progress: ${ctx.progressPct}%` : ''}`);
    if (p.path) lines.push(`- Folder: ${p.path}`);
    if (p.repo) lines.push(`- GitHub: ${p.repo}`);
    if (p.description) lines.push(`- About: ${p.description}`);
    if (ctx.next) lines.push(`- Next: ${ctx.next}`);
    lines.push('');
  }
  fs.mkdirSync(CLAUDE_DIR, { recursive: true });
  fs.writeFileSync(path.join(CLAUDE_DIR, 'projects-index.md'), lines.join('\n'));
}
function installIntegration() {
  const block = `${CC_START}
## Command Center (my project system)
@~/.claude/projects-index.md

- Each project keeps its live status in its own CLAUDE.md, between \`${STATUS_START}\` and \`${STATUS_END}\`, with the lines Phase, Progress (a %), Summary, Next, Blockers and Updated (YYYY-MM-DD).
- When you finish a meaningful piece of work in a project (a feature, a fix, a milestone, or the end of a working session), update that block so it reflects reality. Keep the rest of CLAUDE.md as it is. If the block is missing, add it near the top.
- Progress is an honest estimate toward the project's current goal (MVP or next release), not toward perfection.
- Installed skills, slash commands and agents exist to be used: whenever a task matches a skill's description, use that skill without waiting to be asked.
- A project with a \`skills.json\` lists every skill, tool and model it needs; \`python tools/bootstrap.py\` checks them and \`--install\` installs what's missing. If the session-start message says something isn't installed, offer to install it before work that needs it. When we adopt a new skill or tool for such a project, add it to its \`skills.json\` so every PC gets it.
${CC_END}`;
  const f = path.join(CLAUDE_DIR, 'CLAUDE.md');
  fs.mkdirSync(CLAUDE_DIR, { recursive: true });
  let text = fs.existsSync(f) ? fs.readFileSync(f, 'utf8') : '';
  if (text && !fs.existsSync(f + '.bak-command-center')) fs.writeFileSync(f + '.bak-command-center', text);
  const s = text.indexOf(CC_START), e = text.indexOf(CC_END);
  if (s >= 0 && e > s) text = text.slice(0, s) + block + text.slice(e + CC_END.length);
  else text = (text.trimEnd() ? text.trimEnd() + '\n\n' : '') + block + '\n';
  fs.writeFileSync(f, text);
  db.settings.integrationInstalled = true;
  save();
  writeProjectsIndex();
}
function uninstallIntegration() {
  const f = path.join(CLAUDE_DIR, 'CLAUDE.md');
  if (fs.existsSync(f)) {
    let text = fs.readFileSync(f, 'utf8');
    const s = text.indexOf(CC_START), e = text.indexOf(CC_END);
    if (s >= 0 && e > s) fs.writeFileSync(f, (text.slice(0, s) + text.slice(e + CC_END.length)).replace(/\n{3,}/g, '\n\n'));
  }
  db.settings.integrationInstalled = false;
  save();
}

// ---------- app ----------
const app = express();
app.use(express.json({ limit: '2mb' }));
app.use(express.static(path.join(ROOT, 'public')));
const wrap = fn => (req, res) => Promise.resolve(fn(req, res)).catch(e => res.status(400).json({ error: e.message }));
const findProject = id => {
  const p = db.projects.find(x => x.id === id);
  if (!p) throw new Error('Project not found');
  return p;
};
const afterProjectsChange = () => { save(); try { writeProjectsIndex(); } catch {} };

// Projects
app.get('/api/projects', wrap(async (req, res) => {
  const list = await Promise.all(db.projects.map(async p => {
    const exists = !!p.path && fs.existsSync(p.path);
    const [g, gh] = await Promise.all([exists ? gitInfo(p.path) : null, repoInfo(p.repo)]);
    const ctx = exists ? readContext(p.path) : null;
    const times = [g && g.lastCommitAt, ctx && ctx.modifiedAt, gh && gh.pushedAt].filter(Boolean).map(t => new Date(t).getTime());
    const lastActivityAt = times.length ? new Date(Math.max(...times)).toISOString() : null;
    const openTasks = db.tasks.filter(t => t.projectId === p.id && !t.completedAt).length;
    const doneTasks = db.tasks.filter(t => t.projectId === p.id && t.completedAt).length;
    return { ...p, exists, git: g, context: ctx, github: gh, lastActivityAt, openTasks, doneTasks, setup: exists ? setupInfo(p.path) : null };
  }));
  res.json(list);
}));
app.post('/api/projects', wrap(async (req, res) => {
  const b = req.body || {};
  if (!b.name || !b.name.trim()) throw new Error('Name is required');
  const p = {
    id: newId(), name: b.name.trim(), path: (b.path || '').trim(), repo: (b.repo || '').trim(),
    status: STATUSES.includes(b.status) ? b.status : 'development', active: b.active !== false,
    description: (b.description || '').trim(), createdAt: nowIso()
  };
  if (!p.repo && p.path) { const g = await gitInfo(p.path); p.repo = repoFromRemote(g && g.remote) || ''; }
  db.projects.push(p);
  afterProjectsChange();
  res.json(p);
}));
app.patch('/api/projects/:id', wrap(async (req, res) => {
  const p = findProject(req.params.id);
  for (const k of ['name', 'path', 'repo', 'description']) if (typeof req.body[k] === 'string') p[k] = req.body[k].trim();
  if (STATUSES.includes(req.body.status)) p.status = req.body.status;
  if (typeof req.body.active === 'boolean') p.active = req.body.active;
  afterProjectsChange();
  res.json(p);
}));
app.delete('/api/projects/:id', wrap(async (req, res) => {
  findProject(req.params.id);
  db.projects = db.projects.filter(p => p.id !== req.params.id);
  db.tasks.forEach(t => { if (t.projectId === req.params.id) t.projectId = null; });
  afterProjectsChange();
  res.json({ ok: true });
}));
app.post('/api/projects/:id/open', wrap(async (req, res) => {
  const p = findProject(req.params.id);
  if (!p.path || !fs.existsSync(p.path)) throw new Error('Folder not found: ' + (p.path || '(none set)'));
  const cmd = db.settings.editorCommand || 'code';
  await new Promise((resolve, reject) => exec(`${cmd} "${p.path}"`, { windowsHide: true, timeout: 15000 }, err =>
    err ? reject(new Error(`Could not run "${cmd}". In VS Code, run "Shell Command: Install 'code' command in PATH", or set the editor command in Settings.`)) : resolve()));
  p.lastOpenedAt = nowIso(); save();
  res.json({ ok: true });
}));
app.post('/api/projects/:id/folder', wrap(async (req, res) => {
  const p = findProject(req.params.id);
  if (!p.path || !fs.existsSync(p.path)) throw new Error('Folder not found');
  if (IS_WIN) exec(`explorer "${p.path}"`, { windowsHide: true }, () => {});
  else openUrl(p.path);
  res.json({ ok: true });
}));
app.post('/api/projects/:id/terminal', wrap(async (req, res) => {
  const p = findProject(req.params.id);
  if (!p.path || !fs.existsSync(p.path)) throw new Error('Folder not found');
  if (!IS_WIN) throw new Error('This button is set up for Windows only.');
  spawn('cmd', ['/c', 'start', 'Claude', 'cmd', '/k', 'claude'], { cwd: p.path, detached: true, stdio: 'ignore' }).unref();
  res.json({ ok: true });
}));
app.post('/api/projects/:id/setup', wrap(async (req, res) => {
  const p = findProject(req.params.id);
  if (!hasSetup(p.path)) throw new Error('This project has no skills.json / tools/bootstrap.py');
  if (!IS_WIN) throw new Error('This button is set up for Windows only. Run: python tools/bootstrap.py --install');
  const py = await pythonCmd();
  if (!py) throw new Error('Python not found. Install Python 3.10+ (tick "Add python.exe to PATH").');
  // a visible window, so you can see sizes, answer the prompt and watch progress
  spawn('cmd', ['/c', 'start', 'Project setup', 'cmd', '/k', `${py} tools\\bootstrap.py --install`], { cwd: p.path, detached: true, stdio: 'ignore' }).unref();
  setupCache.delete(p.path);
  res.json({ ok: true });
}));
app.post('/api/projects/:id/setup/recheck', wrap(async (req, res) => {
  const p = findProject(req.params.id);
  if (!hasSetup(p.path)) return res.json(null);
  const info = await checkSetup(p.path);
  setupCache.set(p.path, { at: Date.now(), info });
  res.json(info);
}));
app.post('/api/projects/:id/status-block', wrap(async (req, res) => {
  const p = findProject(req.params.id);
  if (!p.path || !fs.existsSync(p.path)) throw new Error('Folder not found');
  const f = path.join(p.path, 'CLAUDE.md');
  const phase = { idea: 'Idea', planning: 'Planning', development: 'Building', live: 'Live', paused: 'Paused', archived: 'Archived' }[p.status];
  if (!fs.existsSync(f)) fs.writeFileSync(f, `# ${p.name}\n\n${statusTemplate(phase)}\n## About\n${p.description || ''}\n`);
  else {
    const text = fs.readFileSync(f, 'utf8');
    if (text.includes(STATUS_START)) throw new Error('This CLAUDE.md already has a status block.');
    const lines = text.split(/\r?\n/);
    const at = lines[0] && lines[0].startsWith('# ') ? 1 : 0;
    lines.splice(at, 0, '', statusTemplate(phase));
    fs.writeFileSync(f, lines.join('\n'));
  }
  res.json({ ok: true });
}));
app.post('/api/projects/:id/refresh-context', wrap(async (req, res) => {
  const p = findProject(req.params.id);
  if (!p.path || !fs.existsSync(p.path)) throw new Error('Folder not found');
  const log = await git(p.path, ['log', '-20', '--format=%cs %s']) || '(no git history)';
  const prompt = `You are refreshing the project status for "${p.name}".
Look at this project briefly: CLAUDE.md, README, the main source folders, any TODO lists, and this recent git history:

${log}

Then update ONLY the status block in CLAUDE.md, between "${STATUS_START}" and "${STATUS_END}". If the block is missing, add it right after the first heading (create CLAUDE.md if needed). The block must contain exactly these lines:
- Phase: one or two words (Idea, Planning, Building, Testing, Launching, Live, Maintenance, Paused)
- Progress: N% — an honest estimate toward the current goal (MVP or next release)
- Summary: one sentence on where things stand
- Next: the single most useful next step
- Blockers: none, or a short list
- Updated: ${localYmd()}
Do not edit any other part of any file. Reply with one line summarising the new status.`;
  const job = startJob('context:' + p.id, async () => {
    const r = await runClaude({ prompt, cwd: p.path, args: ['--permission-mode', 'acceptEdits', '--allowedTools', 'Read,Glob,Grep,Edit,Write'] });
    try { writeProjectsIndex(); } catch {}
    return r;
  });
  res.json(job);
}));
app.get('/api/jobs/:key', (req, res) => res.json(jobs[req.params.key] || { state: 'idle' }));

app.post('/api/scan', wrap(async (req, res) => {
  const root = (req.body.root || '').trim();
  if (!root || !fs.existsSync(root)) throw new Error('Folder not found: ' + root);
  const markers = ['.git', 'CLAUDE.md', 'package.json', 'pubspec.yaml', 'build.gradle', 'build.gradle.kts', 'pyproject.toml', 'requirements.txt', 'Cargo.toml', 'go.mod', 'index.html'];
  const known = new Set(db.projects.map(p => path.resolve(p.path || '').toLowerCase()));
  const found = [];
  const walk = (dir, depth) => {
    let ents; try { ents = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const e of ents) {
      if (!e.isDirectory() || e.name.startsWith('.') || e.name === 'node_modules') continue;
      const fp = path.join(dir, e.name);
      if (markers.some(m => fs.existsSync(path.join(fp, m)))) {
        if (!known.has(path.resolve(fp).toLowerCase())) found.push({ name: e.name, path: fp, hasGit: fs.existsSync(path.join(fp, '.git')), hasClaudeMd: fs.existsSync(path.join(fp, 'CLAUDE.md')) });
      } else if (depth > 0) walk(fp, depth - 1);
    }
  };
  walk(root, 2);
  res.json(found);
}));

// GitHub
app.get('/api/github/repos', wrap(async (req, res) => {
  const repos = await gh('/user/repos?per_page=100&sort=pushed&affiliation=owner,collaborator');
  const linked = new Set(db.projects.map(p => (p.repo || '').toLowerCase()));
  res.json(repos.map(r => ({
    fullName: r.full_name, name: r.name, description: r.description, private: r.private, pushedAt: r.pushed_at,
    url: r.html_url, language: r.language, linked: linked.has(r.full_name.toLowerCase())
  })));
}));

// Tasks
app.get('/api/tasks', (req, res) => res.json(db.tasks.map(t => ({ ...t, ...taskState(t) }))));
app.post('/api/tasks', wrap(async (req, res) => {
  const b = req.body || {};
  if (!b.title || !b.title.trim()) throw new Error('Title is required');
  const t = { id: newId(), title: b.title.trim(), notes: (b.notes || '').trim(), projectId: b.projectId || null, dueDate: b.dueDate || null, createdAt: nowIso(), lastActivityAt: nowIso(), completedAt: null };
  db.tasks.push(t); save();
  res.json(t);
}));
app.patch('/api/tasks/:id', wrap(async (req, res) => {
  const t = db.tasks.find(x => x.id === req.params.id);
  if (!t) throw new Error('Task not found');
  const b = req.body || {};
  if (typeof b.title === 'string' && b.title.trim()) t.title = b.title.trim();
  if (typeof b.notes === 'string') t.notes = b.notes;
  if ('projectId' in b) t.projectId = b.projectId || null;
  if ('dueDate' in b) t.dueDate = b.dueDate || null;
  if (typeof b.done === 'boolean') t.completedAt = b.done ? nowIso() : null;
  if (b.snoozeDays) t.lastActivityAt = new Date(Date.now() + (Number(b.snoozeDays) - Number(db.settings.staleDays || 7)) * 86400000).toISOString();
  else t.lastActivityAt = nowIso();
  delete db.nudges[t.id];
  save();
  res.json({ ...t, ...taskState(t) });
}));
app.delete('/api/tasks/:id', (req, res) => { db.tasks = db.tasks.filter(t => t.id !== req.params.id); delete db.nudges[req.params.id]; save(); res.json({ ok: true }); });

// Skills
app.get('/api/skills', (req, res) => res.json(scanSkills()));

// Ideas
app.get('/api/ideas', (req, res) => res.json({ ...db.ideas, job: jobs.ideas || { state: 'idle' } }));
app.post('/api/ideas/refresh', wrap(async (req, res) => {
  const focus = (req.body.focus || '').trim();
  db.ideas.focus = focus; save();
  const existing = db.projects.map(p => p.name).join(', ') || 'none';
  const prompt = `Act as a market researcher hunting for digital products with HIGH demand and LOW supply.
Today is ${localYmd()}.${focus ? ` Focus: ${focus}.` : ''}
Use web search to look at real, current signals in several different markets: app store categories with weak top results, Reddit / forum threads full of people asking for a tool that does not exist, search trends, "alternative to X" searches, complaints about expensive or abandoned tools, Product Hunt / Gumroad / Etsy digital product gaps, Telegram/Discord bot requests, browser extension gaps.
Cover a mix of types: Android/iOS app, web app, bot, browser extension or developer tool, and digital product (template, course, dataset, asset pack).
For each market, compare the volume of demand to how many good options exist. Skip anything crowded.
The person is a solo developer (MCA background) who ships with Claude Code. Their existing projects (avoid duplicates): ${existing}.

Return ONLY a JSON array of 8 objects, no prose, no code fences. Each object:
{"title": string, "type": "App"|"Web App"|"Bot"|"Tool"|"Extension"|"Digital Product", "market": string, "problem": string, "demandSignal": string (concrete evidence), "supplyGap": string (what exists and why it falls short), "demand": 1-10, "supply": 1-10 (10 = very crowded), "effort": "Days"|"Weeks"|"Months", "monetization": string, "mvp": string (smallest version worth shipping), "sources": [up to 3 URLs]}`;
  const job = startJob('ideas', async () => {
    const out = await runClaude({ prompt, args: ['--allowedTools', 'WebSearch,WebFetch'] });
    const text = String(out);
    const s = text.indexOf('['), e = text.lastIndexOf(']');
    if (s < 0 || e < s) throw new Error('Claude did not return a list of ideas. Try again.');
    const items = JSON.parse(text.slice(s, e + 1)).map(i => {
      const d = Number(i.demand) || 0, sp = Number(i.supply) || 0;
      return { ...i, id: newId(), score: Math.round((d * (11 - sp)) / 10 * 10) / 10 };
    }).sort((a, b) => b.score - a.score);
    db.ideas.items = items; db.ideas.updatedAt = nowIso(); save();
    return `${items.length} ideas`;
  });
  res.json(job);
}));
app.post('/api/ideas/:id/to-project', wrap(async (req, res) => {
  const i = db.ideas.items.find(x => x.id === req.params.id);
  if (!i) throw new Error('Idea not found');
  const p = { id: newId(), name: i.title, path: '', repo: '', status: 'idea', active: false, description: `${i.type} · ${i.market}. ${i.problem || ''} MVP: ${i.mvp || ''}`.trim(), createdAt: nowIso() };
  db.projects.push(p); i.savedAsProject = p.id;
  afterProjectsChange();
  res.json(p);
}));
app.delete('/api/ideas/:id', (req, res) => { db.ideas.items = db.ideas.items.filter(i => i.id !== req.params.id); save(); res.json({ ok: true }); });

// Settings
app.get('/api/settings', (req, res) => {
  const s = { ...db.settings, githubToken: db.settings.githubToken ? '••••' + db.settings.githubToken.slice(-4) : '', hasToken: !!db.settings.githubToken };
  res.json({ ...s, claudeDir: CLAUDE_DIR, platform: process.platform, notifier: !!notifier });
});
app.patch('/api/settings', wrap(async (req, res) => {
  const b = req.body || {};
  if (typeof b.githubToken === 'string' && !b.githubToken.startsWith('••••')) db.settings.githubToken = b.githubToken.trim();
  if (b.staleDays) db.settings.staleDays = Math.max(1, Number(b.staleDays));
  if (b.notifyIntervalMin) db.settings.notifyIntervalMin = Math.max(5, Number(b.notifyIntervalMin));
  if (typeof b.editorCommand === 'string' && b.editorCommand.trim()) db.settings.editorCommand = b.editorCommand.trim();
  ghCache.clear(); save(); scheduleChecks();
  res.json({ ok: true });
}));
app.post('/api/integration/install', wrap(async (req, res) => { installIntegration(); res.json({ ok: true }); }));
app.post('/api/integration/uninstall', wrap(async (req, res) => { uninstallIntegration(); res.json({ ok: true }); }));
app.post('/api/notify/test', (req, res) => {
  const ok = notify('Command Center', 'Notifications are working.', '#tasks');
  const n = checkStaleTasks(true);
  res.json({ ok, staleSent: n });
});

// ---------- background checks ----------
let checkTimer = null;
function scheduleChecks() {
  if (checkTimer) clearInterval(checkTimer);
  checkTimer = setInterval(() => { try { checkStaleTasks(); } catch {} }, Number(db.settings.notifyIntervalMin || 60) * 60000);
}

const server = app.listen(PORT, '127.0.0.1', () => {
  console.log(`Command Center running at ${BASE_URL}`);
  scheduleChecks();
  setTimeout(() => { try { checkStaleTasks(); } catch {} }, 15000);
  try { writeProjectsIndex(); } catch {}
  if (process.argv.includes('--open')) openUrl(BASE_URL);
});
server.on('error', e => {
  if (e.code === 'EADDRINUSE') {
    console.log('Command Center is already running; opening it.');
    if (process.argv.includes('--open')) openUrl(BASE_URL);
    process.exit(0);
  }
  throw e;
});
