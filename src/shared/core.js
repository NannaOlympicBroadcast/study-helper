'use strict';
// Shared logic used by both the Electron main process and the stdio MCP server.
// Keep this file dependency-free (Node built-ins only).

const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');

const APP_DIR_NAME = 'StudyHelper';

function defaultDataDir() {
  if (process.env.STUDY_HELPER_DATA_DIR && process.env.STUDY_HELPER_DATA_DIR.trim()) {
    return path.resolve(process.env.STUDY_HELPER_DATA_DIR.trim());
  }
  let base;
  if (process.platform === 'win32') base = process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming');
  else if (process.platform === 'darwin') base = path.join(os.homedir(), 'Library', 'Application Support');
  else base = process.env.XDG_CONFIG_HOME || path.join(os.homedir(), '.config');
  return path.join(base, APP_DIR_NAME, 'data');
}

function uid(prefix = '') {
  return prefix + crypto.randomBytes(6).toString('hex') + Date.now().toString(36);
}

// ---------- JSON file store ----------

function readJson(file, fallback) {
  try {
    const txt = fs.readFileSync(file, 'utf8');
    return JSON.parse(txt);
  } catch {
    return typeof fallback === 'function' ? fallback() : fallback;
  }
}

function writeJsonAtomic(file, data) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.${Date.now()}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2), 'utf8');
  fs.renameSync(tmp, file);
}

const DEFAULT_SETTINGS = () => ({
  allowedDomains: ['snh48ssr.com', 'netlify.app', 'bilibili.com', 'icourse163.org', 'github.com'],
  allowedFolders: [],
  homepage: '',
  useSystemProxy: true,
  proxyMode: 'system', // system | direct | custom
  proxyUrl: '', // e.g. http://127.0.0.1:7890 when proxyMode = custom
  popupEnabled: true,
  popupIntervalIdleMin: 15,
  popupIntervalRestMin: 3,
  popupDurationSec: 25,
  popupModuleIds: [], // empty = all enabled modules
  dailyGoalMin: 360,
  githubClientId: '',
  updatedAt: 0,
});

const DEFAULT_STATE = () => ({
  mode: 'idle', // idle | focus | rest | research
  focusEndAt: null,
  restEndAt: null,
  current: null, // {id, type, start}
  updatedAt: Date.now(),
});

class DataStore {
  constructor(dir = defaultDataDir()) {
    this.dir = dir;
    fs.mkdirSync(dir, { recursive: true });
    this.files = {
      settings: path.join(dir, 'settings.json'),
      knowledge: path.join(dir, 'knowledge.json'),
      stats: path.join(dir, 'stats.json'),
      state: path.join(dir, 'state.json'),
      sync: path.join(dir, 'sync.json'),
    };
  }

  getSettings() {
    return { ...DEFAULT_SETTINGS(), ...readJson(this.files.settings, {}) };
  }
  saveSettings(s, { touch = true } = {}) {
    const next = { ...DEFAULT_SETTINGS(), ...s };
    if (touch) next.updatedAt = Date.now();
    next.allowedDomains = normalizeDomains(next.allowedDomains);
    writeJsonAtomic(this.files.settings, next);
    return next;
  }

  getKnowledge() {
    const k = readJson(this.files.knowledge, null);
    return k && Array.isArray(k.modules) ? k : { modules: [] };
  }
  saveKnowledge(k) {
    writeJsonAtomic(this.files.knowledge, k);
    return k;
  }
  knowledgeExists() {
    return fs.existsSync(this.files.knowledge);
  }

  getStats() {
    const s = readJson(this.files.stats, null);
    return s && Array.isArray(s.sessions) ? s : { sessions: [] };
  }
  saveStats(s) {
    writeJsonAtomic(this.files.stats, s);
    return s;
  }

  getState() {
    return { ...DEFAULT_STATE(), ...readJson(this.files.state, {}) };
  }
  saveState(s) {
    s.updatedAt = Date.now();
    writeJsonAtomic(this.files.state, s);
    return s;
  }

  getSyncMeta() {
    return readJson(this.files.sync, {});
  }
  saveSyncMeta(m) {
    writeJsonAtomic(this.files.sync, m);
  }
}

// ---------- Domain / folder rules ----------

function normalizeDomain(d) {
  if (!d) return '';
  let s = String(d).trim().toLowerCase();
  s = s.replace(/^[a-z]+:\/\//, ''); // scheme
  s = s.replace(/^\*\.?/, ''); // leading wildcard
  s = s.replace(/^\.+/, '');
  s = s.split(/[/?#]/)[0];
  s = s.replace(/:\d+$/, ''); // port
  return s;
}

function normalizeDomains(list) {
  const out = [];
  for (const d of list || []) {
    const n = normalizeDomain(d);
    if (n && !out.includes(n)) out.push(n);
  }
  return out;
}

function hostAllowed(host, domains) {
  if (!host) return false;
  const h = String(host).toLowerCase().replace(/\.$/, '');
  return normalizeDomains(domains).some((d) => h === d || h.endsWith('.' + d));
}

function samePathOrInside(child, parent) {
  const norm = (p) => {
    let r = path.resolve(p);
    if (process.platform === 'win32') r = r.toLowerCase();
    return r.replace(/[\\/]+$/, '');
  };
  const c = norm(child);
  const p = norm(parent);
  return c === p || c.startsWith(p + path.sep);
}

function pathAllowed(p, folders) {
  return (folders || []).some((f) => f && samePathOrInside(p, f));
}

function fileUrlToPath(u) {
  try {
    const url = new URL(u);
    if (url.protocol !== 'file:') return null;
    let p = decodeURIComponent(url.pathname);
    if (process.platform === 'win32') {
      if (url.host) return `\\\\${url.host}${p.replace(/\//g, '\\')}`;
      p = p.replace(/^\/([a-zA-Z]:)/, '$1');
      p = p.replace(/\//g, '\\');
    }
    return p;
  } catch {
    return null;
  }
}

// Returns {allowed:boolean, reason:string}
function urlAllowed(u, settings) {
  let url;
  try {
    url = new URL(u);
  } catch {
    return { allowed: false, reason: '无效地址' };
  }
  if (['about:', 'data:', 'blob:', 'devtools:', 'chrome-error:'].includes(url.protocol)) {
    return { allowed: true, reason: 'internal' };
  }
  // Chromium's built-in PDF viewer runs as this extension inside a sub-frame.
  if (url.protocol === 'chrome-extension:' && url.hostname === 'mhjfbmdgcfjbbpaeojofohoefgiehjai') {
    return { allowed: true, reason: 'pdf-viewer' };
  }
  if (url.protocol === 'file:') {
    const p = fileUrlToPath(u);
    if (p && pathAllowed(p, settings.allowedFolders)) return { allowed: true, reason: 'folder' };
    return { allowed: false, reason: `本地路径不在允许的文件夹内：${p || u}` };
  }
  if (url.protocol === 'http:' || url.protocol === 'https:') {
    if (hostAllowed(url.hostname, settings.allowedDomains)) return { allowed: true, reason: 'domain' };
    return { allowed: false, reason: `域名未在白名单中：${url.hostname}` };
  }
  return { allowed: false, reason: `不支持的协议：${url.protocol}` };
}

// ---------- Knowledge modules ----------

function newModule({ name, description = '', id, builtin = false, enabled = true }) {
  const now = Date.now();
  return { id: id || uid('m_'), name, description, enabled, builtin, createdAt: now, updatedAt: now, deleted: false, entries: [] };
}

function newEntry({ title = '', content = '', tags = [], id }) {
  const now = Date.now();
  return { id: id || uid('e_'), title, content, tags, createdAt: now, updatedAt: now, deleted: false };
}

function liveModules(k) {
  return (k.modules || []).filter((m) => !m.deleted).map((m) => ({ ...m, entries: (m.entries || []).filter((e) => !e.deleted) }));
}

function lww(a, b) {
  if (!a) return b;
  if (!b) return a;
  return (b.updatedAt || 0) > (a.updatedAt || 0) ? b : a;
}

function mergeKnowledge(local, remote) {
  const byId = new Map();
  for (const m of local.modules || []) byId.set(m.id, { meta: m, entries: new Map((m.entries || []).map((e) => [e.id, e])) });
  for (const m of remote.modules || []) {
    const cur = byId.get(m.id);
    if (!cur) {
      byId.set(m.id, { meta: m, entries: new Map((m.entries || []).map((e) => [e.id, e])) });
      continue;
    }
    cur.meta = lww(cur.meta, m);
    for (const e of m.entries || []) cur.entries.set(e.id, lww(cur.entries.get(e.id), e));
  }
  const modules = [];
  for (const { meta, entries } of byId.values()) {
    const { entries: _ignored, ...rest } = meta;
    modules.push({ ...rest, entries: [...entries.values()] });
  }
  return { modules };
}

function mergeSettings(local, remote) {
  if (!remote) return local;
  return (remote.updatedAt || 0) > (local.updatedAt || 0) ? { ...local, ...remote } : local;
}

function mergeStats(local, remote) {
  const map = new Map();
  for (const s of (local && local.sessions) || []) map.set(s.id, s);
  for (const s of (remote && remote.sessions) || []) if (!map.has(s.id)) map.set(s.id, s);
  return { sessions: [...map.values()].sort((a, b) => a.start - b.start) };
}

// Merge builtin modules into a knowledge object without clobbering user edits.
function seedBuiltin(k, builtinModules) {
  const ids = new Set((k.modules || []).map((m) => m.id));
  for (const bm of builtinModules) {
    if (!ids.has(bm.id)) {
      k.modules.push(JSON.parse(JSON.stringify(bm)));
    } else {
      const m = k.modules.find((x) => x.id === bm.id);
      m.entries = m.entries || [];
      for (const e of bm.entries) {
        const cur = m.entries.find((x) => x.id === e.id);
        if (!cur) m.entries.push(JSON.parse(JSON.stringify(e)));
        // Untouched built-in entries (updatedAt 0) follow the shipped content.
        else if (!cur.updatedAt && !cur.deleted) Object.assign(cur, { title: e.title, content: e.content, tags: e.tags });
      }
      if (!m.updatedAt) Object.assign(m, { name: bm.name, description: bm.description });
    }
  }
  return k;
}

// ---------- Stats ----------

const STUDY_TYPES = new Set(['focus', 'research']);

function dateKey(ts) {
  const d = new Date(ts);
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

function startOfDay(ts) {
  const d = new Date(ts);
  d.setHours(0, 0, 0, 0);
  return d.getTime();
}

// sessions: [{type,start,end}], returns {'YYYY-MM-DD': {focus, research, rest, study}} in seconds
function dailyTotals(sessions, now = Date.now()) {
  const out = {};
  for (const s of sessions) {
    if (!s || !s.start) continue;
    let start = s.start;
    const end = s.end || now;
    while (start < end) {
      const dayEnd = startOfDay(start) + 86400000;
      const segEnd = Math.min(end, dayEnd);
      const key = dateKey(start);
      const rec = (out[key] = out[key] || { focus: 0, research: 0, rest: 0, study: 0 });
      const sec = (segEnd - start) / 1000;
      if (rec[s.type] !== undefined) rec[s.type] += sec;
      if (STUDY_TYPES.has(s.type)) rec.study += sec;
      start = segEnd;
    }
  }
  for (const k of Object.keys(out)) for (const f of Object.keys(out[k])) out[k][f] = Math.round(out[k][f]);
  return out;
}

function weekStart(ts) {
  const d = new Date(startOfDay(ts));
  const dow = (d.getDay() + 6) % 7; // Monday = 0
  d.setDate(d.getDate() - dow);
  return d.getTime();
}

// Returns 7 days (Mon..Sun) of the week containing ts.
function weekSummary(sessions, ts = Date.now(), now = Date.now()) {
  const totals = dailyTotals(sessions, now);
  const ws = weekStart(ts);
  const days = [];
  for (let i = 0; i < 7; i++) {
    const d = new Date(ws);
    d.setDate(d.getDate() + i);
    const key = dateKey(d.getTime());
    days.push({ date: key, ...(totals[key] || { focus: 0, research: 0, rest: 0, study: 0 }) });
  }
  const sum = days.reduce((a, d) => ({ study: a.study + d.study, rest: a.rest + d.rest }), { study: 0, rest: 0 });
  return { weekStart: dateKey(ws), days, totalStudySec: sum.study, totalRestSec: sum.rest };
}

module.exports = {
  APP_DIR_NAME,
  defaultDataDir,
  uid,
  readJson,
  writeJsonAtomic,
  DataStore,
  DEFAULT_SETTINGS,
  DEFAULT_STATE,
  normalizeDomain,
  normalizeDomains,
  hostAllowed,
  pathAllowed,
  fileUrlToPath,
  urlAllowed,
  newModule,
  newEntry,
  liveModules,
  mergeKnowledge,
  mergeSettings,
  mergeStats,
  seedBuiltin,
  dailyTotals,
  weekSummary,
  dateKey,
  STUDY_TYPES,
};
