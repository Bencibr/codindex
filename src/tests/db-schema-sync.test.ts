import { describe, it, expect } from 'vitest';
import { SCHEMA_DDL } from '../db/schema-ddl';
import * as schema from '../db/schema';
import { DatabaseSync } from 'node:sqlite';

/**
 * 守护 SCHEMA_DDL 与 schema.ts 的一致性。
 *
 * SCHEMA_DDL 是内嵌的建表语句（来源：drizzle-kit generate）。
 * 它一旦与 schema.ts 脱节，全新环境会建出过时的表结构，且因为全部是
 * IF NOT EXISTS，错误会在运行时才暴露成「no such column」这类难查的问题。
 * 这里用「从 schema 取真实表名 → 在空库执行 DDL → 比对」双向校验。
 */

/** 从 drizzle 表对象里取真实 SQLite 表名 */
function tableNames(): string[] {
  const names: string[] = [];
  for (const value of Object.values(schema)) {
    // drizzle 的表对象带 Symbol.for('drizzle:Name') 元数据。
    // 先经 unknown 中转：表对象类型与 Record<symbol, unknown> 不重叠，直接断言会被拒绝。
    const meta = (value as unknown as Record<symbol, unknown> | null)?.[
      Symbol.for('drizzle:Name')
    ];
    if (typeof meta === 'string') names.push(meta);
  }
  return names.sort();
}

describe('SCHEMA_DDL — 与 schema.ts 同步', () => {
  it('schema.ts 中每张表都出现在 SCHEMA_DDL', () => {
    const declared = tableNames();
    expect(declared.length).toBeGreaterThan(0);

    // 必须精确匹配 `CREATE TABLE IF NOT EXISTS \`name\``，
    // 不能用 includes(`name`)：表名会以 FOREIGN KEY 引用形式散落在其他语句里，
    // 导致删掉建表语句后断言依然通过（曾出现过的假阴性）。
    const created = SCHEMA_DDL
      .map(s => s.match(/^CREATE TABLE IF NOT EXISTS `([^`]+)`/)?.[1])
      .filter((n): n is string => !!n);

    const missing = declared.filter(t => !created.includes(t));
    expect(missing).toEqual([]);
    // 反向：DDL 里也不应有 schema 未声明的表
    const extra = created.filter(t => !declared.includes(t));
    expect(extra).toEqual([]);
  });

  it('全部语句幂等（可重复执行且不报错）', () => {
    for (const stmt of SCHEMA_DDL) {
      // 建表/建索引必须带 IF NOT EXISTS，否则二次启动会炸
      expect(stmt).toMatch(/^CREATE (TABLE|UNIQUE INDEX|INDEX) IF NOT EXISTS /);
    }
  });

  it('在空库执行后可建出全部声明表，且重复执行仍成功', () => {
    const db = new DatabaseSync(':memory:');
    db.exec('PRAGMA foreign_keys = ON');

    const apply = () => {
      for (const stmt of SCHEMA_DDL) db.exec(stmt);
    };
    apply();
    // 幂等性：再执行一次不应抛错
    expect(apply).not.toThrow();

    const actual = (
      db
        .prepare(
          "SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'",
        )
        .all() as { name: string }[]
    )
      .map(r => r.name)
      .sort();

    const declared = tableNames();
    const missing = declared.filter(t => !actual.includes(t));
    expect(missing).toEqual([]);
    db.close();
  });

  it('calls 表允许未解析边（callee_func_id 可空 + callee_name 保留）', () => {
    const db = new DatabaseSync(':memory:');
    db.exec('PRAGMA foreign_keys = ON');
    for (const stmt of SCHEMA_DDL) db.exec(stmt);

    const cols = db.prepare('PRAGMA table_info(calls)').all() as {
      name: string;
      notnull: number;
    }[];
    const calleeFunc = cols.find(c => c.name === 'callee_func_id');
    expect(calleeFunc?.notnull).toBe(0);
    expect(cols.some(c => c.name === 'callee_name')).toBe(true);

    // 未解析边能真正插入
    db.exec("INSERT INTO projects (id, name, path) VALUES ('p1','x','/x')");
    db.exec(
      "INSERT INTO files (id, project_id, path, language) VALUES (1,'p1','a.py','python')",
    );
    expect(() =>
      db
        .prepare(
          'INSERT INTO calls (project_id, caller_file_id, call_line, call_type, callee_name, is_external) VALUES (?,?,?,?,?,?)',
        )
        .run('p1', 1, 10, 'method_unresolved', 'compute_capacity', 1),
    ).not.toThrow();

    db.close();
  });
});

describe('raise_edges — 异常路径表', () => {
  it('DDL 建出 raise_edges 且关键列齐全', () => {
    const db = new DatabaseSync(':memory:');
    db.exec('PRAGMA foreign_keys = ON');
    for (const stmt of SCHEMA_DDL) db.exec(stmt);

    const cols = (db.prepare('PRAGMA table_info(raise_edges)').all() as { name: string }[])
      .map(c => c.name);
    // error_type 必须是字符串而非外键 id：ValueError/RequestException 等
    // 标准库或第三方异常不在本仓 types 表里，硬外键会静默丢边。
    for (const need of ['project_id', 'func_id', 'file_id', 'error_type', 'line', 'kind']) {
      expect(cols).toContain(need);
    }
    db.close();
  });

  it('同一函数重复抛同一类型不会重复插入', () => {
    const db = new DatabaseSync(':memory:');
    db.exec('PRAGMA foreign_keys = ON');
    for (const stmt of SCHEMA_DDL) db.exec(stmt);
    db.exec("INSERT INTO projects (id,name,path) VALUES ('p','x','/x')");
    db.exec("INSERT INTO files (id,project_id,path,language) VALUES (1,'p','a.py','python')");
    db.exec("INSERT INTO functions (id,project_id,file_id,name) VALUES (1,'p',1,'f')");

    const ins = db.prepare(
      'INSERT INTO raise_edges (project_id,func_id,file_id,error_type,line,kind) VALUES (?,?,?,?,?,?) ON CONFLICT DO NOTHING',
    );
    ins.run('p', 1, 1, 'ValueError', 10, 'raise');
    ins.run('p', 1, 1, 'ValueError', 10, 'raise');   // 完全重复

    const n = (db.prepare('SELECT COUNT(*) c FROM raise_edges').get() as { c: number }).c;
    expect(n).toBe(1);

    // 不同行号是不同抛出点，必须各自保留
    ins.run('p', 1, 1, 'ValueError', 20, 'raise');
    const n2 = (db.prepare('SELECT COUNT(*) c FROM raise_edges').get() as { c: number }).c;
    expect(n2).toBe(2);
    db.close();
  });
});
