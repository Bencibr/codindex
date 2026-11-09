import { drizzle } from 'drizzle-orm/better-sqlite3';
import { openSqlite, type SqliteLike } from './sqlite-adapter.js';
import { SCHEMA_DDL } from './schema-ddl.js';
import * as schema from './schema.js';
import { resolve, dirname } from 'path';
import { mkdirSync, existsSync } from 'fs';

/**
 * CODINDEX_DB 支持两种特殊写法：
 *   - `:memory:` / `file::memory:`  → 走 SQLite 内存库（测试与 CI 冒烟用）
 *   - 其余值按普通文件路径处理
 *
 * 之前 `resolve(':memory:')` 会把它变成 `<cwd>/:memory:` —— 一个真实磁盘文件，
 * 于是「内存库」在仓库根目录留下一组 `:memory:` / `-wal` / `-shm` 文件，
 * 且跨进程共享，测试之间互相污染。这里显式放行内存写法。
 */
export function resolveDbPath(raw: string | undefined): string {
  if (!raw) return resolve('data', 'codindex.db');
  if (raw === ':memory:' || raw.startsWith('file::memory:')) return raw;
  return resolve(raw);
}

const DEFAULT_DB_PATH = resolveDbPath(process.env.CODINDEX_DB);

let _db: ReturnType<typeof drizzle<typeof schema>> | null = null;
let _sqlite: SqliteLike | null = null;

/** Lightweight schema migration — adds missing columns to existing databases */
function runMigrations(sqlite: SqliteLike): void {
  // 基础表：全新环境必须先建表。此前完全依赖 `drizzle-kit push`，
  // 导致新 clone / CI / 新 data 目录启动即报 `no such table: functions`。
  // 全部 IF NOT EXISTS，对已有库无副作用。
  for (const stmt of SCHEMA_DDL) {
    try {
      sqlite.exec(stmt);
    } catch (e) {
      // 单条建表失败不应中断后续迁移（如旧库已存在同名索引但定义不同）
      console.warn('[codindex] schema ddl skipped:', (e as Error)?.message);
    }
  }

  // L7 fix: PRAGMA doesn't support parameterization — table/col are hardcoded strings
  const columnExists = (table: string, col: string): boolean => {
    const cols = sqlite.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[];
    return cols.some(c => c.name === col);
  };

  const addCol = (table: string, col: string, def: string) => {
    if (!columnExists(table, col)) {
      sqlite.exec(`ALTER TABLE ${table} ADD COLUMN ${col} ${def}`);
    }
  };

  // Enhanced fields added to functions table (Phase 1)
  addCol('functions', 'body', "TEXT DEFAULT ''");
  addCol('functions', 'params_json', "TEXT DEFAULT '[]'");
  addCol('functions', 'return_type', "TEXT DEFAULT ''");
  addCol('functions', 'is_placeholder', "INTEGER DEFAULT 0");
  addCol('functions', 'summary', "TEXT DEFAULT ''");

  // Bridge call columns added to calls table (Phase 2)
  addCol('calls', 'bridge_target', "TEXT DEFAULT ''");
  addCol('calls', 'bridge_framework', "TEXT DEFAULT ''");

  // 未解析调用保留：callee_func_id 改可空 + 新增 callee_name。
  // SQLite 无法直接取消 NOT NULL，需重建表；仅在旧库仍是 NOT NULL 时执行一次。
  try {
    const cols = sqlite.prepare('PRAGMA table_info(calls)').all() as { name: string; notnull: number }[];
    const calleeCol = cols.find(c => c.name === 'callee_func_id');
    const calleeFileCol = cols.find(c => c.name === 'callee_file_id');
    if (calleeCol && calleeCol.notnull === 1 && calleeFileCol) {
      sqlite.exec(`
        CREATE TABLE IF NOT EXISTS calls_new (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
          caller_func_id INTEGER REFERENCES functions(id) ON DELETE CASCADE,
          callee_func_id INTEGER REFERENCES functions(id) ON DELETE CASCADE,
          caller_file_id INTEGER NOT NULL REFERENCES files(id) ON DELETE CASCADE,
          callee_file_id INTEGER REFERENCES files(id) ON DELETE CASCADE,
          call_line INTEGER,
          call_type TEXT,
          callee_name TEXT,
          is_external INTEGER DEFAULT 0,
          bridge_target TEXT DEFAULT '',
          bridge_framework TEXT DEFAULT ''
        );
        INSERT INTO calls_new (id, project_id, caller_func_id, callee_func_id, caller_file_id,
                               callee_file_id, call_line, call_type, is_external, bridge_target, bridge_framework)
          SELECT id, project_id, caller_func_id, callee_func_id, caller_file_id,
                 callee_file_id, call_line, call_type, is_external,
                 COALESCE(bridge_target,''), COALESCE(bridge_framework,'')
          FROM calls;
        DROP TABLE calls;
        ALTER TABLE calls_new RENAME TO calls;
        CREATE UNIQUE INDEX IF NOT EXISTS idx_call_edge ON calls(project_id, caller_func_id, callee_func_id, call_line);
        CREATE INDEX IF NOT EXISTS idx_call_caller ON calls(caller_func_id);
        CREATE INDEX IF NOT EXISTS idx_call_callee ON calls(callee_func_id);
        CREATE INDEX IF NOT EXISTS idx_call_callee_name ON calls(project_id, callee_name);
      `);
    }
  } catch (e) {
    console.warn('[codindex] calls table migration skipped:', (e as Error)?.message);
  }
  addCol('calls', 'callee_name', 'TEXT');
  sqlite.exec('CREATE INDEX IF NOT EXISTS idx_call_callee_name ON calls(project_id, callee_name)');

  // Control Flow Graph tables
  sqlite.exec(`
    CREATE TABLE IF NOT EXISTS control_flow_nodes (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
      func_id INTEGER NOT NULL REFERENCES functions(id) ON DELETE CASCADE,
      node_id TEXT NOT NULL,
      node_type TEXT NOT NULL,
      label TEXT,
      line_start INTEGER,
      line_end INTEGER,
      callee_func_id INTEGER,
      condition_expr TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_cfg_node_project ON control_flow_nodes(project_id);
    CREATE INDEX IF NOT EXISTS idx_cfg_node_func ON control_flow_nodes(func_id);
  `);

  sqlite.exec(`
    CREATE TABLE IF NOT EXISTS control_flow_edges (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
      func_id INTEGER NOT NULL REFERENCES functions(id) ON DELETE CASCADE,
      source_node_id TEXT NOT NULL,
      target_node_id TEXT NOT NULL,
      edge_label TEXT,
      edge_type TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_cfg_edge_project ON control_flow_edges(project_id);
    CREATE INDEX IF NOT EXISTS idx_cfg_edge_func ON control_flow_edges(func_id);
  `);

  // New tables created idempotently
  sqlite.exec(`
    CREATE TABLE IF NOT EXISTS type_fields (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      type_id INTEGER NOT NULL REFERENCES types(id) ON DELETE CASCADE,
      project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
      name TEXT NOT NULL,
      field_type TEXT NOT NULL,
      visibility TEXT,
      is_optional INTEGER DEFAULT 0,
      default_value TEXT,
      line_start INTEGER
    );
    CREATE UNIQUE INDEX IF NOT EXISTS idx_type_field ON type_fields(type_id, name);
    CREATE INDEX IF NOT EXISTS idx_type_field_project ON type_fields(project_id);
  `);

  sqlite.exec(`
    CREATE TABLE IF NOT EXISTS test_mappings (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
      test_func_id INTEGER NOT NULL REFERENCES functions(id) ON DELETE CASCADE,
      target_func_id INTEGER REFERENCES functions(id) ON DELETE SET NULL,
      confidence REAL DEFAULT 0.8
    );
    CREATE UNIQUE INDEX IF NOT EXISTS idx_test_mapping ON test_mappings(project_id, test_func_id, target_func_id);
  `);

  sqlite.exec(`
    CREATE TABLE IF NOT EXISTS type_usage_edges (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
      func_id INTEGER NOT NULL REFERENCES functions(id) ON DELETE CASCADE,
      type_id INTEGER NOT NULL REFERENCES types(id) ON DELETE CASCADE,
      usage_type TEXT NOT NULL
    );
    CREATE UNIQUE INDEX IF NOT EXISTS idx_type_usage ON type_usage_edges(project_id, func_id, type_id, usage_type);
    CREATE INDEX IF NOT EXISTS idx_type_usage_type ON type_usage_edges(type_id);
  `);
}

export function getDb(dbPath?: string) {
  const path = dbPath || DEFAULT_DB_PATH;

  // If same path requested, return cached
  if (_sqlite && !dbPath) return _db!;
  if (_sqlite && dbPath && dbPath === (global as any).__codindex_db_path) return _db!;

  // Close previous connection if different path
  if (_sqlite) {
    try { _sqlite.close(); } catch { /* ignore */ }
  }

  const dir = dirname(path);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });

  // 内存库没有文件目录可建，且 WAL 对内存库无意义（SQLite 会忽略，
  // 但显式跳过更清楚）。
  const isMemory = path === ':memory:' || path.startsWith('file::memory:');

  const sqlite = openSqlite(path);
  if (!isMemory) sqlite.pragma('journal_mode = WAL');
  sqlite.pragma('foreign_keys = ON');

  // Run lightweight migrations for schema evolution
  runMigrations(sqlite);

  // Ensure FTS5 virtual table exists
  sqlite.exec(`
    CREATE VIRTUAL TABLE IF NOT EXISTS functions_fts USING fts5(
      name, body, signature, doc_comment, file_path,
      content='', content_rowid=id
    );
  `);

  (global as any).__codindex_db_path = path;
  _sqlite = sqlite;
  // drizzle-orm/better-sqlite3 的 d.ts 把入参约束为 better-sqlite3 的 Database 类型；
  // 我们的适配层在运行时满足同一使用面（prepare/exec/pragma/transaction/close）。
  // 这里显式桥接，避免为类型引入原生依赖。
  _db = drizzle(sqlite as never, { schema });
  return _db;
}

/** Get the raw SQLite connection (node:sqlite 或 better-sqlite3) for CTE/raw queries */
export function getSqlite(): SqliteLike {
  if (!_sqlite) throw new Error('Database not initialized — call getDb() first');
  return _sqlite;
}

export function closeDb(): void {
  if (_sqlite) {
    try { _sqlite.close(); } catch { /* ignore */ }
    _sqlite = null;
    _db = null;
  }
}