/**
 * node:sqlite 适配层 — 让 Node 内置 SQLite 满足 better-sqlite3 的使用面。
 *
 * 背景：better-sqlite3 是原生 addon，编译产物与 Node ABI（NODE_MODULE_VERSION）
 * 强绑定。同一台机器上并存多个 Node 构建（例如系统 Node 与 Electron 内嵌 Node）
 * 时，ABI 不一致会直接报 `NODE_MODULE_VERSION x vs y`，必须重编译才能切换。
 * `node:sqlite` 是 Node 内置模块，随宿主一起提供，不存在 ABI 绑定问题。
 *
 * 差异补齐（仅补 drizzle-orm/better-sqlite3 驱动与本仓实际用到的面）：
 *   - `pragma(sql)`：better-sqlite3 用 `db.pragma('journal_mode = WAL')`，
 *     node:sqlite 只提供 `exec`，且 PRAGMA 查询需要走 prepare().all()。
 *   - `transaction(fn)`：better-sqlite3 返回一个可调用包装器并支持嵌套（savepoint），
 *     node:sqlite 只有 exec，需要用 BEGIN/COMMIT/ROLLBACK 手工包。
 *   - `run()` 返回值：两者都是 `{ changes, lastInsertRowid }`，无需转换。
 */
import { DatabaseSync } from 'node:sqlite';
import { createRequire } from 'node:module';

type SqlValue = null | number | bigint | string | Uint8Array;

/** better-sqlite3 的 pragma() 支持读写与简易查询，这里按语句类型分流。 */
function pragmaImpl(db: DatabaseSync, source: string): unknown {
  const sql = `PRAGMA ${source}`;
  const stmt = db.prepare(sql);
  // 形如 `journal_mode` / `table_info(x)` 的查询返回行；`x = y` 的设置语句不返回行。
  const rows = stmt.all();
  if (Array.isArray(rows) && rows.length > 0) return rows;
  return undefined;
}

/**
 * 事务包装。depth 用于嵌套：外层 BEGIN，内层 SAVEPOINT，
 * 与 better-sqlite3 的嵌套事务语义对齐。
 */
function transactionImpl(db: DatabaseSync, fn: (...args: unknown[]) => unknown) {
  let depth = 0;
  const wrapper = (...args: unknown[]) => {
    const sp = `sp_${depth}`;
    if (depth === 0) db.exec('BEGIN');
    else db.exec(`SAVEPOINT ${sp}`);
    depth += 1;
    try {
      const result = fn(...args);
      depth -= 1;
      if (depth === 0) db.exec('COMMIT');
      else db.exec(`RELEASE ${sp}`);
      return result;
    } catch (err) {
      depth -= 1;
      if (depth === 0) db.exec('ROLLBACK');
      else db.exec(`ROLLBACK TO ${sp}`);
      throw err;
    }
  };
  // better-sqlite3 的 transaction 还提供 deferred/immediate/exclusive 变体
  (wrapper as unknown as Record<string, unknown>).deferred = wrapper;
  (wrapper as unknown as Record<string, unknown>).immediate = wrapper;
  (wrapper as unknown as Record<string, unknown>).exclusive = wrapper;
  return wrapper;
}

export interface SqliteStatement {
  run(...params: SqlValue[]): { changes: number | bigint; lastInsertRowid: number | bigint };
  get(...params: SqlValue[]): unknown;
  all(...params: SqlValue[]): unknown[];
  /**
   * better-sqlite3 的 raw() 返回「按列序的数组行」，drizzle 的 better-sqlite3 驱动
   * 依赖这个形状做字段映射（见 drizzle-orm/better-sqlite3/session 的 values()）。
   * node:sqlite 只返回对象行，这里按列名还原成数组。
   */
  raw(toggle?: boolean): SqliteStatement;
}

/**
 * 包装 node:sqlite 的 statement，补齐 better-sqlite3 的 raw() 语义。
 * raw() 返回「数组行」，且可链式调用；不带参数开关，始终保持数组模式（drizzle 恒用它）。
 */
function wrapStatement(stmt: ReturnType<DatabaseSync['prepare']>, rawMode = false): SqliteStatement {
  const toRow = (row: unknown): unknown => {
    if (!rawMode || row == null || typeof row !== 'object') return row;
    return Object.values(row as Record<string, unknown>);
  };
  const self: SqliteStatement = {
    run: (...params: SqlValue[]) => stmt.run(...(params as never[])) as
      { changes: number | bigint; lastInsertRowid: number | bigint },
    get: (...params: SqlValue[]) => toRow(stmt.get(...(params as never[]))),
    all: (...params: SqlValue[]) =>
      (stmt.all(...(params as never[])) as unknown[]).map(toRow),
    raw: (toggle?: boolean) => wrapStatement(stmt, toggle ?? true),
  };
  return self;
}

export interface SqliteLike {
  prepare(sql: string): SqliteStatement;
  exec(sql: string): void;
  pragma(source: string): unknown;
  transaction<T extends (...args: never[]) => unknown>(fn: T): T;
  close(): void;
  readonly open: boolean;
}

/**
 * 打开数据库，返回兼容 better-sqlite3 使用面的实例。
 * 默认使用 node:sqlite；CODINDEX_SQLITE=better-sqlite3 可回退到原生驱动。
 */
export function openSqlite(path: string): SqliteLike {
  if (process.env.CODINDEX_SQLITE === 'better-sqlite3') {
    // 动态 require，避免未安装时影响默认路径。
    // 注意：本包是 ESM（package.json type=module），裸写 `require()` 在
    // ESM 作用域里是 undefined，会把这条「逃生通道」变成
    // `ReferenceError: require is not defined in ES module scope`。
    // createRequire 以当前模块 URL 为基准，两种模块形态下都成立。
    // 注意：better-sqlite3 的原生 addon 是在**构造函数**里才 bindings() 的，
    // 所以 require 阶段不报错，真正的 ERR_DLOPEN_FAILED 出现在 `new mod(path)`。
    // 两处都要兜住才能给出可执行提示。
    try {
      const mod = createRequire(import.meta.url)('better-sqlite3') as
        new (p: string) => SqliteLike;
      return new mod(path);
    } catch (err: unknown) {
      // 原生 addon 的 ABI 不匹配是这套适配层存在的原因，必须给出可执行的提示，
      // 而不是抛一个用户看不懂的 ERR_DLOPEN_FAILED。
      const msg = (err as Error)?.message ?? String(err);
      throw new Error(
        `[codindex] CODINDEX_SQLITE=better-sqlite3 无法加载原生驱动：${msg}\n` +
        `        这通常是 NODE_MODULE_VERSION 不匹配（better-sqlite3 编译产物与当前 Node 版本不一致）。\n` +
        `        解决：npm rebuild better-sqlite3；或去掉该环境变量改用内置 node:sqlite。`,
      );
    }
  }

  const db = new DatabaseSync(path);
  // node:sqlite 未暴露「是否已打开」的布尔状态（open 是重新打开的方法），本地跟踪。
  let isOpen = true;
  const shim: SqliteLike = {
    prepare: (sql: string) => wrapStatement(db.prepare(sql)),
    exec: (sql: string) => db.exec(sql),
    pragma: (source: string) => pragmaImpl(db, source),
    transaction: ((fn: (...args: never[]) => unknown) =>
      transactionImpl(db, fn as (...args: unknown[]) => unknown)) as SqliteLike['transaction'],
    close: () => { isOpen = false; db.close(); },
    get open() { return isOpen; },
  };
  return shim;
}

export type { DatabaseSync };
