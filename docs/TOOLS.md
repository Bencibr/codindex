# MCP 接口参考

Codindex 通过 MCP (stdio) 暴露三类接口：

| 接口 | 数量 | 用途 |
|---|---|---|
| **Tools** | 32 | 主动调用：5 个操作类 + 27 个查询类 |
| **Resources** | 4 | 被动读取：让 AI 直接挂载项目数据，无需先调用工具 |
| **Prompts** | 1 | 一次性注入使用指引，帮 AI 自我引导 |

所有按 `func_name` 定位函数的工具共用一套[名称解析规则](#函数名解析契约)。

---

## 核心工具：get_smart_context

最常用的一个，按 `purpose` 返回不同深度的上下文，避免为了拿一点信息而整段读源码：

| purpose | 返回内容 | 适用场景 |
|---|---|---|
| `explore` | 摘要 + 文件 + 复杂度 + 调用者计数 | 快速了解函数做什么（最轻量） |
| `understand` | + callers + callees + 相关类型 | 理解函数在系统中的角色 |
| `modify` | + 完整源码 + 影响文件列表 | 修改函数前的完整评估 |

---

## 操作类 (5)

| 工具 | 参数 | 说明 |
|---|---|---|
| `add_project` | name, path, prdPath? | 注册项目 |
| `scan_project` | project_id | 全量扫描 |
| `scan_project_incremental` | project_id | 增量扫描（仅变更文件） |
| `start_watching` | project_id | 启动文件监听（变更自动同步，debounce 3s） |
| `stop_watching` | project_id | 停止文件监听 |

## 查询类 (27)

| 工具 | 参数 | 说明 |
|---|---|---|
| `get_smart_context` | project_id, func_name, purpose? | **智能上下文**：explore(摘要) / understand(调用) / modify(完整) |
| `get_project_summary` | project_id | 架构概览（模块树、统计、top5 复杂度、语言分布） |
| `get_architecture_guide` | project_id, max_modules?, max_hotspots? | 架构全景（入口点 + 模块树 + 依赖流 + 热点） |
| `get_function_list` | project_id, module?, sort?, filter_test? | 函数清单（含 body、标签、复用分） |
| `get_function_body` | project_id, func_name | 读函数源码实现 |
| `get_function_context` | project_id, func_name, depth?, include_body?, include_callers?, include_callees?, include_types?, include_file_info? | 函数上下文包（body + callers + callees + types） |
| `get_context_bundle` | project_id, func_name, include? | 可配置上下文包（含影响分析与测试覆盖） |
| `get_call_graph` | project_id, func_name, depth? | 调用链（调用了谁、被谁调用） |
| `get_impact_analysis` | project_id, func_name | 影响分析（直接/间接调用者 + 受影响文件） |
| `get_bulk_impact` | project_id, func_names | 多函数批量影响分析 |
| `get_module_deps` | project_id | 模块依赖图 + DFS 循环依赖检测（任意长度环） |
| `get_cfg` | project_id, func_name | 控制流图（CFG）：分支/循环节点 + true/false 边 |
| `search_code` | project_id, query, scope? | 全文搜索函数名/函数体/文件路径/语义摘要，结果含 callers/callees |
| `search_semantic` | project_id, query, max_results? | **语义簇搜索**：基于 call graph BFS，种子函数 → 扩展调用邻居 |
| `find_similar_functions` | project_id, func_name, min_complexity? | 模糊搜索相似函数 |
| `get_reuse_report` | project_id, score_min?, limit? | 复用评分排行 |
| `get_hotspots` | project_id, complexity_min?, min_lines?, module?, limit? | 高复杂度函数（需重构） |
| `get_dead_code` | project_id, include_unexported?, include_exported? | 死代码检测（默认仅非导出函数） |
| `get_export_inventory` | project_id, module? | 导出符号清单（含未使用导出检测） |
| `get_type_info` | project_id, type_name | 类型/接口/结构体详情 |
| `get_type_usage` | project_id, type_name | 类型使用追踪 |
| `get_test_coverage` | project_id, module? | 测试覆盖报告 |
| `get_raise_sites` | project_id, error_type?, func_name?, limit? | 异常路径：按异常类型反查抛出点，或按函数查它抛什么 |
| `get_feature_tracking` | project_id, feature_id? | 功能完成度追踪 |
| `get_change_guide` | project_id, func_name | 变更指南（PRD 影响） |
| `get_file_content` | project_id, file_path | 读文件内容（截断 50KB） |
| `get_bridge_map` | project_id | Tauri/Electron 桥接映射 |

---

## 工具选择指南

| 你想知道什么 | 首选工具 | 备选 |
|---|---|---|
| 项目整体架构 | `get_architecture_guide` | `get_project_summary` |
| 某个函数做什么 | `get_smart_context(explore)` | `get_function_body` |
| 谁调用了这个函数 | `get_call_graph` | `get_impact_analysis` |
| 修改会影响什么 | `get_smart_context(modify)` | `get_impact_analysis` |
| 找某个功能的代码（语义） | `search_semantic` | `search_code` |
| 找某个功能的代码（关键词） | `search_code` | `find_similar_functions` |
| 某个异常从哪抛出 | `get_raise_sites`（error_type） | `search_code` |
| 某函数会抛哪些异常 | `get_raise_sites`（func_name） | `get_function_body` |
| 有哪些可复用代码 | `get_reuse_report` | `find_similar_functions` |
| 有哪些高复杂度函数 | `get_hotspots` | — |
| 全面了解函数上下文 | `get_function_context` | `get_context_bundle` |

---

## Resources（4 个）

工具需要 AI「主动调用」，Resource 则是「被动挂载」——支持 MCP Resources 的客户端
（Claude Code、Cursor 等）可以让用户或 AI 直接把某个 URI 当作上下文读入，
少一次工具往返。

| URI | 返回 |
|---|---|
| `codindex://projects` | 全部已注册项目列表（原始行，含 id / path / status / prdPath） |
| `codindex://projects/{id}/overview` | 单个项目的基本信息 + 文件数 + 函数数 |
| `codindex://projects/{id}/functions` | 该项目全部函数（**上限 500 条**，超出请改用 `get_function_list`） |
| `codindex://projects/{id}/features` | 该项目的 PRD 功能追踪条目 |

`{id}` 就是 `codindex://projects` 返回的 `id` 字段。

> `functions` 资源固定截断 500 条且不支持分页 —— 它是「快速看一眼」的入口，
> 完整清单请用 `get_function_list`（支持 `module` / `sort` / `filter_test`）。
> 未知 URI 会抛 `Unknown resource: <uri>`。

## Prompts（1 个）

| 名称 | 作用 |
|---|---|
| `codindex-guide` | 注入一份使用指引：什么时候该用 Codindex、各工具怎么选、推荐工作流 |

它不返回查询结果，只返回一段给模型看的说明文本。适合在新会话开头注入一次，
让 AI 知道「先查索引，别急着 grep」。Claude Code 里可用 `/mcp__codindex__codindex-guide`
调用（不同客户端语法略有差异，以各自文档为准）。

---

## 函数名解析契约

所有按 `func_name` 定位函数的工具使用同一套解析规则：

1. **精确匹配唯一** → 直接返回结果。
2. **精确匹配多个** → 返回 `{ resolved: false, reason: "ambiguous", candidates: [...] }`，
   **不抛错**。每个候选项自带 `handle`（形如 `path/to/file.py:func_name`），
   把它作为 `func_name` 重新调用即可一次命中。候选按「生产代码优先、测试靠后」排序。
3. **无精确匹配** → 退化为子串模糊匹配；仍多义则同上返回候选。
4. **完全没有** → 返回 `{ resolved: false, reason: "not_found", candidates: [] }`。

该设计避免 AI 拿到异常文本后再猜一次语法：一次调用就能拿到全部决策信息
（文件、行号、签名、是否测试），把两次往返压成一次。

---

## 函数语义摘要

每个函数在扫描时自动生成**一行语义摘要**，基于规则引擎（跨语言、不需要注释）：

| 信号 | 示例 | 推断 |
|---|---|---|
| 函数名 | `parseConfig` | "parse" |
| 调用的函数 | 调用 `fs.readFile` | "file I/O" |
| 复杂度 | complexity > 15 | "high complexity" |

摘要存储在 `functions` 表的 `summary` 字段，所有查询工具都可返回。

## 变更感知

MCP 响应包含 `lastModified` 时间戳，表示数据最后更新时间。配合 `start_watching` 使用：

```
start_watching { project_id }
→ 文件变更后 3 秒自动同步
→ AI 查询时比对 lastModified 判断数据是否过期
```

---

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
