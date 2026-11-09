import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { defineConfig } from 'vitest/config';

/**
 * 说明：这里刻意不配 alias。
 *
 * 历史问题：此前用显式 alias 白名单把 `'../../db/connection'` 映射到
 * `src/db/connection.ts`，原因是测试文件里的相对路径少写了一层（测试在
 * `src/tests/`，`../db/x` 才对应 `src/db/x`，`../../db/x` 会解析到仓库根的
 * `db/x`——那个目录并不存在）。每个新增被测模块都要手动登记一条 alias，
 * 否则报 `Cannot find module`；同时 tsc 不认 vite alias，`tsc --noEmit`
 * 会留下 31 处 TS2307。
 *
 * 现在导入路径已修正为正确的相对深度，alias 不再需要：
 * vite 与 tsc 使用同一套解析规则，新增模块无需登记。
 */
export default defineConfig({
  test: {
    globals: true,
    environment: 'node',
    pool: 'forks',
    fileParallelism: false,
    include: ['src/tests/**/*.test.ts'],
    setupFiles: ['src/tests/setup.ts'],
    /**
     * 每个测试进程落到独立临时库，绝不写仓库里的 data/codindex.db。
     *
     * 历史问题：不设 CODINDEX_DB 时 `resolveDbPath()` 返回
     * `<cwd>/data/codindex.db`，于是 `npm test` 直接往开发者真实的索引库
     * 里写测试数据——跑一次污染一次（实测会凭空生成 data/codindex.db），
     * 还会和正在运行的 Web/MCP 进程抢 WAL 锁。
     * 用 PID + 随机后缀保证并发 worker 之间也不互相踩。
     */
    env: {
      CODINDEX_DB: resolve(
        tmpdir(),
        `codindex-test-${process.pid}-${Math.random().toString(36).slice(2)}.db`,
      ),
    },
  },
});
