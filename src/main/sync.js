'use strict';
// GitHub OAuth (device flow or personal access token) + Gist-based sync.
const { EventEmitter } = require('events');
const fs = require('fs');
const path = require('path');
const { mergeKnowledge, mergeSettings, mergeStats } = require('../shared/core');

const GIST_DESCRIPTION = 'StudyHelper sync data (study-helper)';
const FILES = { settings: 'study-helper-settings.json', knowledge: 'study-helper-knowledge.json', stats: 'study-helper-stats.json' };
// Settings that are device-specific and must not be synced.
const LOCAL_ONLY_SETTINGS = ['allowedFolders', 'githubClientId'];

class SyncService extends EventEmitter {
  constructor({ store, fetch, safeStorage, focus, onDataChanged, defaultClientId }) {
    super();
    this.store = store;
    this.fetch = fetch;
    this.safeStorage = safeStorage;
    this.focus = focus;
    this.onDataChanged = onDataChanged;
    this.defaultClientId = defaultClientId || '';
    this.tokenFile = path.join(store.dir, '..', 'auth.bin');
    this.token = this._loadToken();
    this.user = null;
    this.status = { state: 'idle', lastSyncAt: store.getSyncMeta().lastSyncAt || null, error: null };
    this._debounce = null;
    this._running = null;
    this._device = null;
  }

  // ---------- token ----------
  _loadToken() {
    try {
      const buf = fs.readFileSync(this.tokenFile);
      if (this.safeStorage && this.safeStorage.isEncryptionAvailable()) return this.safeStorage.decryptString(buf);
      return buf.toString('utf8');
    } catch {
      return null;
    }
  }
  _saveToken(t) {
    if (!t) {
      try {
        fs.unlinkSync(this.tokenFile);
      } catch {}
      this.token = null;
      return;
    }
    const data = this.safeStorage && this.safeStorage.isEncryptionAvailable() ? this.safeStorage.encryptString(t) : Buffer.from(t, 'utf8');
    fs.mkdirSync(path.dirname(this.tokenFile), { recursive: true });
    fs.writeFileSync(this.tokenFile, data);
    this.token = t;
  }

  clientId() {
    return (this.store.getSettings().githubClientId || '').trim() || this.defaultClientId;
  }

  info() {
    return {
      loggedIn: !!this.token,
      user: this.user,
      clientIdConfigured: !!this.clientId(),
      status: this.status,
      gistId: this.store.getSyncMeta().gistId || null,
    };
  }

  _setStatus(patch) {
    this.status = { ...this.status, ...patch };
    this.emit('status', this.info());
  }

  async _gh(url, opts = {}) {
    const res = await this.fetch(url.startsWith('http') ? url : `https://api.github.com${url}`, {
      ...opts,
      headers: {
        Accept: 'application/vnd.github+json',
        'X-GitHub-Api-Version': '2022-11-28',
        'User-Agent': 'StudyHelper',
        ...(this.token ? { Authorization: `Bearer ${this.token}` } : {}),
        ...(opts.body ? { 'Content-Type': 'application/json' } : {}),
        ...(opts.headers || {}),
      },
    });
    const text = await res.text();
    let json = null;
    try {
      json = text ? JSON.parse(text) : null;
    } catch {}
    if (!res.ok) {
      const err = new Error(`GitHub ${res.status}: ${(json && json.message) || text.slice(0, 200)}`);
      err.status = res.status;
      throw err;
    }
    return json;
  }

  async fetchUser() {
    if (!this.token) return null;
    try {
      const u = await this._gh('/user');
      this.user = { login: u.login, avatar: u.avatar_url, name: u.name };
    } catch (e) {
      if (e.status === 401) {
        this._saveToken(null);
        this.user = null;
      }
      throw e;
    }
    this.emit('status', this.info());
    return this.user;
  }

  async loginWithToken(token) {
    const t = String(token || '').trim();
    if (!t) throw new Error('Token 不能为空');
    const prev = this.token;
    this.token = t;
    try {
      await this.fetchUser();
    } catch (e) {
      this.token = prev;
      throw new Error(`Token 校验失败：${e.message}`);
    }
    this._saveToken(t);
    this.syncNow().catch(() => {});
    return this.info();
  }

  // Device flow step 1
  async startDeviceLogin() {
    const clientId = this.clientId();
    if (!clientId) throw new Error('尚未配置 GitHub OAuth App 的 Client ID（设置 → 云同步），或改用 Personal Access Token 登录');
    const res = await this.fetch('https://github.com/login/device/code', {
      method: 'POST',
      headers: { Accept: 'application/json', 'Content-Type': 'application/json', 'User-Agent': 'StudyHelper' },
      body: JSON.stringify({ client_id: clientId, scope: 'gist read:user' }),
    });
    const json = await res.json();
    if (!res.ok || json.error) throw new Error(`GitHub 设备授权失败：${json.error_description || json.error || res.status}`);
    this._device = { ...json, clientId, startedAt: Date.now() };
    this._pollDevice();
    return { userCode: json.user_code, verificationUri: json.verification_uri, expiresIn: json.expires_in };
  }

  async _pollDevice() {
    const d = this._device;
    if (!d) return;
    let interval = (d.interval || 5) * 1000;
    while (this._device === d && Date.now() - d.startedAt < d.expires_in * 1000) {
      await new Promise((r) => setTimeout(r, interval));
      if (this._device !== d) return;
      try {
        const res = await this.fetch('https://github.com/login/oauth/access_token', {
          method: 'POST',
          headers: { Accept: 'application/json', 'Content-Type': 'application/json', 'User-Agent': 'StudyHelper' },
          body: JSON.stringify({ client_id: d.clientId, device_code: d.device_code, grant_type: 'urn:ietf:params:oauth:grant-type:device_code' }),
        });
        const json = await res.json();
        if (json.access_token) {
          this._device = null;
          this._saveToken(json.access_token);
          await this.fetchUser().catch(() => {});
          this.emit('login', this.info());
          this.syncNow().catch(() => {});
          return;
        }
        if (json.error === 'slow_down') interval += 5000;
        else if (json.error && json.error !== 'authorization_pending') {
          this._device = null;
          this.emit('loginError', json.error_description || json.error);
          return;
        }
      } catch (e) {
        // network hiccup; keep polling
      }
    }
    if (this._device === d) {
      this._device = null;
      this.emit('loginError', '授权超时，请重试');
    }
  }

  cancelDeviceLogin() {
    this._device = null;
  }

  logout() {
    this._device = null;
    this._saveToken(null);
    this.user = null;
    const meta = this.store.getSyncMeta();
    delete meta.gistId;
    this.store.saveSyncMeta(meta);
    this._setStatus({ state: 'idle', error: null });
  }

  // ---------- gist sync ----------
  schedule(delay = 4000) {
    if (!this.token) return;
    clearTimeout(this._debounce);
    this._debounce = setTimeout(() => this.syncNow().catch(() => {}), delay);
  }

  async _findGist() {
    const meta = this.store.getSyncMeta();
    if (meta.gistId) {
      try {
        return await this._gh(`/gists/${meta.gistId}`);
      } catch (e) {
        if (e.status !== 404) throw e;
      }
    }
    for (let page = 1; page <= 10; page++) {
      const list = await this._gh(`/gists?per_page=100&page=${page}`);
      const hit = list.find((g) => g.description === GIST_DESCRIPTION || (g.files && g.files[FILES.knowledge]));
      if (hit) {
        meta.gistId = hit.id;
        this.store.saveSyncMeta(meta);
        return this._gh(`/gists/${hit.id}`);
      }
      if (list.length < 100) break;
    }
    return null;
  }

  async _readGistFile(gist, name) {
    const f = gist && gist.files && gist.files[name];
    if (!f) return null;
    let content = f.content;
    if (f.truncated && f.raw_url) {
      const res = await this.fetch(f.raw_url, { headers: { Authorization: `Bearer ${this.token}`, 'User-Agent': 'StudyHelper' } });
      content = await res.text();
    }
    try {
      return JSON.parse(content);
    } catch {
      return null;
    }
  }

  syncNow() {
    if (!this.token) return Promise.resolve(this.info());
    if (this._running) return this._running;
    this._running = this._sync().finally(() => {
      this._running = null;
    });
    return this._running;
  }

  async _sync() {
    this._setStatus({ state: 'syncing', error: null });
    try {
      if (!this.user) await this.fetchUser();
      const gist = await this._findGist();
      const localSettings = this.store.getSettings();
      const localKnowledge = this.store.getKnowledge();
      const localStats = this.store.getStats();

      let settings = localSettings;
      let knowledge = localKnowledge;
      let stats = localStats;

      if (gist) {
        const [rs, rk, rst] = await Promise.all([
          this._readGistFile(gist, FILES.settings),
          this._readGistFile(gist, FILES.knowledge),
          this._readGistFile(gist, FILES.stats),
        ]);
        if (rs) {
          for (const k of LOCAL_ONLY_SETTINGS) delete rs[k];
          // While studying, the configuration is locked: never pull remote settings changes.
          if (!this.focus.isLocked()) settings = mergeSettings(localSettings, rs);
        }
        if (rk) knowledge = mergeKnowledge(localKnowledge, rk);
        if (rst) stats = mergeStats(localStats, rst);
      }

      const changed = {
        settings: JSON.stringify(settings) !== JSON.stringify(localSettings),
        knowledge: JSON.stringify(knowledge) !== JSON.stringify(localKnowledge),
        stats: JSON.stringify(stats) !== JSON.stringify(localStats),
      };
      if (changed.settings) this.store.saveSettings(settings, { touch: false });
      if (changed.knowledge) this.store.saveKnowledge(knowledge);
      if (changed.stats) this.store.saveStats(stats);
      if (changed.settings || changed.knowledge || changed.stats) this.onDataChanged && this.onDataChanged(changed);

      const remoteSettings = { ...settings };
      for (const k of LOCAL_ONLY_SETTINGS) delete remoteSettings[k];
      const files = {
        [FILES.settings]: { content: JSON.stringify(remoteSettings, null, 1) },
        [FILES.knowledge]: { content: JSON.stringify(knowledge, null, 1) },
        [FILES.stats]: { content: JSON.stringify(stats, null, 1) },
      };
      let gistId;
      if (gist) {
        await this._gh(`/gists/${gist.id}`, { method: 'PATCH', body: JSON.stringify({ description: GIST_DESCRIPTION, files }) });
        gistId = gist.id;
      } else {
        const created = await this._gh('/gists', { method: 'POST', body: JSON.stringify({ description: GIST_DESCRIPTION, public: false, files }) });
        gistId = created.id;
      }
      const meta = this.store.getSyncMeta();
      meta.gistId = gistId;
      meta.lastSyncAt = Date.now();
      this.store.saveSyncMeta(meta);
      this._setStatus({ state: 'ok', lastSyncAt: meta.lastSyncAt, error: null });
    } catch (e) {
      this._setStatus({ state: 'error', error: e.message });
      throw e;
    }
    return this.info();
  }
}

module.exports = { SyncService, GIST_DESCRIPTION };
