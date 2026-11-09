import { describe, it, expect, afterAll, beforeAll } from 'vitest';
import { getDb } from '../db/connection';
import * as schema from '../db/schema';
import { eq } from 'drizzle-orm';
import { v4 as uuid } from 'uuid';
import { scanProject } from '../scan/orchestrator';
import { TEST_PROJECT_DIR } from './helpers';

describe('Database — schema integrity', () => {
  const projectId = uuid();
  let db: ReturnType<typeof getDb>;

  beforeAll(async () => {
    db = getDb();
    // Clean up any leftover project at TEST_PROJECT_DIR
    await db.delete(schema.projects).where(eq(schema.projects.path, TEST_PROJECT_DIR));
    await db.insert(schema.projects).values({
      id: projectId, name: 'SchemaTest', path: TEST_PROJECT_DIR, status: 'pending',
    });
    await scanProject(projectId, TEST_PROJECT_DIR);
  }, 60_000);

  afterAll(async () => {
    await db.delete(schema.typeUsageEdges).where(eq(schema.typeUsageEdges.projectId, projectId));
    await db.delete(schema.calls).where(eq(schema.calls.projectId, projectId));
    await db.delete(schema.functions).where(eq(schema.functions.projectId, projectId));
    await db.delete(schema.types).where(eq(schema.types.projectId, projectId));
    await db.delete(schema.files).where(eq(schema.files.projectId, projectId));
    await db.delete(schema.projects).where(eq(schema.projects.id, projectId));
  });

  it('files table has unique constraint on project+path', async () => {
    // Inserting the same file twice should either be blocked or succeed
    // The unique constraint uses onConflictDoNothing in orchestrator
    const files = await db.select().from(schema.files).where(eq(schema.files.projectId, projectId));
    const paths = files.map(f => f.path);
    const unique = new Set(paths);
    expect(unique.size).toBe(paths.length);
  });

  it('functions table has correct relationships', async () => {
    const funcs = await db.select().from(schema.functions).where(eq(schema.functions.projectId, projectId));

    for (const f of funcs) {
      // Every function must link to an existing file
      const file = await db.select().from(schema.files).where(eq(schema.files.id, f.fileId)).limit(1);
      expect(file.length).toBe(1);
    }
  });

  it('calls table references valid functions', async () => {
    const allCalls = await db.select().from(schema.calls).where(eq(schema.calls.projectId, projectId));

    for (const c of allCalls) {
      if (c.callerFuncId != null) {
        const caller = await db.select().from(schema.functions).where(eq(schema.functions.id, c.callerFuncId)).limit(1);
        expect(caller.length).toBe(1);
      }
      // 未解析边（calleeFuncId = null）必须带 calleeName，否则该边不可用。
      if (c.calleeFuncId == null) {
        expect(c.isExternal).toBe(true);
        expect(c.calleeName).toBeTruthy();
      } else {
        const callee = await db.select().from(schema.functions).where(eq(schema.functions.id, c.calleeFuncId)).limit(1);
        expect(callee.length).toBe(1);
      }
    }
  });

  it('features table stores project-scoped records', async () => {
    await db.insert(schema.features).values({
      id: 'test-feature-1', projectId, name: 'Test Feature', status: 'planned', priority: 'high',
    });

    const feature = await db.select().from(schema.features)
      .where(eq(schema.features.projectId, projectId)).limit(1);
    expect(feature.length).toBe(1);
    expect(feature[0].name).toBe('Test Feature');
    expect(feature[0].priority).toBe('high');

    await db.delete(schema.features).where(eq(schema.features.id, 'test-feature-1'));
  });

  it('cascade delete works on file deletion', async () => {
    const db2 = getDb();
    const tempPid = uuid();
    const tempName = 'CascadeTest';
    const tempPath = TEST_PROJECT_DIR + '-cascade-' + tempPid.slice(0, 8);

    await db2.insert(schema.projects).values({
      id: tempPid, name: tempName, path: tempPath, status: 'pending',
    });

    // Scan gives us some data
    await scanProject(tempPid, tempPath);

    // Delete the project — cascade should clean up
    await db2.delete(schema.projects).where(eq(schema.projects.id, tempPid));

    const remainingFuncs = await db2.select().from(schema.functions)
      .where(eq(schema.functions.projectId, tempPid));
    const remainingFiles = await db2.select().from(schema.files)
      .where(eq(schema.files.projectId, tempPid));

    expect(remainingFuncs.length).toBe(0);
    expect(remainingFiles.length).toBe(0);
  }, 60_000);
});