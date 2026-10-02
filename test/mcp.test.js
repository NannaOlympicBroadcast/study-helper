'use strict';
// End-to-end test of the bundled stdio MCP server (run `npm run build:mcp` first).
const test = require('node:test');
const assert = require('node:assert');
const os = require('os');
const fs = require('fs');
const path = require('path');
const { Client } = require('@modelcontextprotocol/sdk/client/index.js');
const { StdioClientTransport } = require('@modelcontextprotocol/sdk/client/stdio.js');

const SERVER = path.join(__dirname, '..', 'mcpb', 'server', 'index.js');

test('mcp server tools', async () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'shmcp-'));
  const transport = new StdioClientTransport({ command: process.execPath, args: [SERVER], env: { ...process.env, STUDY_HELPER_DATA_DIR: dataDir } });
  const client = new Client({ name: 'test', version: '1.0.0' });
  await client.connect(transport);
  const call = async (name, args = {}) => {
    const r = await client.callTool({ name, arguments: args });
    const text = r.content[0].text;
    let data;
    try {
      data = JSON.parse(text);
    } catch {
      data = text;
    }
    return { isError: !!r.isError, data };
  };
  try {
    const { tools } = await client.listTools();
    assert.ok(tools.length >= 14);

    const mods = await call('list_modules');
    assert.ok(mods.data.some((m) => m.id === 'builtin_radix'));

    const created = await call('create_module', { name: 'Prob', entries: [{ title: 'Poisson', content: '$E(X)=\\lambda$, $D(X)=\\lambda$' }] });
    assert.strictEqual(created.data.entryCount, 1);
    const added = await call('add_entries', { module: 'Prob', entries: [{ title: 'Binomial', content: '$np$' }] });
    assert.strictEqual(added.data.added.length, 1);
    const found = await call('search_entries', { query: 'poisson' });
    assert.strictEqual(found.data.length, 1);
    const upd = await call('update_entry', { module: 'Prob', entry_id: found.data[0].id, content: 'changed' });
    assert.strictEqual(upd.data.content, 'changed');
    await call('delete_entry', { module: 'Prob', entry_id: found.data[0].id });
    const mod = await call('get_module', { module: 'Prob' });
    assert.strictEqual(mod.data.entries.length, 1);

    const s = await call('update_settings', { add_domains: ['*.snh48ssr.com'] });
    assert.ok(s.data.allowedDomains.includes('snh48ssr.com'));

    const f = await call('start_focus', { minutes: 30 });
    assert.strictEqual(f.data.mode, 'focus');
    const locked = await call('update_settings', { add_domains: ['x.com'] });
    assert.ok(locked.isError);
    const again = await call('start_focus', { minutes: 30 });
    assert.ok(again.isError);

    const st = await call('get_study_stats', { range: 'today' });
    assert.strictEqual(typeof st.data.studyMin, 'number');
    const wk = await call('get_study_stats', { range: 'week' });
    assert.strictEqual(wk.data.days.length, 7);
  } finally {
    await client.close();
  }
});
