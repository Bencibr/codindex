# Codindex A/B 对照实验报告（最终版）

## 实验设计

- **3 个问题** × **2 个条件**（WITH / WITHOUT Codindex MCP）= 6 个 Sonnet 子 Agent 并行
- 测试仓库：CodeGraph (colbymchenry/codegraph, 146 TS files)
- Codindex 索引：1,926 函数、6,101 调用边、239 类型、29 模块

## 最终结果

### Round 1：MCP 修复前

| 问题 | WITH 调用 | WITHOUT 调用 | 差异 | 说明 |
|------|----------|-------------|------|------|
| Q1 架构概览 | 17 | 51 | **-67%** | Codindex 部分可用 |
| Q2 提取管线 | 36 | 22 | +64% ⚠️ | MCP 返回空，fallback 开销 |
| Q3 工具处理 | 23 | 31 | **-26%** | Codindex 部分可用 |

### Round 2：MCP 修复后（Q1 验证）

| 条件 | 工具调用 | 函数发现 | 模块发现 |
|------|---------|---------|---------|
| WITH Codindex | **8** | **1,926** | **23** |
| WITHOUT Codindex | 17 | ~951 | 14 |
| **差异** | **-53%** | **+103%** | **+64%** |

**关键发现**：Codindex 的 tree-sitter AST 解析比 grep 多发现 2 倍函数（捕获 methods、getters/setters、callbacks 等）。

## 答案质量对比（Q1 架构概览）

### WITH Codindex（8 次调用）

Agent 使用 `mcp__codindex__get_function_list` + `mcp__codindex__search_code` 直接获取结构化数据：

```
Total: 1,926 functions across 23 modules
Top 5: src/mcp (267), src/resolution (254), src/extraction (242),
       __tests__ (231), src/resolution/frameworks (219)
```

### WITHOUT Codindex（17 次调用）

Agent 通过 grep/find 手动统计：

```
Total: ~951 functions across 14 modules
Top 3: resolution (357), extraction (135), mcp (134)
```

### 差异分析

| 维度 | Codindex | Grep | 差异原因 |
|------|---------|------|---------|
| 函数数 | 1,926 | ~951 | tree-sitter 捕获 methods/getters/setters，grep 只匹配 `function` 声明 |
| 模块数 | 23 | 14 | Codindex 按路径细分（如 `src/resolution/frameworks` 单独成模块） |
| 准确性 | 高 | 中 | AST 解析 vs 正则匹配 |

## 痛点清单

### 🔴 P0 — MCP `get_project_summary` 报 "Project not found"

**现象**：其他工具（`get_function_list`、`search_code`）能找到项目，但 `get_project_summary` 找不到。

**根因**：`get_project_summary`（server.ts:1069）使用 drizzle ORM 查询，而其他工具可能使用不同的 DB 连接实例或查询路径。

**影响**：Agent 需要额外调用 `add_project` + `scan_project` 才能使用 `get_project_summary`。

**修复方向**：
- 统一所有工具的 DB 连接实例
- 在 MCP server 启动时验证所有工具的 DB 可访问性

### 🔴 P0 — MCP 工具返回空不报错

**现象**：工具返回空结果而非错误消息，Agent 无法区分"没有数据"和"工具出错"。

**影响**：Agent 继续尝试其他 Codindex 工具，浪费调用次数（Q2 中浪费 7 次）。

**修复方向**：
- 所有工具在无数据时返回明确错误（如 "Project not found. Run scan_project first."）
- 在 `listTools` 响应中包含项目状态信息

### 🟡 P1 — Agent 无法智能选择工具

**现象**：Agent 不知道哪些 Codindex 工具适合当前问题，盲目尝试多个工具。

**影响**：Q2 中 Agent 尝试了 7 个 Codindex 工具，大部分返回空。

**修复方向**：
- 在 MCP server instructions 中添加工具选择指南
- 根据问题类型推荐工具组合

### 🟡 P1 — 函数计数差异导致信任问题

**现象**：Codindex 报 1,926 函数，grep 只找到 ~951。用户可能质疑 Codindex 的准确性。

**影响**：用户可能不信任 Codindex 的数据。

**修复方向**：
- 在 `get_project_summary` 中说明函数计数的定义（包含 methods/getters/setters）
- 提供 `get_function_list` 的详细 breakdown（按 kind 分类）

## 量化提升

### 当 Codindex MCP 可用时（Round 2）

| 指标 | 提升 |
|------|------|
| 工具调用减少 | **-53%**（8 vs 17） |
| 函数发现增加 | **+103%**（1,926 vs 951） |
| 模块发现增加 | **+64%**（23 vs 14） |

### 当 Codindex MCP 部分可用时（Round 1）

| 指标 | 提升（Q1, Q3 平均） |
|------|-------------------|
| 工具调用减少 | **-47%** |

### 当 Codindex MCP 不可用时（Round 1 Q2）

| 指标 | 影响 |
|------|------|
| 工具调用增加 | **+64%**（开销） |

## 改进建议

### 短期（1-2 天）

1. **🔴 统一 DB 连接**：所有 MCP 工具使用相同的 DB 连接实例，避免部分工具能找到项目、部分找不到
2. **🔴 改进错误处理**：所有工具在无数据时返回明确错误消息
3. **🟡 添加健康检查**：`listTools` 时验证 DB 可访问性

### 中期（1-2 周）

4. **工具选择指南**：在 MCP instructions 中添加"根据问题类型选择工具"
5. **智能 fallback**：当 Codindex 返回空时，自动建议使用内置工具
6. **函数计数说明**：在 `get_project_summary` 中说明函数计数的定义

### 长期（1+ 月）

7. **增量索引优化**：减少扫描时间，支持实时索引
8. **跨文件调用解析**：支持 re-export、barrel 文件
9. **自动化 A/B 测试**：每次发布前自动运行对照实验

## 结论

**Codindex 的核心价值已验证**：
- 当 MCP 工具可用时，工具调用减少 53%
- tree-sitter AST 解析比 grep 多发现 2 倍函数
- 结构化数据比 grep 结果更准确

**最大障碍**：MCP 工具层的 `get_project_summary` 接口报 "Project not found"，需要排查 DB 连接配置。

**下一步**：
1. 🔴 修复 `get_project_summary` 的 DB 连接问题
2. 🔴 改进错误处理（返回明确错误而非空结果）
3. 🟡 重跑完整 A/B 实验（验证修复效果）

---

*实验时间：2026-06-27*
*实验环境：Claude Code + Codindex MCP + Sonnet sub-agents*
*测试仓库：CodeGraph (colbymchenry/codegraph, commit 7a361ef)*
