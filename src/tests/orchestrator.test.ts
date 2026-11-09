import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import * as schema from '../db/schema';
import { getDb } from '../db/connection';
import { scanProject, scanProjectIncremental } from '../scan/orchestrator';
import { eq, sql } from 'drizzle-orm';
import { v4 as uuid } from 'uuid';
import { TEST_PROJECT_DIR, isGitAvailable } from './helpers';
import { existsSync, rmSync, writeFileSync } from 'fs';
import { execSync } from 'child_process';
import { resolve } from 'path';

const TEST_DB = resolve('data', 'test-orchestrator.db');

describe('orchestrator — scan pipeline', () => {
  beforeAll(async () => {
    // Clean up any leftover test data
    const db = getDb();
    await db.delete(schema.projects).where(eq(schema.projects.path, TEST_PROJECT_DIR));
    await db.delete(schema.projects).where(eq(schema.projects.path, resolve('/tmp', 'codindex-empty-test')));
    // Clean up any leftover status paths
    const leftovers = await db.select().from(schema.projects).where(sql`path LIKE '%-status-%'`);
    for (const p of leftovers) {
      await db.delete(schema.projects).where(eq(schema.projects.id, p.id));
    }
  });

  it('collects source files from test project', async () => {
    const db = getDb();
    const id = uuid();

    // Verify test project exists
    expect(existsSync(TEST_PROJECT_DIR)).toBe(true);
    const findOut = execSync(`find "${TEST_PROJECT_DIR}" -name '*.ts' 2>/dev/null`, { encoding: 'utf-8' });
    const tsFiles = findOut.trim().split('\n').filter(Boolean);
    expect(tsFiles.length).toBeGreaterThanOrEqual(5);

    await db.insert(schema.projects).values({
      id, name: 'TestScan', path: TEST_PROJECT_DIR, status: 'pending',
    });

    const result = await scanProject(id, TEST_PROJECT_DIR);
    expect(result.files).toBeGreaterThanOrEqual(5);
    expect(result.functions).toBeGreaterThanOrEqual(8);
    expect(result.types).toBeGreaterThanOrEqual(2);

    // Verify DB has correct records
    const files = await db.select().from(schema.files).where(eq(schema.files.projectId, id));
    expect(files.length).toBeGreaterThanOrEqual(5);

    const funcs = await db.select().from(schema.functions).where(eq(schema.functions.projectId, id));
    expect(funcs.length).toBe(result.functions);

    // Calls table may have 0 entries if cross-file resolution misses — the
    // important thing is the orchestrator ran successfully and wrote data
    const types = await db.select().from(schema.types).where(eq(schema.types.projectId, id));
    expect(types.length).toBeGreaterThanOrEqual(2);

    // Cleanup
    await db.delete(schema.typeUsageEdges).where(eq(schema.typeUsageEdges.projectId, id));
    await db.delete(schema.calls).where(eq(schema.calls.projectId, id));
    await db.delete(schema.functions).where(eq(schema.functions.projectId, id));
    await db.delete(schema.types).where(eq(schema.types.projectId, id));
    await db.delete(schema.files).where(eq(schema.files.projectId, id));
    await db.delete(schema.projects).where(eq(schema.projects.id, id));
  }, 60_000);

  it('handles empty directory gracefully', async () => {
    const db = getDb();
    const id = uuid();
    const emptyDir = resolve('/tmp', 'codindex-empty-test');
    if (!existsSync(emptyDir)) require('fs').mkdirSync(emptyDir, { recursive: true });

    await db.insert(schema.projects).values({
      id, name: 'Empty', path: emptyDir, status: 'pending',
    });

    const result = await scanProject(id, emptyDir);
    expect(result.files).toBe(0);
    expect(result.functions).toBe(0);

    await db.delete(schema.projects).where(eq(schema.projects.id, id));
    if (existsSync(emptyDir)) rmSync(emptyDir, { recursive: true });
  }, 30_000);

  it('updates project status to ready after scan', async () => {
    const db = getDb();
    const id = uuid();
    const projPath = TEST_PROJECT_DIR + '-status-' + id.slice(0, 8);

    await db.insert(schema.projects).values({
      id, name: 'StatusCheck', path: projPath, status: 'scanning',
    });

    await scanProject(id, projPath);

    const proj = await db.select().from(schema.projects).where(eq(schema.projects.id, id)).limit(1);
    expect(proj[0].status).toBe('ready');
    expect(proj[0].lastScanned).toBeGreaterThan(0);
    expect(proj[0].scanProgress).toBe(100);

    await db.delete(schema.typeUsageEdges).where(eq(schema.typeUsageEdges.projectId, id));
    await db.delete(schema.calls).where(eq(schema.calls.projectId, id));
    await db.delete(schema.functions).where(eq(schema.functions.projectId, id));
    await db.delete(schema.types).where(eq(schema.types.projectId, id));
    await db.delete(schema.files).where(eq(schema.files.projectId, id));
    await db.delete(schema.projects).where(eq(schema.projects.id, id));
  }, 30_000);
});

describe('orchestrator — incremental scan', () => {
  let db: ReturnType<typeof getDb>;
  // 空串代替 `string | null`：可空声明会让所有 eq()/scan 调用都带上
  // 「string | null 不能赋给 string」，而空串在真值判断里同样为假。
  let projectId = '';
  const incDir = resolve('/tmp', `codindex-inc-test-${process.env.VITEST_WORKER_ID || '0'}`);
  const gitAvailable = isGitAvailable();

  beforeAll(async () => {
    if (!gitAvailable) return;
    db = getDb();
    projectId = uuid();

    // Clean up any leftover project at incDir
    await db.delete(schema.projects).where(eq(schema.projects.path, incDir));

    // Create a mini git project
    if (existsSync(incDir)) rmSync(incDir, { recursive: true });
    require('fs').mkdirSync(incDir, { recursive: true });
    writeFileSync(`${incDir}/a.ts`, "export function alpha() { return 1; }\n");
    writeFileSync(`${incDir}/b.ts`, "export function beta() { return 2; }\n");

    execSync('git init', { cwd: incDir, stdio: 'pipe' });
    execSync('git config user.email test@test', { cwd: incDir, stdio: 'pipe' });
    execSync('git config user.name T', { cwd: incDir, stdio: 'pipe' });
    execSync('git add -A && git commit -m "init"', { cwd: incDir, stdio: 'pipe' });

    await db.insert(schema.projects).values({
      id: projectId, name: 'IncTest', path: incDir, status: 'pending',
    });
    await scanProject(projectId, incDir);
  });

  afterAll(async () => {
    if (!gitAvailable || !projectId) return;
    await db.delete(schema.typeUsageEdges).where(eq(schema.typeUsageEdges.projectId, projectId));
    await db.delete(schema.calls).where(eq(schema.calls.projectId, projectId));
    await db.delete(schema.functions).where(eq(schema.functions.projectId, projectId));
    await db.delete(schema.types).where(eq(schema.types.projectId, projectId));
    await db.delete(schema.files).where(eq(schema.files.projectId, projectId));
    await db.delete(schema.moduleDeps).where(eq(schema.moduleDeps.projectId, projectId));
    await db.delete(schema.modules).where(eq(schema.modules.projectId, projectId));
    await db.delete(schema.controlFlowNodes).where(eq(schema.controlFlowNodes.projectId, projectId));
    await db.delete(schema.controlFlowEdges).where(eq(schema.controlFlowEdges.projectId, projectId));
    await db.delete(schema.projects).where(eq(schema.projects.id, projectId));
    if (existsSync(incDir)) rmSync(incDir, { recursive: true });
  });

  it('returns changed=0 when nothing changed', async () => {
    if (!gitAvailable) return;
    // Use a lastScanned in the future to guarantee no git changes
    const futureTs = Math.floor(Date.now() / 1000) + 3600;
    const result = await scanProjectIncremental(projectId, incDir, futureTs);
    expect(result.changed).toBe(0);
    expect(result.total).toBe(0);
  });

  it('detects changed files after modification', async () => {
    if (!gitAvailable) return;
    // Modify a file
    writeFileSync(`${incDir}/a.ts`, "export function alpha() { return 42; }\n");
    execSync('git add -A && git commit -m "update a"', { cwd: incDir, stdio: 'pipe' });

    const proj = await db.select().from(schema.projects).where(eq(schema.projects.id, projectId)).limit(1);
    // Use a lastScanned before the new commit
    const oldTs = (proj[0].lastScanned ?? 0) - 60;
    const result = await scanProjectIncremental(projectId, incDir, oldTs);
    expect(result.changed).toBeGreaterThanOrEqual(1);
  }, 30_000);
});
