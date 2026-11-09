# Regression Test Report

**Generated**: 2026-11-09
**Scope**: full（构建 + 类型检查 + 全量单测 + MCP 协议 + HTTP API + 全新 clone 安装）
**Rounds**: 1 / 10

## 汇总

| 关卡 | 命令 | 结果 |
|---|---|---|
| 类型检查 | `npx tsc --noEmit` | ✅ 0 errors |
| 构建 | `npm run build` | ✅ exit 0，产物含 `dist/web/ui/index.html` |
| 单元/集成测试 | `npx vitest run` | ✅ 14 files / 325 tests passed |
| MCP 协议 | 32 个工具 `tools/list` + 逐工具调用 | ✅ 32 注册，缺参路径返回结构化错误 |
| HTTP API | 启动服务后逐一探测 | ✅ 路由全部 200 |

## 测试文件明细

| 文件 | 用例数 | 覆盖 |
|---|---|---|
| `regression-skill.test.ts` | 91 | MCP 协议、扫描器、DB 完整性、调用图、模块图、增量扫描、性能基线 |
| `mcp.test.ts` | 81 | 全部 MCP 工具的正确性契约 |
| `scanner-ts.test.ts` | 33 | 6 语言 AST 提取 |
| `phase2.test.ts` | 23 | 调用解析 + git 元信息落库 + 重扫收敛 |
| `scanner-scc.test.ts` | 15 | scc + git 批量元信息（子目录 / 非 ASCII / 含空格路径） |
| `phase3.test.ts` | 14 | 复用评分 |
| `type-fields.test.ts` | 12 | 类型字段 |
| `context-bundle.test.ts` | 12 | 上下文包 |
| `bridge-calls.test.ts` | 11 | Tauri/Electron 桥接 |
| `db-schema-sync.test.ts` | 6 | schema 与迁移一致性 |
| `orchestrator.test.ts` | 5 | 扫描编排 + 增量 |
| `db.test.ts` | 5 | 基础 CRUD + 外键 |
| `db-connection.test.ts` | 4 | 连接、WAL、foreign_keys |
| `http-api.test.ts` | 13 | HTTP 路由契约、overview 别名、删除生命周期、CODINDEX_DB 解析 |

## 本轮修复并在测试中固化的问题

| # | 问题 | 回归用例 |
|---|---|---|
| 1 | 批量 git 元信息 key 用仓库根相对路径，项目注册在仓库子目录时 `last_modified` 全 NULL | `phase2.test.ts`「项目注册在仓库子目录时…」、`scanner-scc.test.ts`「子目录项目…」 |
| 2 | 非 ASCII 路径被 git 八进制转义，永远匹配不上 | `scanner-scc.test.ts`「非 ASCII 文件名…」、`phase2.test.ts` 中文文件名断言 |
| 3 | 全部写入 `ON CONFLICT DO NOTHING`，重扫后函数体/时间戳停在首次扫描 | `phase2.test.ts`「重扫会刷新内容与 last_modified」 |
| 4 | 源文件删除后旧行永久残留 | `phase2.test.ts`「删除源文件后重扫，旧文件与其函数不再残留」 |
| 5 | `DELETE /api/projects/:id` 对 `db.transaction()` 返回值二次调用，接口不可用 | `http-api.test.ts`「注册 → 查询 → 删除 → 再查 404」 |
| 6 | `CODINDEX_SQLITE=better-sqlite3` 在 ESM 下 `require is not defined` | 手工验证（现给出可执行的 ABI 修复提示） |
| 7 | 测试文件重复 import / 可空 projectId 等 106 处 tsc 错误，`npm run build` 红 | `npm run build` 现为 0 错误 |
| 8 | 构建不搬运静态资源，`node dist/index.js` 启动 ENOENT | CI `Verify dist boots` + 本地冒烟（GET / → 200） |
| 9 | MCP 工具缺参时抛 `TypeError: Cannot read properties of undefined (reading 'lastIndexOf')`，调用方拿不到「缺哪个参数」 | `mcp.test.ts`「缺参时返回结构化提示」5 例 |
| 10 | `get_file_content` 的 `file_path` 限长 64，深层路径被 schema 层拒绝 | `mcp.test.ts`「深层文件路径不被 schema 的 maxLength 挡住」 |
| 11 | `CODINDEX_DB=:memory:` 被 `resolve()` 变成真实文件 `<cwd>/:memory:`，测试互相污染 | `http-api.test.ts`「CODINDEX_DB 路径解析」3 例 |
| 12 | `GET /api/projects/:id/overview` 文档化但不存在（404） | `http-api.test.ts`「overview 存在且与主路由一致」 |
| 13 | `DELETE` 不存在的项目返回 200，调用方无法区分 | `http-api.test.ts`「删除已不存在的项目返回 404」 |
| 14 | CI 用手搓 SQL + `require()` 调 ESM 做自扫描，且 `drizzle-kit push` 的错误被 `2>/dev/null` 吞掉 | `scripts/self-scan.ts`（CI 走公开 API） |
| 15 | 新 clone 后 `npm install` 直接 ERESOLVE 失败（tree-sitter 语法包 peer 范围互相冲突），CI 用 `--legacy-peer-deps` 把坑藏住 | 全新 clone 跑 `npm ci`（仅凭 `.npmrc`）通过 |
| 16 | `npm test` 不设 `CODINDEX_DB` 时写到 `<cwd>/data/codindex.db`，污染开发者真实索引库 | `vitest.config.ts` 注入临时库；跑完测试后仓库内无 `data/codindex.db` |
| 17 | MCP server 名、prompt、资源 URI、环境变量、默认库路径全部以旧名硬编码 | 更名后单元测试全通过（MCP 相关 81 例）；`node dist/index.js` 启动日志与 API 一致 |
| 18 | `.claude/settings.json` 指向 `/Volumes/Mac/Workspace/...` 旧绝对路径 | 改为当前绝对路径后 MCP 可直连 |

## 已知限制

- 增量扫描当前仍是「检测变更 → 全量重扫」，未实现真正的按文件增量；语义正确但耗时等同全量。
- `getGitStatsBatch` 只覆盖 `lastModified` 与 `authors`，不含逐文件 diff 统计。
- 合并提交在 `--name-only` 下的路径展开与逐文件查询略有差异，但不影响上述两个字段。
