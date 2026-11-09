# Codindex 文档

根目录只保留必须放在那里的文件（`README.md` / `README.en.md` / `LICENSE` /
`CHANGELOG.md`，以及工具会自动加载的 `AGENTS.md` / `CLAUDE.md`），其余文档都在这里。

| 文档 | 内容 | 语言 |
|---|---|---|
| [TOOLS.md](TOOLS.md) | 32 个 MCP 工具、4 个 Resource、1 个 Prompt 的完整参数与返回说明 | 中文 |
| [API.md](API.md) | Web API 路由、Web UI 页面、环境变量、PRD 功能追踪写法 | 中文 |
| [CONTRIBUTING.md](CONTRIBUTING.md) | 开发环境、命令、PR 检查清单、如何新增语言 | English |
| [SECURITY.md](SECURITY.md) | 漏洞报告渠道、安全边界、已实施的加固项 | English |
| [REGRESSION-REPORT.md](REGRESSION-REPORT.md) | 全功能回归测试报告 | 中文 |

## 从哪开始

- **第一次用** → [../README.md](../README.md) 的「快速开始」
- **查某个工具怎么调** → [TOOLS.md](TOOLS.md)
- **调 HTTP 接口或改端口** → [API.md](API.md)
- **想提 PR** → [CONTRIBUTING.md](CONTRIBUTING.md)
- **报告安全问题** → [SECURITY.md](SECURITY.md)（请勿开公开 issue）

## 说明

`docs/*` 在 `.gitignore` 里被整体忽略，用于存放本地草稿，只有上表这几份被显式
放行（`!docs/xxx.md`）。新增对外文档时记得在 `.gitignore` 里加一行放行，否则
clone 下来的人会看到死链接。
