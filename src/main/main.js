'use strict';
const { app, BrowserWindow, Tray, Menu, ipcMain, session, dialog, shell, screen, nativeImage, net, safeStorage, Notification } = require('electron');
const path = require('path');
const fs = require('fs');
const core = require('../shared/core');
const { builtinModules } = require('../shared/builtin');
const { FocusController } = require('./focus');
const { SyncService } = require('./sync');

const ROOT = path.join(__dirname, '..', '..');
const RENDERER = path.join(ROOT, 'dist', 'renderer');
const ICON = path.join(ROOT, 'assets', 'icon.png');
const BROWSE_PARTITION = 'persist:browse';
// OAuth App client id used for the GitHub device flow. Can be overridden in Settings.
const DEFAULT_CLIENT_ID = (() => {
  try {
    return require('../../assets/oauth.json').clientId || '';
  } catch {
    return process.env.STUDY_HELPER_GITHUB_CLIENT_ID || '';
  }
})();

app.setAppUserModelId('io.github.nannaolympicbroadcast.studyhelper');
if (!app.requestSingleInstanceLock()) {
  app.quit();
  process.exit(0);
}

const store = new core.DataStore();
let focus;
let sync;
let mainWin = null;
let popupWin = null;
let tray = null;
let quitting = false;
let lastPopupAt = Date.now();
const recentEntryIds = [];

// ---------------- data bootstrap ----------------
function bootstrapData() {
  const k = store.getKnowledge();
  core.seedBuiltin(k, builtinModules());
  store.saveKnowledge(k);
  if (!fs.existsSync(store.files.settings)) store.saveSettings(core.DEFAULT_SETTINGS(), { touch: false });
}

function broadcast(channel, payload) {
  for (const w of BrowserWindow.getAllWindows()) if (!w.isDestroyed()) w.webContents.send(channel, payload);
}

function notify(title, body) {
  if (Notification.isSupported()) new Notification({ title, body, icon: ICON }).show();
}

// ---------------- proxy & restrictions ----------------
async function applyProxy() {
  const s = store.getSettings();
  const mode = s.proxyMode || (s.useSystemProxy ? 'system' : 'direct');
  let cfg = { mode: 'system' };
  if (mode === 'direct') cfg = { mode: 'direct' };
  else if (mode === 'custom' && s.proxyUrl) cfg = { mode: 'fixed_servers', proxyRules: s.proxyUrl.trim(), proxyBypassRules: '<local>' };
  await Promise.all([session.defaultSession.setProxy(cfg), session.fromPartition(BROWSE_PARTITION).setProxy(cfg)]);
}

function setupBrowseSession() {
  const ses = session.fromPartition(BROWSE_PARTITION);
  ses.webRequest.onBeforeRequest({ urls: ['<all_urls>'] }, (details, cb) => {
    if (details.resourceType === 'mainFrame' || details.resourceType === 'subFrame') {
      const res = core.urlAllowed(details.url, store.getSettings());
      if (!res.allowed) {
        broadcast('browse:blocked', { url: details.url, reason: res.reason });
        return cb({ cancel: true });
      }
    }
    cb({});
  });
  ses.setPermissionRequestHandler((_wc, permission, cb) => cb(['fullscreen', 'clipboard-sanitized-write', 'media'].includes(permission)));
}

app.on('web-contents-created', (_e, contents) => {
  if (contents.getType() === 'webview') {
    const guard = (event, url) => {
      const res = core.urlAllowed(url, store.getSettings());
      if (!res.allowed) {
        event.preventDefault();
        broadcast('browse:blocked', { url, reason: res.reason });
      }
    };
    contents.on('will-navigate', guard);
    contents.on('will-redirect', guard);
    contents.setWindowOpenHandler(({ url }) => {
      const res = core.urlAllowed(url, store.getSettings());
      if (res.allowed) contents.loadURL(url);
      else broadcast('browse:blocked', { url, reason: res.reason });
      return { action: 'deny' };
    });
  } else {
    // App windows never navigate away from the bundled UI.
    contents.on('will-navigate', (event, url) => {
      if (!url.startsWith('file://') || !url.includes('dist/renderer')) event.preventDefault();
    });
    contents.setWindowOpenHandler(({ url }) => {
      if (/^https:\/\/github\.com\//.test(url)) shell.openExternal(url);
      return { action: 'deny' };
    });
  }
  contents.on('will-attach-webview', (_ev, webPreferences, params) => {
    delete webPreferences.preload;
    webPreferences.nodeIntegration = false;
    webPreferences.contextIsolation = true;
    webPreferences.plugins = true; // PDF viewer
    params.partition = BROWSE_PARTITION;
  });
});

// ---------------- windows ----------------
function createMainWindow() {
  mainWin = new BrowserWindow({
    width: 1280,
    height: 820,
    minWidth: 900,
    minHeight: 600,
    title: '考研复习助手',
    icon: ICON,
    backgroundColor: '#f6f7fb',
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      webviewTag: true,
      sandbox: false,
    },
  });
  mainWin.loadFile(path.join(RENDERER, 'index.html'));
  // Focus mode keeps the window fullscreen: leaving fullscreen / minimizing / closing snaps back.
  mainWin.on('leave-full-screen', () => focus && focus.mode === 'focus' && setTimeout(applyFocusFullscreen, 300));
  mainWin.on('minimize', () => focus && focus.mode === 'focus' && setTimeout(applyFocusFullscreen, 300));
  mainWin.on('close', (e) => {
    if (!quitting && focus && focus.mode === 'focus') {
      e.preventDefault();
      applyFocusFullscreen();
      return;
    }
    if (!quitting) {
      e.preventDefault();
      mainWin.hide();
      if (!store.getSyncMeta().trayHintShown) {
        tray && tray.displayBalloon && tray.displayBalloon({ title: '考研复习助手', content: '已收到托盘，右键托盘图标可退出' });
        const m = store.getSyncMeta();
        m.trayHintShown = true;
        store.saveSyncMeta(m);
      }
    }
  });
}

function applyFocusFullscreen() {
  if (!mainWin || mainWin.isDestroyed()) return;
  const on = focus.mode === 'focus';
  if (on) {
    if (!mainWin.isVisible()) mainWin.show();
    if (mainWin.isMinimized()) mainWin.restore();
    mainWin.setFullScreen(true);
    mainWin.focus();
  } else if (mainWin.isFullScreen()) {
    mainWin.setFullScreen(false);
  }
}

function showMain() {
  if (!mainWin || mainWin.isDestroyed()) createMainWindow();
  mainWin.show();
  if (mainWin.isMinimized()) mainWin.restore();
  mainWin.focus();
}

function pickEntry() {
  const s = store.getSettings();
  const mods = core.liveModules(store.getKnowledge()).filter((m) => m.enabled && (!s.popupModuleIds.length || s.popupModuleIds.includes(m.id)));
  const pool = [];
  for (const m of mods) for (const e of m.entries) pool.push({ module: { id: m.id, name: m.name }, entry: e });
  if (!pool.length) return null;
  let candidates = pool.filter((p) => !recentEntryIds.includes(p.entry.id));
  if (!candidates.length) candidates = pool;
  const pick = candidates[Math.floor(Math.random() * candidates.length)];
  recentEntryIds.push(pick.entry.id);
  while (recentEntryIds.length > Math.min(30, Math.floor(pool.length / 2))) recentEntryIds.shift();
  return { ...pick, total: pool.length };
}

function showPopup(item = pickEntry()) {
  if (!item) return false;
  lastPopupAt = Date.now();
  const wa = screen.getPrimaryDisplay().workArea;
  const W = 420;
  const H = 260;
  if (!popupWin || popupWin.isDestroyed()) {
    popupWin = new BrowserWindow({
      width: W,
      height: H,
      x: wa.x + wa.width - W - 16,
      y: wa.y + wa.height - H - 16,
      frame: false,
      resizable: false,
      skipTaskbar: true,
      alwaysOnTop: true,
      show: false,
      focusable: true,
      icon: ICON,
      backgroundColor: '#ffffff',
      webPreferences: { preload: path.join(__dirname, 'preload.js'), contextIsolation: true, nodeIntegration: false },
    });
    popupWin.setAlwaysOnTop(true, 'screen-saver');
    popupWin.loadFile(path.join(RENDERER, 'popup.html'));
    popupWin.webContents.once('did-finish-load', () => {
      popupWin.webContents.send('popup:entry', { item, durationSec: store.getSettings().popupDurationSec });
      popupWin.showInactive();
    });
  } else {
    popupWin.webContents.send('popup:entry', { item, durationSec: store.getSettings().popupDurationSec });
    popupWin.showInactive();
  }
  return true;
}

function resizePopup(h) {
  if (!popupWin || popupWin.isDestroyed()) return;
  const wa = screen.getPrimaryDisplay().workArea;
  const W = 420;
  const H = Math.max(140, Math.min(Math.ceil(h), Math.floor(wa.height * 0.8)));
  popupWin.setBounds({ x: wa.x + wa.width - W - 16, y: wa.y + wa.height - H - 16, width: W, height: H });
}

function popupTick() {
  const s = store.getSettings();
  if (!s.popupEnabled) return;
  const mode = focus.mode;
  if (mode === 'focus') return;
  const intervalMin = mode === 'rest' ? s.popupIntervalRestMin : s.popupIntervalIdleMin;
  if (!intervalMin || intervalMin <= 0) return;
  if (popupWin && !popupWin.isDestroyed() && popupWin.isVisible()) return;
  if (Date.now() - lastPopupAt >= intervalMin * 60000) showPopup();
}

// ---------------- tray ----------------
function trayIcon() {
  const img = nativeImage.createFromPath(ICON);
  return img.isEmpty() ? img : img.resize({ width: 16, height: 16 });
}

const MODE_LABEL = { idle: '未在学习', focus: '专注中', rest: '休息中', research: '查资料/看网课' };

function updateTray() {
  if (!tray) return;
  const snap = focus.snapshot();
  const items = [
    { label: `状态：${MODE_LABEL[snap.mode]}`, enabled: false },
    { type: 'separator' },
    { label: '打开主界面', click: showMain },
    { label: '来一张速记卡片', click: () => showPopup() },
  ];
  if (snap.mode === 'focus') {
    items.push({ label: '休息', submenu: [5, 10, 20].map((m) => ({ label: `${m} 分钟`, click: () => safe(() => focus.takeRest(m)) })) });
    items.push({ label: '查资料 / 看网课', click: () => safe(() => focus.startResearch()) });
  } else if (snap.mode === 'rest' || snap.mode === 'research') {
    items.push({ label: '回到专注', click: () => safe(() => focus.resumeFocus()) });
  } else {
    items.push({ label: '开始学习…', click: () => { showMain(); broadcast('ui:open-start', {}); } });
  }
  items.push({ type: 'separator' }, { label: '退出', click: () => requestQuit() });
  tray.setContextMenu(Menu.buildFromTemplate(items));
  tray.setToolTip(`考研复习助手 · ${MODE_LABEL[snap.mode]}`);
}

function safe(fn) {
  try {
    fn();
  } catch (e) {
    notify('考研复习助手', e.message);
  }
}

async function requestQuit() {
  if (focus.mode !== 'idle') {
    const { response } = await dialog.showMessageBox({
      type: 'warning',
      buttons: ['继续学习', '仍然退出'],
      defaultId: 0,
      cancelId: 0,
      title: '正在学习中',
      message: '你还在学习中，确定要退出吗？本段学习记录会被保存。',
    });
    if (response !== 1) return;
    focus._closeCurrent();
    focus.state.mode = 'idle';
    focus.state.focusEndAt = null;
    focus.state.restEndAt = null;
    store.saveState(focus.state);
  }
  quitting = true;
  try {
    await Promise.race([sync.syncNow(), new Promise((r) => setTimeout(r, 4000))]);
  } catch {}
  app.quit();
}

// ---------------- data watcher (changes from MCP server / other process) ----------------
function watchData() {
  let t = null;
  const pending = new Set();
  try {
    fs.watch(store.dir, (_ev, file) => {
      if (!file || !/^(settings|knowledge|stats|state)\.json$/.test(file)) return;
      pending.add(file);
      clearTimeout(t);
      t = setTimeout(() => {
        const files = [...pending];
        pending.clear();
        if (files.includes('state.json')) {
          const disk = store.getState();
          // Another process (MCP) changed focus state.
          if (disk.mode !== focus.state.mode || disk.focusEndAt !== focus.state.focusEndAt) {
            focus.state = disk;
            focus.emit('change', focus.snapshot());
          }
        }
        if (files.some((f) => f !== 'state.json')) {
          broadcast('data:changed', { files });
          if (files.includes('settings.json')) applyProxy().catch(() => {});
          sync.schedule();
        }
      }, 400);
    });
  } catch (e) {
    console.error('watch failed', e);
  }
}

// ---------------- IPC ----------------
function handle(channel, fn) {
  ipcMain.handle(channel, async (_e, ...args) => {
    try {
      return { ok: true, data: await fn(...args) };
    } catch (e) {
      return { ok: false, error: e.message || String(e) };
    }
  });
}

function assertUnlocked() {
  if (focus.isLocked()) throw new Error('学习中配置已锁定，结束学习后才能修改设置');
}

function listDir(dir) {
  const s = store.getSettings();
  if (!core.pathAllowed(dir, s.allowedFolders)) throw new Error('该路径不在允许的文件夹内');
  const entries = fs.readdirSync(dir, { withFileTypes: true });
  return entries
    .filter((d) => !d.name.startsWith('.'))
    .map((d) => {
      const full = path.join(dir, d.name);
      let size = 0;
      let mtime = 0;
      try {
        const st = fs.statSync(full);
        size = st.size;
        mtime = st.mtimeMs;
      } catch {}
      return { name: d.name, path: full, dir: d.isDirectory(), size, mtime };
    })
    .sort((a, b) => (a.dir === b.dir ? a.name.localeCompare(b.name, 'zh') : a.dir ? -1 : 1));
}

function registerIpc() {
  handle('app:state', () => ({
    focus: focus.snapshot(),
    settings: store.getSettings(),
    sync: sync.info(),
    version: app.getVersion(),
    dataDir: store.dir,
  }));

  handle('settings:save', async (s) => {
    assertUnlocked();
    const cur = store.getSettings();
    const next = store.saveSettings({ ...cur, ...s });
    await applyProxy();
    broadcast('data:changed', { files: ['settings.json'] });
    sync.schedule();
    return next;
  });
  handle('settings:pickFolder', async () => {
    assertUnlocked();
    const r = await dialog.showOpenDialog(mainWin, { properties: ['openDirectory', 'multiSelections'] });
    return r.canceled ? [] : r.filePaths;
  });

  handle('focus:start', (endAt) => focus.startFocus(endAt));
  handle('focus:rest', (m) => focus.takeRest(m));
  handle('focus:research', () => focus.startResearch());
  handle('focus:resume', () => focus.resumeFocus());
  handle('focus:stop', () => focus.stop());
  handle('focus:extend', (endAt) => focus.extendFocus(endAt));

  handle('browse:check', (url) => core.urlAllowed(url, store.getSettings()));
  handle('files:list', (dir) => listDir(dir));
  handle('files:read', (p) => {
    const s = store.getSettings();
    if (!core.pathAllowed(p, s.allowedFolders)) throw new Error('该路径不在允许的文件夹内');
    const st = fs.statSync(p);
    if (st.size > 5 * 1024 * 1024) throw new Error('文件过大（>5MB），无法以文本预览');
    return fs.readFileSync(p, 'utf8');
  });
  handle('files:toUrl', (p) => {
    const s = store.getSettings();
    if (!core.pathAllowed(p, s.allowedFolders)) throw new Error('该路径不在允许的文件夹内');
    return require('url').pathToFileURL(p).href;
  });

  handle('knowledge:get', () => store.getKnowledge());
  handle('knowledge:saveModule', (m) => {
    const k = store.getKnowledge();
    const now = Date.now();
    let mod = k.modules.find((x) => x.id === m.id);
    if (!mod) {
      mod = core.newModule({ name: m.name || '未命名模块', description: m.description || '' });
      k.modules.push(mod);
    } else {
      Object.assign(mod, { name: m.name ?? mod.name, description: m.description ?? mod.description, enabled: m.enabled ?? mod.enabled, updatedAt: now });
    }
    store.saveKnowledge(k);
    sync.schedule();
    return mod;
  });
  handle('knowledge:deleteModule', (id) => {
    const k = store.getKnowledge();
    const mod = k.modules.find((x) => x.id === id);
    if (mod) {
      mod.deleted = true;
      mod.updatedAt = Date.now();
      store.saveKnowledge(k);
      sync.schedule();
    }
    return true;
  });
  handle('knowledge:saveEntry', (moduleId, e) => {
    const k = store.getKnowledge();
    const mod = k.modules.find((x) => x.id === moduleId && !x.deleted);
    if (!mod) throw new Error('模块不存在');
    let ent = mod.entries.find((x) => x.id === e.id);
    if (!ent) {
      ent = core.newEntry({ title: e.title, content: e.content, tags: e.tags || [] });
      mod.entries.push(ent);
    } else {
      Object.assign(ent, { title: e.title ?? ent.title, content: e.content ?? ent.content, tags: e.tags ?? ent.tags, updatedAt: Date.now(), deleted: false });
    }
    store.saveKnowledge(k);
    sync.schedule();
    return ent;
  });
  handle('knowledge:deleteEntry', (moduleId, entryId) => {
    const k = store.getKnowledge();
    const mod = k.modules.find((x) => x.id === moduleId);
    const ent = mod && mod.entries.find((x) => x.id === entryId);
    if (ent) {
      ent.deleted = true;
      ent.updatedAt = Date.now();
      store.saveKnowledge(k);
      sync.schedule();
    }
    return true;
  });
  handle('knowledge:restoreBuiltin', () => {
    const k = store.getKnowledge();
    for (const bm of builtinModules()) {
      const m = k.modules.find((x) => x.id === bm.id);
      if (m && m.deleted) {
        m.deleted = false;
        m.updatedAt = Date.now();
      }
      if (m) for (const e of m.entries) if (e.deleted && e.id.startsWith(bm.id)) { e.deleted = false; e.updatedAt = Date.now(); }
    }
    core.seedBuiltin(k, builtinModules());
    store.saveKnowledge(k);
    sync.schedule();
    return true;
  });
  handle('knowledge:export', async () => {
    const r = await dialog.showSaveDialog(mainWin, { defaultPath: 'study-helper-knowledge.json', filters: [{ name: 'JSON', extensions: ['json'] }] });
    if (r.canceled) return false;
    fs.writeFileSync(r.filePath, JSON.stringify({ modules: core.liveModules(store.getKnowledge()) }, null, 2));
    return r.filePath;
  });
  handle('knowledge:import', async () => {
    const r = await dialog.showOpenDialog(mainWin, { filters: [{ name: 'JSON', extensions: ['json'] }], properties: ['openFile'] });
    if (r.canceled) return 0;
    const data = JSON.parse(fs.readFileSync(r.filePaths[0], 'utf8'));
    const mods = Array.isArray(data) ? data : data.modules || [];
    const k = store.getKnowledge();
    let n = 0;
    for (const m of mods) {
      const mod = core.newModule({ name: m.name || '导入模块', description: m.description || '' });
      for (const e of m.entries || []) mod.entries.push(core.newEntry({ title: e.title, content: e.content, tags: e.tags || [] }));
      n += mod.entries.length;
      k.modules.push(mod);
    }
    store.saveKnowledge(k);
    sync.schedule();
    return n;
  });

  handle('stats:week', (ts) => core.weekSummary(focus.sessionsWithCurrent(), ts || Date.now()));
  handle('stats:today', () => {
    const sessions = focus.sessionsWithCurrent();
    const key = core.dateKey(Date.now());
    const totals = core.dailyTotals(sessions)[key] || { focus: 0, research: 0, rest: 0, study: 0 };
    const today = sessions.filter((s) => core.dateKey(s.end || Date.now()) === key || core.dateKey(s.start) === key);
    return { date: key, totals, sessions: today.slice(-50) };
  });

  handle('sync:info', () => sync.info());
  handle('sync:loginDevice', async () => {
    const r = await sync.startDeviceLogin();
    shell.openExternal(r.verificationUri);
    return r;
  });
  handle('sync:cancelDevice', () => sync.cancelDeviceLogin());
  handle('sync:loginToken', (t) => sync.loginWithToken(t));
  handle('sync:logout', () => sync.logout());
  handle('sync:now', () => sync.syncNow());

  handle('popup:test', () => {
    if (!showPopup()) throw new Error('没有可展示的知识条目（检查知识模块是否启用）');
    return true;
  });
  handle('popup:next', () => showPopup());
  handle('popup:close', () => {
    if (popupWin && !popupWin.isDestroyed()) popupWin.hide();
    lastPopupAt = Date.now();
  });
  handle('popup:resize', (h) => resizePopup(h));
  handle('app:openExternal', (url) => {
    if (/^https:\/\/(github\.com|gist\.github\.com)\//.test(url)) shell.openExternal(url);
  });
}

// ---------------- lifecycle ----------------
app.on('second-instance', showMain);
app.on('before-quit', () => {
  quitting = true;
});
app.on('window-all-closed', (e) => e.preventDefault());

app.whenReady().then(async () => {
  bootstrapData();
  focus = new FocusController(store);
  sync = new SyncService({
    store,
    focus,
    fetch: (url, opts) => net.fetch(url, opts),
    safeStorage,
    defaultClientId: DEFAULT_CLIENT_ID,
    onDataChanged: (changed) => {
      broadcast('data:changed', { files: Object.keys(changed).filter((k) => changed[k]).map((k) => `${k}.json`) });
      if (changed.settings) applyProxy().catch(() => {});
    },
  });
  await applyProxy().catch(() => {});
  setupBrowseSession();
  registerIpc();

  focus.on('change', (snap) => {
    broadcast('focus:state', snap);
    updateTray();
    applyFocusFullscreen();
  });
  focus.on('session', () => sync.schedule(8000));
  focus.on('restOver', () => notify('休息结束', '回到专注模式，继续加油！'));
  focus.on('finished', ({ reason }) => {
    if (reason === 'completed') notify('学习完成', '已到达设定的学习结束时间，辛苦了！');
  });
  sync.on('status', (info) => broadcast('sync:status', info));
  sync.on('login', (info) => broadcast('sync:status', info));
  sync.on('loginError', (msg) => broadcast('sync:loginError', msg));

  tray = new Tray(trayIcon());
  tray.on('click', showMain);
  updateTray();

  createMainWindow();
  mainWin.once('ready-to-show', applyFocusFullscreen);
  watchData();
  setInterval(popupTick, 15000);
  setInterval(() => sync.syncNow().catch(() => {}), 10 * 60000);
  if (sync.token) {
    sync.fetchUser().catch(() => {});
    setTimeout(() => sync.syncNow().catch(() => {}), 3000);
  }
});

// ---------------- self-test (dev only) ----------------
// STUDY_HELPER_SELFTEST=<output dir>; optional STUDY_HELPER_SELFTEST_STEPS=<json file> with
// [{"js": "...", "wait": ms, "shot": "name", "popup": true, "log": "..."}]
if (process.env.STUDY_HELPER_SELFTEST) {
  const outDir = process.env.STUDY_HELPER_SELFTEST;
  const wait = (ms) => new Promise((r) => setTimeout(r, ms));
  const defaultSteps = ['browser', 'knowledge', 'stats', 'settings', 'files'].map((v) => ({ js: `document.querySelector('[data-view="${v}"]').click()`, wait: 1200, shot: `view-${v}` }));
  app.whenReady().then(async () => {
    fs.mkdirSync(outDir, { recursive: true });
    await wait(2500);
    const steps = process.env.STUDY_HELPER_SELFTEST_STEPS ? JSON.parse(fs.readFileSync(process.env.STUDY_HELPER_SELFTEST_STEPS, 'utf8')) : [...defaultSteps, { popup: true, wait: 2000, shot: 'popup' }];
    const log = [];
    for (const st of steps) {
      try {
        if (st.popup) showPopup();
        if (st.js) log.push({ step: st.log || st.js.slice(0, 60), result: await mainWin.webContents.executeJavaScript(st.js) });
        await wait(st.wait || 500);
        if (st.shot) {
          const win = st.popup || st.shotPopup ? popupWin : mainWin;
          if (win) fs.writeFileSync(path.join(outDir, `${st.shot}.png`), (await win.webContents.capturePage()).toPNG());
        }
      } catch (e) {
        log.push({ step: st.log || st.js, error: e.message });
      }
    }
    fs.writeFileSync(path.join(outDir, 'log.json'), JSON.stringify({ log, state: store.getState(), stats: store.getStats() }, null, 2));
    quitting = true;
    app.exit(0);
  });
}
