// Command Center UI — vanilla JS, talks to the local server.
const $ = s => document.querySelector(s);
const main = $('#main');
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const STATUSES = ['idea', 'planning', 'development', 'live', 'paused', 'archived'];
const S = { projects: [], tasks: [], skills: null, ideas: null, settings: null, projFilter: 'all', taskFilter: 'all', skillQuery: '' };

async function api(url, opts = {}) {
  const r = await fetch(url, { headers: { 'Content-Type': 'application/json' }, ...opts, body: opts.body ? JSON.stringify(opts.body) : undefined });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(j.error || `Request failed (${r.status})`);
  return j;
}
const post = (u, b = {}) => api(u, { method: 'POST', body: b });
const patch = (u, b) => api(u, { method: 'PATCH', body: b });
const del = u => api(u, { method: 'DELETE' });

let toastT;
function toast(msg, err = false) {
  const t = $('#toast'); t.textContent = msg; t.className = 'show' + (err ? ' err' : '');
  clearTimeout(toastT); toastT = setTimeout(() => t.className = '', err ? 5000 : 2500);
}
async function act(fn, okMsg) { try { const r = await fn(); if (okMsg) toast(okMsg); return r; } catch (e) { toast(e.message, true); } }

// ---------- dates ----------
const ymd = (d = new Date()) => { const z = n => String(n).padStart(2, '0'); return `${d.getFullYear()}-${z(d.getMonth() + 1)}-${z(d.getDate())}`; };
const endOfWeek = () => { const d = new Date(); d.setDate(d.getDate() + (7 - d.getDay()) % 7); return ymd(d); };
const endOfMonth = () => { const d = new Date(); return ymd(new Date(d.getFullYear(), d.getMonth() + 1, 0)); };
const DUE = { today: () => ymd(), week: endOfWeek, month: endOfMonth, none: () => null };
function bucket(t) {
  if (t.completedAt) return 'done';
  if (!t.dueDate) return 'none';
  const today = ymd();
  if (t.dueDate < today) return 'overdue';
  if (t.dueDate === today) return 'today';
  if (t.dueDate <= endOfWeek()) return 'week';
  if (t.dueDate <= endOfMonth()) return 'month';
  return 'later';
}
const BUCKETS = [['overdue', 'Overdue'], ['today', 'Today'], ['week', 'This week'], ['month', 'This month'], ['later', 'Later'], ['none', 'No date'], ['done', 'Completed']];
function ago(iso) {
  if (!iso) return 'never';
  const s = (Date.now() - new Date(iso).getTime()) / 1000;
  if (s < 3600) return Math.max(1, Math.round(s / 60)) + 'm ago';
  if (s < 86400) return Math.round(s / 3600) + 'h ago';
  const d = Math.round(s / 86400);
  return d < 30 ? d + 'd ago' : Math.round(d / 30) + 'mo ago';
}
const projName = id => (S.projects.find(p => p.id === id) || {}).name;

// ---------- data ----------
async function loadProjects() { S.projects = await api('/api/projects'); }
async function loadTasks() { S.tasks = await api('/api/tasks'); updateBadge(); }
function updateBadge() {
  const n = S.tasks.filter(t => !t.completedAt && (t.overdue || bucket(t) === 'today')).length;
  $('#taskBadge').textContent = n || '';
}

// ---------- modal ----------
function modal(title, body, { submit = 'Save', onSubmit, wide } = {}) {
  const root = $('#modalRoot');
  root.innerHTML = `<div class="modal-bg"><form class="modal" ${wide ? 'style="width:720px"' : ''}>
    <h2>${esc(title)}</h2><div class="mbody">${body}</div>
    <div class="foot"><button type="button" class="ghost" data-close>Cancel</button>${onSubmit ? `<button class="primary" type="submit">${esc(submit)}</button>` : ''}</div>
  </form></div>`;
  const close = () => root.innerHTML = '';
  root.querySelector('[data-close]').onclick = close;
  root.querySelector('.modal-bg').onclick = e => { if (e.target.classList.contains('modal-bg')) close(); };
  const form = root.querySelector('form');
  form.onsubmit = async e => {
    e.preventDefault();
    if (!onSubmit) return;
    const data = Object.fromEntries(new FormData(form));
    form.querySelectorAll('input[type=checkbox][name]').forEach(c => data[c.name] = c.checked);
    try { if (await onSubmit(data, form) !== false) close(); } catch (err) { toast(err.message, true); }
  };
  const first = form.querySelector('input,select,textarea'); if (first) first.focus();
  return { form, close };
}
const statusOptions = sel => STATUSES.map(s => `<option value="${s}" ${s === sel ? 'selected' : ''}>${s[0].toUpperCase() + s.slice(1)}</option>`).join('');

function projectForm(p = {}) {
  return `<label>Name</label><input name="name" required value="${esc(p.name)}">
  <label>Folder on your PC</label><input name="path" class="mono" placeholder="C:\\Users\\you\\Projects\\my-app" value="${esc(p.path)}">
  <label>GitHub repo (owner/name, optional; detected from the folder if left empty)</label><input name="repo" class="mono" placeholder="username/repo" value="${esc(p.repo)}">
  <label>Status</label><select name="status">${statusOptions(p.status || 'development')}</select>
  <label>What is it? (one or two lines)</label><textarea name="description">${esc(p.description)}</textarea>
  <label style="display:flex;gap:8px;align-items:center;color:var(--text)"><input type="checkbox" name="active" ${p.active !== false ? 'checked' : ''} style="width:auto"> Show on my dashboard (currently working on it)</label>`;
}
function openAddProject(prefill = {}) {
  modal('Add project', projectForm(prefill), {
    submit: 'Add project',
    onSubmit: async d => { await post('/api/projects', d); toast('Project added'); await refresh(); }
  });
}
function openEditProject(id) {
  const p = S.projects.find(x => x.id === id);
  modal('Edit project', projectForm(p), { onSubmit: async d => { await patch('/api/projects/' + id, d); toast('Saved'); await refresh(); } });
}
async function openScan() {
  const m = modal('Find projects in a folder', `<p class="sub" style="margin:0">Point at the folder that holds your projects. Subfolders with git, a CLAUDE.md, package.json and similar files are picked up (two levels deep).</p>
    <label>Folder</label><div style="display:flex;gap:8px"><input name="root" class="mono" placeholder="C:\\Users\\you\\Projects" value="${esc(localStorageGet('scanRoot'))}"><button type="button" id="scanGo">Scan</button></div>
    <div id="scanRes" style="margin-top:12px"></div>`, {
    submit: 'Add selected',
    onSubmit: async (d, form) => {
      const picks = [...form.querySelectorAll('input[data-path]:checked')];
      if (!picks.length) { toast('Nothing selected', true); return false; }
      for (const c of picks) await post('/api/projects', { name: c.dataset.name, path: c.dataset.path, status: 'development', active: false });
      toast(`Added ${picks.length} project${picks.length > 1 ? 's' : ''}. Star the ones you're working on.`);
      await refresh();
    }
  });
  const go = async () => {
    const root = m.form.root.value.trim(); localStorageSet('scanRoot', root);
    const box = $('#scanRes'); box.innerHTML = '<span class="spin"></span>';
    try {
      const found = await post('/api/scan', { root });
      box.innerHTML = found.length ? `<div class="pick">${found.map(f => `<label class="row" style="margin:0;color:var(--text)"><input type="checkbox" checked style="width:auto" data-path="${esc(f.path)}" data-name="${esc(f.name)}">
        <div class="grow"><b>${esc(f.name)}</b><div class="mono" style="color:var(--muted)">${esc(f.path)}</div></div>
        ${f.hasGit ? '<span class="chip">git</span>' : ''}${f.hasClaudeMd ? '<span class="chip">CLAUDE.md</span>' : ''}</label>`).join('')}</div>` : '<div class="empty">No new projects found there.</div>';
    } catch (e) { box.innerHTML = `<div class="empty" style="color:var(--bad)">${esc(e.message)}</div>`; }
  };
  $('#scanGo').onclick = go;
  m.form.root.addEventListener('keydown', e => { if (e.key === 'Enter') { e.preventDefault(); go(); } });
}
async function openGithub() {
  const m = modal('Import from GitHub', '<div id="ghRes"><span class="spin"></span></div>', {
    submit: 'Import selected', wide: true,
    onSubmit: async (d, form) => {
      const picks = [...form.querySelectorAll('input[data-repo]:checked')];
      if (!picks.length) { toast('Nothing selected', true); return false; }
      for (const c of picks) await post('/api/projects', { name: c.dataset.name, repo: c.dataset.repo, path: form.querySelector(`input[data-pathfor="${c.dataset.repo}"]`).value, status: 'development', active: false, description: c.dataset.desc });
      toast(`Imported ${picks.length}`); await refresh();
    }
  });
  try {
    const repos = await api('/api/github/repos');
    $('#ghRes').innerHTML = `<p class="sub" style="margin:0 0 10px">Tick repos to track. Add the local folder if it's cloned on this PC so "Open in VS Code" works.</p>
    <div class="pick">${repos.map(r => `<div class="row"><input type="checkbox" style="width:auto" ${r.linked ? 'disabled' : ''} data-repo="${esc(r.fullName)}" data-name="${esc(r.name)}" data-desc="${esc(r.description || '')}">
      <div class="grow"><b>${esc(r.name)}</b> ${r.private ? '<span class="chip">private</span>' : ''} ${r.linked ? '<span class="chip">already added</span>' : ''}
      <div style="color:var(--muted);font-size:12px">${esc(r.description || '')} · pushed ${ago(r.pushedAt)}</div>
      <input data-pathfor="${esc(r.fullName)}" class="mono" placeholder="Local folder (optional)" style="margin-top:6px;width:100%;padding:5px 8px" ${r.linked ? 'disabled' : ''}></div></div>`).join('')}</div>`;
  } catch (e) {
    $('#ghRes').innerHTML = `<div class="banner warn">${esc(e.message)} <a href="#settings" data-close>Open Settings</a></div>`;
  }
}
function localStorageGet(k) { try { return localStorage.getItem('cc:' + k) || ''; } catch { return ''; } }
function localStorageSet(k, v) { try { localStorage.setItem('cc:' + k, v); } catch {} }

// ---------- project actions ----------
async function projAction(id, kind) {
  if (kind === 'open') return act(() => post(`/api/projects/${id}/open`), 'Opening in VS Code…');
  if (kind === 'folder') return act(() => post(`/api/projects/${id}/folder`));
  if (kind === 'terminal') return act(() => post(`/api/projects/${id}/terminal`), 'Claude terminal opened');
  if (kind === 'setup') {
    const r = await act(() => post(`/api/projects/${id}/setup`), 'Setup window opened. It shows what it installs; big downloads take a while.');
    if (r) setTimeout(async () => { await post(`/api/projects/${id}/setup/recheck`).catch(() => {}); refresh(); }, 60000);
    return;
  }
  if (kind === 'recheck') { toast('Checking…'); await post(`/api/projects/${id}/setup/recheck`).catch(e => toast(e.message, true)); return refresh(); }
  if (kind === 'edit') return openEditProject(id);
  if (kind === 'star') { const p = S.projects.find(x => x.id === id); await act(() => patch('/api/projects/' + id, { active: !p.active })); return refresh(); }
  if (kind === 'block') { await act(() => post(`/api/projects/${id}/status-block`), 'Status block added to CLAUDE.md'); return refresh(); }
  if (kind === 'delete') {
    const p = S.projects.find(x => x.id === id);
    if (!confirm(`Remove "${p.name}" from Command Center? Your files are not touched.`)) return;
    await act(() => del('/api/projects/' + id), 'Removed'); return refresh();
  }
  if (kind === 'context') {
    const r = await act(() => post(`/api/projects/${id}/refresh-context`));
    if (!r) return;
    toast('Claude is reading the project… this takes a minute or two');
    pollJob('context:' + id, () => { toast('Status updated'); refresh(); });
    render();
  }
}
const running = new Set();
function pollJob(key, onDone) {
  running.add(key);
  const tick = async () => {
    const j = await api('/api/jobs/' + encodeURIComponent(key)).catch(() => ({ state: 'error', error: 'Lost connection' }));
    if (j.state === 'running') return setTimeout(tick, 3000);
    running.delete(key);
    if (j.state === 'error') { toast(j.error, true); render(); } else onDone(j);
  };
  setTimeout(tick, 2000);
}

function setupChip(p) {
  const s = p.setup;
  if (!s || s.checking) return '';
  if (s.error) return `<span class="chip warn" title="${esc(s.error)}">Setup: can't check</span>`;
  if (s.ok) return `<span class="chip" title="Every skill, tool and model in skills.json is installed${s.optionalMissing && s.optionalMissing.length ? ' (optional missing: ' + esc(s.optionalMissing.join(', ')) + ')' : ''}">Skills &amp; tools ready</span>`;
  return `<span class="chip warn" title="Missing: ${esc(s.missing.join(', '))}">Setup: ${s.missing.length} to install</span>`;
}
function projectCard(p, compact = false) {
  const c = p.context || {};
  const pct = c.progressPct;
  const busy = running.has('context:' + p.id);
  const last = p.lastActivityAt;
  const idle = last && (Date.now() - new Date(last)) / 86400000 > 14;
  return `<div class="card proj">
    <div class="proj-head">
      <button class="star ${p.active ? 'on' : ''}" title="${p.active ? 'On dashboard' : 'Add to dashboard'}" data-p="${p.id}" data-a="star">${p.active ? '★' : '☆'}</button>
      <h3>${esc(p.name)}</h3><span class="pill ${p.status}">${p.status}</span>
    </div>
    ${p.description && !compact ? `<div style="color:var(--muted);font-size:13px">${esc(p.description)}</div>` : ''}
    <div>
      <div style="display:flex;justify-content:space-between;font-size:12px;margin-bottom:5px"><span>${esc(c.phase || (c.hasStatusBlock ? 'Status set' : 'No status yet'))}</span><span>${pct != null ? pct + '%' : '–'}</span></div>
      <div class="bar ${p.status === 'live' ? 'ok' : ''}"><i style="width:${pct || 0}%"></i></div>
    </div>
    ${c.summary ? `<div class="kv">${esc(c.summary)}</div>` : ''}
    ${c.next ? `<div class="kv"><b>Next:</b> ${esc(c.next)}</div>` : ''}
    ${c.blockers && !/^none$/i.test(c.blockers) ? `<div class="kv" style="color:var(--warn)"><b>Blocked:</b> ${esc(c.blockers)}</div>` : ''}
    <div class="meta">
      <span class="${idle ? 'chip warn' : ''}">Active ${ago(last)}</span>
      ${p.openTasks ? `<span>${p.openTasks} open task${p.openTasks > 1 ? 's' : ''}</span>` : ''}
      ${p.git && p.git.uncommitted ? `<span>${p.git.uncommitted} uncommitted</span>` : ''}
      ${p.github ? `<a href="${esc(p.github.url)}" target="_blank">GitHub${p.github.openIssues ? ` · ${p.github.openIssues} issues` : ''}</a>` : (p.repo ? `<span class="mono">${esc(p.repo)}</span>` : '')}
      ${!p.exists && p.path ? '<span class="chip bad">folder missing</span>' : ''}
      ${setupChip(p)}
    </div>
    <div class="actions">
      <button class="sm primary" data-p="${p.id}" data-a="open" ${p.exists ? '' : 'disabled'}>Open in VS Code</button>
      ${!compact ? `<button class="sm" data-p="${p.id}" data-a="terminal" ${p.exists ? '' : 'disabled'} title="Opens a terminal running claude in this folder">Claude terminal</button>
      <button class="sm" data-p="${p.id}" data-a="folder" ${p.exists ? '' : 'disabled'}>Folder</button>` : ''}
      ${p.exists ? (c.hasStatusBlock || !compact ? `<button class="sm" data-p="${p.id}" data-a="context" ${busy ? 'disabled' : ''} title="Claude reads the project and updates its status block">${busy ? '<span class="spin"></span> Updating' : '↻ Status'}</button>` : '') : ''}
      ${p.exists && !c.hasStatusBlock ? `<button class="sm" data-p="${p.id}" data-a="block" title="Adds an empty status block to CLAUDE.md">+ Status block</button>` : ''}
      ${p.exists && p.setup && !p.setup.checking && !p.setup.ok ? `<button class="sm primary" data-p="${p.id}" data-a="setup" title="Installs the skills, tools and models this project lists in skills.json (opens a window)">Install ${p.setup.missing ? p.setup.missing.length : ''} missing</button>` : ''}
      ${p.exists && p.setup && !compact ? `<button class="sm ghost" data-p="${p.id}" data-a="recheck" title="Check skills.json again">↻ Setup</button>` : ''}
      ${!compact ? `<span class="spacer"></span><button class="sm ghost" data-p="${p.id}" data-a="edit">Edit</button><button class="sm ghost danger" data-p="${p.id}" data-a="delete">Remove</button>` : ''}
    </div>
  </div>`;
}

// ---------- tasks ----------
function taskRow(t) {
  const pn = projName(t.projectId);
  const b = bucket(t);
  return `<div class="task ${t.completedAt ? 'done' : ''}">
    <button class="check ${t.completedAt ? 'on' : ''}" data-t="${t.id}" data-a="toggle" title="Mark ${t.completedAt ? 'not done' : 'done'}"></button>
    <div class="t"><div class="title">${esc(t.title)}</div>
      <div class="meta">
        <span class="chip">${pn ? esc(pn) : 'General'}</span>
        ${t.dueDate && !t.completedAt ? `<span class="${b === 'overdue' ? 'chip bad' : ''}">due ${t.dueDate === ymd() ? 'today' : esc(t.dueDate)}</span>` : ''}
        ${t.completedAt ? `<span>done ${ago(t.completedAt)}</span>` : `<span>added ${ago(t.createdAt)}</span>`}
        ${t.stale && !t.overdue ? '<span class="chip warn">untouched for a while</span>' : ''}
        ${t.notes ? `<span title="${esc(t.notes)}">📝</span>` : ''}
      </div>
    </div>
    ${t.completedAt ? `<div class="row-actions"><button class="ghost sm danger" data-t="${t.id}" data-a="delete">Delete</button></div>` : `<div class="row-actions">
      <button class="ghost sm" data-t="${t.id}" data-a="due-today">Today</button>
      <button class="ghost sm" data-t="${t.id}" data-a="due-week">Week</button>
      <button class="ghost sm" data-t="${t.id}" data-a="due-month">Month</button>
      ${t.stale ? `<button class="ghost sm" data-t="${t.id}" data-a="snooze" title="Stop reminders for 3 days">Snooze</button>` : ''}
      <button class="ghost sm" data-t="${t.id}" data-a="edit">Edit</button>
      <button class="ghost sm danger" data-t="${t.id}" data-a="delete">✕</button></div>`}
  </div>`;
}
async function taskAction(id, a) {
  const t = S.tasks.find(x => x.id === id);
  if (a === 'toggle') await act(() => patch('/api/tasks/' + id, { done: !t.completedAt }), t.completedAt ? null : 'Nice, done ✓');
  else if (a.startsWith('due-')) await act(() => patch('/api/tasks/' + id, { dueDate: DUE[a.slice(4)]() }));
  else if (a === 'snooze') await act(() => patch('/api/tasks/' + id, { snoozeDays: 3 }), 'Snoozed for 3 days');
  else if (a === 'delete') { if (!confirm('Delete this task?')) return; await act(() => del('/api/tasks/' + id)); }
  else if (a === 'edit') return openEditTask(t);
  await loadTasks(); render();
}
function projectSelect(name, selected, withAll = false) {
  return `<select name="${name}">${withAll ? '' : ''}<option value="">General (no project)</option>${S.projects.filter(p => p.status !== 'archived').map(p => `<option value="${p.id}" ${p.id === selected ? 'selected' : ''}>${esc(p.name)}</option>`).join('')}</select>`;
}
function openEditTask(t) {
  modal('Edit task', `<label>Task</label><input name="title" required value="${esc(t.title)}">
    <label>Project</label>${projectSelect('projectId', t.projectId)}
    <label>Due date</label><input type="date" name="dueDate" value="${esc(t.dueDate || '')}">
    <label>Notes</label><textarea name="notes">${esc(t.notes)}</textarea>`, {
    onSubmit: async d => { await patch('/api/tasks/' + t.id, d); await loadTasks(); render(); }
  });
}
function quickAdd(defaultProject = '') {
  return `<form class="card" id="quickAdd">
    <div class="quick"><input name="title" placeholder="Add a task and press Enter…" autocomplete="off">${projectSelect('projectId', defaultProject)}<button class="primary">Add</button></div>
    <div class="due-btns"><span style="color:var(--muted);font-size:12px;align-self:center;margin-right:4px">Due:</span>
      <button type="button" data-due="today" class="sm on">Today</button><button type="button" data-due="week" class="sm">This week</button>
      <button type="button" data-due="month" class="sm">This month</button><button type="button" data-due="none" class="sm">No date</button>
      <input type="date" name="customDate" style="padding:3px 6px;font-size:12px"></div>
  </form>`;
}
function wireQuickAdd() {
  const f = $('#quickAdd'); if (!f) return;
  let due = 'today';
  f.querySelectorAll('[data-due]').forEach(b => b.onclick = () => {
    due = b.dataset.due; f.customDate.value = '';
    f.querySelectorAll('[data-due]').forEach(x => x.classList.toggle('on', x === b));
  });
  f.customDate.onchange = () => { if (f.customDate.value) f.querySelectorAll('[data-due]').forEach(x => x.classList.remove('on')); };
  f.onsubmit = async e => {
    e.preventDefault();
    const title = f.title.value.trim(); if (!title) return;
    const dueDate = f.customDate.value || DUE[due]();
    await act(() => post('/api/tasks', { title, projectId: f.projectId.value || null, dueDate }));
    f.title.value = ''; await loadTasks(); render();
    $('#quickAdd') && $('#quickAdd').title.focus();
  };
}

// ---------- views ----------
const views = {
  async dashboard() {
    const active = S.projects.filter(p => p.active && p.status !== 'archived');
    const open = S.tasks.filter(t => !t.completedAt);
    const today = open.filter(t => bucket(t) === 'today');
    const overdue = open.filter(t => t.overdue);
    const stale = open.filter(t => t.stale && !t.overdue);
    const live = S.projects.filter(p => p.status === 'live').length;
    const dev = S.projects.filter(p => ['development', 'planning'].includes(p.status)).length;
    const doneWeek = S.tasks.filter(t => t.completedAt && Date.now() - new Date(t.completedAt) < 7 * 86400000).length;
    const h = new Date().getHours();
    const greet = h < 12 ? 'Good morning' : h < 17 ? 'Good afternoon' : 'Good evening';
    const setupHints = [];
    if (!S.projects.length) setupHints.push('Add your projects: use <b>Scan a folder</b> on the Projects page to pick them all up at once.');
    if (S.settings && !S.settings.integrationInstalled) setupHints.push('Connect Command Center to Claude Code in <a href="#settings">Settings</a> so every chat knows your projects and keeps their status current.');
    return `<h1>${greet}</h1><p class="sub">${new Date().toLocaleDateString(undefined, { weekday: 'long', day: 'numeric', month: 'long' })}</p>
      ${setupHints.map(s => `<div class="banner">${s}</div>`).join('')}
      <div class="grid g4">
        <div class="card stat"><div class="n">${today.length}</div><div class="l">Due today</div></div>
        <div class="card stat ${overdue.length ? 'bad' : ''}"><div class="n">${overdue.length}</div><div class="l">Overdue</div></div>
        <div class="card stat ${stale.length ? 'warn' : ''}"><div class="n">${stale.length}</div><div class="l">Untouched for a while</div></div>
        <div class="card stat"><div class="n">${doneWeek}</div><div class="l">Done in the last 7 days</div></div>
      </div>
      <div class="section"><div class="toolbar" style="margin-bottom:12px"><h2 style="margin:0">Working on</h2><span class="meta">${live} live · ${dev} in development</span><span class="spacer"></span><a href="#projects">All projects →</a></div>
        ${active.length ? `<div class="grid gp">${active.map(p => projectCard(p, true)).join('')}</div>` : '<div class="card empty">Star a project on the Projects page to pin it here.</div>'}
      </div>
      <div class="section grid g2">
        <div><h2>Today</h2>${quickAdd()}<div class="list" style="margin-top:10px">${[...overdue, ...today].map(taskRow).join('') || '<div class="empty">Nothing due today.</div>'}</div></div>
        <div><h2>Needs attention</h2><div class="list">${stale.slice(0, 8).map(taskRow).join('') || '<div class="empty">No forgotten tasks. 👌</div>'}</div>
          ${S.ideas && S.ideas.items && S.ideas.items[0] ? `<h2 style="margin-top:22px">Top opportunity</h2><div class="card"><b>${esc(S.ideas.items[0].title)}</b> <span class="chip">${esc(S.ideas.items[0].type)}</span><p style="color:var(--muted);font-size:13px;margin:6px 0 0">${esc(S.ideas.items[0].problem || S.ideas.items[0].supplyGap || '')}</p><a href="#ideas" style="font-size:13px">See all ideas →</a></div>` : ''}
        </div>
      </div>`;
  },

  async projects() {
    const counts = Object.fromEntries(STATUSES.map(s => [s, S.projects.filter(p => p.status === s).length]));
    const f = S.projFilter;
    const list = S.projects.filter(p => f === 'all' ? p.status !== 'archived' : f === 'active' ? p.active : p.status === f)
      .sort((a, b) => (b.active - a.active) || (new Date(b.lastActivityAt || 0) - new Date(a.lastActivityAt || 0)));
    return `<h1>Projects</h1><p class="sub">★ pins a project to your dashboard. Status and progress come from each project's CLAUDE.md.</p>
      <div class="toolbar">
        <button class="primary" id="addProj">+ Add project</button><button id="scanProj">Scan a folder</button><button id="ghProj">Import from GitHub</button>
      </div>
      <div class="tabs" style="margin-bottom:16px">
        ${[['all', 'All', S.projects.filter(p => p.status !== 'archived').length], ['active', '★ Working on', S.projects.filter(p => p.active).length], ...STATUSES.map(s => [s, s[0].toUpperCase() + s.slice(1), counts[s]])]
          .map(([k, l, n]) => `<button class="${f === k ? 'on' : ''}" data-pf="${k}">${l} <span style="opacity:.6">${n}</span></button>`).join('')}
      </div>
      ${list.length ? `<div class="grid gp">${list.map(p => projectCard(p)).join('')}</div>` : '<div class="card empty">No projects here yet.</div>'}`;
  },

  async tasks() {
    const f = S.taskFilter;
    const list = S.tasks.filter(t => f === 'all' || (f === 'general' ? !t.projectId : t.projectId === f));
    const groups = BUCKETS.map(([k, label]) => {
      let items = list.filter(t => bucket(t) === k);
      if (k === 'done') items = items.sort((a, b) => new Date(b.completedAt) - new Date(a.completedAt)).slice(0, 30);
      if (!items.length) return '';
      return `<div class="group-h ${k === 'overdue' ? 'bad' : ''}">${label} <span style="opacity:.6">${items.length}</span></div><div class="list">${items.map(taskRow).join('')}</div>`;
    }).join('');
    const projsWithTasks = S.projects.filter(p => S.tasks.some(t => t.projectId === p.id));
    return `<h1>Tasks</h1><p class="sub">Tasks can belong to a project or be general. You'll get a desktop reminder when one sits untouched for ${S.settings ? S.settings.staleDays : 7}+ days or goes overdue.</p>
      ${quickAdd(['all', 'general'].includes(f) ? '' : f)}
      <div class="tabs" style="margin:16px 0 0">
        <button class="${f === 'all' ? 'on' : ''}" data-tf="all">All</button><button class="${f === 'general' ? 'on' : ''}" data-tf="general">General</button>
        ${projsWithTasks.map(p => `<button class="${f === p.id ? 'on' : ''}" data-tf="${p.id}">${esc(p.name)}</button>`).join('')}
      </div>
      ${groups || '<div class="card empty" style="margin-top:16px">No tasks yet. Add one above.</div>'}`;
  },

  async skills() {
    if (!S.skills) S.skills = await api('/api/skills');
    const q = S.skillQuery.toLowerCase();
    const match = x => !q || (x.name + ' ' + x.description + ' ' + x.source).toLowerCase().includes(q);
    const block = (title, items, hint) => {
      const m = items.filter(match);
      return `<div class="section"><h2>${title} <span style="color:var(--muted);font-weight:400">${m.length}</span></h2>
        ${hint ? `<p class="sub" style="margin:-6px 0 10px;font-size:13px">${hint}</p>` : ''}
        <div class="list">${m.map(s => `<div class="skill"><div class="nm"><span class="mono" style="font-size:13px">${esc(s.name)}</span><span class="chip">${esc(s.source)}</span></div>
          <div class="ds">${esc(s.description) || '<i>No description</i>'}</div></div>`).join('') || '<div class="empty">None found.</div>'}</div></div>`;
    };
    const sk = S.skills;
    return `<h1>Skills</h1><p class="sub">Everything Claude Code has installed on this PC. You don't need to remember these: Claude reads each description and picks the right skill when a task fits.</p>
      <div class="toolbar"><input id="skillQ" placeholder="Search skills, commands, agents…" value="${esc(S.skillQuery)}" style="flex:1;max-width:420px"><button id="skillRe">↻ Rescan</button></div>
      ${block('Global & plugin skills', sk.skills.filter(s => s.scope !== 'project'), 'Available in every project.')}
      ${block('Project skills', sk.skills.filter(s => s.scope === 'project'), 'Only load inside that project folder.')}
      ${block('Slash commands', sk.commands, 'Type these in Claude Code, e.g. /name.')}
      ${block('Agents', sk.agents, 'Subagents Claude can hand work to.')}
      <p class="sub" style="margin-top:20px;font-size:12px">Tip: a skill gets used more reliably when its description says <i>when</i> to use it ("Use when…"). Edit SKILL.md in <span class="mono">${esc(S.settings ? S.settings.claudeDir : '~/.claude')}\\skills</span> if one is being ignored.</p>`;
  },

  async ideas() {
    S.ideas = await api('/api/ideas');
    const I = S.ideas;
    const busy = I.job && I.job.state === 'running';
    if (busy && !running.has('ideas')) pollJob('ideas', () => { toast('Fresh ideas are in'); render(); });
    const bar = (v, inv) => `<div class="bar ${inv ? '' : 'ok'}"><i style="width:${(Number(v) || 0) * 10}%;${inv ? 'background:var(--warn)' : ''}"></i></div>`;
    return `<h1>Ideas</h1><p class="sub">High demand, low supply. Claude searches app stores, forums, Reddit, Product Hunt and marketplaces, then scores each gap. Score = demand × how empty the market is.</p>
      <div class="toolbar"><input id="ideaFocus" placeholder="Optional focus, e.g. Play Store apps for India, Telegram bots, Notion templates" value="${esc(I.focus)}" style="flex:1;min-width:240px">
        <button class="primary" id="ideaGo" ${busy ? 'disabled' : ''}>${busy ? '<span class="spin"></span> Researching… (a few minutes)' : '↻ Find ideas'}</button></div>
      ${I.job && I.job.state === 'error' ? `<div class="banner warn">${esc(I.job.error)}</div>` : ''}
      ${I.updatedAt ? `<p class="meta" style="margin-bottom:14px">Last refreshed ${ago(I.updatedAt)}</p>` : ''}
      ${I.items.length ? `<div class="grid gp">${I.items.map(i => `<div class="card idea">
        <div style="display:flex;gap:10px;align-items:flex-start"><div style="flex:1"><b style="font-size:15px">${esc(i.title)}</b><div class="meta" style="margin-top:4px"><span class="chip">${esc(i.type)}</span><span>${esc(i.market)}</span><span>${esc(i.effort || '')}</span></div></div><div class="big" title="Opportunity score">${esc(i.score)}</div></div>
        <div class="scores" style="margin:12px 0"><span>Demand</span>${bar(i.demand)}<span>${esc(i.demand)}</span><span>Crowded</span>${bar(i.supply, true)}<span>${esc(i.supply)}</span></div>
        ${i.problem ? `<p>${esc(i.problem)}</p>` : ''}
        <p><b>Demand:</b> ${esc(i.demandSignal)}</p><p><b>Gap:</b> ${esc(i.supplyGap)}</p>
        ${i.mvp ? `<p><b>MVP:</b> ${esc(i.mvp)}</p>` : ''}${i.monetization ? `<p><b>Money:</b> ${esc(i.monetization)}</p>` : ''}
        ${(i.sources || []).length ? `<p class="meta">${i.sources.map((u, n) => `<a href="${esc(u)}" target="_blank" rel="noopener">source ${n + 1}</a>`).join('')}</p>` : ''}
        <div class="actions" style="margin-top:8px">${i.savedAsProject ? '<span class="chip">Added to projects</span>' : `<button class="sm" data-idea="${i.id}" data-a="save">+ Save as project idea</button>`}<span class="spacer"></span><button class="sm ghost" data-idea="${i.id}" data-a="drop">Dismiss</button></div>
      </div>`).join('')}</div>` : `<div class="card empty">${busy ? 'Research is running. You can leave this page; results appear here when ready.' : 'No ideas yet. Press <b>Find ideas</b>. It runs Claude Code on your PC, so it uses your Claude plan rather than an API key.'}</div>`}`;
  },

  async settings() {
    S.settings = await api('/api/settings');
    const s = S.settings;
    return `<h1>Settings</h1><p class="sub">Everything is stored in the <span class="mono">data</span> folder next to the app.</p>
      <div class="grid g2">
        <form class="card" id="setForm"><h2>General</h2>
          <label>GitHub token (fine-grained, read-only "Metadata" + "Contents" is enough)</label><input name="githubToken" class="mono" placeholder="github_pat_…" value="${esc(s.githubToken)}">
          <div class="meta" style="margin-top:4px"><a href="https://github.com/settings/personal-access-tokens/new" target="_blank">Create a token on GitHub →</a></div>
          <label>Remind me when a task sits untouched for (days)</label><input name="staleDays" type="number" min="1" value="${esc(s.staleDays)}">
          <label>Check for reminders every (minutes)</label><input name="notifyIntervalMin" type="number" min="5" value="${esc(s.notifyIntervalMin)}">
          <label>Editor command</label><input name="editorCommand" class="mono" value="${esc(s.editorCommand)}">
          <div class="meta" style="margin-top:4px">"code" for VS Code, "cursor" for Cursor, "code-insiders" for Insiders.</div>
          <div style="margin-top:16px;display:flex;gap:8px"><button class="primary">Save</button><button type="button" id="testNotify">Send test notification</button></div>
        </form>
        <div class="card"><h2>Claude Code connection</h2>
          <p style="font-size:13px;color:var(--muted);margin-top:0">Adds a small, clearly marked block to your global <span class="mono">${esc(s.claudeDir)}\\CLAUDE.md</span> (a backup is saved first). After that, every Claude Code chat, in any project:</p>
          <ul style="font-size:13px;padding-left:18px;margin:0 0 14px">
            <li>knows your full project list (<span class="mono">projects-index.md</span>, rewritten whenever projects change)</li>
            <li>updates the project's status block in CLAUDE.md as work gets done, which feeds this dashboard</li>
            <li>is told to use installed skills whenever they fit, without being asked</li>
          </ul>
          ${s.integrationInstalled ? '<div class="banner" style="border-left-color:var(--ok)">Connected ✓</div><button id="intOff" class="danger">Disconnect</button> <button id="intOn">Reinstall / update block</button>' : '<button class="primary" id="intOn">Connect to Claude Code</button>'}
          <h2 style="margin-top:24px">Start with Windows</h2>
          <p style="font-size:13px;color:var(--muted);margin:0">Run <span class="mono">install-startup.bat</span> once from the app folder. It starts silently at login so reminders keep working. <span class="mono">uninstall-startup.bat</span> removes it.</p>
          ${!s.notifier ? '<div class="banner warn" style="margin-top:12px">Notifications are unavailable: run <span class="mono">npm install</span> in the app folder.</div>' : ''}
        </div>
      </div>`;
  }
};

// ---------- render & events ----------
let current = 'dashboard';
async function render() {
  const v = (location.hash.slice(1) || 'dashboard');
  current = views[v] ? v : 'dashboard';
  document.querySelectorAll('#nav a').forEach(a => a.classList.toggle('active', a.dataset.view === current));
  try { main.innerHTML = await views[current](); } catch (e) { main.innerHTML = `<div class="banner warn">${esc(e.message)}</div>`; }
  wire();
}
function wire() {
  wireQuickAdd();
  main.querySelectorAll('[data-p]').forEach(b => b.onclick = () => projAction(b.dataset.p, b.dataset.a));
  main.querySelectorAll('[data-t]').forEach(b => b.onclick = () => taskAction(b.dataset.t, b.dataset.a));
  main.querySelectorAll('[data-pf]').forEach(b => b.onclick = () => { S.projFilter = b.dataset.pf; render(); });
  main.querySelectorAll('[data-tf]').forEach(b => b.onclick = () => { S.taskFilter = b.dataset.tf; render(); });
  const on = (sel, fn) => { const el = $(sel); if (el) el.onclick = fn; };
  on('#addProj', () => openAddProject());
  on('#scanProj', openScan);
  on('#ghProj', openGithub);
  on('#skillRe', async () => { S.skills = null; await render(); toast('Rescanned'); });
  const q = $('#skillQ');
  if (q) q.oninput = () => { S.skillQuery = q.value; const pos = q.selectionStart; render().then(() => { const n = $('#skillQ'); n.focus(); n.setSelectionRange(pos, pos); }); };
  on('#ideaGo', async () => {
    const r = await act(() => post('/api/ideas/refresh', { focus: $('#ideaFocus').value }));
    if (r) { pollJob('ideas', () => { toast('Fresh ideas are in'); render(); }); render(); }
  });
  main.querySelectorAll('[data-idea]').forEach(b => b.onclick = async () => {
    if (b.dataset.a === 'save') { await act(() => post(`/api/ideas/${b.dataset.idea}/to-project`), 'Saved under Projects → Idea'); await loadProjects(); }
    else await act(() => del('/api/ideas/' + b.dataset.idea));
    render();
  });
  const sf = $('#setForm');
  if (sf) sf.onsubmit = async e => { e.preventDefault(); await act(() => patch('/api/settings', Object.fromEntries(new FormData(sf))), 'Settings saved'); S.skills = null; render(); };
  on('#testNotify', () => act(() => post('/api/notify/test'), 'Notification sent; check the bottom-right of your screen'));
  on('#intOn', async () => { await act(() => post('/api/integration/install'), 'Connected to Claude Code'); render(); });
  on('#intOff', async () => { if (!confirm('Remove the Command Center block from your global CLAUDE.md?')) return; await act(() => post('/api/integration/uninstall'), 'Disconnected'); render(); });
}
async function refresh() { await Promise.all([loadProjects(), loadTasks()]); await render(); }

window.addEventListener('hashchange', () => { $('#modalRoot').innerHTML = ''; render(); });
(async () => {
  try {
    S.settings = await api('/api/settings');
    S.ideas = await api('/api/ideas').catch(() => null);
    await refresh();
    $('#sideFoot').textContent = 'Running locally · port ' + location.port;
  } catch (e) { main.innerHTML = `<div class="banner warn">Can't reach the Command Center server. Is it running? (${esc(e.message)})</div>`; }
  setInterval(() => { if (!document.hidden && !$('#modalRoot').innerHTML && !document.activeElement.matches('input,textarea,select')) refresh(); }, 5 * 60 * 1000);
})();
