import { describe, it, expect } from 'vitest';
import { getDb } from '../db/connection';
import { closeDb } from '../db/connection';

describe('Database — connection', () => {
  it('creates a working SQLite connection', () => {
    const db = getDb();
    const row = db.get<{ val: number }>('SELECT 1 as val');
    expect(row?.val).toBe(1);
  });

  it('WAL mode is enabled', () => {
    const db = getDb();
    const row = db.get<{ journal_mode: string }>('PRAGMA journal_mode');
    expect(row?.journal_mode?.toLowerCase()).toBe('wal');
  });

  it('foreign keys are enabled', () => {
    const db = getDb();
    const row = db.get<{ foreign_keys: number }>('PRAGMA foreign_keys');
    expect(row?.foreign_keys).toBe(1);
  });

  it('core tables exist', () => {
    const db = getDb();
    // all<T> 的泛型参数是**单行**类型（内部再包一层数组），
    // 传 `{name:string}[]` 会得到双层数组，t.name 自然取不到。
    const tables = db.all<{ name: string }>(
      "SELECT name FROM sqlite_master WHERE type='table' ORDER BY name",
    );
    const names = tables.map(t => t.name);
    expect(names).toContain('projects');
    expect(names).toContain('files');
    expect(names).toContain('functions');
    expect(names).toContain('calls');
    expect(names).toContain('types');
    expect(names).toContain('modules');
    expect(names).toContain('module_deps');
    expect(names).toContain('features');
    expect(names).toContain('feature_code');
  });
});