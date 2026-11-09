# Changelog

本项目遵循 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/)，
版本号遵循 [SemVer](https://semver.org/lang/zh-CN/)。

## [Unreleased]

### Added

- **`docs/CONTRIBUTING.md` 新增发布流程**：此前没有任何地方记录「怎么发版」，
  每次都要重新踩一遍坑。现在写清了版本号三处同步、tag 必须是 annotated、
  发布前要确认目标版本在 registry 上还不存在、npm 字段上限、staging 两步发布、
  以及发布后怎么验证真正发出去的东西。
- 记录了一组**硬编码数字**（32 工具 / 6 语言 / 6-5-3-8-5-5 分组 / 版本号）
  在哪些文件里重复出现，并标注 banner SVG 里的 pill 最容易漏改。

## [0.1.2] - 2026-11-09

### Fixed

- **npm description 被截断**：0.1.1 写的 334 字符超过了 npm 的 255 字符字段上限，
  registry 上存下的是断在 `(Claude Code, Cursor,` 的半句。现压到 214 字符，
  保留全部硬指标（32 工具 / 6 语言 / 无 LLM 调用 / 支持的 client），
  去掉的是同义堆叠（function inventory → functions、control-flow graph → CFG）。

## [0.1.1] - 2026-11-09

### Changed

- **npm 关键词 32 → 38**：补入横向场景词（`repo-index`、`code-context`、
  `agentic-coding`）与 MCP 客户端名（`codex`、`windsurf`、`claude-mcp`）。
  原关键词缺 `codex` / `windsurf` —— README 只提了 Claude Code / Cursor /
  VS Code，而这两个是同领域 client，用户会按名字搜。
  刻意**未加** `rag`（4019 个包）与 `vibe-coding`（1176 个包）：搜索量大但与
  产品定位相反，README 里明确写了「不是向量检索 / RAG」。
- **npm description 128 → 334 字符**：原文只列 function inventory / call graph /
  module deps / impact analysis 四项，漏了 call chains、control-flow graph、
  dead-code detection，也漏了「6 种语言 / 32 工具 / 无 LLM 调用 / 不上传源码」
  这些选型时先看的硬指标。
- **README 补 agentic coding 定位段**：「整仓塞进上下文会爆、grep 只拿碎片」比
  堆功能形容词更能说明项目解决什么问题；client 列表补上 Windsurf / Codex。
- **头图版本号 v1.0.0 → v0.1.1**：banner 上的版本停留在更名前的 1.0.0，
  与实际发布的 0.1.x 不一致。两套（dark / light）同步。
- **文档归入 `docs/`**：根目录原有 7 个 md（README ×2、LICENSE、CHANGELOG、
  AGENTS、CLAUDE、CONTRIBUTING、SECURITY），加上 docs/ 里 3 个，一眼看不出
  从哪读起。现只保留必须放在根目录的：`README(.en).md`（GitHub 只渲染根目录
  README）、`LICENSE`（npm 约定）、`CHANGELOG.md`（约定）、`AGENTS.md` /
  `CLAUDE.md`（工具只从根目录自动加载）。`CONTRIBUTING.md` / `SECURITY.md`
  移入 `docs/` —— GitHub 认 root / docs / .github 三处，移到 docs 后仍会在
  「Contributing」入口中显示。
- 新增 `docs/README.md` 作为文档索引，说明每份文档的位置与适用场景。
- **README 里指向文档的链接改为绝对 GitHub 地址**：npm 不会重写相对链接，
  `docs/TOOLS.md` 这类路径在 npmjs.com 上是 404。banner 图片同样改为
  `raw.githubusercontent.com` 绝对地址。

## [0.1.0] - 2026-11-09

首次发布到 npm（`npm i -g codindex`），`latest` 标签指向本版本。

版本号从 1.0.0 改为 0.1.0：此前从未对外发布过，用 1.0.0 意味着承诺 SemVer
稳定接口，而 MCP 工具的参数与返回结构仍在调整。0.1.0 更符合实际状态，
也给后续破坏性变更留出空间。

能力范围：扫描 6 种语言，产出函数清单、调用图、类型关系、模块依赖图、
复用评分、PRD 功能追踪、函数语义摘要、CFG 控制流图；
对外暴露 32 个 MCP 工具 + 4 个 Resource + 1 个 Prompt，
以及 Web UI 和 stdio MCP Server，支持 chokidar 文件监听增量同步。

### Added

- `CONTRIBUTING.md`（开发环境、PR 检查清单、如何新增语言）与 `SECURITY.md`
  （漏洞报告渠道、安全边界、已实施的加固项）。
- `docs/TOOLS.md` 补充 MCP 的另外两类接口：4 个 Resource
  （`codindex://projects` 及 `projects/{id}/{overview,functions,features}`）与
  1 个 Prompt（`codindex-guide`）。此前只有 tools 被文档化，资源与提示词完全隐形。
- `codindex --version` / `codindex --help`。此前敲这两个参数会直接去占 3100 端口，
  既不打印版本也不打印帮助，还留下一个僵死进程。
- README 新增「跑通一次完整链路」四步（注册 → 扫描 → 验证），
  以及「装不上 / 跑不起来」故障排查表（ERESOLVE、PATH、端口占用、
  `CODINDEX_DB` 相对路径、语言未支持、数据过期、重置库）。
- `docs/API.md` 补充 `{id}` 的来源（`POST /api/projects` 返回体）与 8 个 Web UI 页面路径。
- `README.en.md` 英文版，与中文版并列为首页备选；`docs/TOOLS.md`（32 个工具完整参考）、
  `docs/API.md`（API 路由、环境变量、PRD 功能追踪），从原 README 拆出。
- `package.json` 补 `repository` / `homepage` / `bugs`，指向 GitHub 仓库。
- `--mcp` 之外的库用法：`index.ts` 改为仅在直接执行时启动服务，并导出 `app` / `main`。
- `GET /api/projects/:id/overview`：README 一直文档化但此前不存在的路由，现为 `/api/projects/:id` 的等价别名。
- `LICENSE`（MIT）、`CHANGELOG.md`、`package.json` 的 `bin` / `main` / `types` / `exports` / `files`。
- `scripts/copy-assets.mjs`：构建时把 `src/web` 一并搬运到 `dist/web`。
- `.npmrc`（`legacy-peer-deps=true`）：见下方「新 clone 装不上依赖」。
- README 头图 `assets/codindex-hero-{dark,light}.svg`，按 `prefers-color-scheme` 自动切换，
  已加入 `package.json` 的 `files` 字段（否则 npm 包内不含图，registry 页面上的图片会 404）。
- README 新增「常见问题」「支持的语言」两节，并补上此前未文档化的三条 API 路由
  （`cfg` / `cfg/:func_id` / `flowchart`）。

### Changed

- **CORS 白名单跟随 `PORT`**：原先写死 `localhost:3100` / `127.0.0.1:3100`，
  按排错文档用 `PORT=3199` 起服务时，任何跨端口访问都会被 CORS 拦掉。
  现按运行时端口生成白名单，`PORT` 只解析一次（模块顶部常量）。
- **文档分类口径三处统一**：`AGENTS.md`（查询 18/操作 5/增强 9）与
  `CLAUDE.md`（查询 19/操作 5/增强 8）各自与 README 的 6 组分类（6+5+3+8+5+5=32）
  互相矛盾，同一工具在两份 AI 指南里归属不同类别，会直接污染 AI 的工具选择。
  现三份文档统一为 6 组口径，`get_context_bundle` 从「增强类」归入「上下文与读取」，
  `AGENTS.md` 的 Web UI 表补齐 CFG 与流程图两行。
- **`docs/TOOLS.md` 参数补全**：9 个工具的参数表与实际 `inputSchema` 不符，
  `get_function_context` 漏了全部 6 个可选开关，`get_hotspots` 漏了
  `complexity_min`/`min_lines`/`module`/`limit`，`get_dead_code` 漏了
  `include_unexported`（与 `include_exported` 语义相反，写错会得到完全不同的结果）。
- **README 的 MCP 配置改为用全局 `codindex` 命令**：原文让用户 `npx tsx
  /path/to/src/index.ts`，而 `tsx` 在 `devDependencies` 里 —— 没 `npm install` 过的
  机器上 `npx` 会去网上现拉，编辑器启动超时或被墙就直接失败；也与「快速开始」
  教用户 `npm i -g` 的做法自相矛盾。源码方式降为备选并注明前置条件。
- **README 重写为精简版**：509 行 → 240 行，并拆出 [README.en.md](README.en.md) 英文版
  （首行语言切换）。工具清单、API 路由、环境变量等细节移入 `docs/TOOLS.md` 与 `docs/API.md`，
  README 只留介绍、快速开始、配置、工具分类、性能、FAQ、语言支持。
  两版 README 都覆盖全部 32 个包关键词（此前仅 8 个）。
- **项目更名 Codemap → Codindex**，因为 npm 上的 `codemap` 已被他人占用（1.3.2），
  且 `codemap-mcp` / `mcp-codemap` / `codemap-cli` / `codemap-index` 等同族名字
  也全部被同领域项目占掉。改名覆盖 npm 包名、`bin` 命令、MCP server 名、
  `codindex-guide` prompt、`codindex://` 资源 URI、环境变量、默认库路径
  `data/codindex.db`、日志前缀、Web UI 标题与文档。
  **这是破坏性变更**：环境变量 `CODEMAP_DB` / `CODEMAP_SQLITE` 不再识别，
  已部署的 MCP 配置需同步改名，旧的 `data/codemap.db` 不会被自动迁移。
- `package.json` 的 `keywords` 由 4 个扩到 32 个，补入 `tree-sitter`、`ast`、`call-graph`、
  `mcp-server`、`model-context-protocol`、`codebase-index`、`claude-code` 等真实检索入口；
  `description` 改为以 "MCP server" 开头（npm 搜索结果页只显示描述前几十个字符）。
- README 的 AI 效率基准改为并列两轮实验：第一轮（单问题）为 -53% 调用、-95% 数据量，
  第二轮（三问题）为 **+11% 调用**。原文只引第一轮，未提第二轮的反向结论。

### Removed

- `plan-regression-test-skill.md`（316 行）：回归测试 Skill 的设计稿。实现已完成并落在
  `.claude/skills/regression-test/SKILL.md`（506 行），设计稿属于过程产物，无独立引用。
- 仓库根目录 11 张手工截图（`w0*-*.png`、`codemap-*.png`、`screenshot-home.png`）。
  早期 Web UI 验证时留下的，唯一引用在已删除的设计稿里。
- 旧库 `data/codemap.db`（199 MB）+ WAL（44 MB）。改名遗留，内含两个指向 `/tmp`、
  早已不存在的探针项目，`files` / `functions` / `calls` 全为 0 行。数据无价值，删除。
- `.agent-orchestration/`（编排器遗留 SQLite 状态，无进程占用）、`.playwright-mcp/`
  （17 MB 的 Playwright 会话日志与截图）。
- `.opencode/agents/` 下两个指向 `~/.bugx/core/` 的断链软链接（详见 `.gitignore` 注释）。
- `docs/` 下 9 份未跟踪的历史草稿（审计、PRD、对比测试、Web UI 验证）。其中安全审计
  的结论（C1 / H5 / H8 / M10）已固化在 `AGENTS.md` 与 `CLAUDE.md` 的安全审计表里，
  代码侧也仍有对应实现（`escapeLike()`、`spawnSync`、CORS 白名单），删草稿不影响可追溯性。

### Fixed

- **重扫不刷新数据**：所有写入都是 `ON CONFLICT DO NOTHING`，改过的函数体、`files.last_modified`
  永远停在首次扫描的值，`/api/projects/:id/diff?since=` 因此恒返回空；删除/改名的文件也永久残留。
  现在扫描前统一清理本项目派生数据（`clearProjectData`），并弃用由调用方各自维护的删除清单。
- **子目录项目 git 元信息全失**：批量预取的 key 是「仓库根相对路径」，项目注册在 monorepo
  子目录时与 `relPath` 不等，`last_modified` 静默变 NULL。现按 `git rev-parse --show-toplevel`
  换算到项目根基准。
- **非 ASCII 路径匹配不上**：git 默认 `core.quotepath=true` 会把中文路径输出为八进制转义。
  现显式传 `-c core.quotepath=false`，并对含空格/引号仍被加引号的路径做解码兜底。
- **`isGitRepo` 只认 `.git` 目录**：仓库内子目录被误判为「非 git」，整轮跳过元信息；
  现先走 `.git` 快路径，未命中再问 `git rev-parse --is-inside-work-tree`。
- **`DELETE /api/projects/:id` 完全不可用**：对 `db.transaction(fn)` 的返回值又调用了一次，
  运行时报 `is not a function`。
- **`CODINDEX_SQLITE=better-sqlite3` 回退路径**：ESM 作用域里裸写 `require()` 直接抛
  `ReferenceError`；改用 `createRequire(import.meta.url)`，并对原生 addon ABI 不匹配给出可执行提示。
- **`npm run build` 无法通过**：清理全部 tsc 错误（源码 32 处 + 测试 74 处），
  并在 `tsconfig.json` 中补 `types: ["node", "vitest/globals"]`（vitest 开了 `globals: true`）。
- **构建产物跑不起来**：`tsc` 不搬运静态资源，`node dist/index.js` 读 UI 时 ENOENT。
- `get_file_content` 的 `file_path` schema 上限从 64 放宽到 4096，深层路径不再被 schema 层拒绝。
- **MCP 缺参报错不可读**：协议层不校验 `inputSchema.required`，工具内部
  直接 `args.func_name.lastIndexOf(...)` 时漏参就抛
  `TypeError: Cannot read properties of undefined (reading 'lastIndexOf')`
  并被包成 -32603，调用方（AI）完全不知道缺哪个参数。现在统一在分发前
  校验，返回 `{ error: "missing_required_arguments", tool, missing, required, hint }`。
- **`CODINDEX_DB=:memory:` 落成磁盘文件**：`resolve(':memory:')` 会产出
  `<cwd>/:memory:`，于是「内存库」在仓库根留下 `:memory:` / `-wal` / `-shm`
  三件套并被多进程共享。现在显式放行内存写法，反正规文件路径不受影响。
- **`DELETE /api/projects/:id` 对不存在的 id 返回 200**，调用方无法区分
  「删掉了」与「id 打错」，现返回 404。
- **CI 形同虚设**：自扫描用手搓 SQL + 裸 `require()` 调 ESM 模块，
  `drizzle-kit push` 的错误被 `2>/dev/null` 吞掉，构建失败也不拦。已改为
  类型检查 → 单测 → 构建 → 启动产物探测 → 走公开 API 的自扫描脚本。
- **新 clone 装不上依赖**：tree-sitter 各家语法包声明的 peer 范围互不兼容
  （java→`^0.21.1`、typescript→`^0.21.0`、python/rust→`^0.22.1`），没有单一
  版本能满足，npm 7+ 把 peer 冲突当硬错误，`npm install` 直接 ERESOLVE 失败。
  CI 里靠 `npm ci --legacy-peer-deps` 把这个坑藏住了，用户照 README 敲命令必踩。
  现由仓库根的 `.npmrc` 统一声明，CI 与本地命令完全一致。
- **`npm test` 污染开发者真实索引库**：不设 `CODINDEX_DB` 时测试会落到
  `<cwd>/data/codindex.db`，跑一次测试就往真实库写一次数据，还会与运行中的
  Web/MCP 进程抢 WAL 锁。现在 `vitest.config.ts` 给每个测试进程注入
  PID + 随机后缀的临时库路径。
- 若干文档漂移：工具数（29/30/31/32 并存 → 统一 32）、表数（10 → 15）、
  测试数据（13 files/306 → 14 files/325）、AGENTS.md 指向不存在的
  `.Codex/skills/...`、`docs/` 被整体忽略导致公开链接全死、README 让用户
  手工安装已在 `dependencies` 里的 tree-sitter 包。

