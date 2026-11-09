# Codindex — AI 使用指南

## 这是什么

Codindex 是一个代码索引管理系统。它扫描整个代码库，构建函数清单、调用关系（血缘）、模块依赖图、复用评分、功能追踪台账和**函数语义摘要**，存储在 SQLite 数据库中。支持文件监听自动同步。

## 为什么要使用 Codindex

- **加速 AI 理解项目** — 不需要 AI 从头扫描整个代码库，直接从 Codindex 查询函数清单、调用链、模块结构
- **减少重复编码** — 通过 `find_similar_functions` 和 `get_reuse_report` 发现项目中已有可复用的代码
- **精准定位** — 给定一个功能点（如"用户登录"），直接看到哪些函数已经实现、哪些缺失
- **架构分析** — 模块依赖图和循环依赖检测帮你发现架构问题
- **修改安全** — `get_impact_analysis` + `get_call_graph` 在修改函数前评估影响范围
- **实时同步** — `start_watching` 启动文件监听，变更自动同步到数据库
- **智能上下文** — `get_smart_context` 根据用途（探索/理解/修改）返回不同深度的上下文

## 工具总览 (32个)

分类口径与 `README.md`、`docs/TOOLS.md` 完全一致：6 组，合计 32 个。

| 类别 | 数量 | 工具 |
|---|---|---|
| 上下文与读取 | 6 | `get_smart_context`（三档深度）、`get_context_bundle`、`get_function_context`、`get_function_body`、`get_function_list`、`get_file_content` |
| 调用与影响 | 5 | `get_call_graph`、`get_impact_analysis`、`get_bulk_impact`、`get_dead_code`、`get_raise_sites` |
| 搜索 | 3 | `search_code`（FTS5 全文）、`search_semantic`（调用图 BFS 语义簇）、`find_similar_functions` |
| 结构 | 8 | `get_project_summary`、`get_architecture_guide`、`get_module_deps`、`get_cfg`、`get_type_info`、`get_type_usage`、`get_export_inventory`、`get_bridge_map` |
| 质量与追踪 | 5 | `get_hotspots`、`get_reuse_report`、`get_test_coverage`、`get_change_guide`、`get_feature_tracking` |
| 扫描 | 5 | `add_project`、`scan_project`、`scan_project_incremental`、`start_watching`、`stop_watching` |
| **合计** | **32** | |

## 核心功能：get_smart_context

`get_smart_context` 是最常用的工具，根据用途返回不同深度的上下文：

| purpose | 返回内容 | 适用场景 |
|---------|---------|---------|
| `explore` | 函数摘要 + 文件 + 复杂度 + 调用者计数 | 快速了解函数做什么（最轻量） |
| `understand` | + callers 列表 + callees 列表 + 相关类型 | 理解函数在系统中的角色 |
| `modify` | + 完整源码 body + 影响文件列表 | 修改函数前的完整评估 |

```
# 快速了解函数做什么
get_smart_context { project_id, func_name: "handleExplore", purpose: "explore" }
→ { name: "handleExplore", summary: "handle · high complexity · long function", complexity: 139, callers: 5, callees: 12 }

# 理解函数的调用关系
get_smart_context { project_id, func_name: "handleExplore", purpose: "understand" }
→ + callers: [{name: "handleTool", ...}], callees: [{name: "findRelevantContext", ...}], relatedTypes: [...]

# 修改前完整评估
get_smart_context { project_id, func_name: "handleExplore", purpose: "modify" }
→ + body: "function handleExplore(...) {...}", impactedFiles: ["src/mcp/tools.ts", "src/mcp/engine.ts"]
```

## 函数语义摘要

每个函数在扫描时自动生成**一行语义摘要**，基于规则引擎（跨语言、不需要注释）：

| 信号 | 示例 | 推断 |
|------|------|------|
| 函数名 | `parseConfig` | "parse" |
| 调用的函数 | 调用 `fs.readFile` | "file I/O" |
| 调用者 | 被 `loadConfig` 调用 | 上下文推断 |
| 复杂度 | complexity > 15 | "high complexity" |

摘要存储在 `functions` 表的 `summary` 字段，所有查询工具都可返回。

## 变更感知

MCP 响应中包含 `lastModified` 时间戳，表示数据的最后更新时间。如果 `lastModified` 远早于当前时间，数据可能过期。

```
start_watching { project_id }
→ 文件变更后 3 秒自动同步

# AI 查询时检查 lastModified
get_smart_context { ... }
→ { ..., lastModified: 1719500000 }
```

## AI 编程场景

### 场景 1: 首次接触项目
```
get_project_summary { project_id }
→ 架构概览：290文件、1926函数、29模块、语言分布

get_module_deps { project_id }
→ 模块依赖图 + 循环依赖

search_code { project_id, query: "关键功能名" }
→ 找到相关函数和文件
```

### 场景 2: 快速了解函数（推荐）
```
get_smart_context { project_id, func_name: "scanProject", purpose: "explore" }
→ 一行摘要："handle · file I/O · complex logic"
→ 不需要读原始代码就能知道这个函数做什么
```

### 场景 3: 快速了解函数（全面上下文包）
```
# 一次调用获得 body + callers + callees + 类型 + 文件信息 + 测试
get_function_context { project_id, func_name: "scanProject", depth: 2 }
→ { 
  body: "...", callees: [ "buildModuleGraph", "detectLanguage", ... ], 
  callers: [ "main", "createMcpServer", ... ],
  relatedTypes: [ "ScanBatch", "FileStats", "GitStats" ]
}

# 或使用 context_bundle（更全面，含影响分析和测试覆盖率）
get_context_bundle { project_id, func_name: "scanProject", include: { body: true, impact: true, callGraph: true, types: true, tests: true } }
```

### 场景 4: 控制流分析
```
# 获取函数的 CFG — 条件分支、循环、节点和边
get_cfg { project_id, func_name: "walkStatement" }
→ { nodes: 41, branches: 1, loops: 0, edges: 64 }
```

### 场景 5: 修改函数前评估
```
get_smart_context { project_id, func_name: "getDb", purpose: "modify" }
→ 完整源码 + 调用者 + 受影响文件列表

get_impact_analysis { project_id, func_name: "getDb" }
→ getDb 被 5 个函数调用，跨 4 个文件

get_bulk_impact { project_id, func_names: ["scanProject", "scanFile"] }
→ 多函数批量影响分析
```

### 场景 6: 找已有代码复用
```
search_code { project_id, query: "formatDate" }
→ 找到 formatDate 函数 + 相关文件
注意：query 参数必填且不能为空字符串，否则抛错误

find_similar_functions { project_id, func_name: "format" }
→ 名称类似函数列表

get_reuse_report { project_id, score_min: 80 }
→ 高复用函数排行，优先考虑复用
```

### 场景 7: 持续开发（推荐）
```
start_watching { project_id }
→ 文件监听启动，变更自动同步

# 开发中...每次保存文件后 3 秒自动更新数据库

stop_watching { project_id }
→ 停止监听
```

## MCP 命令序列

### 1. 注册并扫描项目

```
> add_project { name: "项目名", path: "/absolute/path" }
→ { id: "uuid" }

> scan_project { project_id: "uuid" }
→ { files: 42, functions: 156, calls: 89, types: 23 }
```

### 2. 了解项目架构

```
> get_project_summary { project_id: "uuid" }
→ { stats: {files:42, functions:156, ...}, modules: [...], topComplexFunctions: [...] }

> get_module_deps { project_id: "uuid" }
→ 模块列表、依赖边、循环依赖
```

### 3. 快速了解函数（新）

```
> get_smart_context { project_id: "uuid", func_name: "getDb", purpose: "explore" }
→ { name:"getDb", summary:"get · database", file:"src/db/connection.ts", complexity:2, callers:5 }
```

### 4. 修改函数前

```
> get_smart_context { project_id: "uuid", func_name: "getDb", purpose: "modify" }
→ { body:"function getDb(...){...}", callers:[...], impactedFiles:[...] }

> get_impact_analysis { project_id: "uuid", func_name: "getDb" }
→ { directCallers:[...], indirectCallers:[...], affectedFiles:[...] }
```

### 5. 搜索代码

```
> search_code { project_id: "uuid", query: "用户认证" }
→ { functions:[...], files:[...] }
```

### 6. 启动文件监听

```
> start_watching { project_id: "uuid" }
→ { status: "watching", message: "Watching /path/to/project for changes (debounce 3000ms)" }
```

## Web UI

打开 http://localhost:3100 获得相同的可视化功能：

| 功能 | Web UI 入口 |
|---|---|
| 函数清单 | 项目 → 📋 函数（`/projects/:id/functions`） |
| 文件浏览器 | 项目 → 📁 文件（`/projects/:id/files`） |
| 调用关系 | 函数详情页 → 调用/被调用 |
| 复用报告 | 项目 → ⭐ 复用（`/projects/:id/reuse`） |
| 依赖图 | 项目 → 🔗 依赖图（`/projects/:id/deps`） |
| 功能追踪 | 项目 → 🎯 功能（`/projects/:id/features`） |
| 控制流图 | 项目 → CFG（`/projects/:id/cfg`） |
| 流程图 | 项目 → 流程图（`/projects/:id/flowchart`） |

所有页面通过 SPA 路由加载，支持直接 URL 访问。

## 数据格式

所有 MCP 工具返回 JSON。函数对象的关键字段：

```json
{
  "name": "formatDate",
  "fullName": "formatDate",
  "kind": "function",
  "signature": "formatDate(d: Date)",
  "summary": "format · file I/O",
  "body": "function formatDate(d: Date): string {\n  return d.toISOString().split('T')[0];\n}",
  "lineStart": 12,
  "lineEnd": 14,
  "complexity": 2,
  "paramsCount": 1,
  "linesCount": 3,
  "isExported": true,
  "isTest": false,
  "reuseScore": 92,
  "docComment": "/** Format a date */",
  "tags": "[\"@feature:data\"]"
}
```

## 工具选择指南

根据问题类型选择合适的工具：

| 你想知道什么 | 首选工具 | 备选工具 |
|---|---|---|
| 项目整体架构 | `get_architecture_guide` | `get_project_summary` |
| 模块间依赖关系 | `get_module_deps` | — |
| 某个函数做什么 | `get_smart_context(explore)` | `get_function_body` |
| 谁调用了这个函数 | `get_call_graph` | `get_impact_analysis` |
| 修改会影响什么 | `get_smart_context(modify)` | `get_impact_analysis` |
| 找某个功能的代码（语义） | `search_semantic` | `search_code` |
| 找某个功能的代码（关键词） | `search_code` | `find_similar_functions` |
| 有什么高复杂度函数 | `get_hotspots` | — |
| 有什么可复用代码 | `get_reuse_report` | `find_similar_functions` |
| 函数控制流分析 | `get_cfg` | — |
| 全面了解函数上下文 | `get_function_context` | `get_context_bundle` |

## 性能基准

### 扫描性能（审计优化后）

| 优化项 | 优化前 | 优化后 | 提升 |
|------|--------|--------|------|
| 函数/调用边 INSERT | 逐条插入 | 批量事务 | **~50%** |
| 复用评分 UPDATE | 逐条更新 | CASE/WHEN 批量 | **~15%** |
| 类型使用边 | O(funcs×types) 嵌套循环 | Map 索引 + 批量 | **O(N²)→O(N)** |
| search_code enrichment | 50函数×3查询=150查询 | 3次批量 IN 查询 | **~500ms→~20ms** |
| 综合扫描时间 | ~9s | ~3.5s | **~60%** |

### AI 工具效率（CodeGraph 项目，146 TS files, 1926 functions）

| 指标 | Codindex MCP | 直接读文件 | 提升 |
|------|-------------|-----------|------|
| 工具调用 | 8 | 17 | **-53%** |
| 函数发现 | 1,926 | ~951 | **+103%** |
| 数据传输 | ~64KB | ~1.4MB | **-95%** |

## 安全审计

| 修复 | 描述 |
|------|------|
| C1 | `collectSourceFiles` 改用 `spawnSync` 消除 shell 命令注入 |
| H5/H6 | 全部 LIKE 查询添加 `escapeLike()` 防止通配符注入 |
| H8 | CORS 限制为 localhost origin |
| M10 | 错误消息通用化，不泄露内部路径 |
| F1 | FTS5 索引构建修复 — `const sqlite` 重新赋值导致运行时崩溃 |
| F2 | `get_project_summary` 返回 `lastModified` 修复 — 查询投影补充 `lastScanned` |
| F3 | `get_file_content` 错误信息修复 — 恢复原始 `err.message` |
| F4 | `search_code` 空 query 修复 — 从返回 200 OK 改为抛错误 |
| F5 | `get_call_graph` 死代码清理 — 移除冗余 `targetFile` 变量 |
| F6 | catch 块类型安全 — `catch (e)` → `catch (err: unknown)` |

## 自回归测试

使用 `/skill regression-test` 启动全功能回归测试。

Skill 文件：[.claude/skills/regression-test/SKILL.md](.claude/skills/regression-test/SKILL.md)
测试报告：[docs/REGRESSION-REPORT.md](docs/REGRESSION-REPORT.md)

触发条件：
- 用户说"跑回归测试"、"全功能测试"、"自回归"
- 重大重构后需要验证所有功能
- 发布前的质量检查

使用方式：
```
/skill regression-test
args: {"project_path": "/path/to/test/project", "scope": "full"}
```

**铁律：全程自主执行，不要停下来问用户。发现 bug → 修复 → 继续，直到全部通过或达到轮次上限。**

## 提示

- 新增项目后先 `scan_project` 再查询
- **快速了解函数用 `get_smart_context(explore)`**，不需要读原始代码
- **修改函数前用 `get_smart_context(modify)`**，获取完整源码 + 影响分析
- **全面评估用 `get_function_context`** — 一次调用获得 body + callers + callees + types + file info + tests
- `get_context_bundle` 更全面，包含 body + impact + call graph + types + tests + **测试覆盖率**
- `search_code` 的 `query` 参数必填且不能为空字符串，否则会抛 `query is required` 错误
- `search_semantic` 基于调用图的语义簇搜索，找相关代码首选
- `start_watching` 启动后文件变更自动同步，开发时推荐始终开启
- 复用评分 ≥85 的函数可以直接复用，≥60 的稍作抽象后可用
- `scan_project_incremental` 只扫描变更文件，比全量扫描快得多
- `get_dead_code` 默认检测未被调用的非导出函数，`include_exported=true` 可包含导出函数
- `get_module_deps` 使用 DFS 检测任意长度的循环依赖链
- 检查 `lastModified` 字段判断数据是否过期
