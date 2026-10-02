'use strict';
// Focus-mode state machine. Persists to state.json and appends finished sessions to stats.json.
const { EventEmitter } = require('events');
const { uid } = require('../shared/core');

const REST_CHOICES = [5, 10, 20];

class FocusController extends EventEmitter {
  constructor(store) {
    super();
    this.store = store;
    this.state = store.getState();
    this.timer = null;
    this._recover();
    this.timer = setInterval(() => this.tick(), 1000);
  }

  _recover() {
    // If app was closed while a session was open, close it at last known update time.
    const s = this.state;
    if (s.current && s.mode !== 'idle') {
      const now = Date.now();
      // Gap larger than 2 minutes means the app was not running: end the session at the last heartbeat.
      if (now - (s.updatedAt || now) > 120000) {
        this._closeCurrent(s.updatedAt || now);
        if (s.focusEndAt && now < s.focusEndAt) {
          this._open('focus');
          s.mode = 'focus';
          s.restEndAt = null;
        } else {
          s.mode = 'idle';
          s.focusEndAt = null;
          s.restEndAt = null;
        }
        this._persist();
      }
    }
  }

  get mode() {
    return this.state.mode;
  }

  isLocked() {
    return this.state.mode !== 'idle';
  }

  snapshot() {
    const s = this.state;
    return {
      mode: s.mode,
      focusEndAt: s.focusEndAt,
      restEndAt: s.restEndAt,
      current: s.current,
      now: Date.now(),
      restChoices: REST_CHOICES,
    };
  }

  _persist() {
    this.store.saveState(this.state);
    this.emit('change', this.snapshot());
  }

  _open(type) {
    this.state.current = { id: uid('s_'), type, start: Date.now() };
  }

  _closeCurrent(endTs = Date.now()) {
    const cur = this.state.current;
    if (!cur) return;
    const end = Math.max(cur.start, endTs);
    if (end - cur.start >= 1000) {
      const stats = this.store.getStats();
      stats.sessions.push({ id: cur.id, type: cur.type, start: cur.start, end });
      this.store.saveStats(stats);
      this.emit('session', { ...cur, end });
    }
    this.state.current = null;
  }

  startFocus(endAt) {
    const end = Number(endAt);
    if (!end || end <= Date.now() + 30000) throw new Error('结束时间需要晚于当前时间');
    if (this.state.mode !== 'idle') throw new Error('已经在学习中');
    this.state.mode = 'focus';
    this.state.focusEndAt = end;
    this.state.restEndAt = null;
    this._open('focus');
    this._persist();
  }

  takeRest(minutes) {
    const m = Number(minutes);
    if (!REST_CHOICES.includes(m)) throw new Error('休息时长只能是 5 / 10 / 20 分钟');
    if (this.state.mode !== 'focus' && this.state.mode !== 'research') throw new Error('只有学习中才能休息');
    this._closeCurrent();
    this.state.mode = 'rest';
    this.state.restEndAt = Date.now() + m * 60000;
    this._open('rest');
    this._persist();
  }

  startResearch() {
    if (this.state.mode !== 'focus' && this.state.mode !== 'rest') throw new Error('只有学习中才能切换到查资料/看网课');
    this._closeCurrent();
    this.state.mode = 'research';
    this.state.restEndAt = null;
    this._open('research');
    this._persist();
  }

  resumeFocus() {
    if (this.state.mode === 'idle') throw new Error('当前没有进行中的学习');
    if (this.state.mode === 'focus') return;
    this._closeCurrent();
    this.state.mode = 'focus';
    this.state.restEndAt = null;
    this._open('focus');
    this._persist();
  }

  extendFocus(endAt) {
    if (this.state.mode === 'idle') throw new Error('当前没有进行中的学习');
    const end = Number(endAt);
    if (!end || end <= Date.now()) throw new Error('结束时间需要晚于当前时间');
    this.state.focusEndAt = end;
    this._persist();
  }

  // Ending early is only allowed from rest / research (focus itself can only be left via those).
  stop({ reason = 'manual' } = {}) {
    if (this.state.mode === 'idle') return;
    if (reason === 'manual' && this.state.mode === 'focus') throw new Error('专注中不能直接退出，请先选择“休息”或“查资料/看网课”');
    this._closeCurrent();
    this.state.mode = 'idle';
    this.state.focusEndAt = null;
    this.state.restEndAt = null;
    this._persist();
    this.emit('finished', { reason });
  }

  tick() {
    const s = this.state;
    const now = Date.now();
    if (s.mode === 'idle') return;
    if (s.focusEndAt && now >= s.focusEndAt) {
      this.stop({ reason: 'completed' });
      return;
    }
    if (s.mode === 'rest' && s.restEndAt && now >= s.restEndAt) {
      this.resumeFocus();
      this.emit('restOver');
      return;
    }
    // heartbeat every 30s so crash recovery knows when we were last alive
    if (now - (s.updatedAt || 0) > 30000) this.store.saveState(s);
  }

  // Current open session counts toward live stats.
  sessionsWithCurrent() {
    const stats = this.store.getStats();
    const list = stats.sessions.slice();
    if (this.state.current) list.push({ ...this.state.current, end: Date.now(), open: true });
    return list;
  }
}

module.exports = { FocusController, REST_CHOICES };
