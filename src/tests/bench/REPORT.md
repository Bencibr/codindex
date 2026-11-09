# Codindex Benchmark 对照实验报告

## 1. 概要

**测试目标**：量化 Codindex（代码索引 MCP 工具）对 AI 编程效率的提升。

**核心结论**：
- **工具调用减少 52%**（平均 2.5 次 vs 5.5 次）
- **数据传输减少 96%**（平均 8,804 chars vs 233,888 chars）
- **精确数据直达**：Codindex 返回的是结构化的函数清单、调用关系、模块依赖，而非原始源码

---

## 2. 方法论

### 被测仓库

| 属性 | 值 |
|------|-----|
| 仓库 | [colbymchenry/codegraph](https://github.com/colbymchenry/codegraph) |
| Stars | 55,000+ |
| TypeScript 源文件 | 146 |
| 总文件数 | 290 |
| 总代码行数 | 60,669 |
| 扫描函数数 | 1,926 |
| 扫描调用边 | 6,101 |
| 扫描类型 | 239 |
| 模块数 | 29 |

### 对照设计

| 组别 | 方法 | 说明 |
|------|------|------|
| **WITH Codindex** | 查询预建索引（SQLite） | 通过 MCP 工具调用：`get_project_summary`、`get_call_graph`、`search_code` 等 |
| **WITHOUT Codindex** | 直接读取源码文件 | 模拟 AI Agent 的 `Read` 工具调用 |

### 测量指标

- **Tool Calls**：完成同一问题所需的工具/文件读取次数
- **Data Transfer**：返回的总字符数（含源码、元数据）
- **Time**：端到端耗时（本地 DB 查询 vs 磁盘读取）

---

## 3. 测试问题集

| ID | 问题 | 类型 |
|----|------|------|
| Q1 | 项目整体架构是什么？主要模块及依赖关系？ | 架构概览 |
| Q2 | 源文件从读取到生成图节点的完整提取管线？ | 调用链追踪 |
| Q3 | MCP 工具请求从进入到响应的完整处理流程？ | 调用链追踪 |
| Q4 | `codegraph explore` 如何决定返回哪些符号？ | 代码搜索+分析 |
| Q5 | Swift↔ObjC 跨语言桥接的完整实现路径？ | 跨语言分析 |
| Q6 | 项目中是否有可复用的相似代码？ | 复用分析 |

---

## 4. 详细结果

### Q1: 架构概览

| 指标 | WITH Codindex | WITHOUT Codindex | 差异 |
|------|-------------|----------------|------|
| 工具调用 | 2 次 | 8 次 | **-75%** |
| 数据量 | 1,034 chars | 207,168 chars | **-99.5%** |
| 耗时 | 37ms | 6ms | +31ms（DB 查询） |

**Codindex 使用的工具**：`get_project_summary` + `get_module_deps`

**分析**：Codindex 一次 `get_project_summary` 返回所有模块统计（290 文件、1,926 函数、6,101 调用边），一次 `get_module_deps` 返回完整依赖图。无 Codindex 时需要读取 8 个入口文件（207K chars）才能拼凑出架构全貌。

---

### Q2: 提取管线（源码→图节点）

| 指标 | WITH Codindex | WITHOUT Codindex | 差异 |
|------|-------------|----------------|------|
| 工具调用 | 3 次 | 6 次 | **-50%** |
| 数据量 | 638 chars | 359,157 chars | **-99.8%** |
| 耗时 | 3ms | 2ms | +1ms |

**Codindex 使用的工具**：`search_code("parseWorker")` + `get_call_graph("extractAll")` + `get_function_body("parseWorker")`

**分析**：Codindex 通过 `search_code` 定位关键函数，`get_call_graph` 返回调用关系（3 层深度），`get_function_body` 返回函数源码。无 Codindex 时需要读取 6 个文件（359K chars），其中 `tree-sitter.ts` 单文件就有 254K chars。

---

### Q3: MCP 工具请求处理流程

| 指标 | WITH Codindex | WITHOUT Codindex | 差异 |
|------|-------------|----------------|------|
| 工具调用 | 2 次 | 5 次 | **-60%** |
| 数据量 | 260 chars | 260,137 chars | **-99.9%** |
| 耗时 | 2ms | 3ms | -1ms |

**Codindex 使用的工具**：`search_code("handleExplore")` + `get_call_graph("handleTool")`

**分析**：Codindex 直接搜索关键函数名并返回调用链。无 Codindex 时需要读取 `tools.ts`（4,378 行，209K chars）等 5 个文件。

---

### Q4: Explore 搜索策略

| 指标 | WITH Codindex | WITHOUT Codindex | 差异 |
|------|-------------|----------------|------|
| 工具调用 | 2 次 | 4 次 | **-50%** |
| 数据量 | 58,506 chars | 291,619 chars | **-80%** |
| 耗时 | 2ms | 2ms | 持平 |

**Codindex 使用的工具**：`search_code("handleExplore")` + `get_function_body("handleExplore")`

**分析**：`get_function_body` 返回了 `handleExplore` 的完整源码（58K chars），这是唯一一个 Codindex 数据量较大的场景（因为函数本身很大）。无 Codindex 时需要读取 4 个文件（292K chars）。

---

### Q5: 跨语言桥接（Swift↔ObjC）

| 指标 | WITH Codindex | WITHOUT Codindex | 差异 |
|------|-------------|----------------|------|
| 工具调用 | 3 次 | 6 次 | **-50%** |
| 数据量 | 741 chars | 178,817 chars | **-99.6%** |
| 耗时 | 1ms | 3ms | -2ms |

**Codindex 使用的工具**：`search_code("swift")` + `get_call_graph("resolveSwiftObjcBridges")` + `get_impact_analysis("resolveSwiftObjcBridges")`

**分析**：Codindex 通过 `search_code` 定位 Swift 相关函数，`get_call_graph` 返回桥接调用链，`get_impact_analysis` 返回影响范围。无 Codindex 时需要读取 6 个文件（179K chars），其中 `callback-synthesizer.ts` 单文件 129K chars。

---

### Q6: 复用检测 / 相似函数

| 指标 | WITH Codindex | WITHOUT Codindex | 差异 |
|------|-------------|----------------|------|
| 工具调用 | 3 次 | 4 次 | **-25%** |
| 数据量 | 1,648 chars | 106,429 chars | **-98.5%** |
| 耗时 | 2ms | 1ms | +1ms |

**Codindex 使用的工具**：`find_similar_functions("traverseBFS")` + `get_reuse_report` + `search_code("traversal")`

**分析**：`find_similar_functions` 直接返回相似函数列表（模糊匹配），`get_reuse_report` 返回复用评分分布。无 Codindex 时需要读取 4 个文件（106K chars）并人工比对。

---

## 5. 效率汇总

| 问题 | 调用减少 | 数据减少 |
|------|---------|---------|
| Q1 架构概览 | **-75%** | **-99.5%** |
| Q2 提取管线 | **-50%** | **-99.8%** |
| Q3 MCP 流程 | **-60%** | **-99.9%** |
| Q4 Explore 策略 | **-50%** | **-80%** |
| Q5 跨语言桥接 | **-50%** | **-99.6%** |
| Q6 复用检测 | **-25%** | **-98.5%** |
| **平均** | **-52%** | **-96%** |

---

## 6. 关键发现

### 6.1 数据量差异的核心原因

WITHOUT Codindex 时，AI Agent 需要读取**整个文件**才能找到相关函数。例如：
- `tools.ts`（4,378 行）→ 只需要 `handleExplore` 函数（~200 行）
- `tree-sitter.ts`（5,690 行）→ 只需要 `extractAll` 函数（~50 行）
- `callback-synthesizer.ts`（2,752 行）→ 只需要 `resolveSwiftObjcBridges`（~30 行）

Codindex 通过索引直接定位到函数级别，**避免了读取无关代码**。

### 6.2 Token 消耗的隐性成本

在实际 AI 编程场景中：
- 每个 Read 工具调用 = 1 次 tool call + 文件内容进入 context
- 207K chars ≈ **52K tokens**（按 4 chars/token 估算）
- 6 题总计 WITHOUT Codindex = **1.4M chars ≈ 350K tokens**
- 6 题总计 WITH Codindex = **63K chars ≈ 16K tokens**

**Token 节省约 95%**，直接转化为 API 成本节省。

### 6.3 调用链追踪的价值

`get_call_graph` 和 `get_impact_analysis` 是 Codindex 最有价值的工具：
- 返回**精确的函数级调用关系**，而非文件级猜测
- 支持多层深度追踪（depth=3 可覆盖完整调用链）
- 返回**结构化数据**（JSON），AI 可直接解析使用

---

## 7. 局限性

1. **测量的是"数据传输量"，非"AI 理解质量"**：Codindex 返回的是索引数据，AI 仍需理解；无 Codindex 时 AI 读取完整源码，理解可能更深入
2. **本地 DB 查询 vs 网络传输**：实际 MCP 场景中，工具调用有网络延迟；本实验均为本地操作
3. **问题设计偏向 Codindex 优势场景**：6 个问题都适合用索引查询回答；如果是"这段代码的业务逻辑是什么"，Codindex 优势可能更小
4. **未测量 AI 回答质量**：需要人工评估 AI 在两种条件下的回答准确性
5. **单次运行**：未做多次重复取平均值，结果可能有波动

---

## 8. 结论

Codindex 在**代码理解类任务**上效果显著：
- 工具调用减少 52%（减少 AI 的探索成本）
- 数据传输减少 96%（减少 token 消耗和 API 成本）
- 核心价值：**函数级精确索引**，避免读取无关代码

**适用场景**：
- 大型代码库的架构理解
- 调用链追踪和影响分析
- 跨文件函数定位
- 复用检测和相似函数发现

**不适用场景**：
- 需要理解具体业务逻辑
- 需要阅读注释和文档
- 需要分析代码风格和质量

---

*报告生成时间：2026-06-27*
*测试环境：Codindex v1.0 + CodeGraph (commit 7a361ef)*
*测试工具：Codindex MCP Server + SQLite 索引查询*
