import { renderMarkdown } from './md.js';

const api = window.api;
const $ = (s) => document.querySelector(s);
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

const S = {
  focus: { mode: 'idle' },
  settings: null,
  sync: null,
  knowledge: { modules: [] },
  activeModuleId: null,
  weekTs: Date.now(),
  fileRoot: null,
  fileDir: null,
  clockOffset: 0,
};

// ---------------- utils ----------------
function toast(msg, isError = false) {
  const t = $('#toast');
  t.textContent = msg;
  t.className = `toast${isError ? ' error' : ''}`;
  clearTimeout(toast._t);
  toast._t = setTimeout(() => t.classList.add('hidden'), 3200);
}

async function call(ch, ...args) {
  try {
    return await api.call(ch, ...args);
  } catch (e) {
    toast(e.message, true);
    throw e;
  }
}

function fmtDur(sec, withSec = false) {
  sec = Math.max(0, Math.round(sec));
  const h = Math.floor(sec / 3600);
  const m = Math.floor((sec % 3600) / 60);
  const s = sec % 60;
  if (withSec) return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
  if (h) return `${h} 小时 ${m} 分`;
  return `${m} 分钟`;
}

function fmtTime(ts) {
  const d = new Date(ts);
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
}

function openModal(html, onMount) {
  $('#modal-box').innerHTML = html;
  $('#modal').classList.remove('hidden');
  onMount && onMount($('#modal-box'));
}
function closeModal() {
  $('#modal').classList.add('hidden');
  $('#modal-box').innerHTML = '';
}
$('#modal').addEventListener('mousedown', (e) => {
  if (e.target.id === 'modal') closeModal();
});

// ---------------- navigation ----------------
function showView(name) {
  document.querySelectorAll('#sidebar button').forEach((b) => b.classList.toggle('active', b.dataset.view === name));
  document.querySelectorAll('.view').forEach((v) => v.classList.toggle('active', v.id === `view-${name}`));
  if (name === 'stats') renderStats();
  if (name === 'files') renderFileRoots();
  if (name === 'settings') renderSettings();
}
document.querySelectorAll('#sidebar button').forEach((b) => b.addEventListener('click', () => showView(b.dataset.view)));

// ---------------- focus panel ----------------
const MODE_LABEL = { idle: '未在学习', focus: '专注中', rest: '休息中', research: '查资料 / 看网课' };

function renderFocus() {
  const f = S.focus;
  const p = $('#focus-panel');
  let html = `<span class="mode-pill ${f.mode}">${MODE_LABEL[f.mode]}</span>`;
  if (f.mode === 'idle') {
    html += `<button id="btn-start" class="primary">▶ 开始学习</button>`;
  } else {
    html += `<span class="timer" id="timer"></span>`;
    if (f.mode === 'focus') {
      html += `<div class="dropdown"><button id="btn-rest">☕ 休息 ▾</button><div class="dropdown-menu hidden" id="rest-menu">${(f.restChoices || [5, 10, 20])
        .map((m) => `<button data-rest="${m}">休息 ${m} 分钟</button>`)
        .join('')}</div></div>`;
      html += `<button id="btn-research">🔎 查资料 / 看网课</button>`;
    } else {
      html += `<button id="btn-resume" class="primary">🎯 回到专注</button>`;
      if (f.mode === 'research') html += `<div class="dropdown"><button id="btn-rest">☕ 休息 ▾</button><div class="dropdown-menu hidden" id="rest-menu">${[5, 10, 20].map((m) => `<button data-rest="${m}">休息 ${m} 分钟</button>`).join('')}</div></div>`;
      if (f.mode === 'rest') html += `<button id="btn-research">🔎 查资料 / 看网课</button>`;
      html += `<button id="btn-stop" class="small danger">结束今天的学习</button>`;
    }
    html += `<button id="btn-extend" class="small" title="修改结束时间">⏰ ${fmtTime(f.focusEndAt)} 结束</button>`;
  }
  p.innerHTML = html;
  $('#btn-start')?.addEventListener('click', openStartDialog);
  $('#btn-rest')?.addEventListener('click', (e) => {
    e.stopPropagation();
    $('#rest-menu').classList.toggle('hidden');
  });
  p.querySelectorAll('[data-rest]').forEach((b) => b.addEventListener('click', () => call('focus:rest', Number(b.dataset.rest))));
  $('#btn-research')?.addEventListener('click', () => call('focus:research'));
  $('#btn-resume')?.addEventListener('click', () => call('focus:resume'));
  $('#btn-stop')?.addEventListener('click', () => {
    if (confirm('确定结束今天的学习吗？')) call('focus:stop');
  });
  $('#btn-extend')?.addEventListener('click', () => openStartDialog(true));
  tickTimer();
  const locked = f.mode !== 'idle';
  $('#lock-banner').classList.toggle('hidden', !locked);
  document.querySelectorAll('#view-settings input, #view-settings textarea, #view-settings select, #view-settings button:not(#sync-now)').forEach((el) => {
    if (!el.closest('#sync-card')) el.disabled = locked;
  });
}
document.addEventListener('click', () => $('#rest-menu')?.classList.add('hidden'));

function tickTimer() {
  const f = S.focus;
  const el = $('#timer');
  if (!el) return;
  const now = Date.now();
  if (f.mode === 'focus') el.textContent = `距结束 ${fmtDur((f.focusEndAt - now) / 1000, true)}`;
  else if (f.mode === 'rest') el.textContent = `休息剩余 ${fmtDur((f.restEndAt - now) / 1000, true)}`;
  else if (f.mode === 'research') el.textContent = `已查资料 ${fmtDur((now - (f.current?.start || now)) / 1000, true)}`;
}
setInterval(tickTimer, 1000);

function openStartDialog(extend = false) {
  const now = new Date();
  const def = new Date(extend && S.focus.focusEndAt ? S.focus.focusEndAt : now.getTime() + 2 * 3600000);
  const val = `${String(def.getHours()).padStart(2, '0')}:${String(def.getMinutes()).padStart(2, '0')}`;
  openModal(
    `<h3>${extend ? '修改学习结束时间' : '开始学习 · 进入专注模式'}</h3>
     <div class="form">
       <label>学习到 <input type="time" id="end-time" value="${val}" /></label>
       <div class="quick-times">
         ${[30, 60, 90, 120, 180, 240].map((m) => `<button class="small" data-add="${m}">+${m >= 60 ? m / 60 + ' 小时' : m + ' 分钟'}</button>`).join('')}
         ${['12:00', '18:00', '22:00', '23:30'].map((t) => `<button class="small" data-at="${t}">到 ${t}</button>`).join('')}
       </div>
       <p class="muted" id="end-hint"></p>
       <p class="muted">专注期间：不会弹出知识卡片，配置被锁定。中途离开只能选择「休息（5/10/20 分钟）」或「查资料 / 看网课」。</p>
       <div class="row end"><button id="m-cancel">取消</button><button id="m-ok" class="primary">${extend ? '确定' : '开始专注'}</button></div>
     </div>`,
    (box) => {
      const input = box.querySelector('#end-time');
      const compute = () => {
        const [h, m] = input.value.split(':').map(Number);
        const d = new Date();
        d.setHours(h, m, 0, 0);
        if (d.getTime() <= Date.now()) d.setDate(d.getDate() + 1);
        return d.getTime();
      };
      const hint = () => (box.querySelector('#end-hint').textContent = `将学习 ${fmtDur((compute() - Date.now()) / 1000)}，${new Date(compute()).toLocaleString()} 结束`);
      input.addEventListener('input', hint);
      hint();
      box.querySelectorAll('[data-add]').forEach((b) =>
        b.addEventListener('click', () => {
          const d = new Date(Date.now() + Number(b.dataset.add) * 60000);
          input.value = `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
          hint();
        })
      );
      box.querySelectorAll('[data-at]').forEach((b) =>
        b.addEventListener('click', () => {
          input.value = b.dataset.at;
          hint();
        })
      );
      box.querySelector('#m-cancel').addEventListener('click', closeModal);
      box.querySelector('#m-ok').addEventListener('click', async () => {
        await call(extend ? 'focus:extend' : 'focus:start', compute());
        closeModal();
      });
    }
  );
}

// ---------------- browser ----------------
const web = $('#web');
function normalizeUrl(u) {
  u = u.trim();
  if (!u) return '';
  if (/^[a-zA-Z]:[\\/]/.test(u)) return 'file:///' + u.replace(/\\/g, '/');
  if (!/^[a-z]+:/i.test(u)) u = 'https://' + u;
  return u;
}
async function navigate(u) {
  const url = normalizeUrl(u);
  if (!url) return;
  const r = await call('browse:check', url);
  if (!r.allowed) return showBlocked(url, r.reason);
  $('#blocked-banner').classList.add('hidden');
  $('#web-empty').classList.add('hidden');
  web.loadURL(url).catch(() => {});
}
function showBlocked(url, reason) {
  const b = $('#blocked-banner');
  b.innerHTML = `⛔ 已拦截：${esc(reason)}${S.focus.mode !== 'idle' ? '（学习中无法修改白名单）' : '，可在 设置 → 允许的域名 中添加'}`;
  b.classList.remove('hidden');
  clearTimeout(showBlocked._t);
  showBlocked._t = setTimeout(() => b.classList.add('hidden'), 6000);
}
$('#nav-go').addEventListener('click', () => navigate($('#address').value));
$('#address').addEventListener('keydown', (e) => e.key === 'Enter' && navigate($('#address').value));
$('#nav-back').addEventListener('click', () => web.canGoBack() && web.goBack());
$('#nav-fwd').addEventListener('click', () => web.canGoForward() && web.goForward());
$('#nav-reload').addEventListener('click', () => web.reload());
$('#nav-home').addEventListener('click', () => {
  const s = S.settings;
  navigate(s.homepage || (s.allowedDomains[0] ? `https://${s.allowedDomains[0]}` : ''));
});
web.addEventListener('did-navigate', (e) => ($('#address').value = e.url));
web.addEventListener('did-navigate-in-page', (e) => e.isMainFrame && ($('#address').value = e.url));
web.addEventListener('page-title-updated', (e) => (document.title = `${e.title} - 考研复习助手`));

function renderQuickLinks() {
  $('#quick-links').innerHTML = (S.settings.allowedDomains || []).map((d) => `<span class="chip" data-d="${esc(d)}">${esc(d)}</span>`).join('');
  document.querySelectorAll('#quick-links .chip').forEach((c) => c.addEventListener('click', () => navigate(`https://${c.dataset.d}`)));
}

// ---------------- files ----------------
const TEXT_EXT = /\.(txt|md|markdown|json|csv|log|py|js|ts|c|cpp|h|java|m|tex|yaml|yml|ini|xml)$/i;
const WEB_EXT = /\.(pdf|png|jpe?g|gif|webp|bmp|svg|mp4|webm|mkv|mov|mp3|wav|ogg|m4a|flac|html?)$/i;

function renderFileRoots() {
  const sel = $('#folder-root');
  const folders = S.settings.allowedFolders || [];
  sel.innerHTML = folders.length ? folders.map((f) => `<option value="${esc(f)}">${esc(f)}</option>`).join('') : '<option value="">（未配置文件夹）</option>';
  if (!folders.includes(S.fileRoot)) {
    S.fileRoot = folders[0] || null;
    S.fileDir = S.fileRoot;
  }
  sel.value = S.fileRoot || '';
  loadDir();
}
$('#folder-root').addEventListener('change', (e) => {
  S.fileRoot = e.target.value;
  S.fileDir = S.fileRoot;
  loadDir();
});

async function loadDir() {
  const list = $('#file-list');
  if (!S.fileDir) {
    list.innerHTML = '<li class="muted">请先在设置中添加允许的文件夹</li>';
    $('#breadcrumb').innerHTML = '';
    return;
  }
  let items;
  try {
    items = await api.call('files:list', S.fileDir);
  } catch (e) {
    list.innerHTML = `<li class="muted">${esc(e.message)}</li>`;
    return;
  }
  const rel = S.fileDir.slice(S.fileRoot.length).split(/[\\/]/).filter(Boolean);
  const sep = api.platform === 'win32' ? '\\' : '/';
  let acc = S.fileRoot;
  const crumbs = [`<a data-p="${esc(S.fileRoot)}">${esc(S.fileRoot.split(/[\\/]/).filter(Boolean).pop() || S.fileRoot)}</a>`];
  for (const r of rel) {
    acc = acc.replace(/[\\/]$/, '') + sep + r;
    crumbs.push(`<a data-p="${esc(acc)}">${esc(r)}</a>`);
  }
  $('#breadcrumb').innerHTML = crumbs.join(' / ');
  $('#breadcrumb').querySelectorAll('a').forEach((a) => a.addEventListener('click', () => ((S.fileDir = a.dataset.p), loadDir())));
  list.innerHTML =
    (S.fileDir !== S.fileRoot ? `<li data-up="1">⬆️ 上一级</li>` : '') +
    items.map((it, i) => `<li data-i="${i}">${it.dir ? '📁' : fileIcon(it.name)} <span>${esc(it.name)}</span></li>`).join('');
  list.querySelector('[data-up]')?.addEventListener('click', () => {
    S.fileDir = S.fileDir.replace(/[\\/][^\\/]+[\\/]?$/, '');
    if (S.fileDir.length < S.fileRoot.length) S.fileDir = S.fileRoot;
    loadDir();
  });
  list.querySelectorAll('[data-i]').forEach((li) =>
    li.addEventListener('click', () => {
      const it = items[Number(li.dataset.i)];
      if (it.dir) {
        S.fileDir = it.path;
        loadDir();
      } else previewFile(it);
    })
  );
}

function fileIcon(n) {
  if (/\.pdf$/i.test(n)) return '📕';
  if (/\.(png|jpe?g|gif|webp|bmp|svg)$/i.test(n)) return '🖼️';
  if (/\.(mp4|webm|mkv|mov)$/i.test(n)) return '🎬';
  if (/\.(mp3|wav|ogg|m4a|flac)$/i.test(n)) return '🎵';
  if (/\.(md|markdown)$/i.test(n)) return '📝';
  return '📄';
}

async function previewFile(it) {
  $('#preview-title').textContent = it.name;
  ['#preview-md', '#preview-text', '#file-web', '#preview-empty'].forEach((s) => $(s).classList.add('hidden'));
  if (/\.(md|markdown)$/i.test(it.name)) {
    const txt = await call('files:read', it.path);
    $('#preview-md').innerHTML = renderMarkdown(txt);
    $('#preview-md').classList.remove('hidden');
  } else if (TEXT_EXT.test(it.name)) {
    $('#preview-text').textContent = await call('files:read', it.path);
    $('#preview-text').classList.remove('hidden');
  } else if (WEB_EXT.test(it.name)) {
    const url = await call('files:toUrl', it.path);
    const fw = $('#file-web');
    fw.classList.remove('hidden');
    fw.loadURL(url).catch(() => {});
  } else {
    $('#preview-empty').textContent = '该文件类型暂不支持预览';
    $('#preview-empty').classList.remove('hidden');
  }
}

// ---------------- knowledge ----------------
async function loadKnowledge() {
  S.knowledge = await api.call('knowledge:get');
  renderModules();
}

function liveMods() {
  return S.knowledge.modules.filter((m) => !m.deleted);
}

function renderModules() {
  const mods = liveMods();
  if (!mods.find((m) => m.id === S.activeModuleId)) S.activeModuleId = mods[0]?.id || null;
  $('#module-list').innerHTML = mods
    .map((m) => {
      const n = m.entries.filter((e) => !e.deleted).length;
      return `<li data-id="${m.id}" class="${m.id === S.activeModuleId ? 'active' : ''}">
        <input type="checkbox" data-toggle="${m.id}" ${m.enabled ? 'checked' : ''} title="是否参与弹窗" />
        <span class="name">${esc(m.name)}</span><span class="count">${n}</span></li>`;
    })
    .join('');
  $('#module-list').querySelectorAll('li').forEach((li) =>
    li.addEventListener('click', (e) => {
      if (e.target.matches('input')) return;
      S.activeModuleId = li.dataset.id;
      renderModules();
    })
  );
  $('#module-list').querySelectorAll('[data-toggle]').forEach((cb) =>
    cb.addEventListener('change', async () => {
      await call('knowledge:saveModule', { id: cb.dataset.toggle, enabled: cb.checked });
      await loadKnowledge();
    })
  );
  renderEntries();
}

function renderEntries() {
  const m = liveMods().find((x) => x.id === S.activeModuleId);
  $('#mod-title').textContent = m ? `${m.name}${m.description ? ' · ' + m.description : ''}` : '请选择模块';
  const q = $('#entry-search').value.trim().toLowerCase();
  const entries = m ? m.entries.filter((e) => !e.deleted && (!q || (e.title + e.content).toLowerCase().includes(q))) : [];
  $('#entry-list').innerHTML = entries.length
    ? entries
        .map(
          (e) => `<div class="entry-card"><h4><span>${esc(e.title)}</span><span class="ops"><button class="small" data-edit="${e.id}">编辑</button> <button class="small danger" data-del="${e.id}">删除</button></span></h4>
          <div class="markdown-body">${renderMarkdown(e.content)}</div></div>`
        )
        .join('')
    : `<div class="muted">${m ? '还没有条目，点击右上角添加' : ''}</div>`;
  $('#entry-list').querySelectorAll('[data-edit]').forEach((b) => b.addEventListener('click', () => editEntry(m, m.entries.find((e) => e.id === b.dataset.edit))));
  $('#entry-list').querySelectorAll('[data-del]').forEach((b) =>
    b.addEventListener('click', async () => {
      if (!confirm('删除这个条目？')) return;
      await call('knowledge:deleteEntry', m.id, b.dataset.del);
      await loadKnowledge();
    })
  );
}
$('#entry-search').addEventListener('input', renderEntries);

function editEntry(m, e) {
  if (!m) return toast('请先选择或新建模块', true);
  const isNew = !e;
  e = e || { title: '', content: '' };
  openModal(
    `<h3>${isNew ? '添加条目' : '编辑条目'} · ${esc(m.name)}</h3>
    <div class="form">
      <input id="e-title" placeholder="标题，例如：泊松分布" value="${esc(e.title)}" />
      <div class="editor-split">
        <textarea id="e-content" placeholder="支持 Markdown 与 LaTeX，例如：\n期望 $E(X)=\\lambda$，方差 $D(X)=\\lambda$">${esc(e.content)}</textarea>
        <div class="markdown-body" id="e-preview"></div>
      </div>
      <div class="row end"><button id="m-cancel">取消</button><button id="m-ok" class="primary">保存</button></div>
    </div>`,
    (box) => {
      const ta = box.querySelector('#e-content');
      const upd = () => (box.querySelector('#e-preview').innerHTML = renderMarkdown(ta.value));
      ta.addEventListener('input', upd);
      upd();
      box.querySelector('#m-cancel').addEventListener('click', closeModal);
      box.querySelector('#m-ok').addEventListener('click', async () => {
        const title = box.querySelector('#e-title').value.trim();
        if (!title) return toast('标题不能为空', true);
        await call('knowledge:saveEntry', m.id, { id: e.id, title, content: ta.value });
        closeModal();
        await loadKnowledge();
      });
    }
  );
}

function editModule(m) {
  const isNew = !m;
  m = m || { name: '', description: '' };
  openModal(
    `<h3>${isNew ? '新建知识模块' : '编辑模块'}</h3>
    <div class="form">
      <input id="m-name" placeholder="模块名称，例如：线性代数" value="${esc(m.name)}" />
      <input id="m-desc" placeholder="描述（可选）" value="${esc(m.description)}" />
      <div class="row end">${isNew ? '' : '<button id="m-del" class="danger">删除模块</button><span class="grow"></span>'}<button id="m-cancel">取消</button><button id="m-ok" class="primary">保存</button></div>
    </div>`,
    (box) => {
      box.querySelector('#m-cancel').addEventListener('click', closeModal);
      box.querySelector('#m-del')?.addEventListener('click', async () => {
        if (!confirm(`删除模块「${m.name}」及其全部条目？`)) return;
        await call('knowledge:deleteModule', m.id);
        closeModal();
        await loadKnowledge();
      });
      box.querySelector('#m-ok').addEventListener('click', async () => {
        const name = box.querySelector('#m-name').value.trim();
        if (!name) return toast('名称不能为空', true);
        const saved = await call('knowledge:saveModule', { id: m.id, name, description: box.querySelector('#m-desc').value.trim() });
        S.activeModuleId = saved.id;
        closeModal();
        await loadKnowledge();
      });
    }
  );
}
$('#mod-add').addEventListener('click', () => editModule(null));
$('#mod-edit').addEventListener('click', () => editModule(liveMods().find((x) => x.id === S.activeModuleId)));
$('#entry-add').addEventListener('click', () => editEntry(liveMods().find((x) => x.id === S.activeModuleId), null));
$('#popup-test').addEventListener('click', () => call('popup:test'));
$('#kn-export').addEventListener('click', async () => {
  const p = await call('knowledge:export');
  if (p) toast(`已导出到 ${p}`);
});
$('#kn-import').addEventListener('click', async () => {
  const n = await call('knowledge:import');
  if (n) toast(`已导入 ${n} 个条目`);
  await loadKnowledge();
});
$('#kn-restore').addEventListener('click', async () => {
  await call('knowledge:restoreBuiltin');
  toast('内置模块已恢复');
  await loadKnowledge();
});

// ---------------- stats ----------------
async function renderStats() {
  const [today, week] = await Promise.all([api.call('stats:today'), api.call('stats:week', S.weekTs)]);
  const goal = (S.settings.dailyGoalMin || 0) * 60;
  const t = today.totals;
  const pct = goal ? Math.min(100, Math.round((t.study / goal) * 100)) : 0;
  $('#today-cards').innerHTML = `
    <div class="card"><div class="muted">今日学习</div><div class="stat-num">${fmtDur(t.study)}</div>${goal ? `<div class="progress"><div style="width:${pct}%"></div></div><div class="muted">目标 ${fmtDur(goal)} · ${pct}%</div>` : ''}</div>
    <div class="card"><div class="muted">其中专注</div><div class="stat-num">${fmtDur(t.focus)}</div></div>
    <div class="card"><div class="muted">查资料 / 网课</div><div class="stat-num">${fmtDur(t.research)}</div></div>
    <div class="card"><div class="muted">今日休息</div><div class="stat-num">${fmtDur(t.rest)}</div></div>`;
  const days = week.days;
  const end = new Date(days[6].date);
  $('#week-label').textContent = `${days[0].date} ~ ${days[6].date} · 共学习 ${fmtDur(week.totalStudySec)} · 日均 ${fmtDur(week.totalStudySec / 7)}`;
  $('#week-next').disabled = end.getTime() >= new Date(new Date().toDateString()).getTime();
  $('#week-chart').innerHTML = weekChart(days, goal);
  $('#session-list').innerHTML =
    today.sessions
      .slice()
      .reverse()
      .map((s) => `<li><span class="tag ${s.type}">${MODE_LABEL[s.type]}</span><span>${fmtTime(s.start)} – ${!s.open ? fmtTime(s.end) : '进行中'}</span><span class="muted">${fmtDur(((s.end || Date.now()) - s.start) / 1000)}</span></li>`)
      .join('') || '<li class="muted">今天还没有学习记录</li>';
}

function weekChart(days, goalSec) {
  const W = 900;
  const H = 300;
  const padL = 50;
  const padB = 40;
  const padT = 16;
  const maxSec = Math.max(goalSec, ...days.map((d) => d.study + d.rest), 3600);
  const maxH = Math.ceil(maxSec / 3600);
  const plotH = H - padB - padT;
  const y = (sec) => H - padB - (sec / (maxH * 3600)) * plotH;
  const bw = (W - padL) / 7;
  const names = ['周一', '周二', '周三', '周四', '周五', '周六', '周日'];
  let g = '';
  for (let h = 0; h <= maxH; h += Math.max(1, Math.ceil(maxH / 6))) {
    g += `<line x1="${padL}" x2="${W}" y1="${y(h * 3600)}" y2="${y(h * 3600)}" stroke="currentColor" stroke-opacity=".1"/><text x="${padL - 8}" y="${y(h * 3600) + 4}" text-anchor="end">${h}h</text>`;
  }
  days.forEach((d, i) => {
    const x = padL + i * bw + bw * 0.2;
    const w = bw * 0.6;
    let acc = 0;
    for (const [k, color] of [['focus', 'var(--focus)'], ['research', 'var(--research)'], ['rest', 'var(--rest)']]) {
      const v = d[k];
      if (!v) continue;
      g += `<rect x="${x}" y="${y(acc + v)}" width="${w}" height="${y(acc) - y(acc + v)}" fill="${color}" rx="3"><title>${names[i]} ${k === 'focus' ? '专注' : k === 'research' ? '查资料/网课' : '休息'} ${fmtDur(v)}</title></rect>`;
      acc += v;
    }
    g += `<text x="${x + w / 2}" y="${H - padB + 16}" text-anchor="middle">${names[i]}</text><text x="${x + w / 2}" y="${H - padB + 32}" text-anchor="middle">${d.study ? (d.study / 3600).toFixed(1) + 'h' : '-'}</text>`;
  });
  if (goalSec) g += `<line x1="${padL}" x2="${W}" y1="${y(goalSec)}" y2="${y(goalSec)}" stroke="var(--danger)" stroke-dasharray="6 4"/>`;
  return `<svg viewBox="0 0 ${W} ${H}" preserveAspectRatio="none">${g}</svg>`;
}
$('#week-prev').addEventListener('click', () => ((S.weekTs -= 7 * 86400000), renderStats()));
$('#week-next').addEventListener('click', () => ((S.weekTs += 7 * 86400000), renderStats()));
setInterval(() => $('#view-stats').classList.contains('active') && renderStats(), 30000);

// ---------------- settings ----------------
let draftFolders = [];
function renderSettings() {
  const s = S.settings;
  $('#set-domains').value = (s.allowedDomains || []).join('\n');
  $('#set-homepage').value = s.homepage || '';
  draftFolders = [...(s.allowedFolders || [])];
  renderFolderList();
  $('#set-proxy-mode').value = s.proxyMode || (s.useSystemProxy ? 'system' : 'direct');
  $('#set-proxy-url').value = s.proxyUrl || '';
  $('#set-popup').checked = !!s.popupEnabled;
  $('#set-pi-idle').value = s.popupIntervalIdleMin;
  $('#set-pi-rest').value = s.popupIntervalRestMin;
  $('#set-pdur').value = s.popupDurationSec;
  $('#set-goal').value = s.dailyGoalMin;
  $('#set-clientid').value = s.githubClientId || '';
  const sel = new Set(s.popupModuleIds || []);
  $('#set-popup-mods').innerHTML = liveMods()
    .map((m) => `<span class="chip ${sel.size === 0 || sel.has(m.id) ? 'on' : ''}" data-id="${m.id}">${esc(m.name)}</span>`)
    .join('');
  $('#set-popup-mods').querySelectorAll('.chip').forEach((c) => c.addEventListener('click', () => S.focus.mode === 'idle' && c.classList.toggle('on')));
  $('#data-dir').textContent = `数据目录：${S.dataDir}`;
  renderSync();
  renderFocus();
}
function renderFolderList() {
  $('#set-folders').innerHTML = draftFolders.map((f, i) => `<li><span>${esc(f)}</span><button class="small danger" data-rm="${i}">移除</button></li>`).join('') || '<li class="muted">未配置</li>';
  $('#set-folders').querySelectorAll('[data-rm]').forEach((b) => b.addEventListener('click', () => (draftFolders.splice(Number(b.dataset.rm), 1), renderFolderList())));
}
$('#set-folder-add').addEventListener('click', async () => {
  const picked = await call('settings:pickFolder');
  for (const p of picked) if (!draftFolders.includes(p)) draftFolders.push(p);
  renderFolderList();
});
$('#set-save').addEventListener('click', async () => {
  const chips = [...document.querySelectorAll('#set-popup-mods .chip')];
  const on = chips.filter((c) => c.classList.contains('on')).map((c) => c.dataset.id);
  const s = await call('settings:save', {
    allowedDomains: $('#set-domains').value.split(/[\n,，\s]+/).filter(Boolean),
    homepage: $('#set-homepage').value.trim(),
    allowedFolders: draftFolders,
    proxyMode: $('#set-proxy-mode').value,
    useSystemProxy: $('#set-proxy-mode').value === 'system',
    proxyUrl: $('#set-proxy-url').value.trim(),
    popupEnabled: $('#set-popup').checked,
    popupIntervalIdleMin: Number($('#set-pi-idle').value) || 15,
    popupIntervalRestMin: Number($('#set-pi-rest').value) || 3,
    popupDurationSec: Number($('#set-pdur').value) || 0,
    popupModuleIds: on.length === chips.length ? [] : on,
    dailyGoalMin: Number($('#set-goal').value) || 0,
    githubClientId: $('#set-clientid').value.trim(),
  });
  S.settings = s;
  renderQuickLinks();
  renderSettings();
  toast('设置已保存');
});

// ---------------- sync ----------------
function renderSync() {
  const i = S.sync;
  if (!i) return;
  const st = i.status || {};
  const stText = { idle: '', syncing: '同步中…', ok: `已同步 ${st.lastSyncAt ? new Date(st.lastSyncAt).toLocaleString() : ''}`, error: `同步失败：${st.error}` }[st.state] || '';
  $('#sync-info').innerHTML = i.loggedIn
    ? `${i.user?.avatar ? `<img src="${esc(i.user.avatar)}" />` : ''} 已登录 <b>${esc(i.user?.login || '')}</b> <span class="muted">${esc(stText)}</span>${i.gistId ? ` <a class="muted" href="#" id="gist-link">查看 Gist</a>` : ''}`
    : `<span class="muted">未登录，数据仅保存在本机。${st.state === 'error' ? esc(stText) : ''}</span>`;
  $('#gist-link')?.addEventListener('click', (e) => {
    e.preventDefault();
    api.call('app:openExternal', `https://gist.github.com/${i.gistId}`);
  });
  $('#sync-device').classList.toggle('hidden', i.loggedIn);
  $('#sync-token-btn').classList.toggle('hidden', i.loggedIn);
  $('#sync-now').classList.toggle('hidden', !i.loggedIn);
  $('#sync-logout').classList.toggle('hidden', !i.loggedIn);
  $('#sync-badge').textContent = i.loggedIn ? (st.state === 'error' ? '☁️ 同步失败' : st.state === 'syncing' ? '☁️ 同步中…' : '☁️ 已同步') : '💾 本地模式';
  if (i.loggedIn) $('#device-box').classList.add('hidden');
}
$('#sync-badge').addEventListener('click', () => showView('settings'));
$('#sync-device').addEventListener('click', async () => {
  const r = await call('sync:loginDevice');
  const box = $('#device-box');
  box.innerHTML = `浏览器已打开 <b>${esc(r.verificationUri)}</b>，请输入下面的验证码完成授权：<div class="device-code">${esc(r.userCode)}</div><button class="small" id="dev-cancel">取消</button>`;
  box.classList.remove('hidden');
  $('#dev-cancel').addEventListener('click', () => (api.call('sync:cancelDevice'), box.classList.add('hidden')));
});
$('#sync-token-btn').addEventListener('click', () => {
  openModal(
    `<h3>使用 GitHub Personal Access Token 登录</h3>
    <div class="form"><p class="muted">在 GitHub → Settings → Developer settings → Personal access tokens 创建一个只勾选 <code>gist</code> 权限的 token。Token 会用系统加密存储在本机。</p>
    <input id="tok" type="password" placeholder="ghp_... / github_pat_..." />
    <div class="row end"><button id="m-cancel">取消</button><button id="m-ok" class="primary">登录</button></div></div>`,
    (box) => {
      box.querySelector('#m-cancel').addEventListener('click', closeModal);
      box.querySelector('#m-ok').addEventListener('click', async () => {
        S.sync = await call('sync:loginToken', box.querySelector('#tok').value);
        closeModal();
        renderSync();
        toast('登录成功，正在同步');
      });
    }
  );
});
$('#sync-now').addEventListener('click', async () => {
  S.sync = await call('sync:now');
  renderSync();
});
$('#sync-logout').addEventListener('click', async () => {
  if (!confirm('退出 GitHub 登录？本地数据会保留。')) return;
  await call('sync:logout');
  S.sync = await api.call('sync:info');
  renderSync();
});

// ---------------- events ----------------
api.on('focus:state', (f) => {
  S.focus = f;
  renderFocus();
});
api.on('data:changed', async ({ files }) => {
  if (files.includes('settings.json')) {
    const st = await api.call('app:state');
    S.settings = st.settings;
    renderQuickLinks();
    if ($('#view-settings').classList.contains('active')) renderSettings();
  }
  if (files.includes('knowledge.json')) await loadKnowledge();
  if ($('#view-stats').classList.contains('active')) renderStats();
});
api.on('sync:status', (i) => {
  S.sync = i;
  renderSync();
});
api.on('sync:loginError', (msg) => {
  $('#device-box').classList.add('hidden');
  toast(`登录失败：${msg}`, true);
});
api.on('browse:blocked', ({ url, reason }) => showBlocked(url, reason));
api.on('ui:open-start', () => openStartDialog());

// ---------------- init ----------------
(async function init() {
  const st = await api.call('app:state');
  S.focus = st.focus;
  S.settings = st.settings;
  S.sync = st.sync;
  S.dataDir = st.dataDir;
  renderFocus();
  renderQuickLinks();
  renderSync();
  await loadKnowledge();
  if (S.settings.homepage) navigate(S.settings.homepage);
})();
