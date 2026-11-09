import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { execSync } from 'child_process';
import { existsSync, mkdirSync, rmSync, writeFileSync } from 'fs';
import { resolve } from 'path';
import { scanWithScc, isSccAvailable, getGitStats, getGitStatsBatch, isGitRepo } from '../scan/scanner-scc';
import { TEST_PROJECT_DIR } from './helpers';

describe('scanner-scc — scc + git analysis', () => {
  it('detects whether scc is available', () => {
    // Should be false in CI or local without scc installed
    const available = isSccAvailable();
    expect(typeof available).toBe('boolean');
  });

  it('scc returns an array (possibly empty)', () => {
    const result = scanWithScc(TEST_PROJECT_DIR);
    expect(Array.isArray(result)).toBe(true);
  });

  it('each scc result has correct shape', () => {
    const result = scanWithScc(TEST_PROJECT_DIR);
    for (const f of result) {
      expect(typeof f.path).toBe('string');
      expect(typeof f.language).toBe('string');
      expect(f.lines).toBeGreaterThan(0);
    }
  });

  it('getGitStats returns valid shape', () => {
    const stats = getGitStats(`${TEST_PROJECT_DIR}/src/utils/helpers.ts`);
    expect(stats).toHaveProperty('lastModified');
    expect(stats).toHaveProperty('authors');
    expect(Array.isArray(stats.authors)).toBe(true);
  });

  it('isGitRepo returns false for non-git test dir', () => {
    expect(isGitRepo(TEST_PROJECT_DIR)).toBe(false);
  });

  it('handles non-existent file path for getGitStats', () => {
    const stats = getGitStats('/nonexistent/path.ts');
    expect(stats.authors).toEqual([]);
    expect(stats.lastModified).toBeNull();
  });
});

describe('scanner-scc — getGitStatsBatch 批量语义', () => {
  const gitRepo = resolve('/tmp', `codindex-gitbatch-${process.env.VITEST_WORKER_ID || '0'}`);

  const git = (args: string, cwd: string, env?: NodeJS.ProcessEnv) =>
    execSync(`git ${args}`, {
      cwd,
      stdio: 'pipe',
      env: { ...process.env, ...env },
    });

  beforeAll(() => {
    if (existsSync(gitRepo)) rmSync(gitRepo, { recursive: true });
    mkdirSync(gitRepo, { recursive: true });
    git('init -q', gitRepo);
    git('config user.email a@b.c', gitRepo);
    git('config user.name Alice', gitRepo);

    writeFileSync(`${gitRepo}/one.ts`, 'export const a = 1;\n');
    git('add -A', gitRepo);
    git('-c user.name=Alice -c user.email=alice@x.y commit -q -m c1', gitRepo, {
      GIT_AUTHOR_DATE: '2026-01-01T00:00:00 +0800',
      GIT_COMMITTER_DATE: '2026-01-01T00:00:00 +0800',
    });

    writeFileSync(`${gitRepo}/two.ts`, 'export const b = 2;\n');
    git('add -A', gitRepo);
    git('-c user.name=Bob -c user.email=bob@x.y commit -q -m c2', gitRepo, {
      GIT_AUTHOR_DATE: '2026-02-02T00:00:00 +0800',
      GIT_COMMITTER_DATE: '2026-02-02T00:00:00 +0800',
    });
  });

  afterAll(() => {
    if (existsSync(gitRepo)) rmSync(gitRepo, { recursive: true });
  });

  it('一次 git log 取到多个文件的 lastModified 与 authors', () => {
    const m = getGitStatsBatch(gitRepo);
    expect(m.size).toBeGreaterThanOrEqual(2);

    const one = m.get('one.ts');
    const two = m.get('two.ts');
    expect(one).toBeDefined();
    expect(two).toBeDefined();

    // one.ts 只被 Alice 在 1 月改过；two.ts 只被 Bob 在 2 月改过
    expect(one!.authors).toEqual(['Alice']);
    expect(two!.authors).toEqual(['Bob']);
    expect(new Date(one!.lastModified! * 1000).toISOString().slice(0, 7)).toBe('2025-12');
    expect(new Date(two!.lastModified! * 1000).toISOString().slice(0, 7)).toBe('2026-02');
  });

  it('批量结果与逐文件 getGitStats 完全一致（防止语义漂移）', () => {
    const batch = getGitStatsBatch(gitRepo);
    for (const rel of ['one.ts', 'two.ts']) {
      const per = getGitStats(`${gitRepo}/${rel}`);
      const b = batch.get(rel);
      expect(b).toBeDefined();
      // lastModified 是核心字段：必须逐秒相等
      expect(b!.lastModified).toBe(per.lastModified);
      expect([...b!.authors].sort()).toEqual([...per.authors].sort());
    }
  });

  it('非 git 目录返回空 Map，不抛错', () => {
    const m = getGitStatsBatch('/tmp');
    expect(m).toBeInstanceOf(Map);
    expect(m.size).toBe(0);
  });
});

/**
 * 这两个场景此前全部静默返回 NULL，且不影响任何现有断言：
 *   - 项目注册在仓库的子目录（monorepo 里单独索引 packages/app）；
 *   - 文件名非 ASCII（git 默认 core.quotepath=true 会输出八进制转义）。
 * 它们直接决定 files.last_modified 是否可用，而 `/api/projects/:id/diff?since=`
 * 完全建立在这一列上 —— 所以必须有回归用例，否则修复会再次悄悄退化。
 */
describe('scanner-scc — getGitStatsBatch 子目录 / 非 ASCII 路径', () => {
  const repo = resolve('/tmp', `codindex-gitsub-${process.env.VITEST_WORKER_ID || '0'}`);
  const appDir = `${repo}/packages/app`;
  const subDir = `${appDir}/sub`;

  const git = (args: string, cwd: string) =>
    execSync(`git ${args}`, { cwd, stdio: 'pipe' });

  beforeAll(() => {
    if (existsSync(repo)) rmSync(repo, { recursive: true });
    mkdirSync(subDir, { recursive: true });
    git('init -q', repo);
    git('config user.email a@b.c', repo);
    git('config user.name Alice', repo);

    writeFileSync(`${repo}/root.ts`, 'export const r = 1;\n');
    writeFileSync(`${appDir}/a.ts`, 'export const a = 1;\n');
    writeFileSync(`${subDir}/b.ts`, 'export const b = 1;\n');
    writeFileSync(`${appDir}/中文.ts`, 'export const cn = 1;\n');
    writeFileSync(`${appDir}/sp ace.ts`, 'export const sp = 1;\n');
    git('add -A', repo);
    git('commit -q -m c1', repo);
  });

  afterAll(() => {
    if (existsSync(repo)) rmSync(repo, { recursive: true });
  });

  it('仓库根扫描时 key 是仓库根相对路径', () => {
    const m = getGitStatsBatch(repo);
    expect([...m.keys()].sort()).toEqual([
      'packages/app/a.ts',
      'packages/app/sp ace.ts',
      'packages/app/sub/b.ts',
      'packages/app/中文.ts',
      'root.ts',
    ]);
  });

  it('子目录项目：key 必须换算成项目根相对路径', () => {
    const m = getGitStatsBatch(appDir);
    // 关键点：不能出现 `packages/app/` 前缀，否则调用方用 relPath 查不到
    expect([...m.keys()].sort()).toEqual([
      'a.ts',
      'sp ace.ts',
      'sub/b.ts',
      '中文.ts',
    ]);
    expect(m.get('a.ts')!.lastModified).not.toBeNull();
    expect(m.get('sub/b.ts')!.authors).toEqual(['Alice']);
  });

  it('更深的子目录项目同样正确', () => {
    const m = getGitStatsBatch(subDir);
    expect([...m.keys()]).toEqual(['b.ts']);
    expect(m.get('b.ts')!.lastModified).not.toBeNull();
  });

  it('非 ASCII 文件名不会被 git 的八进制转义吃掉', () => {
    const m = getGitStatsBatch(appDir);
    expect(m.get('中文.ts')).toBeDefined();
    expect(m.get('中文.ts')!.authors).toEqual(['Alice']);
    // 反向确认：转义形式不应作为 key 出现
    expect([...m.keys()].some(k => k.includes('\\344'))).toBe(false);
  });

  it('含空格的路径照常命中', () => {
    expect(getGitStatsBatch(appDir).get('sp ace.ts')!.lastModified).not.toBeNull();
  });

  it('isGitRepo 能识别仓库内的子目录（而不只看 .git 是否存在）', () => {
    expect(isGitRepo(appDir)).toBe(true);
    expect(isGitRepo(subDir)).toBe(true);
  });
});
