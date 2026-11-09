# Web API 与配置参考

## API 路由

| 方法 | 路由 | 说明 |
|---|---|---|
| GET | `/api/projects` | 项目列表 |
| POST | `/api/projects` | 添加项目 |
| GET | `/api/projects/:id` | 项目详情 + 统计 |
| GET | `/api/projects/:id/overview` | 同上（等价别名） |
| POST | `/api/projects/:id/scan` | 触发扫描 |
| GET | `/api/projects/:id/functions` | 函数清单（支持 `?sort=&filter_test=&limit=`） |
| GET | `/api/projects/:id/functions/:fid` | 函数详情 + 调用链 + 调用来源 |
| GET | `/api/projects/:id/files` | 文件列表 |
| GET | `/api/projects/:id/files/:fid` | 文件详情 + 关联函数 |
| GET | `/api/projects/:id/features` | 功能追踪 |
| GET | `/api/projects/:id/reuse` | 复用评分报告（支持 `?score_min=&sort=&limit=`） |
| GET | `/api/projects/:id/deps` | 模块依赖图（含循环依赖检测） |
| GET | `/api/projects/:id/cfg` | 项目内函数的 CFG 索引 |
| GET | `/api/projects/:id/cfg/:func_id` | 单个函数的控制流图 |
| GET | `/api/projects/:id/flowchart` | 流程图数据 |
| GET | `/api/projects/:id/diff?since=` | 快照对比 |
| DELETE | `/api/projects/:id` | 删除项目（含全部派生数据；不存在时返回 404） |

Web UI 使用 SPA 路由 `/projects/:id/{functions,files,reuse,deps,features,cfg,flowchart}`，
直接访问带深链的 URL 也能正确加载（服务端统一回落到 `index.html`）。

### 示例

`{id}` 是 `POST /api/projects` 返回体里的 `id` 字段，也是列表接口每条的 `id`。
先注册拿到它，再拿它去调其余接口：

```bash
# 1. 注册项目 —— 响应里的 id 就是后面的 project_id
curl -X POST http://localhost:3100/api/projects \
  -H "Content-Type: application/json" \
  -d '{"name":"My Project","path":"/path/to/your/project"}'
# → {"id":"7796c52f-95e8-4eb8-b061-2de428e1980f","name":"My Project","status":"pending",...}

# 2. 触发扫描（同步执行，返回即完成）
curl -X POST http://localhost:3100/api/projects/7796c52f-.../scan
# → {"status":"complete","files":38,"functions":145,"calls":7572,"types":31,"cycles":0}

# 3. 查看结果
curl http://localhost:3100/api/projects/7796c52f-.../overview
```

忘了 id 就查列表：`curl http://localhost:3100/api/projects`。

### Web UI 页面

打开 `http://localhost:3100` 得到同一套数据的可视化界面，页面与接口一一对应：

| 页面 | 路径 |
|---|---|
| 项目列表 / 添加 | `/` |
| 函数清单 | `/projects/:id/functions` |
| 文件浏览器 | `/projects/:id/files` |
| 复用报告 | `/projects/:id/reuse` |
| 模块依赖图 | `/projects/:id/deps` |
| 功能追踪 | `/projects/:id/features` |
| 控制流图 | `/projects/:id/cfg` |
| 流程图 | `/projects/:id/flowchart` |

---

## 环境变量

| 变量 | 说明 |
|---|---|
| `PORT` | Web API 端口，默认 `3100`。CORS 白名单跟随该端口（`localhost`/`127.0.0.1` 两种写法） |
| `CODINDEX_DB` | SQLite 文件路径，默认 `data/codindex.db`；支持 `:memory:` |
| `CODINDEX_SQLITE` | 设为 `better-sqlite3` 时改用原生驱动（需能加载对应 ABI 的预编译包） |

> 两个变量沿用 `CODINDEX_` 前缀。若你从更早的版本升级上来，旧的 `CODEMAP_DB` /
> `CODEMAP_SQLITE` 不再识别，默认库路径也从 `data/codemap.db` 改成了
> `data/codindex.db` —— 旧库不会自动迁移，重新扫描一次即可。

---

## 功能追踪（PRD）

在项目设置中填写 `prdPath` 指向 PRD Markdown 文档：

```markdown
# 功能：用户登录
## 需求：邮箱密码登录
## 需求：短信验证码登录
```

代码中用 `@feature:` 标签关联功能：

```typescript
// @feature: user-login
export async function login(email: string, password: string) { ... }
```

扫描后自动计算每个功能的完成度，通过 `get_feature_tracking` 或 Web UI 的「功能」页查看。
