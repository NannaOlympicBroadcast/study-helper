'use strict';
const test = require('node:test');
const assert = require('node:assert');
const os = require('os');
const path = require('path');
const fs = require('fs');
const core = require('../src/shared/core');
const { builtinModules } = require('../src/shared/builtin');

test('domain suffix matching', () => {
  const d = ['snh48ssr.com', '*.example.org', 'https://Foo.net/path'];
  assert.ok(core.hostAllowed('snh48ssr.com', d));
  assert.ok(core.hostAllowed('www.snh48ssr.com', d));
  assert.ok(core.hostAllowed('a.b.snh48ssr.com', d));
  assert.ok(!core.hostAllowed('evilsnh48ssr.com', d));
  assert.ok(!core.hostAllowed('snh48ssr.com.evil.io', d));
  assert.ok(core.hostAllowed('example.org', d));
  assert.ok(core.hostAllowed('x.foo.net', d));
});

test('urlAllowed for http and file', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sh-'));
  const s = { allowedDomains: ['snh48ssr.com'], allowedFolders: [dir] };
  assert.ok(core.urlAllowed('https://live.snh48ssr.com/a?b', s).allowed);
  assert.ok(!core.urlAllowed('https://google.com', s).allowed);
  const inside = require('url').pathToFileURL(path.join(dir, 'sub', 'a.pdf')).href;
  const outside = require('url').pathToFileURL(path.join(os.tmpdir(), 'b.pdf')).href;
  assert.ok(core.urlAllowed(inside, s).allowed);
  assert.ok(!core.urlAllowed(outside, s).allowed);
  assert.ok(!core.urlAllowed(require('url').pathToFileURL(dir + '-evil/x').href, s).allowed);
  assert.ok(!core.urlAllowed('ftp://x.com', s).allowed);
  assert.ok(core.urlAllowed('chrome-extension://mhjfbmdgcfjbbpaeojofohoefgiehjai/index.html', s).allowed);
  assert.ok(!core.urlAllowed('chrome-extension://abcdefabcdef/x.html', s).allowed);
});

test('daily totals split across midnight', () => {
  const d = new Date(2026, 0, 1, 23, 30).getTime();
  const t = core.dailyTotals([{ type: 'focus', start: d, end: d + 3600000 }, { type: 'rest', start: d + 3600000, end: d + 4200000 }]);
  assert.strictEqual(t['2026-01-01'].study, 1800);
  assert.strictEqual(t['2026-01-02'].study, 1800);
  assert.strictEqual(t['2026-01-02'].rest, 600);
  const w = core.weekSummary([{ type: 'research', start: d, end: d + 600000 }], d, d + 600000);
  assert.strictEqual(w.days.length, 7);
  assert.strictEqual(w.totalStudySec, 600);
});

test('merge knowledge LWW with tombstones', () => {
  const a = { modules: [{ id: 'm1', name: 'A', updatedAt: 1, entries: [{ id: 'e1', title: 'x', updatedAt: 5 }, { id: 'e2', title: 'y', updatedAt: 1 }] }] };
  const b = { modules: [{ id: 'm1', name: 'A2', updatedAt: 2, entries: [{ id: 'e1', title: 'old', updatedAt: 3 }, { id: 'e2', title: 'y', updatedAt: 9, deleted: true }, { id: 'e3', title: 'z', updatedAt: 1 }] }, { id: 'm2', name: 'B', updatedAt: 1, entries: [] }] };
  const m = core.mergeKnowledge(a, b);
  const m1 = m.modules.find((x) => x.id === 'm1');
  assert.strictEqual(m1.name, 'A2');
  assert.strictEqual(m1.entries.find((e) => e.id === 'e1').title, 'x');
  assert.ok(m1.entries.find((e) => e.id === 'e2').deleted);
  assert.strictEqual(m1.entries.length, 3);
  assert.strictEqual(m.modules.length, 2);
});

test('builtin radix module', () => {
  const mods = builtinModules();
  const r = mods.find((m) => m.id === 'builtin_radix');
  assert.strictEqual(r.entries.length, 17);
  assert.match(r.entries[10].content, /1011/);
  const k = core.seedBuiltin({ modules: [] }, mods);
  core.seedBuiltin(k, mods);
  assert.strictEqual(k.modules.filter((m) => m.id === 'builtin_radix').length, 1);
});

test('focus controller flow', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'shf-'));
  const store = new core.DataStore(dir);
  const { FocusController } = require('../src/main/focus');
  const f = new FocusController(store);
  clearInterval(f.timer);
  f.startFocus(Date.now() + 3600000);
  assert.throws(() => f.stop(), /专注中不能直接退出/);
  assert.throws(() => f.takeRest(7));
  f.takeRest(5);
  assert.strictEqual(f.mode, 'rest');
  f.startResearch();
  f.resumeFocus();
  f.state.focusEndAt = Date.now() - 1;
  f.tick();
  assert.strictEqual(f.mode, 'idle');
});

test('netlify-derived builtin modules are present and render', () => {
  const katex = require('katex');
  const mods = builtinModules();
  for (const id of ['builtin_probability', 'builtin_integrals', 'builtin_taylor']) {
    const m = mods.find((x) => x.id === id);
    assert.ok(m && m.entries.length > 0, id);
    for (const e of m.entries) {
      for (const mm of e.content.matchAll(/\$\$([\s\S]+?)\$\$|\$([^$\n]+?)\$/g)) katex.renderToString(mm[1] || mm[2], { throwOnError: true });
    }
  }
});
