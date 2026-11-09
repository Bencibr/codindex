# Codindex A/B 对照实验报告 v2

## 实验设计

- **3 个问题** × **2 个条件**（WITH / WITHOUT Codindex MCP）= 7 个 Sonnet 子 Agent
- 测试仓库：CodeGraph (colbymchenry/codegraph, 146 TS files)
- Codindex 索引：1,926 函数、6,101 调用边、239 类型
- 测试新增功能：`search_semantic`、`get_smart_context`、`search_code(summary)`

## 结果

| 问题 | WITH 调用 | WITHOUT 调用 | 差异 | WITH 答案 | WITHOUT 答案 |
|------|----------|-------------|------|----------|-------------|
| Q1 提取管线 | 24 | 24 | 0% | 6,287 chars | 3,420 chars |
| Q2 文件 I/O | 32 | 33 | -3% | 4,571 chars | 5,598 chars |
| Q3 修改评估 | 36 | 28 | **+29%** | 5,953 chars | 7,580 chars |
| **平均** | **31** | **28** | **+11%** | — | — |

## 关键发现

### 1. Codindex 没有减少工具调用

**WITH Codindex 平均 31 次调用，WITHOUT 平均 28 次。Codindex 反而多了 11%。**

根因：Codindex Agent 仍然大量使用 Bash/Read 工具：

| 问题 | Codindex 调用 | Bash 调用 | Read 调用 |
|------|-------------|----------|----------|
| Q1 | 8 | 7 | 7 |
| Q2 | 7 | 20 | 3 |
| Q3 | 8 | 16 | 12 |

**Agent 在使用 Codindex 工具后，仍然用 Bash/Read 验证和补充信息。** Codindex 没有替代内置工具，而是增加了额外开销。

### 2. 每个 Agent 都调用了 add_project + scan_project

所有 WITH Codindex Agent 都花 2 次调用做 `add_project` + `scan_project`，即使项目已索引。这说明 Agent 不知道项目已索引，或者 `get_project_summary` 仍然报错。

### 3. 答案质量对比

| 问题 | WITH 答案特点 | WITHOUT 答案特点 |
|------|-------------|-----------------|
| Q1 | 更长（6,287 chars），包含更多细节 | 较短（3,420 chars），更精炼 |
| Q2 | 较短（4,571 chars） | 更长（5,598 chars） |
| Q3 | 较短（5,953 chars） | 更长（7,580 chars） |

**答案质量没有显著差异。** Codindex 没有让答案更完整或更准确。

### 4. Codindex 工具的实际使用

| 工具 | 使用次数 | 效果 |
|------|---------|------|
| `search_code` | 11 次 | 用于搜索关键词，但 Agent 仍需 Read 验证 |
| `get_project_summary` | 3 次 | 用于获取概览，但 Agent 仍需 Bash 探索 |
| `get_function_list` | 3 次 | 用于列出函数，但 Agent 仍需 Read 理解 |
| `get_call_graph` | 1 次 | 用于调用链，效果未知 |
| `get_impact_analysis` | 1 次 | 用于影响分析，效果未知 |
| `add_project` | 3 次 | 浪费调用（项目已索引） |
| `scan_project` | 3 次 | 浪费调用（项目已索引） |

## 痛点分析

### 🔴 P0 — Codindex 是"额外开销"而非"替代方案"

**现象**：Agent 用 Codindex 获取信息后，仍然用 Bash/Read 验证。总调用数不减反增。

**根因**：
1. Agent 不信任 Codindex 返回的数据（可能因为之前的"Project not found"错误）
2. Codindex 返回的信息不够完整，Agent 需要补充细节
3. Agent 没有被明确指导"用 Codindex 替代 Read/Grep"

**影响**：Codindex 的核心价值（减少调用）没有实现。

### 🔴 P0 — Agent 浪费调用在 add_project + scan_project

**现象**：每个 Agent 都花 2 次调用注册+扫描项目，即使项目已索引。

**根因**：Agent 不知道项目已索引，或者 `get_project_summary` 报错导致 Agent 重新注册。

**影响**：每次对话浪费 2 次调用。

### 🟡 P1 — search_semantic 和 get_smart_context 未被使用

**现象**：Q2（文件 I/O）和 Q3（修改评估）应该分别使用 `search_semantic` 和 `get_smart_context`，但 Agent 用了 `search_code` + `get_function_list`。

**根因**：Agent 不知道新工具的存在，或者不理解何时使用它们。

**影响**：新功能没有被验证。

## 结论

**Codindex v2 的 A/B 实验结果令人失望。** 核心问题：

1. **Codindex 没有替代内置工具** — Agent 仍然大量使用 Bash/Read
2. **总调用数不减反增** — Codindex 是额外开销
3. **新功能未被验证** — `search_semantic` 和 `get_smart_context` 未被使用

**根本原因**：Agent 的行为模式是"先用 Codindex 获取概览，再用内置工具深入探索"，而不是"用 Codindex 替代内置工具"。这说明 Codindex 的信息密度不够高，无法让 Agent 一次调用就获得完整答案。

## 改进方向

### 短期

1. **提高信息密度** — `get_smart_context(explore)` 应该返回更多上下文（不只是摘要，还要返回关键代码片段）
2. **消除 add_project/scan_project 浪费** — 在 `listTools` 响应中包含项目状态
3. **Agent 指导优化** — 在 MCP instructions 中明确"用 Codindex 替代 Read/Grep"

### 中期

4. **验证 search_semantic** — 设计专门的语义搜索测试问题
5. **验证 get_smart_context** — 设计专门的智能上下文测试问题
6. **信息完整性提升** — 让 Codindex 返回的信息足够完整，不需要 Read 补充

### 长期

7. **答案生成** — Codindex 不只返回数据，还生成"答案"（类似 RAG）
8. **上下文压缩** — 把多个工具的结果压缩成一个精简的上下文包

---

*实验时间：2026-06-27*
*实验环境：Claude Code + Codindex MCP v2 + Sonnet sub-agents*
*测试仓库：CodeGraph (colbymchenry/codegraph, commit 7a361ef)*
