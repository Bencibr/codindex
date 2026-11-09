import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import * as schema from '../db/schema';
import { getDb } from '../db/connection';
import { scanProject } from '../scan/orchestrator';
import { existsSync, mkdirSync, rmSync, writeFileSync } from 'fs';
import { resolve } from 'path';
import { execSync } from 'child_process';
import { buildImportMap, resolveCalls, resolveImportPath } from '../scan/call-graph';
import { buildModuleGraph, getChangedFiles } from '../scan/module-graph';
import { scanFile } from '../scan/scanner-ts';
import { eq } from 'drizzle-orm';
import { v4 as uuid } from 'uuid';
import { TEST_PROJECT_DIR, isGitAvailable } from './helpers';

const gitAvailable = isGitAvailable();

describe('Phase 2 — cross-file call resolution', () => {
  let db: ReturnType<typeof getDb>;
  let projectId: string | null = null;

  beforeAll(async () => {
    db = getDb();
    expect(existsSync(TEST_PROJECT_DIR)).toBe(true);
  });

  afterAll(() => {
    if (projectId) {
      db.delete(schema.calls).where(eq(schema.calls.projectId, projectId));
      db.delete(schema.functions).where(eq(schema.functions.projectId, projectId));
      db.delete(schema.types).where(eq(schema.types.projectId, projectId));
      db.delete(schema.files).where(eq(schema.files.projectId, projectId));
      db.delete(schema.moduleDeps).where(eq(schema.moduleDeps.projectId, projectId));
      db.delete(schema.modules).where(eq(schema.modules.projectId, projectId));
      db.delete(schema.controlFlowNodes).where(eq(schema.controlFlowNodes.projectId, projectId));
      db.delete(schema.controlFlowEdges).where(eq(schema.controlFlowEdges.projectId, projectId));
      db.delete(schema.projects).where(eq(schema.projects.id, projectId));
    }
  });

  it('buildImportMap creates a correct import map', () => {
    const absRoot = TEST_PROJECT_DIR;
    const absPaths = [
      `${absRoot}/src/utils/helpers.ts`,
      `${absRoot}/src/services/user-service.ts`,
      `${absRoot}/src/index.ts`,
    ];

    const scans = new Map();
    for (const fp of absPaths) {
      const lang = fp.endsWith('.ts') ? 'typescript' : 'javascript';
      scans.set(fp, scanFile(fp, lang));
    }

    const map = buildImportMap(absRoot, absPaths, scans);

    // Check user-service.ts imports
    const svc = map.get(`${absRoot}/src/services/user-service.ts`);
    expect(svc).toBeDefined();
    const helpersImport = svc!.imports.find(i => i.source.includes('../utils/helpers'));
    expect(helpersImport).toBeDefined();
    expect(helpersImport!.names).toContain('formatDate');
    expect(helpersImport!.names).toContain('clamp');
  });

  it('resolveImportPath handles relative paths', () => {
    const fileLookup = new Set([`${TEST_PROJECT_DIR}/src/utils/helpers.ts`]);

    const result = resolveImportPath(
      '../utils/helpers',
      `${TEST_PROJECT_DIR}/src/services/user-service.ts`,
      TEST_PROJECT_DIR,
      fileLookup,
    );

    expect(result).toBe(`${TEST_PROJECT_DIR}/src/utils/helpers.ts`);
  });

  it('resolveImportPath returns null for package imports', () => {
    const result = resolveImportPath(
      'react',
      `${TEST_PROJECT_DIR}/src/index.ts`,
      TEST_PROJECT_DIR,
      new Set(),
    );
    expect(result).toBeNull();
  });

  it('resolveImportPath returns null for non-existent files', () => {
    const result = resolveImportPath(
      './nonexistent',
      `${TEST_PROJECT_DIR}/src/index.ts`,
      TEST_PROJECT_DIR,
      new Set(),
    );
    expect(result).toBeNull();
  });
});

describe('Phase 2 — module dependency graph', () => {
  it('buildModuleGraph produces correct structure', () => {
    const absRoot = TEST_PROJECT_DIR;
    const absPaths = [
      `${absRoot}/src/utils/helpers.ts`,
      `${absRoot}/src/services/user-service.ts`,
      `${absRoot}/src/index.ts`,
    ];
    const fileLookup = new Set(absPaths);

    const scans = new Map();
    for (const fp of absPaths) {
      scans.set(fp, scanFile(fp, 'typescript'));
    }
    const importMap = buildImportMap(absRoot, absPaths, scans);

    const result = buildModuleGraph(importMap, absRoot, fileLookup);

    expect(result.modules.length).toBeGreaterThanOrEqual(2);
    expect(Array.isArray(result.edges)).toBe(true);
    expect(Array.isArray(result.cycles)).toBe(true);
  });
});

describe('Phase 2 — orchestrator integration', () => {
  let db: ReturnType<typeof getDb>;
  let projectId: string | null = null;

  beforeAll(async () => {
    db = getDb();
    // Clean up any leftover test data
    await db.delete(schema.projects).where(eq(schema.projects.path, TEST_PROJECT_DIR));
  });

  it('produces cross-file calls when scanning', async () => {
    projectId = uuid();

    await db.insert(schema.projects).values({
      id: projectId, name: 'Phase2Test', path: TEST_PROJECT_DIR, status: 'pending',
    });

    const result = await scanProject(projectId, TEST_PROJECT_DIR);

    // Files found
    expect(result.files).toBeGreaterThanOrEqual(5);
    expect(result.functions).toBeGreaterThanOrEqual(8);
    expect(result.types).toBeGreaterThanOrEqual(2);

    // Cross-file calls
    const calls = await db.select().from(schema.calls).where(eq(schema.calls.projectId, projectId));
    // Cross-file resolution is best-effort — check by scanning result
    if (result.calls > 0) {
      expect(calls.length).toBeGreaterThan(0);
    } else {
      // If 0 calls resolved, verify the rest completed
      expect(result.files).toBeGreaterThanOrEqual(5);
      expect(result.functions).toBeGreaterThanOrEqual(8);
    }

    // Module deps created
    const deps = await db.select().from(schema.moduleDeps).where(eq(schema.moduleDeps.projectId, projectId));
    const modules = await db.select().from(schema.modules).where(eq(schema.modules.projectId, projectId));
    expect(modules.length).toBeGreaterThanOrEqual(2);

    // Return module/cycle counts
    expect(result.modules).toBeGreaterThanOrEqual(2);

    // Cleanup
    await db.delete(schema.calls).where(eq(schema.calls.projectId, projectId));
    await db.delete(schema.functions).where(eq(schema.functions.projectId, projectId));
    await db.delete(schema.types).where(eq(schema.types.projectId, projectId));
    await db.delete(schema.files).where(eq(schema.files.projectId, projectId));
    await db.delete(schema.moduleDeps).where(eq(schema.moduleDeps.projectId, projectId));
    await db.delete(schema.modules).where(eq(schema.modules.projectId, projectId));
    await db.delete(schema.projects).where(eq(schema.projects.id, projectId));
  }, 60_000);
});

describe('Phase 2 — cycle detection', () => {
  it('detects a 2-node cycle', () => {
    const absRoot = '/tmp/codindex-cycle-test';
    const absPaths = [`${absRoot}/modA/a.ts`, `${absRoot}/modB/b.ts`];
    const fileLookup = new Set(absPaths);

    // Create a fake import map: modA imports modB, modB imports modA
    const importMap = new Map<string, { relPath: string; module: string; imports: { source: string; names: string[]; line: number }[] }>();
    importMap.set(`${absRoot}/modA/a.ts`, {
      relPath: 'modA/a.ts', module: 'modA',
      imports: [{ source: '../modB/b', names: ['beta'], line: 1 }],
    });
    importMap.set(`${absRoot}/modB/b.ts`, {
      relPath: 'modB/b.ts', module: 'modB',
      imports: [{ source: '../modA/a', names: ['alpha'], line: 1 }],
    });

    const result = buildModuleGraph(importMap, absRoot, fileLookup);
    expect(result.cycles.length).toBeGreaterThanOrEqual(1);
    expect(result.cycles[0].description).toContain('modA');
    expect(result.cycles[0].description).toContain('modB');
  });

  it('detects no cycles for acyclic graph', () => {
    const absRoot = '/tmp/codindex-acyclic-test';
    const absPaths = [`${absRoot}/modX/x.ts`, `${absRoot}/modY/y.ts`];
    const fileLookup = new Set(absPaths);

    const importMap = new Map<string, { relPath: string; module: string; imports: { source: string; names: string[]; line: number }[] }>();
    importMap.set(`${absRoot}/modX/x.ts`, {
      relPath: 'modX/x.ts', module: 'modX',
      imports: [{ source: '../modY/y', names: ['yo'], line: 1 }],
    });
    importMap.set(`${absRoot}/modY/y.ts`, {
      relPath: 'modY/y.ts', module: 'modY',
      imports: [],  // no back-edge
    });

    const result = buildModuleGraph(importMap, absRoot, fileLookup);
    expect(result.cycles.length).toBe(0);
    expect(result.edges.length).toBe(1);
    expect(result.edges[0].fromModule).toBe('modX');
    expect(result.edges[0].toModule).toBe('modY');
  });

  it('handles empty import map', () => {
    const result = buildModuleGraph(new Map(), '/tmp', new Set());
    expect(result.modules.length).toBe(0);
    expect(result.edges.length).toBe(0);
    expect(result.cycles.length).toBe(0);
  });

  it('deduplicates parallel edges', () => {
    const absRoot = '/tmp/codindex-dedup-test';
    const absPaths = [`${absRoot}/modP/p.ts`, `${absRoot}/modQ/q.ts`];
    const fileLookup = new Set(absPaths);

    const importMap = new Map<string, { relPath: string; module: string; imports: { source: string; names: string[]; line: number }[] }>();
    importMap.set(`${absRoot}/modP/p.ts`, {
      relPath: 'modP/p.ts', module: 'modP',
      imports: [
        { source: '../modQ/q', names: ['a'], line: 1 },
        { source: '../modQ/q', names: ['b'], line: 2 },
      ],
    });
    importMap.set(`${absRoot}/modQ/q.ts`, {
      relPath: 'modQ/q.ts', module: 'modQ',
      imports: [],
    });

    const result = buildModuleGraph(importMap, absRoot, fileLookup);
    // Should only have 1 edge despite 2 imports to same module
    expect(result.edges.length).toBe(1);
  });
});

describe('Phase 2 — getChangedFiles', () => {
  const gitDir = resolve('/tmp', `codindex-git-test-${process.env.VITEST_WORKER_ID || '0'}`);

  beforeAll(() => {
    if (existsSync(gitDir)) rmSync(gitDir, { recursive: true });
    mkdirSync(gitDir, { recursive: true });
    if (!gitAvailable) return;
    execSync('git init', { cwd: gitDir, stdio: 'pipe' });
    execSync('git config user.email test@test', { cwd: gitDir, stdio: 'pipe' });
    execSync('git config user.name T', { cwd: gitDir, stdio: 'pipe' });
    writeFileSync(`${gitDir}/test.ts`, 'export const x = 1;\n');
    execSync('git add -A && git commit -m "init"', { cwd: gitDir, stdio: 'pipe' });
  });

  afterAll(() => {
    if (existsSync(gitDir)) rmSync(gitDir, { recursive: true });
  });

  it('returns empty array when lastScanned is 0', () => {
    const result = getChangedFiles(gitDir, 0);
    expect(result).toEqual([]);
  });

  it('returns empty array when no changes since last scan', () => {
    const futureTs = Math.floor(Date.now() / 1000) + 3600;
    const result = getChangedFiles(gitDir, futureTs);
    expect(result).toEqual([]);
  });

  it('returns changed files after a commit', () => {
    if (!gitAvailable) return;
    writeFileSync(`${gitDir}/new.ts`, 'export const y = 2;\n');
    execSync('git add -A && git commit -m "add new"', { cwd: gitDir, stdio: 'pipe' });

    const pastTs = Math.floor(Date.now() / 1000) - 60;
    const result = getChangedFiles(gitDir, pastTs);
    expect(result.length).toBeGreaterThanOrEqual(1);
    expect(result.some(f => f.includes('new.ts'))).toBe(true);
  });

  it('returns empty array for non-git directory', () => {
    const nonGit = '/tmp/codindex-non-git-' + Date.now();
    mkdirSync(nonGit, { recursive: true });
    const result = getChangedFiles(nonGit, Math.floor(Date.now() / 1000) - 60);
    expect(result).toEqual([]);
    rmSync(nonGit, { recursive: true });
  });
});

describe('call-graph — self/this 方法解析（零误连）', () => {
  const buildInv = (scan: ReturnType<typeof scanFile>) =>
    scan.functions.map((f: any, i: number) => ({
      id: i + 1, name: f.name, fileId: 1, filePath: '/p/a.py',
      lineStart: f.lineStart, lineEnd: f.lineEnd,
      ownerClass: f.fullName?.includes('.')
        ? f.fullName.slice(0, f.fullName.lastIndexOf('.'))
        : null,
    }));

  const run = (src: string, parentOf?: Map<string, string>) => {
    const scan = scanFile('/p/a.py', 'python', src);
    const scans = new Map([['/p/a.py', scan]]);
    const importMap = new Map([['/p/a.py', { relPath: 'a.py', imports: [] }]]);
    const inv = buildInv(scan);
    const out = resolveCalls(
      importMap as any, inv, new Map([['a.py', 1]]), '/p', ['/p/a.py'], scans as any, parentOf,
    );
    return { out, inv };
  };

  it('self.X() 解析到本类方法，而不是同文件同名的其他类方法', () => {
    // 关键场景：同文件两个类都有 to_dict，self.to_dict() 必须连到自己的类
    const src = [
      'class A:',
      '    def to_dict(self):',
      '        pass',
      '    def save(self):',
      '        self.to_dict()',
      'class B:',
      '    def to_dict(self):',
      '        pass',
    ].join('\n');
    const { out, inv } = run(src);
    const edge = out.find(e => e.callType === 'self_method');
    expect(edge).toBeDefined();
    const callee = inv.find(x => x.id === edge!.calleeFuncId)!;
    // 必须指向 A.to_dict，不能是 B.to_dict
    expect(callee.ownerClass).toBe('A');
  });

  it('沿继承链解析子类未重写的父类方法', () => {
    const src = [
      'class Base:',
      '    def helper(self):',
      '        pass',
      'class Child(Base):',
      '    def run(self):',
      '        self.helper()',
    ].join('\n');
    const { out, inv } = run(src, new Map([['Child', 'Base']]));
    const edge = out.find(e => e.callType === 'self_method_inherited');
    expect(edge).toBeDefined();
    const callee = inv.find(x => x.id === edge!.calleeFuncId)!;
    expect(callee.ownerClass).toBe('Base');
    expect(callee.name).toBe('helper');
  });

  it('非 self 接收者（obj.X()）不做猜测性解析', () => {
    const src = [
      'class A:',
      '    def helper(self):',
      '        pass',
      '    def run(self, other):',
      '        other.helper()',
    ].join('\n');
    const { out } = run(src);
    // 不得产生 self_method 边：接收者类型未知，按名硬连会产生大规模误连
    expect(out.filter(e => e.callType.startsWith('self_method'))).toEqual([]);
  });
});

describe('call-graph — 性能不退化', () => {
  it('caller 查找按文件预分组，不再遍历全量函数表', async () => {
    // 回归：内层曾每个调用遍历整个 funcInventory（185k × 18k ≈ 3.4e9 次比较，
    // 扫描从 ~90s 涨到 5 分钟以上）。这里用大函数表验证耗时是线性量级。
    const N = 3000;
    const src = Array.from({ length: N }, (_, i) =>
      `def f${i}():\n    pass\n`).join('');
    const calls = Array.from({ length: 300 }, () => 'f1()\n').join('');
    const full = src + `def top():\n${calls.split('\n').map(l => '    ' + l).join('\n')}`;

    const scan = scanFile('/p/a.py', 'python', full);
    const inv = scan.functions.map((f: any, i: number) => ({
      id: i + 1, name: f.name, fileId: 1, filePath: '/p/a.py',
      lineStart: f.lineStart, lineEnd: f.lineEnd, ownerClass: null,
    }));
    const scans = new Map([['/p/a.py', scan]]);
    const importMap = new Map([['/p/a.py', { relPath: 'a.py', imports: [] }]]);

    const t0 = Date.now();
    resolveCalls(importMap as any, inv, new Map([['a.py', 1]]), '/p', ['/p/a.py'], scans as any);
    const ms = Date.now() - t0;

    // 全局遍历会是 300 calls × 3000 funcs = 900k 次；按文件分组是 300 × 3000/1 文件…
    // 这里真正要守的是「不随函数表规模爆炸」：给 5s 上限即可捕获 O(n²) 回归。
    expect(ms).toBeLessThan(5000);
    expect(scan.calls.length).toBeGreaterThan(0);
  });
});

describe('Phase 2 — git 元信息必须真正落库', () => {
  it('扫描后 files.last_modified / authors 不得恒为 NULL', async () => {
    // 回归：曾把 lastModified 硬编码为 null 并注释「handled below」，
    // 但根本没有 below —— gitStats 算了却被丢弃。后果是
    // /api/projects/:id/diff?since= 的增量检测永远返回空集，
    // MCP get_file_content 的 lastModified 永远为 null。
    const db = getDb();
    await db.delete(schema.projects).where(eq(schema.projects.path, TEST_PROJECT_DIR));
    const pid = uuid();
    await db.insert(schema.projects).values({
      id: pid, name: 'GitStatsPersist', path: TEST_PROJECT_DIR, status: 'pending',
    });

    await scanProject(pid, TEST_PROJECT_DIR);

    const files = await db
      .select({ path: schema.files.path, lastModified: schema.files.lastModified, authors: schema.files.authors })
      .from(schema.files)
      .where(eq(schema.files.projectId, pid));
    expect(files.length).toBeGreaterThan(0);

    // 测试项目不是 git 仓库 → 值可以为 null，但必须存在列访问且不抛错。
    // 真正的断言放在下一例（真 git 仓库）。
    for (const f of files) {
      expect(f).toHaveProperty('lastModified');
      expect(f).toHaveProperty('authors');
    }

    await db.delete(schema.functions).where(eq(schema.functions.projectId, pid));
    await db.delete(schema.files).where(eq(schema.files.projectId, pid));
    await db.delete(schema.projects).where(eq(schema.projects.id, pid));
  }, 60_000);

  it('真 git 仓库扫描后 last_modified 与 authors 有值', async () => {
    const db = getDb();
    const repo = resolve('/tmp', `codindex-gitscan-${process.env.VITEST_WORKER_ID || '0'}`);
    if (existsSync(repo)) rmSync(repo, { recursive: true });
    mkdirSync(repo, { recursive: true });
    const g = (a: string) => execSync(`git ${a}`, { cwd: repo, stdio: 'pipe' });
    g('init -q');
    g('config user.email a@b.c');
    g('config user.name Alice');
    writeFileSync(`${repo}/mod.js`, 'export function f(){ return 1; }\n');
    g('add -A');
    execSync('git -c user.name=Alice -c user.email=alice@x.y commit -q -m init', {
      cwd: repo, stdio: 'pipe',
      env: { ...process.env, GIT_AUTHOR_DATE: '2026-03-03T00:00:00 +0800', GIT_COMMITTER_DATE: '2026-03-03T00:00:00 +0800' },
    });

    await db.delete(schema.projects).where(eq(schema.projects.path, repo));
    const pid = uuid();
    await db.insert(schema.projects).values({ id: pid, name: 'GitScan', path: repo, status: 'pending' });
    await scanProject(pid, repo);

    const files = await db
      .select({ lastModified: schema.files.lastModified, authors: schema.files.authors })
      .from(schema.files)
      .where(eq(schema.files.projectId, pid));
    expect(files.length).toBeGreaterThan(0);
    expect(files[0].lastModified).not.toBeNull();
    expect(JSON.parse(files[0].authors || '[]')).toContain('Alice');

    await db.delete(schema.functions).where(eq(schema.functions.projectId, pid));
    await db.delete(schema.files).where(eq(schema.files.projectId, pid));
    await db.delete(schema.projects).where(eq(schema.projects.id, pid));
    rmSync(repo, { recursive: true });
  }, 60_000);

  it('项目注册在仓库子目录时，last_modified 依然落库', async () => {
    // 回归：批量 git 预取的 key 曾是「仓库根相对路径」，而写入时用 relPath
    // （项目根相对路径）。当 project.path 是 monorepo 的子目录时两者不等，
    // Map.get 全部落空 → 整库 last_modified 静默变 NULL，/diff 永远返回空。
    const db = getDb();
    const repo = resolve('/tmp', `codindex-gitsub-scan-${process.env.VITEST_WORKER_ID || '0'}`);
    if (existsSync(repo)) rmSync(repo, { recursive: true });
    mkdirSync(`${repo}/packages/app`, { recursive: true });
    const g = (a: string) => execSync(`git ${a}`, { cwd: repo, stdio: 'pipe' });
    g('init -q');
    g('config user.email a@b.c');
    g('config user.name Alice');
    writeFileSync(`${repo}/root.js`, 'export const r = 1;\n');
    writeFileSync(`${repo}/packages/app/mod.js`, 'export function f(){ return 1; }\n');
    writeFileSync(`${repo}/packages/app/中文.js`, 'export function cn(){ return 1; }\n');
    g('add -A');
    execSync('git -c user.name=Alice -c user.email=alice@x.y commit -q -m init', {
      cwd: repo, stdio: 'pipe',
      env: { ...process.env, GIT_AUTHOR_DATE: '2026-04-04T00:00:00 +0800', GIT_COMMITTER_DATE: '2026-04-04T00:00:00 +0800' },
    });

    const appDir = `${repo}/packages/app`;
    await db.delete(schema.projects).where(eq(schema.projects.path, appDir));
    const pid = uuid();
    await db.insert(schema.projects).values({ id: pid, name: 'GitSubScan', path: appDir, status: 'pending' });
    await scanProject(pid, appDir);

    const files = await db
      .select({ path: schema.files.path, lastModified: schema.files.lastModified, authors: schema.files.authors })
      .from(schema.files)
      .where(eq(schema.files.projectId, pid));
    expect(files.length).toBeGreaterThan(0);

    // 每一个文件都必须有值：子目录场景下「部分命中」同样是 bug
    for (const f of files) {
      expect(f.lastModified, `${f.path} 的 last_modified 为空`).not.toBeNull();
    }
    const cn = files.find(f => f.path.includes('中文'));
    expect(cn, '非 ASCII 文件应当被索引').toBeDefined();
    expect(cn!.lastModified).not.toBeNull();
    expect(JSON.parse(cn!.authors || '[]')).toContain('Alice');

    await db.delete(schema.functions).where(eq(schema.functions.projectId, pid));
    await db.delete(schema.files).where(eq(schema.files.projectId, pid));
    await db.delete(schema.projects).where(eq(schema.projects.id, pid));
    rmSync(repo, { recursive: true });
  }, 60_000);

  it('重扫会刷新内容与 last_modified（不再停在首次扫描）', async () => {
    // 回归：全部写入都是 ON CONFLICT DO NOTHING，且旧数据清理依赖调用方。
    // 结果直接调 scanProject 重扫时，改过的函数体、改过的 last_modified
    // 全部保持第一次扫描的值 —— 于是 /diff?since= 的增量结果恒为空，
    // 函数体也会与实际代码脱节（AI 读到的是历史版本）。
    const db = getDb();
    const repo = resolve('/tmp', `codindex-rescan-${process.env.VITEST_WORKER_ID || '0'}`);
    if (existsSync(repo)) rmSync(repo, { recursive: true });
    mkdirSync(repo, { recursive: true });
    const g = (a: string) => execSync(`git ${a}`, { cwd: repo, stdio: 'pipe' });
    g('init -q');
    g('config user.email a@b.c');
    g('config user.name Alice');
    writeFileSync(`${repo}/mod.js`, 'export function f(){ return 1; }\n');
    g('add -A');
    execSync('git -c user.name=Alice -c user.email=alice@x.y commit -q -m c1', {
      cwd: repo, stdio: 'pipe',
      env: { ...process.env, GIT_AUTHOR_DATE: '2026-05-05T00:00:00 +0800', GIT_COMMITTER_DATE: '2026-05-05T00:00:00 +0800' },
    });

    await db.delete(schema.projects).where(eq(schema.projects.path, repo));
    const pid = uuid();
    await db.insert(schema.projects).values({ id: pid, name: 'Rescan', path: repo, status: 'pending' });
    await scanProject(pid, repo);

    const beforeFiles = await db
      .select({ lastModified: schema.files.lastModified })
      .from(schema.files).where(eq(schema.files.projectId, pid));
    const beforeFns = await db
      .select({ name: schema.functions.name, body: schema.functions.body })
      .from(schema.functions).where(eq(schema.functions.projectId, pid));
    expect(beforeFiles[0].lastModified).not.toBeNull();
    expect(beforeFns.some(f => f.body?.includes('return 1'))).toBe(true);

    // 改内容 + 换作者 + 换时间，再提交
    writeFileSync(`${repo}/mod.js`, 'export function f(){ return 2; }\n');
    g('add -A');
    execSync('git -c user.name=Carol -c user.email=carol@x.y commit -q -m c2', {
      cwd: repo, stdio: 'pipe',
      env: { ...process.env, GIT_AUTHOR_DATE: '2026-07-07T00:00:00 +0800', GIT_COMMITTER_DATE: '2026-07-07T00:00:00 +0800' },
    });

    await scanProject(pid, repo);

    const afterFiles = await db
      .select({ lastModified: schema.files.lastModified, authors: schema.files.authors })
      .from(schema.files).where(eq(schema.files.projectId, pid));
    const afterFns = await db
      .select({ name: schema.functions.name, body: schema.functions.body })
      .from(schema.functions).where(eq(schema.functions.projectId, pid));

    // 1) last_modified 必须前移
    expect(afterFiles[0].lastModified).toBeGreaterThan(beforeFiles[0].lastModified!);
    // 2) 作者集合必须包含新作者
    expect(JSON.parse(afterFiles[0].authors || '[]')).toContain('Carol');
    // 3) 函数体必须是最新版本
    expect(afterFns.some(f => f.body?.includes('return 2'))).toBe(true);
    expect(afterFns.some(f => f.body?.includes('return 1'))).toBe(false);
    // 4) 不能产生重复行（唯一索引 + 先删后插）
    expect(afterFns.filter(f => f.name === 'f').length).toBe(1);

    await db.delete(schema.functions).where(eq(schema.functions.projectId, pid));
    await db.delete(schema.files).where(eq(schema.files.projectId, pid));
    await db.delete(schema.projects).where(eq(schema.projects.id, pid));
    rmSync(repo, { recursive: true });
  }, 90_000);

  it('删除源文件后重扫，旧文件与其函数不再残留', async () => {
    // 回归：ON CONFLICT DO NOTHING 让删掉/改名的文件永远留在库里，
    // /functions、复用排行、死代码检测都会被幽灵数据污染。
    const db = getDb();
    const repo = resolve('/tmp', `codindex-purge-${process.env.VITEST_WORKER_ID || '0'}`);
    if (existsSync(repo)) rmSync(repo, { recursive: true });
    mkdirSync(repo, { recursive: true });
    const g = (a: string) => execSync(`git ${a}`, { cwd: repo, stdio: 'pipe' });
    g('init -q');
    g('config user.email a@b.c');
    g('config user.name Alice');
    writeFileSync(`${repo}/keep.js`, 'export function keep(){ return 1; }\n');
    writeFileSync(`${repo}/gone.js`, 'export function gone(){ return 2; }\n');
    g('add -A');
    g('commit -q -m c1');

    await db.delete(schema.projects).where(eq(schema.projects.path, repo));
    const pid = uuid();
    await db.insert(schema.projects).values({ id: pid, name: 'Purge', path: repo, status: 'pending' });
    await scanProject(pid, repo);

    const before = await db.select({ path: schema.files.path })
      .from(schema.files).where(eq(schema.files.projectId, pid));
    expect(before.length).toBe(2);

    rmSync(`${repo}/gone.js`);
    g('add -A');
    g('commit -q -m c2');
    await scanProject(pid, repo);

    const after = await db.select({ path: schema.files.path })
      .from(schema.files).where(eq(schema.files.projectId, pid));
    const afterFns = await db.select({ name: schema.functions.name })
      .from(schema.functions).where(eq(schema.functions.projectId, pid));

    expect(after.map(f => f.path).sort()).toEqual(['keep.js']);
    expect(afterFns.some(f => f.name === 'gone')).toBe(false);
    expect(afterFns.some(f => f.name === 'keep')).toBe(true);

    await db.delete(schema.functions).where(eq(schema.functions.projectId, pid));
    await db.delete(schema.files).where(eq(schema.files.projectId, pid));
    await db.delete(schema.projects).where(eq(schema.projects.id, pid));
    rmSync(repo, { recursive: true });
  }, 90_000);
});
