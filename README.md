# Codindex

<p align="center">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="https://raw.githubusercontent.com/Bencibr/codindex/main/assets/codindex-hero-dark.svg">
    <source media="(prefers-color-scheme: light)" srcset="https://raw.githubusercontent.com/Bencibr/codindex/main/assets/codindex-hero-light.svg">
    <img alt="Codindex — structural code index for AI agents" src="https://raw.githubusercontent.com/Bencibr/codindex/main/assets/codindex-hero-dark.svg" width="100%">
  </picture>
</p>

<p align="center">
  <a href="https://github.com/Bencibr/codindex/blob/main/README.en.md">English</a> · <b>简体中文</b>
</p>

<p align="center">
  <a href="https://www.npmjs.com/package/codindex"><img alt="npm version" src="https://img.shields.io/npm/v/codindex?color=38BDF8&label=npm"></a>
  <a href="#快速开始"><img alt="Node.js ≥ 22.5" src="https://img.shields.io/badge/node-%E2%89%A522.5-339933?logo=node.js&logoColor=white"></a>
  <a href="https://github.com/Bencibr/codindex/blob/main/docs/TOOLS.md"><img alt="MCP tools" src="https://img.shields.io/badge/MCP_tools-32-38BDF8"></a>
  <a href="#支持的语言"><img alt="Languages" src="https://img.shields.io/badge/languages-6-38BDF8"></a>
  <a href="https://github.com/Bencibr/codindex/blob/main/LICENSE"><img alt="License: MIT" src="https://img.shields.io/badge/license-MIT-0F172A"></a>
</p>

**本地代码索引服务：用 MCP 把代码库结构交给 AI。**

tree-sitter 解析 AST，把函数、调用图、模块依赖图、控制流图存进单个 SQLite 文件，
通过 32 个 MCP 工具供 AI 查询。让 AI 不必 grep、不必逐文件 Read，
就知道仓库里有什么、谁调用了谁、改一处会波及哪里。

- **本地优先** — 不调 LLM API、不上传源码、无遥测
- **结构化** — 调用边由 AST 解析得出，不是正则猜的
- **快** — 自扫描 38 文件 / 145 函数 / 7,570 调用边，3.4 秒

以 MCP server 接入 Claude Code、Cursor、VS Code、Windsurf、Codex 及任何支持
Model Context Protocol 的 client。代码搜索与代码导航（code navigation）走 SQLite FTS5，
语义簇走调用图 BFS，产物是一张可查询的代码图（code graph）。

agentic coding 的关键瓶颈不是模型能力，而是给它看什么：整仓塞进上下文会爆，靠 grep
又只能拿到碎片。Codindex 把仓库索引成一份可复用的 repo index，让 AI 按需取结构化
code context——而不是把几万行源码反复喂进去。

<p align="center"><sub>
Codindex — a local-first code indexing, codebase indexing and code intelligence server for
AI coding agents, doing static analysis and code analysis locally.
Parses any repository with tree-sitter into a structural static-analysis index (function
inventory, call graph and call chains, dependency graph, control-flow graph, impact analysis,
dead-code detection) and serves it over MCP. Code search and navigation run on SQLite FTS5;
semantic clusters come from call-graph BFS. 32 tools · 6 languages · MIT · no telemetry.
</sub></p>

---

## 它能回答哪些问题

| 你想知道 | 用 grep 的做法 | Codindex |
|---|---|---|
| 谁调用了 `scanProject`？ | 正则匹配，跨文件/别名/方法调用全靠猜 | `get_call_graph` |
| 改这个函数波及哪些文件？ | 手工顺藤摸瓜，容易漏 | `get_impact_analysis` |
| 这个模块依赖了谁，有循环吗？ | import 正则，路径别名解析不了 | `get_module_deps` |
| 哪些函数从没被调用过？ | 基本做不到 | `get_dead_code` |
| 有没有可复用的现成实现？ | 靠记忆和全文搜索 | `get_reuse_report` |
| 这个函数的分支和循环长什么样？ | 读源码脑补 | `get_cfg` |

> 在 CodeGraph 仓库（146 个 TS 文件）上实测：AST 统计到 1,926 个函数，
> 让 Agent 用 grep 手工统计只得到约 951 个——差一倍，且 grep 拿不到调用关系。

---

## 快速开始

需要 Node.js ≥ 22.5（依赖内置 `node:sqlite`）。

```bash
npm i -g codindex
```

装好后：

```bash
codindex --version   # 确认版本
codindex --mcp       # MCP stdio 模式，交给编辑器挂载
codindex             # Web UI → http://localhost:3100
```

**从源码安装**（想改代码或跑测试时）：

```bash
git clone https://github.com/Bencibr/codindex.git codindex && cd codindex
npm install && npm run build
npm pack && npm i -g ./codindex-*.tgz
```

仓库根 `.npmrc` 已声明 `legacy-peer-deps=true`（tree-sitter 语法包的 peer 范围互相冲突），
`npm install` 无需额外参数。开发用 `npm run dev` 起服务，`npm test` 跑测试（325 个用例）。

> 安装时若出现 `npm warn allow-scripts tree-sitter-* (install: node-gyp-build)`，
> 属正常提示：语法包自带预编译产物，跳过 install 脚本不影响使用。
> 想消除提示可执行 `npm approve-scripts --allow-scripts-pending`。

### 扫描项目

任选其一：

```bash
# Web UI：打开 http://localhost:3100，填名称和路径，点「添加」→「扫描」
```

```bash
# API
curl -X POST http://localhost:3100/api/projects \
  -H "Content-Type: application/json" \
  -d '{"name":"My Project","path":"/path/to/your/project"}'
curl -X POST http://localhost:3100/api/projects/{id}/scan
```

```
// MCP
add_project { name: "My Project", path: "/path/to/your/project" }
scan_project { project_id: "xxx" }
```

### 跑通一次完整链路

装完不确定有没有生效，按下面四步走一遍（以扫描本仓库为例）：

**1. 起服务**

```bash
codindex          # Web UI → http://localhost:3100
```

**2. 注册项目** —— 返回体里的 `id` 就是后续所有接口要用的 `project_id`

```bash
curl -X POST http://localhost:3100/api/projects \
  -H "Content-Type: application/json" \
  -d '{"name":"Codindex","path":"/path/to/codindex"}'
# → {"id":"bace225b-...","name":"Codindex","status":"pending", ...}
```

**3. 扫描** —— 同步执行，返回即完成

```bash
curl -X POST http://localhost:3100/api/projects/bace225b-.../scan
# → {"status":"complete","files":38,"functions":145,"calls":7572,"types":31,"cycles":0}
```

**4. 验证能查**

```bash
curl http://localhost:3100/api/projects/bace225b-.../overview
# → {"name":"Codindex","status":"ready","lastScanned":1794213971, ...}
```

或者走 MCP：`add_project` → `scan_project` → `get_project_summary`，
最后一步会返回 `{files: 38, functions: 145, types: 31, calls: 7568, modules: 9}`。

看到 `status: "ready"` 且函数数不为 0，就说明整条链路通了。

---

## MCP 配置

**Claude Code** — 全局装好后直接用 `codindex` 命令（最省事）：

```json
{
  "mcpServers": {
    "codindex": {
      "command": "codindex",
      "args": ["--mcp"],
      "env": { "CODINDEX_DB": "/absolute/path/to/codindex.db" }
    }
  }
}
```

或用命令：`claude mcp add codindex -- codindex --mcp`

**不想全局安装**，也可以直接跑克隆下来的源码（需要该 clone 已 `npm install`）：

```json
{
  "mcpServers": {
    "codindex": {
      "command": "npx",
      "args": ["tsx", "/absolute/path/to/codindex/src/index.ts", "--mcp"]
    }
  }
}
```

**Cursor / VS Code** — 把同样的内容写进 `.cursor/mcp.json` 或 `.vscode/mcp.json`，
外层键改成 `"servers"`。

> `CODINDEX_DB` 必须是绝对路径，否则 MCP 子进程可能找不到数据库。

---

## 32 个工具

完整清单（参数、返回值、解析规则）见 **[docs/TOOLS.md](https://github.com/Bencibr/codindex/blob/main/docs/TOOLS.md)**。

| 类别 | 数量 | 代表工具 |
|---|---|---|
| 上下文与读取 | 6 | `get_smart_context`（三档深度）、`get_context_bundle`、`get_function_context`、`get_function_body`、`get_function_list`、`get_file_content` |
| 调用与影响 | 5 | `get_call_graph`、`get_impact_analysis`、`get_bulk_impact`、`get_dead_code`、`get_raise_sites` |
| 搜索 | 3 | `search_code`（FTS5 全文）、`search_semantic`（调用图 BFS 语义簇）、`find_similar_functions` |
| 结构 | 8 | `get_project_summary`、`get_architecture_guide`、`get_module_deps`、`get_cfg`、`get_type_info`、`get_type_usage`、`get_export_inventory`、`get_bridge_map` |
| 质量与追踪 | 5 | `get_hotspots`、`get_reuse_report`、`get_test_coverage`、`get_change_guide`、`get_feature_tracking` |
| 扫描 | 5 | `add_project`、`scan_project`、`scan_project_incremental`、`start_watching`、`stop_watching` |
| **合计** | **32** | |

最常用的 `get_smart_context` 按 `purpose` 返回不同深度，避免为一点信息整段读源码：

| purpose | 返回 | 场景 |
|---|---|---|
| `explore` | 摘要 + 文件 + 复杂度 + 调用者数 | 快速了解函数做什么 |
| `understand` | + callers + callees + 类型 | 理解它在系统中的角色 |
| `modify` | + 完整源码 + 影响文件 | 修改前的完整评估 |

除了工具，MCP 还提供 **4 个 Resource**（`codindex://projects` 及
`codindex://projects/{id}/{overview,functions,features}`）供客户端直接挂载，
以及 **1 个 Prompt**（`codindex-guide`）用于注入使用指引。见
[docs/TOOLS.md](https://github.com/Bencibr/codindex/blob/main/docs/TOOLS.md#resources4-个)。

---

## 性能

**扫描**：优化后综合耗时 ~9s → ~3.5s（批量事务、批量 UPDATE、Map 索引替代嵌套循环）。
本仓库自扫描 3.4s，含进程启动。

**AI 效率**：我们跑了两轮，结论不一致，两个都放上来。

| 轮次 | 样本 | 工具调用 | 回传数据量 |
|---|---|---|---|
| 第一轮 | 单问题（架构概览） | 8 vs 17，**−53%** | 64KB vs 1.4MB，**−95%** |
| 第二轮 | 3 个问题 | 31 vs 28，**+11%** | — |

**能可靠省下来的**是单次回答的数据量：结构化查询返回几万字符，而不是几十万字符的源码。
这一点两轮都成立。
**不能承诺**的是调用次数一定下降——这取决于 Agent 是否真的信任并优先使用这些工具，
受提示词、模型版本影响。第一轮的 −53% 没能复现。完整记录在 `src/tests/bench/`。

---

## 常见问题

**它是向量检索 / RAG 吗？**
不是。没有 embedding、没有向量库、不调模型 API。`search_semantic` 这个名字容易误解，
它实际是基于调用图做 BFS：找到种子函数后把调用邻居一并返回，结果可复现、可审计。

**需要联网或上传代码吗？**
不需要。数据落在单个 SQLite 文件（默认 `data/codindex.db`）。

**和 LSP / IDE 跳转有什么不同？**
LSP 面向编辑器里的即时导航；Codindex 面向「把整个仓库结构一次性交给 AI」——
批量、可查询、可跨会话复用，还能算影响面、复用分和死代码。两者不冲突。

**数据会过期吗？**
`start_watching` 后文件变更 3 秒内同步。所有响应带 `lastModified`，可比对判断新鲜度。

### 装不上 / 跑不起来

| 症状 | 原因 | 处理 |
|---|---|---|
| `npm install` 报 `ERESOLVE could not resolve` | tree-sitter 各家语法包 peer 范围互斥（java `^0.21.1`、python/rust `^0.22.1`） | 仓库根 `.npmrc` 已写 `legacy-peer-deps=true`。若你删过或不在仓库根执行，加 `npm install --legacy-peer-deps` |
| `codindex` 命令找不到 | `npm i -g` 的 bin 目录不在 `PATH` | `npm config get prefix` 看前缀，把 `<prefix>/bin` 加进 `PATH` |
| 启动报端口被占用 | 3100 已被别的服务（含 IDE 插件）占了 | `PORT=3199 codindex` |
| MCP 连上但查不到数据 / 库是空的 | `CODINDEX_DB` 用了相对路径，MCP 子进程 cwd 与你的 shell 不同 | 一律写**绝对路径**；或干脆不设，用默认 `data/codindex.db` |
| 函数数是 0、文件数却不为 0 | 语言不在支持列表内，或单文件 > 1MB | 见[支持的语言](#支持的语言) |
| 改了代码但结果没变 | 没重扫，或没开监听 | 调 `scan_project_incremental`，或 `start_watching` |
| 想从零重来 | 派生数据可随时重建 | 停掉进程，删掉 `data/codindex.db*`，重新扫描 |

`.npmrc` 那条最容易踩：它只在**仓库根目录**执行 `npm install` 时生效，
在子目录或别的目录装会重新触发 `ERESOLVE`。

---

## 支持的语言

| 语言 | 扩展名 | 提取内容 |
|---|---|---|
| TypeScript | `.ts` `.tsx` | 函数/方法/箭头函数、调用边、类型、import |
| JavaScript | `.js` `.jsx` `.mjs` `.cjs` | 同上 |
| Python | `.py` | 函数/方法、调用边、类字段 |
| Go | `.go` | 函数/方法（receiver）、调用边、struct 字段 |
| Rust | `.rs` | 函数/方法、调用边、struct/enum 字段 |
| Java | `.java` | 方法、调用边、类字段 |

单文件上限 1MB。未列出的语言不会被索引——宁可少支持，也不做「文件数统计上了、
函数却一个都解析不出来」的虚假覆盖。

---

## 技术栈

Node.js ≥ 22.5 + TypeScript (ESM) · Tree-sitter · SQLite（内置 `node:sqlite`，
可选 better-sqlite3）+ Drizzle ORM + FTS5 · Hono · React 18 + MUI 5（CDN 直出，无前端构建）
· @modelcontextprotocol/sdk · chokidar · Vitest

---

## 文档

| 文档 | 内容 |
|---|---|
| [docs/](https://github.com/Bencibr/codindex/blob/main/docs/README.md) | 文档索引 —— 所有对外文档都收在这里 |
| [docs/TOOLS.md](https://github.com/Bencibr/codindex/blob/main/docs/TOOLS.md) | 32 个工具 + 4 个 Resource + 1 个 Prompt 的完整参考 |
| [docs/API.md](https://github.com/Bencibr/codindex/blob/main/docs/API.md) | Web API 路由、Web UI 页面、环境变量、PRD 功能追踪 |
| [docs/CONTRIBUTING.md](https://github.com/Bencibr/codindex/blob/main/docs/CONTRIBUTING.md) | 开发环境、提交流程、如何加语言 |
| [docs/SECURITY.md](https://github.com/Bencibr/codindex/blob/main/docs/SECURITY.md) | 漏洞报告渠道与安全边界 |
| [CHANGELOG.md](https://github.com/Bencibr/codindex/blob/main/CHANGELOG.md) | 变更记录 |
| [AGENTS.md](https://github.com/Bencibr/codindex/blob/main/AGENTS.md) / [CLAUDE.md](https://github.com/Bencibr/codindex/blob/main/CLAUDE.md) | 给 AI 助手的使用指南 |

开发常用命令：

```bash
npm run dev        # tsx 直跑，改代码即生效
npx tsc --noEmit   # 完整类型检查
npm test           # 14 files / 325 tests（用临时库，不碰 data/）
npm run build      # 产物在 dist/
codindex --help    # CLI 用法
```

---

## License

MIT
