'use strict';
// Built-in knowledge modules shipped with the app. Each module has a stable id so
// user edits survive re-seeding (see core.seedBuiltin).

function entry(moduleId, i, title, content, tags = []) {
  return { id: `${moduleId}_${String(i).padStart(3, '0')}`, title, content, tags, createdAt: 0, updatedAt: 0, deleted: false };
}

function mod(id, name, description, items) {
  return {
    id,
    name,
    description,
    enabled: true,
    builtin: true,
    createdAt: 0,
    updatedAt: 0,
    deleted: false,
    entries: items.map((it, i) => entry(id, i + 1, it.title, it.content, it.tags || [])),
  };
}

function radixModule() {
  const items = [];
  for (let n = 1; n <= 16; n++) {
    const bin = n.toString(2).padStart(n === 16 ? 5 : 4, '0');
    const hex = n.toString(16).toUpperCase();
    items.push({
      title: `${n} 的进制表示`,
      content: `| 十进制 | 二进制 | 十六进制 |\n|:-:|:-:|:-:|\n| **${n}** | \`${bin}\` | \`${hex}\` |\n\n$$${n}_{(10)} = ${bin}_{(2)} = \\mathrm{${hex}}_{(16)}$$`,
      tags: ['进制'],
    });
  }
  const rows = [];
  for (let n = 1; n <= 16; n++) rows.push(`| ${n} | \`${n.toString(2).padStart(4, '0')}\` | \`${n.toString(16).toUpperCase()}\` |`);
  items.push({ title: '1–16 进制对照总表', content: `| 十进制 | 二进制 | 十六进制 |\n|:-:|:-:|:-:|\n${rows.join('\n')}`, tags: ['进制'] });
  return mod('builtin_radix', '进制转换 1–16', '1 到 16 的二进制、十进制、十六进制表示', items);
}

function loadJsonModules() {
  const out = [];
  for (const name of ['probability', 'integrals', 'taylor']) {
    try {
      // eslint-disable-next-line import/no-dynamic-require
      const data = require(`./${name}.json`);
      out.push(mod(data.id, data.name, data.description, data.entries));
    } catch {
      /* module not generated yet */
    }
  }
  return out;
}

function builtinModules() {
  return [...loadJsonModules(), radixModule()];
}

module.exports = { builtinModules };
