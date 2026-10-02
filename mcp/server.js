#!/usr/bin/env node
'use strict';
// StudyHelper stdio MCP server: lets agents manage knowledge modules, read study stats and
// edit settings. It works directly on the app's data directory, so the desktop app picks up
// changes immediately (and syncs them to GitHub Gists when logged in).
const { McpServer } = require('@modelcontextprotocol/sdk/server/mcp.js');
const { StdioServerTransport } = require('@modelcontextprotocol/sdk/server/stdio.js');
const { z } = require('zod');
const core = require('../src/shared/core');
const { builtinModules } = require('../src/shared/builtin');

const VERSION = '0.1.0';
const store = new core.DataStore();
if (!store.knowledgeExists()) store.saveKnowledge(core.seedBuiltin({ modules: [] }, builtinModules()));

const server = new McpServer({ name: 'study-helper', version: VERSION });

const ok = (data) => ({ content: [{ type: 'text', text: typeof data === 'string' ? data : JSON.stringify(data, null, 2) }] });
const fail = (msg) => ({ content: [{ type: 'text', text: msg }], isError: true });

function findModule(k, id) {
  return k.modules.find((m) => !m.deleted && (m.id === id || m.name === id));
}
function summary(m) {
  return { id: m.id, name: m.name, description: m.description, enabled: m.enabled, builtin: !!m.builtin, entryCount: m.entries.filter((e) => !e.deleted).length };
}
function entryOut(e) {
  return { id: e.id, title: e.title, content: e.content, tags: e.tags || [] };
}
function fmtMin(sec) {
  return Math.round(sec / 60);
}

const entryShape = z.object({
  title: z.string().min(1).describe('条目标题，例如“泊松分布”'),
  content: z.string().describe('Markdown 内容，可使用 $...$ / $$...$$ LaTeX 公式'),
  tags: z.array(z.string()).optional(),
});

server.registerTool(
  'get_status',
  { title: '查看状态', description: '查看复习助手当前状态：学习模式（idle/focus/rest/research）、结束时间、数据目录和知识库概况。', inputSchema: {} },
  async () => {
    const st = store.getState();
    const k = store.getKnowledge();
    const live = core.liveModules(k);
    return ok({
      mode: st.mode,
      focusEndAt: st.focusEndAt ? new Date(st.focusEndAt).toISOString() : null,
      restEndAt: st.restEndAt ? new Date(st.restEndAt).toISOString() : null,
      configLocked: st.mode !== 'idle',
      dataDir: store.dir,
      modules: live.length,
      entries: live.reduce((a, m) => a + m.entries.length, 0),
    });
  }
);

server.registerTool(
  'list_modules',
  { title: '列出知识模块', description: '列出所有知识模块（id、名称、描述、是否参与弹窗、条目数）。', inputSchema: {}, annotations: { readOnlyHint: true } },
  async () => ok(core.liveModules(store.getKnowledge()).map(summary))
);

server.registerTool(
  'get_module',
  {
    title: '查看模块条目',
    description: '获取某个知识模块及其全部条目内容。module 可以是模块 id 或名称。',
    inputSchema: { module: z.string().describe('模块 id 或名称') },
    annotations: { readOnlyHint: true },
  },
  async ({ module }) => {
    const m = findModule(store.getKnowledge(), module);
    if (!m) return fail(`找不到模块：${module}`);
    return ok({ ...summary(m), entries: m.entries.filter((e) => !e.deleted).map(entryOut) });
  }
);

server.registerTool(
  'create_module',
  {
    title: '新建知识模块',
    description: '新建一个知识模块，可同时附带初始条目。',
    inputSchema: {
      name: z.string().min(1),
      description: z.string().optional(),
      enabled: z.boolean().optional().describe('是否参与右下角弹窗，默认 true'),
      entries: z.array(entryShape).optional(),
    },
  },
  async ({ name, description, enabled, entries }) => {
    const k = store.getKnowledge();
    const m = core.newModule({ name, description: description || '', enabled: enabled !== false });
    for (const e of entries || []) m.entries.push(core.newEntry(e));
    k.modules.push(m);
    store.saveKnowledge(k);
    return ok(summary(m));
  }
);

server.registerTool(
  'update_module',
  {
    title: '修改知识模块',
    description: '修改模块名称、描述或是否参与弹窗。',
    inputSchema: { module: z.string(), name: z.string().optional(), description: z.string().optional(), enabled: z.boolean().optional() },
  },
  async ({ module, name, description, enabled }) => {
    const k = store.getKnowledge();
    const m = findModule(k, module);
    if (!m) return fail(`找不到模块：${module}`);
    if (name !== undefined) m.name = name;
    if (description !== undefined) m.description = description;
    if (enabled !== undefined) m.enabled = enabled;
    m.updatedAt = Date.now();
    store.saveKnowledge(k);
    return ok(summary(m));
  }
);

server.registerTool(
  'delete_module',
  { title: '删除知识模块', description: '删除整个知识模块（会同步删除云端）。', inputSchema: { module: z.string() }, annotations: { destructiveHint: true } },
  async ({ module }) => {
    const k = store.getKnowledge();
    const m = findModule(k, module);
    if (!m) return fail(`找不到模块：${module}`);
    m.deleted = true;
    m.updatedAt = Date.now();
    store.saveKnowledge(k);
    return ok(`已删除模块 ${m.name}`);
  }
);

server.registerTool(
  'add_entries',
  {
    title: '添加知识条目',
    description: '向模块批量添加知识条目。内容为 Markdown，公式用 LaTeX（$...$ 行内，$$...$$ 独立）。',
    inputSchema: { module: z.string().describe('模块 id 或名称'), entries: z.array(entryShape).min(1) },
  },
  async ({ module, entries }) => {
    const k = store.getKnowledge();
    const m = findModule(k, module);
    if (!m) return fail(`找不到模块：${module}`);
    const added = entries.map((e) => core.newEntry(e));
    m.entries.push(...added);
    store.saveKnowledge(k);
    return ok({ module: m.name, added: added.map((e) => ({ id: e.id, title: e.title })) });
  }
);

server.registerTool(
  'update_entry',
  {
    title: '修改知识条目',
    description: '修改某个条目的标题、内容或标签。',
    inputSchema: { module: z.string(), entry_id: z.string(), title: z.string().optional(), content: z.string().optional(), tags: z.array(z.string()).optional() },
  },
  async ({ module, entry_id, title, content, tags }) => {
    const k = store.getKnowledge();
    const m = findModule(k, module);
    const e = m && m.entries.find((x) => x.id === entry_id && !x.deleted);
    if (!e) return fail('找不到条目');
    if (title !== undefined) e.title = title;
    if (content !== undefined) e.content = content;
    if (tags !== undefined) e.tags = tags;
    e.updatedAt = Date.now();
    store.saveKnowledge(k);
    return ok(entryOut(e));
  }
);

server.registerTool(
  'delete_entry',
  { title: '删除知识条目', description: '删除一个知识条目。', inputSchema: { module: z.string(), entry_id: z.string() }, annotations: { destructiveHint: true } },
  async ({ module, entry_id }) => {
    const k = store.getKnowledge();
    const m = findModule(k, module);
    const e = m && m.entries.find((x) => x.id === entry_id && !x.deleted);
    if (!e) return fail('找不到条目');
    e.deleted = true;
    e.updatedAt = Date.now();
    store.saveKnowledge(k);
    return ok(`已删除 ${e.title}`);
  }
);

server.registerTool(
  'search_entries',
  {
    title: '搜索知识条目',
    description: '按关键词在标题和内容中搜索知识条目。',
    inputSchema: { query: z.string().min(1), module: z.string().optional(), limit: z.number().int().min(1).max(200).optional() },
    annotations: { readOnlyHint: true },
  },
  async ({ query, module, limit = 30 }) => {
    const q = query.toLowerCase();
    const out = [];
    for (const m of core.liveModules(store.getKnowledge())) {
      if (module && m.id !== module && m.name !== module) continue;
      for (const e of m.entries) if ((e.title + '\n' + e.content).toLowerCase().includes(q)) out.push({ module: m.name, moduleId: m.id, ...entryOut(e) });
    }
    return ok(out.slice(0, limit));
  }
);

server.registerTool(
  'get_study_stats',
  {
    title: '学习时长统计',
    description: '查看学习时长（分钟）。range=today 返回今天；range=week 返回某一周（周一到周日），week_offset=0 为本周，-1 为上周。',
    inputSchema: { range: z.enum(['today', 'week']).default('week'), week_offset: z.number().int().max(0).optional() },
    annotations: { readOnlyHint: true },
  },
  async ({ range, week_offset = 0 }) => {
    const st = store.getState();
    const sessions = store.getStats().sessions.slice();
    if (st.current) sessions.push({ ...st.current, end: Date.now() });
    if (range === 'today') {
      const t = core.dailyTotals(sessions)[core.dateKey(Date.now())] || { focus: 0, research: 0, rest: 0, study: 0 };
      return ok({ date: core.dateKey(Date.now()), studyMin: fmtMin(t.study), focusMin: fmtMin(t.focus), researchMin: fmtMin(t.research), restMin: fmtMin(t.rest), goalMin: store.getSettings().dailyGoalMin });
    }
    const w = core.weekSummary(sessions, Date.now() + week_offset * 7 * 86400000);
    return ok({
      weekStart: w.weekStart,
      totalStudyMin: fmtMin(w.totalStudySec),
      totalRestMin: fmtMin(w.totalRestSec),
      days: w.days.map((d) => ({ date: d.date, studyMin: fmtMin(d.study), focusMin: fmtMin(d.focus), researchMin: fmtMin(d.research), restMin: fmtMin(d.rest) })),
    });
  }
);

server.registerTool(
  'get_settings',
  { title: '查看设置', description: '查看白名单域名、允许的文件夹、代理和弹窗设置。', inputSchema: {}, annotations: { readOnlyHint: true } },
  async () => {
    const { githubClientId, ...s } = store.getSettings();
    return ok(s);
  }
);

server.registerTool(
  'update_settings',
  {
    title: '修改设置',
    description: '修改白名单域名、允许的文件夹等设置。学习中（专注/休息/查资料）配置被锁定，此时会拒绝修改。域名填后缀即可，如 snh48ssr.com 同时允许其所有子域名。',
    inputSchema: {
      allowed_domains: z.array(z.string()).optional().describe('完整替换白名单域名列表'),
      add_domains: z.array(z.string()).optional(),
      remove_domains: z.array(z.string()).optional(),
      allowed_folders: z.array(z.string()).optional().describe('完整替换允许的本地文件夹（绝对路径）'),
      homepage: z.string().optional(),
      proxy_mode: z.enum(['system', 'direct', 'custom']).optional(),
      proxy_url: z.string().optional(),
      popup_enabled: z.boolean().optional(),
      popup_interval_idle_min: z.number().min(1).max(240).optional(),
      popup_interval_rest_min: z.number().min(1).max(60).optional(),
      popup_duration_sec: z.number().min(0).max(600).optional(),
      daily_goal_min: z.number().min(0).max(1440).optional(),
    },
  },
  async (a) => {
    const st = store.getState();
    if (st.mode !== 'idle') return fail('学习中配置已锁定，结束学习后才能修改设置');
    const s = store.getSettings();
    if (a.allowed_domains) s.allowedDomains = a.allowed_domains;
    if (a.add_domains) s.allowedDomains = [...s.allowedDomains, ...a.add_domains];
    if (a.remove_domains) {
      const rm = new Set(core.normalizeDomains(a.remove_domains));
      s.allowedDomains = core.normalizeDomains(s.allowedDomains).filter((d) => !rm.has(d));
    }
    if (a.allowed_folders) s.allowedFolders = a.allowed_folders;
    if (a.homepage !== undefined) s.homepage = a.homepage;
    if (a.proxy_mode) {
      s.proxyMode = a.proxy_mode;
      s.useSystemProxy = a.proxy_mode === 'system';
    }
    if (a.proxy_url !== undefined) s.proxyUrl = a.proxy_url;
    if (a.popup_enabled !== undefined) s.popupEnabled = a.popup_enabled;
    if (a.popup_interval_idle_min) s.popupIntervalIdleMin = a.popup_interval_idle_min;
    if (a.popup_interval_rest_min) s.popupIntervalRestMin = a.popup_interval_rest_min;
    if (a.popup_duration_sec !== undefined) s.popupDurationSec = a.popup_duration_sec;
    if (a.daily_goal_min !== undefined) s.dailyGoalMin = a.daily_goal_min;
    const { githubClientId, ...saved } = store.saveSettings(s);
    return ok(saved);
  }
);

server.registerTool(
  'start_focus',
  {
    title: '开始专注学习',
    description: '开始一段专注学习，直到指定时间。只能在未学习（idle）时调用；中途退出需要用户在应用里选择休息或查资料。',
    inputSchema: {
      minutes: z.number().int().min(1).max(1440).optional().describe('从现在起学习多少分钟'),
      until: z.string().optional().describe('结束时间，ISO 8601 或 HH:MM（今天，若已过则为明天）'),
    },
  },
  async ({ minutes, until }) => {
    const st = store.getState();
    if (st.mode !== 'idle') return fail(`已经在学习中（${st.mode}）`);
    let end;
    if (minutes) end = Date.now() + minutes * 60000;
    else if (until) {
      const hm = /^(\d{1,2}):(\d{2})$/.exec(until.trim());
      if (hm) {
        const d = new Date();
        d.setHours(Number(hm[1]), Number(hm[2]), 0, 0);
        if (d.getTime() <= Date.now()) d.setDate(d.getDate() + 1);
        end = d.getTime();
      } else end = Date.parse(until);
    }
    if (!end || Number.isNaN(end) || end <= Date.now() + 30000) return fail('请提供有效的 minutes 或 until（需晚于当前时间）');
    st.mode = 'focus';
    st.focusEndAt = end;
    st.restEndAt = null;
    st.current = { id: core.uid('s_'), type: 'focus', start: Date.now() };
    store.saveState(st);
    return ok({ mode: 'focus', focusEndAt: new Date(end).toISOString() });
  }
);

async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
