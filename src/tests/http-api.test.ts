/**
 * HTTP API 契约测试。
 *
 * 为什么必须有：此前 src/index.ts 在模块顶层无条件调用 main()，任何 import
 * 都会真的去抢占 3100 端口，于是 HTTP 路由根本无法在测试里被覆盖 —— 结果
 * `DELETE /api/projects/:id` 因为对 `db.transaction(fn)` 的返回值再调用一次
 * 而彻底不可用，`README` 里写着的 `/api/projects/:id/overview` 也从未存在，
 * 两者都无人发现。现在入口已改为「仅直接执行时启动」，可以放心用 app.request()
 * 在进程内打所有路由。
 *
 * 独立数据库：本文件把 CODINDEX_DB 指向临时文件，绝不碰 data/codindex.db
 * （那个库被其它测试并发使用，且体积已达百 MB 级）。
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

let app: { request: (path: string, init?: RequestInit) => Response | Promise<Response> };
let dbDir: string;

const call = async (method: string, path: string, body?: unknown) => {
  const init: RequestInit =
    body === undefined
      ? { method }
      : { method, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) };
  const res = await app.request(path, init);
  return { status: res.status, json: async () => JSON.parse(await res.text()) };
};

beforeAll(async () => {
  dbDir = mkdtempSync(join(tmpdir(), 'codindex-http-'));
  // 必须早于第一次导入 connection.ts —— 它读 CODINDEX_DB 后缓存 db 单例。
  process.env.CODINDEX_DB = join(dbDir, 'http.db');
  ({ app } = await import('../index.js'));
});

afterAll(() => {
  try { rmSync(dbDir, { recursive: true, force: true }); } catch { /* ignore */ }
});

describe('HTTP API — 路由契约', () => {
  it('GET / 返回 SPA HTML', async () => {
    const res = await app.request('/');
    expect(res.status).toBe(200);
    expect(await res.text()).toContain('<title>Codindex</title>');
  });

  it('SPA 深链返回同一份 HTML（不是 404）', async () => {
    for (const p of ['/projects/abc', '/projects/abc/functions', '/projects/abc/cfg', '/projects/abc/flowchart']) {
      const res = await app.request(p);
      expect(res.status, p).toBe(200);
    }
  });

  it('GET /api/projects 返回数组', async () => {
    const r = await call('GET', '/api/projects');
    expect(r.status).toBe(200);
    expect(Array.isArray(await r.json())).toBe(true);
  });

  it('GET /api/projects/:id 未知 id 返回 404', async () => {
    const r = await call('GET', '/api/projects/does-not-exist');
    expect(r.status).toBe(404);
  });

  it('GET /api/projects/:id/overview 存在且与 /api/projects/:id 一致', async () => {
    // README「快速开始」里公开文档化的路径。曾经 404，照文档敲 curl 直接失败。
    const created = await call('POST', '/api/projects', {
      name: 'HttpOverview', path: join(dbDir, 'proj-overview'),
    });
    expect(created.status).toBe(201);
    const id = (await created.json()).id as string;

    const a = await call('GET', `/api/projects/${id}`);
    const b = await call('GET', `/api/projects/${id}/overview`);
    expect(a.status).toBe(200);
    expect(b.status).toBe(200);
    expect(await b.json()).toEqual(await a.json());
  });

  it('overview 的 stats 字段齐全（前端直接读这些键）', async () => {
    const created = await call('POST', '/api/projects', {
      name: 'HttpStats', path: join(dbDir, 'proj-stats'),
    });
    const id = (await created.json()).id as string;
    const { json } = await call('GET', `/api/projects/${id}/overview`);
    const data = await json();
    expect(Object.keys(data.stats).sort()).toEqual(
      ['calls', 'files', 'functions', 'module_deps', 'modules', 'types'],
    );
    for (const v of Object.values(data.stats)) expect(typeof v).toBe('number');
  });

  it('GET /api/projects/:id/overview 未知 id 返回 404（与主路由行为一致）', async () => {
    const r = await call('GET', '/api/projects/nope/overview');
    expect(r.status).toBe(404);
  });

  it('空项目上各列表路由不 500', async () => {
    const created = await call('POST', '/api/projects', {
      name: 'HttpEmpty', path: join(dbDir, 'proj-empty'),
    });
    const id = (await created.json()).id as string;
    for (const p of ['functions', 'files', 'features', 'reuse', 'deps', 'cfg']) {
      const r = await call('GET', `/api/projects/${id}/${p}`);
      expect(r.status, p).toBe(200);
    }
  });
});

describe('HTTP API — 生命周期', () => {
  it('注册 → 查询 → 删除 → 再查 404', async () => {
    const path = join(dbDir, 'proj-lifecycle');
    const created = await call('POST', '/api/projects', { name: 'Lifecycle', path });
    expect(created.status).toBe(201);
    const id = (await created.json()).id as string;

    expect((await call('GET', `/api/projects/${id}`)).status).toBe(200);

    // 回归：这条路由曾是 `db.transaction((tx) => {...})()`，
    // drizzle 的事务是同步执行后返回结果的，末尾那个 () 直接抛
    // "is not a function"，删除接口 100% 不可用。
    const del = await call('DELETE', `/api/projects/${id}`);
    expect(del.status).toBe(200);
    expect(await del.json()).toEqual({ deleted: true });

    expect((await call('GET', `/api/projects/${id}`)).status).toBe(404);
    expect((await call('GET', `/api/projects/${id}/overview`)).status).toBe(404);
  });

  it('删除已不存在的项目返回 404 而不是 500', async () => {
    const r = await call('DELETE', '/api/projects/ghost-id');
    expect(r.status).toBe(404);
  });
});

describe('CODINDEX_DB 路径解析', () => {
  it(':memory: 不会被当成文件名落到磁盘', async () => {
    // 回归：`resolve(':memory:')` 会产出 `<cwd>/:memory:` —— 一个真实文件，
    // 于是「内存库」在仓库根留下 :memory: / -wal / -shm 三件套，且多进程共享、
    // 测试互相污染。这里只剩纯函数语义，不实际打开连接。
    const { resolveDbPath } = await import('../db/connection.js');
    expect(resolveDbPath(':memory:')).toBe(':memory:');
    expect(resolveDbPath('file::memory:?cache=shared')).toBe('file::memory:?cache=shared');
  });

  it('普通相对路径按 cwd 解析为绝对路径', async () => {
    const { resolveDbPath } = await import('../db/connection.js');
    const p = resolveDbPath('data/x.db');
    expect(p.startsWith('/')).toBe(true);
    expect(p.endsWith('data/x.db')).toBe(true);
  });

  it('未设置时落到默认 data/codindex.db', async () => {
    const { resolveDbPath } = await import('../db/connection.js');
    expect(resolveDbPath(undefined).endsWith('data/codindex.db')).toBe(true);
    expect(resolveDbPath('').endsWith('data/codindex.db')).toBe(true);
  });
});
