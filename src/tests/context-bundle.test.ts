import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { createMcpServer } from '../mcp/server';
import { getDb } from '../db/connection';
import * as schema from '../db/schema';
import { eq } from 'drizzle-orm';
import { v4 as uuid } from 'uuid';
import { TEST_PROJECT_DIR, createTestProject, destroyTestProject, initTestGitRepo } from './helpers';
import { scanProject } from '../scan/orchestrator';

describe('get_context_bundle', () => {
  let client: Client;
  let server: ReturnType<typeof createMcpServer>;
  let projectId: string;

  beforeAll(async () => {
    createTestProject();
    initTestGitRepo();
    server = createMcpServer();
    client = new Client({ name: 'test-bundle', version: '1.0.0' });
    const [ct, st] = InMemoryTransport.createLinkedPair();
    await server.connect(st);
    await client.connect(ct);

    const db = getDb();
    // Clean up any leftover project at TEST_PROJECT_DIR
    await db.delete(schema.projects).where(eq(schema.projects.path, TEST_PROJECT_DIR));
    projectId = uuid();
    await db.insert(schema.projects).values({
      id: projectId, name: 'BundleTest', path: TEST_PROJECT_DIR, status: 'pending',
    });
    await scanProject(projectId, TEST_PROJECT_DIR);
  });

  afterAll(async () => {
    const db = getDb();
    await db.delete(schema.typeFields).where(eq(schema.typeFields.projectId, projectId));
    await db.delete(schema.typeUsageEdges).where(eq(schema.typeUsageEdges.projectId, projectId));
    await db.delete(schema.calls).where(eq(schema.calls.projectId, projectId));
    await db.delete(schema.functions).where(eq(schema.functions.projectId, projectId));
    await db.delete(schema.types).where(eq(schema.types.projectId, projectId));
    await db.delete(schema.files).where(eq(schema.files.projectId, projectId));
    await db.delete(schema.moduleDeps).where(eq(schema.moduleDeps.projectId, projectId));
    await db.delete(schema.modules).where(eq(schema.modules.projectId, projectId));
    await db.delete(schema.features).where(eq(schema.features.projectId, projectId));
    await db.delete(schema.featureCode).where(eq(schema.featureCode.featureId, projectId));
    await db.delete(schema.projects).where(eq(schema.projects.id, projectId));
    await client.close();
    await server.close();
    destroyTestProject();
  });

  function callBundle(args: Record<string, any>) {
    return client.callTool({ name: 'get_context_bundle', arguments: args });
  }
  function parse(result: any) {
    return JSON.parse((result.content as any[])[0].text);
  }

  // ── 基本功能 ──

  it('returns full bundle for known function', async () => {
    const result = parse(await callBundle({ project_id: projectId, func_name: 'clamp' }));
    expect(result.name).toBe('clamp');
    expect(result.signature).toContain('clamp');
    expect(result.body).toContain('if (value < min)');
    expect(result.file).toContain('helpers.ts');
    expect(result.complexity).toBeGreaterThanOrEqual(1);
  });

  it('returns impact info', async () => {
    const result = parse(await callBundle({ project_id: projectId, func_name: 'clamp' }));
    expect(result.impact).toBeDefined();
    expect(result.impact.directCallers).toBeDefined();
    expect(Array.isArray(result.impact.directCallers)).toBe(true);
    expect(result.impact.summary).toContain('clamp');
  });

  it('returns call graph', async () => {
    const result = parse(await callBundle({ project_id: projectId, func_name: 'getGreeting' }));
    expect(result.callGraph).toBeDefined();
    expect(Array.isArray(result.callGraph.calls)).toBe(true);
    expect(Array.isArray(result.callGraph.calledBy)).toBe(true);
  });

  it('returns related types', async () => {
    const result = parse(await callBundle({ project_id: projectId, func_name: 'findUserByEmail' }));
    expect(result.relatedTypes).toBeDefined();
    expect(Array.isArray(result.relatedTypes)).toBe(true);
    // findUserByEmail uses User type
    expect(result.relatedTypes.some((t: any) => t.name === 'User')).toBe(true);
  });

  it('returns params and return type', async () => {
    const result = parse(await callBundle({ project_id: projectId, func_name: 'formatDate' }));
    expect(result.paramsJson).toBeDefined();
    expect(Array.isArray(result.paramsJson)).toBe(true);
  });

  // ── include 开关 ──

  it('include.body=false omits body', async () => {
    const result = parse(await callBundle({
      project_id: projectId,
      func_name: 'clamp',
      include: { body: false },
    }));
    expect(result.body).toBeUndefined();
    expect(result.name).toBe('clamp');
  });

  it('include.impact=false omits impact', async () => {
    const result = parse(await callBundle({
      project_id: projectId,
      func_name: 'clamp',
      include: { impact: false },
    }));
    expect(result.impact).toBeUndefined();
    expect(result.body).toBeDefined(); // body still present by default
  });

  it('include.tests=true returns test list', async () => {
    const result = parse(await callBundle({
      project_id: projectId,
      func_name: 'clamp',
      include: { tests: true },
    }));
    expect(result.tests).toBeDefined();
    expect(Array.isArray(result.tests)).toBe(true);
  });

  it('all includes false returns minimal', async () => {
    const result = parse(await callBundle({
      project_id: projectId,
      func_name: 'clamp',
      include: { body: false, impact: false, callGraph: false, types: false, tests: false },
    }));
    expect(result.name).toBe('clamp');
    expect(result.body).toBeUndefined();
    expect(result.impact).toBeUndefined();
    expect(result.callGraph).toBeUndefined();
    expect(result.relatedTypes).toBeUndefined();
    expect(result.tests).toBeUndefined();
    // But basic info always present
    expect(result.signature).toBeDefined();
    expect(result.file).toBeDefined();
  });

  // ── 模糊匹配 ──

  it('returns candidates for ambiguous function name', async () => {
    // 契约变更：歧义不再抛错，改为一次返回全部候选（含可用 handle），
    // 让调用方无需二次往返即可决策。
    const res = await callBundle({ project_id: projectId, func_name: 'format' });
    const payload = JSON.parse((res.content as Array<{ text: string }>)[0].text);
    expect(payload.resolved).toBe(false);
    expect(payload.reason).toBe('ambiguous');
    expect(payload.candidates.length).toBeGreaterThan(1);
    for (const c of payload.candidates) {
      expect(c.handle).toContain(':');
    }
  });

  // ── 错误处理 ──

  it('returns not_found for nonexistent function', async () => {
    const res = await callBundle({ project_id: projectId, func_name: 'nonExistentFunc123' });
    const payload = JSON.parse((res.content as Array<{ text: string }>)[0].text);
    expect(payload.resolved).toBe(false);
    expect(payload.reason).toBe('not_found');
    expect(payload.candidates).toEqual([]);
  });

  it('throws for nonexistent project', async () => {
    await expect(callBundle({
      project_id: 'fake-project-id',
      func_name: 'clamp',
    })).rejects.toThrow();
  });
});
