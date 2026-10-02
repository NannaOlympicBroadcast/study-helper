# 考研复习助手 StudyHelper

一个帮你**管住注意力**、顺便**背公式**的 Windows 桌面应用（Electron）。

- **受限浏览器**：只能打开白名单域名（填 `snh48ssr.com` 即同时允许 `snh48ssr.com` 和 `*.snh48ssr.com`），或只能浏览/预览指定文件夹里的资料（PDF、图片、音视频、Markdown、文本）。支持系统代理 / 自定义代理 / 直连。
- **专注模式**：点「开始学习」设定学到几点。中途离开只有两种方式：**休息**（5 / 10 / 20 分钟，到点自动回到专注）或 **查资料 / 看网课**。学习中配置被锁定。
- **知识速记卡片**：最小化到托盘后，在休息或非专注时，右下角定时弹出知识卡片，完整渲染 Markdown + LaTeX（KaTeX）。知识库可扩展：多个模块，每个模块多个条目，可导入导出 JSON。
- **学习看板**：按专注 / 查资料 / 休息统计每天学习时长，按周查看柱状图和每日目标。
- **云同步**：设置、知识库、学习记录通过 **GitHub Gist**（私有）同步；未登录或离线时只保存在本地，联网后自动合并。
- **MCP 服务**：提供标准 stdio MCP 服务（`.mcpb` 扩展包），Agent 可以直接管理知识库、查看学习时长、修改白名单、开始专注。

## 下载

在 [Releases](https://github.com/NannaOlympicBroadcast/study-helper/releases) 或 [Actions](https://github.com/NannaOlympicBroadcast/study-helper/actions) 的构建产物中下载：

- `StudyHelper-Setup-x.y.z.exe`：安装版
- `StudyHelper-Portable-x.y.z.exe`：便携版
- `study-helper-x.y.z.mcpb`：MCP 扩展包（Claude Desktop 等支持 MCPB 的客户端双击安装）

## GitHub 登录

两种方式：

1. **GitHub 授权登录（设备码）**：需要一个开启了 Device Flow 的 GitHub OAuth App。在仓库 Secrets 中设置 `STUDY_HELPER_GITHUB_CLIENT_ID` 后，CI 构建的版本会内置它；也可以在「设置 → 云同步 → 高级」里填写 Client ID。
2. **Personal Access Token**：创建一个只勾选 `gist` 权限的 token，在「使用 Token 登录」中粘贴。

Token 使用系统加密（Windows DPAPI）保存在本机。白名单文件夹等本机路径不会上传。

## MCP 服务

数据目录默认是 `%APPDATA%\StudyHelper\data`，可用环境变量 `STUDY_HELPER_DATA_DIR` 覆盖。MCP 服务直接读写该目录，桌面应用会实时刷新并同步到云端。

| 工具 | 作用 |
|---|---|
| `get_status` | 当前学习模式、结束时间、知识库概况 |
| `list_modules` / `get_module` | 查看知识模块和条目 |
| `create_module` / `update_module` / `delete_module` | 管理模块 |
| `add_entries` / `update_entry` / `delete_entry` / `search_entries` | 管理条目（Markdown + LaTeX） |
| `get_study_stats` | 今日 / 某周学习时长 |
| `get_settings` / `update_settings` | 白名单域名、文件夹、代理、弹窗（学习中锁定） |
| `start_focus` | 开始专注学习 |

不用 `.mcpb` 时也可以手动配置：

```json
{
  "mcpServers": {
    "study-helper": { "command": "node", "args": ["<path>/mcpb/server/index.js"] }
  }
}
```

## 开发

```bash
npm install
npm start          # 构建界面并启动
npm test           # 单元测试 + MCP 端到端测试
npm run dist:win   # 打包 Windows 安装版和便携版
npm run pack:mcpb  # 打包 .mcpb
```

内置知识模块位于 `src/shared/builtin/`：进制转换 1–16 由代码生成，概率统计、积分表、泰勒展开以 JSON 形式维护。
