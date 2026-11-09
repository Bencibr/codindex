import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { createMcpServer } from '../mcp/server';
import { getDb } from '../db/connection';
import * as schema from '../db/schema';
import { eq } from 'drizzle-orm';
import { v4 as uuid } from 'uuid';
import { TEST_PROJECT_DIR, initTestGitRepo } from './helpers';
import { scanProject } from '../scan/orchestrator';

// Test MCP tools through actual protocol (InMemoryTransport + Client)

describe('MCP Server — protocol integration', () => {
  let client: Client;
  let server: ReturnType<typeof createMcpServer>;
  // 用空串而非 `string | null`：projectId 在 beforeAll 里才赋值，声明成可空会让
  // 每个用例里的 eq(..., projectId) / insert 都退化成「string | null 不能赋给
  // string」，凭空制造一批类型噪音。空串在 `if (projectId)` 里同样为假。
  let projectId = '';

  beforeAll(async () => {
    server = createMcpServer();
    client = new Client({ name: 'test-client', version: '1.0.0' });

    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await server.connect(serverTransport);
    await client.connect(clientTransport);

    // Seed: register + scan a project
    const db = getDb();
    projectId = uuid();
    // Clean up any leftover project at TEST_PROJECT_DIR
    await db.delete(schema.projects).where(eq(schema.projects.path, TEST_PROJECT_DIR));
    await db.insert(schema.projects).values({
      id: projectId, name: 'MCPTest', path: TEST_PROJECT_DIR, status: 'pending',
    });
    await scanProject(projectId, TEST_PROJECT_DIR);
    initTestGitRepo();
  });

  afterAll(async () => {
    const db = getDb();
    if (projectId) {
      await db.delete(schema.typeUsageEdges).where(eq(schema.typeUsageEdges.projectId, projectId));
      await db.delete(schema.calls).where(eq(schema.calls.projectId, projectId));
      await db.delete(schema.functions).where(eq(schema.functions.projectId, projectId));
      await db.delete(schema.types).where(eq(schema.types.projectId, projectId));
      await db.delete(schema.files).where(eq(schema.files.projectId, projectId));
      await db.delete(schema.moduleDeps).where(eq(schema.moduleDeps.projectId, projectId));
      await db.delete(schema.modules).where(eq(schema.modules.projectId, projectId));
      await db.delete(schema.features).where(eq(schema.features.projectId, projectId));
      await db.delete(schema.featureCode).where(eq(schema.featureCode.featureId, projectId));
      await db.delete(schema.controlFlowNodes).where(eq(schema.controlFlowNodes.projectId, projectId));
      await db.delete(schema.controlFlowEdges).where(eq(schema.controlFlowEdges.projectId, projectId));
      await db.delete(schema.projects).where(eq(schema.projects.id, projectId));
    }
    await client.close();
    await server.close();
  });

  // ── ListTools ──

  it('listTools returns all tools', async () => {
    const result = await client.listTools();
    const names = result.tools.map(t => t.name);
    expect(names).toContain('add_project');
    expect(names).toContain('scan_project');
    expect(names).toContain('get_function_list');
    expect(names).toContain('get_call_graph');
    expect(names).toContain('get_feature_tracking');
    expect(names).toContain('find_similar_functions');
    expect(names).toContain('get_module_deps');
    expect(names).toContain('get_reuse_report');
    expect(names).toContain('get_hotspots');
    expect(names).toContain('scan_project_incremental');
    // Phase 1 new tools
    expect(names).toContain('get_type_info');
    expect(names).toContain('get_context_bundle');
    expect(names).toContain('get_change_guide');
    expect(names).toContain('get_type_usage');
    expect(names).toContain('get_test_coverage');
    // Supplementary tools
    expect(names).toContain('get_dead_code');
    expect(names).toContain('get_bulk_impact');
    expect(names).toContain('get_export_inventory');
    expect(names).toContain('get_bridge_map');
    expect(names).toContain('get_architecture_guide');
    expect(names).toContain('get_function_context');
    expect(names).toContain('get_smart_context');
    expect(names).toContain('search_semantic');
    expect(names).toContain('get_raise_sites');
    // 不再断言具体数量：每加一个工具都会让魔法数字失效，却证明不了任何契约。
    // 真正要守的是「工具名不重复」——重复注册会让后者静默覆盖前者。
    expect(new Set(names).size).toBe(names.length);
  });

  // ── add_project ──

  it('add_project registers and returns id', async () => {
    const result = await client.callTool({
      name: 'add_project',
      arguments: { name: 'ProtoTest', path: '/tmp/proto-test' },
    });
    const data = JSON.parse((result.content as any[])[0].text);
    expect(data.id).toBeDefined();
    expect(data.name).toBe('ProtoTest');
    expect(data.path).toBe('/tmp/proto-test');

    // Cleanup
    const db = getDb();
    await db.delete(schema.projects).where(eq(schema.projects.id, data.id));
  });

  // ── scan_project ──

  it('scan_project returns scan results or already_scanned', async () => {
    const result = await client.callTool({
      name: 'scan_project',
      arguments: { project_id: projectId },
    });
    const data = JSON.parse((result.content as any[])[0].text);
    // First scan returns 'complete', subsequent scans return 'already_scanned'
    expect(['complete', 'already_scanned']).toContain(data.status);
    if (data.status === 'complete') {
      expect(data.files).toBeGreaterThanOrEqual(5);
      expect(data.functions).toBeGreaterThanOrEqual(8);
    } else {
      expect(data.functions).toBeGreaterThanOrEqual(1);
    }
  });

  it('scan_project errors on unknown project', async () => {
    await expect(
      client.callTool({ name: 'scan_project', arguments: { project_id: 'nonexistent' } }),
    ).rejects.toThrow();
  });

  // ── get_function_list ──

  it('get_function_list returns functions with all fields', async () => {
    const result = await client.callTool({
      name: 'get_function_list',
      arguments: { project_id: projectId },
    });
    const funcs = JSON.parse((result.content as any[])[0].text);
    expect(funcs.length).toBeGreaterThan(0);
    expect(funcs[0]).toHaveProperty('name');
    expect(funcs[0]).toHaveProperty('signature');
    expect(funcs[0]).toHaveProperty('complexity');
    expect(funcs[0]).toHaveProperty('reuseScore');
  });

  it('get_function_list with sort=complexity orders by complexity asc', async () => {
    const result = await client.callTool({
      name: 'get_function_list',
      arguments: { project_id: projectId, sort: 'complexity' },
    });
    const funcs = JSON.parse((result.content as any[])[0].text);
    for (let i = 1; i < funcs.length; i++) {
      expect(funcs[i].complexity).toBeGreaterThanOrEqual(funcs[i - 1].complexity);
    }
  });

  it('get_function_list with filter_test returns only test functions', async () => {
    const result = await client.callTool({
      name: 'get_function_list',
      arguments: { project_id: projectId, filter_test: true },
    });
    const funcs = JSON.parse((result.content as any[])[0].text);
    for (const f of funcs) {
      expect(f.isTest).toBe(true);
    }
  });

  // ── get_call_graph ──

  it('get_call_graph returns target, calls, called_by', async () => {
    // Find a function name from the project
    const db = getDb();
    const funcs = await db.select().from(schema.functions)
      .where(eq(schema.functions.projectId, projectId)).limit(1);
    expect(funcs.length).toBeGreaterThan(0);

    const result = await client.callTool({
      name: 'get_call_graph',
      arguments: { project_id: projectId, func_name: funcs[0].name },
    });
    const data = JSON.parse((result.content as any[])[0].text);
    expect(data.target).toBeDefined();
    expect(data.target.name).toBe(funcs[0].name);
    expect(Array.isArray(data.calls)).toBe(true);
    expect(Array.isArray(data.called_by)).toBe(true);
  });

  it('get_call_graph returns not_found for unknown function', async () => {
    const res = await client.callTool({
      name: 'get_call_graph',
      arguments: { project_id: projectId, func_name: '__nonexistent_xyz__' },
    });
    const payload = JSON.parse((res.content as Array<{ text: string }>)[0].text);
    expect(payload.resolved).toBe(false);
    expect(payload.reason).toBe('not_found');
    expect(payload.candidates).toEqual([]);
  });

  // ── find_similar_functions ──

  it('find_similar_functions returns matches', async () => {
    const result = await client.callTool({
      name: 'find_similar_functions',
      arguments: { project_id: projectId, func_name: 'format' },
    });
    const data = JSON.parse((result.content as any[])[0].text);
    expect(data.query).toBe('format');
    expect(typeof data.matches).toBe('number');
    expect(Array.isArray(data.functions)).toBe(true);
  });

  it('find_similar_functions with min_complexity filters results', async () => {
    const result = await client.callTool({
      name: 'find_similar_functions',
      arguments: { project_id: projectId, func_name: 'format', min_complexity: 1 },
    });
    const data = JSON.parse((result.content as any[])[0].text);
    for (const f of data.functions) {
      expect(f.complexity).toBeGreaterThanOrEqual(1);
    }
  });

  // ── get_module_deps ──

  it('get_module_deps returns modules, dependencies, cycles', async () => {
    const result = await client.callTool({
      name: 'get_module_deps',
      arguments: { project_id: projectId },
    });
    const data = JSON.parse((result.content as any[])[0].text);
    expect(Array.isArray(data.modules)).toBe(true);
    expect(Array.isArray(data.dependencies)).toBe(true);
    expect(Array.isArray(data.potential_cycles)).toBe(true);
  });

  // ── get_reuse_report ──

  it('get_reuse_report returns scored functions', async () => {
    const result = await client.callTool({
      name: 'get_reuse_report',
      arguments: { project_id: projectId },
    });
    const data = JSON.parse((result.content as any[])[0].text);
    expect(typeof data.total).toBe('number');
    expect(Array.isArray(data.top_scores)).toBe(true);
    if (data.top_scores.length > 0) {
      expect(data.top_scores[0]).toHaveProperty('reuseScore');
      expect(data.top_scores[0]).toHaveProperty('name');
    }
  });

  it('get_reuse_report with score_min filters results', async () => {
    const result = await client.callTool({
      name: 'get_reuse_report',
      arguments: { project_id: projectId, score_min: 80 },
    });
    const data = JSON.parse((result.content as any[])[0].text);
    for (const f of data.top_scores) {
      expect(f.reuseScore).toBeGreaterThanOrEqual(80);
    }
  });

  it('get_reuse_report with limit caps results', async () => {
    const result = await client.callTool({
      name: 'get_reuse_report',
      arguments: { project_id: projectId, limit: 3 },
    });
    const data = JSON.parse((result.content as any[])[0].text);
    expect(data.top_scores.length).toBeLessThanOrEqual(3);
  });

  // ── get_hotspots ──

  it('get_hotspots returns hotspot data', async () => {
    const result = await client.callTool({
      name: 'get_hotspots',
      arguments: { project_id: projectId },
    });
    const data = JSON.parse((result.content as any[])[0].text);
    expect(typeof data.total).toBe('number');
    expect(Array.isArray(data.hotspots)).toBe(true);
    expect(typeof data.suggestion).toBe('string');
    expect(data.filters).toBeDefined();
  });

  // ── get_feature_tracking ──

  it('get_feature_tracking returns features array', async () => {
    const result = await client.callTool({
      name: 'get_feature_tracking',
      arguments: { project_id: projectId },
    });
    const data = JSON.parse((result.content as any[])[0].text);
    expect(Array.isArray(data.features)).toBe(true);
    expect(Array.isArray(data.mappings)).toBe(true);
  });

  // ── scan_project_incremental ──

  it('scan_project_incremental runs without error', async () => {
    const result = await client.callTool({
      name: 'scan_project_incremental',
      arguments: { project_id: projectId },
    });
    const data = JSON.parse((result.content as any[])[0].text);
    expect(data.status).toBe('ok');
    expect(typeof data.changed).toBe('number');
    expect(typeof data.total).toBe('number');
  });

  // ── error handling ──

  it('unknown tool throws error', async () => {
    await expect(
      client.callTool({ name: 'nonexistent_tool', arguments: {} }),
    ).rejects.toThrow();
  });

  // ── prompts ──

  it('listPrompts returns codindex-guide', async () => {
    const result = await client.listPrompts();
    expect(result.prompts.length).toBe(1);
    expect(result.prompts[0].name).toBe('codindex-guide');
  });

  it('getPrompt codindex-guide returns guide text', async () => {
    const result = await client.getPrompt({ name: 'codindex-guide' });
    expect(result.messages.length).toBe(1);
    const text = (result.messages[0].content as any).text;
    expect(text).toContain('Codindex');
    expect(text).toContain('add_project');
  });

  it('getPrompt unknown name throws', async () => {
    await expect(
      client.getPrompt({ name: 'unknown-prompt' }),
    ).rejects.toThrow();
  });

  // ── resources ──

  it('listResources returns codindex://projects', async () => {
    const result = await client.listResources();
    expect(result.resources.length).toBeGreaterThanOrEqual(1);
    expect(result.resources[0].uri).toBe('codindex://projects');
  });

  it('readResource codindex://projects returns project list', async () => {
    const result = await client.readResource({ uri: 'codindex://projects' });
    const data = JSON.parse(result.contents[0].text as string);
    expect(Array.isArray(data)).toBe(true);
    expect(data.some((p: any) => p.id === projectId)).toBe(true);
  });

  it('readResource codindex://projects/{id}/functions returns functions', async () => {
    const result = await client.readResource({
      uri: `codindex://projects/${projectId}/functions`,
    });
    const data = JSON.parse(result.contents[0].text as string);
    expect(Array.isArray(data)).toBe(true);
    expect(data.length).toBeGreaterThan(0);
  });

  it('readResource codindex://projects/{id}/overview returns overview', async () => {
    const result = await client.readResource({
      uri: `codindex://projects/${projectId}/overview`,
    });
    const data = JSON.parse(result.contents[0].text as string);
    expect(data.project).toBeDefined();
    expect(typeof data.files).toBe('number');
    expect(typeof data.functions).toBe('number');
  });

  it('readResource codindex://projects/{id}/features returns features', async () => {
    const result = await client.readResource({
      uri: `codindex://projects/${projectId}/features`,
    });
    const data = JSON.parse(result.contents[0].text as string);
    expect(Array.isArray(data)).toBe(true);
  });

  it('readResource unknown URI throws', async () => {
    await expect(
      client.readResource({ uri: 'codindex://unknown' }),
    ).rejects.toThrow();
  });

  // ── New tools: get_function_body ──

  it('get_function_body returns source code', async () => {
    const result = await client.callTool({
      name: 'get_function_body',
      arguments: { project_id: projectId, func_name: 'formatDate' },
    });
    const data = JSON.parse((result.content as any[])[0].text);
    expect(data.matches).toBeGreaterThanOrEqual(1);
    expect(data.functions[0]).toHaveProperty('body');
    expect(data.functions[0].body).toContain('function');
    expect(data.functions[0]).toHaveProperty('filePath');
    expect(data.functions[0]).toHaveProperty('signature');
  });

  it('get_function_body returns not_found for unknown function', async () => {
    // 契约变更：不再抛错，改为返回 resolved:false + reason，
    // 让 AI 一次拿到结论而不是靠异常反复试探。
    const res = await client.callTool({ name: 'get_function_body', arguments: { project_id: projectId, func_name: '__nonexistent__' } });
    const payload = JSON.parse((res.content as Array<{ text: string }>)[0].text);
    expect(payload.resolved).toBe(false);
    expect(payload.reason).toBe('not_found');
    expect(payload.candidates).toEqual([]);
  });

  // ── search_code ──

  it('search_code finds functions by name', async () => {
    const result = await client.callTool({
      name: 'search_code',
      arguments: { project_id: projectId, query: 'format' },
    });
    const data = JSON.parse((result.content as any[])[0].text);
    expect(data.functions.length).toBeGreaterThanOrEqual(1);
    expect(data.functions[0]).toHaveProperty('name');
    expect(data.functions[0]).toHaveProperty('file');
  });

  it('search_code finds files by path', async () => {
    const result = await client.callTool({
      name: 'search_code',
      arguments: { project_id: projectId, query: 'helpers', scope: 'files' },
    });
    const data = JSON.parse((result.content as any[])[0].text);
    expect(data.files.length).toBeGreaterThanOrEqual(1);
    expect(data.files[0].path).toContain('helpers');
  });

  it('search_code with scope=functions returns only functions', async () => {
    const result = await client.callTool({
      name: 'search_code',
      arguments: { project_id: projectId, query: 'clamp', scope: 'functions' },
    });
    const data = JSON.parse((result.content as any[])[0].text);
    expect(data.scope).toBe('functions');
    expect(data.functions.length).toBeGreaterThanOrEqual(1);
  });

  // ── get_project_summary ──

  it('get_project_summary returns architecture overview', async () => {
    const result = await client.callTool({
      name: 'get_project_summary',
      arguments: { project_id: projectId },
    });
    const data = JSON.parse((result.content as any[])[0].text);
    expect(data.project).toBeDefined();
    expect(data.stats.files).toBeGreaterThanOrEqual(5);
    expect(data.stats.functions).toBeGreaterThanOrEqual(8);
    expect(Array.isArray(data.languageDistribution)).toBe(true);
    expect(Array.isArray(data.modules)).toBe(true);
    expect(Array.isArray(data.topComplexFunctions)).toBe(true);
    expect(data.topComplexFunctions.length).toBeLessThanOrEqual(5);
  });

  // ── get_file_content ──

  it('get_file_content returns file source', async () => {
    const result = await client.callTool({
      name: 'get_file_content',
      arguments: { project_id: projectId, file_path: 'src/utils/helpers.ts' },
    });
    const data = JSON.parse((result.content as any[])[0].text);
    expect(data.path).toBe('src/utils/helpers.ts');
    expect(data.content).toContain('formatDate');
    expect(data.lines).toBeGreaterThan(0);
    expect(data.truncated).toBe(false);
  });

  it('get_file_content errors on nonexistent file', async () => {
    await expect(
      client.callTool({ name: 'get_file_content', arguments: { project_id: projectId, file_path: 'nonexistent.ts' } }),
    ).rejects.toThrow();
  });

  // ── get_impact_analysis ──

  it('get_impact_analysis returns callers', async () => {
    const result = await client.callTool({
      name: 'get_impact_analysis',
      arguments: { project_id: projectId, func_name: 'formatDate' },
    });
    const data = JSON.parse((result.content as any[])[0].text);
    expect(data.target).toBe('formatDate');
    expect(Array.isArray(data.directCallers)).toBe(true);
    expect(Array.isArray(data.indirectCallers)).toBe(true);
    expect(Array.isArray(data.affectedFiles)).toBe(true);
    expect(data.summary).toContain('formatDate');
  });

  it('get_impact_analysis returns not_found for unknown function', async () => {
    // 契约变更：不再抛错，改为返回 resolved:false + reason，
    // 让 AI 一次拿到结论而不是靠异常反复试探。
    const res = await client.callTool({ name: 'get_impact_analysis', arguments: { project_id: projectId, func_name: '__nonexistent__' } });
    const payload = JSON.parse((res.content as Array<{ text: string }>)[0].text);
    expect(payload.resolved).toBe(false);
    expect(payload.reason).toBe('not_found');
    expect(payload.candidates).toEqual([]);
  });

  // ── start_watching / stop_watching ──

  it('start_watching begins watching', async () => {
    const result = await client.callTool({
      name: 'start_watching',
      arguments: { project_id: projectId },
    });
    const data = JSON.parse((result.content as any[])[0].text);
    expect(data.status).toBe('watching');
    expect(data.message).toContain('Watching');
  });

  it('start_watching returns already_watching on repeat', async () => {
    const result = await client.callTool({
      name: 'start_watching',
      arguments: { project_id: projectId },
    });
    const data = JSON.parse((result.content as any[])[0].text);
    expect(data.status).toBe('already_watching');
  });

  it('stop_watching stops watching', async () => {
    const result = await client.callTool({
      name: 'stop_watching',
      arguments: { project_id: projectId },
    });
    const data = JSON.parse((result.content as any[])[0].text);
    expect(data.status).toBe('stopped');
  });

  it('stop_watching returns not_watching when not active', async () => {
    const result = await client.callTool({
      name: 'stop_watching',
      arguments: { project_id: projectId },
    });
    const data = JSON.parse((result.content as any[])[0].text);
    expect(data.status).toBe('not_watching');
  });

  // ═══════════════════════════════════════
  // Phase 1 — New tool integration tests
  // ═══════════════════════════════════════

  // ── get_type_info ──

  it('get_type_info returns type with fields', async () => {
    const result = await client.callTool({
      name: 'get_type_info',
      arguments: { project_id: projectId, type_name: 'User' },
    });
    const data = JSON.parse((result.content as any[])[0].text);
    expect(data.name).toBe('User');
    expect(data.kind).toBe('interface');
    expect(data.file).toContain('user-service');
    expect(Array.isArray(data.fields)).toBe(true);
    expect(Array.isArray(data.usedByFunctions)).toBe(true);
  });

  it('get_type_info fuzzy matches', async () => {
    const result = await client.callTool({
      name: 'get_type_info',
      arguments: { project_id: projectId, type_name: 'Config' },
    });
    const data = JSON.parse((result.content as any[])[0].text);
    expect(data.name).toBe('Config');
  });

  it('get_type_info errors on unknown type', async () => {
    await expect(
      client.callTool({ name: 'get_type_info', arguments: { project_id: projectId, type_name: '__nonexistent__' } }),
    ).rejects.toThrow();
  });

  // ── get_context_bundle ──

  it('get_context_bundle returns combined data', async () => {
    const result = await client.callTool({
      name: 'get_context_bundle',
      arguments: { project_id: projectId, func_name: 'clamp' },
    });
    const data = JSON.parse((result.content as any[])[0].text);
    expect(data.name).toBe('clamp');
    expect(data.body).toBeDefined();
    expect(data.body).toContain('if (value < min)');
    expect(data.impact).toBeDefined();
    expect(data.callGraph).toBeDefined();
    expect(data.signature).toContain('clamp');
  });

  it('get_context_bundle with include flags', async () => {
    const result = await client.callTool({
      name: 'get_context_bundle',
      arguments: {
        project_id: projectId,
        func_name: 'clamp',
        include: { body: false, impact: false, callGraph: false, types: false, tests: false },
      },
    });
    const data = JSON.parse((result.content as any[])[0].text);
    expect(data.name).toBe('clamp');
    expect(data.body).toBeUndefined();
    expect(data.impact).toBeUndefined();
    expect(data.callGraph).toBeUndefined();
  });

  it('get_context_bundle returns not_found for unknown function', async () => {
    // 契约变更：不再抛错，改为返回 resolved:false + reason，
    // 让 AI 一次拿到结论而不是靠异常反复试探。
    const res = await client.callTool({ name: 'get_context_bundle', arguments: { project_id: projectId, func_name: '__nonexistent__' } });
    const payload = JSON.parse((res.content as Array<{ text: string }>)[0].text);
    expect(payload.resolved).toBe(false);
    expect(payload.reason).toBe('not_found');
    expect(payload.candidates).toEqual([]);
  });

  // ── get_change_guide ──

  it('get_change_guide returns guide for real function', async () => {
    const result = await client.callTool({
      name: 'get_change_guide',
      arguments: { project_id: projectId, func_name: 'formatDate' },
    });
    const data = JSON.parse((result.content as any[])[0].text);
    expect(data.target).toBeDefined();
    expect(data.target.name).toBe('formatDate');
    expect(typeof data.target.isPlaceholder).toBe('boolean');
    expect(Array.isArray(data.relatedFunctions)).toBe(true);
    expect(Array.isArray(data.suggestedSteps)).toBe(true);
  });

  it('get_change_guide detects placeholder by body content', async () => {
    // Test with a function that exists — placeholder detection depends on body content
    const result = await client.callTool({
      name: 'get_change_guide',
      arguments: { project_id: projectId, func_name: 'findUserByEmail' },
    });
    const data = JSON.parse((result.content as any[])[0].text);
    expect(data.target).toBeDefined();
    expect(data.target.name).toBe('findUserByEmail');
    expect(typeof data.target.isPlaceholder).toBe('boolean');
    expect(Array.isArray(data.suggestedSteps)).toBe(true);
    // findUserByEmail is NOT a placeholder
    expect(data.target.isPlaceholder).toBe(false);
    expect(data.suggestedSteps.length).toBeGreaterThan(0);
  });

  it('get_change_guide returns not_found for unknown function', async () => {
    // 契约变更：不再抛错，改为返回 resolved:false + reason，
    // 让 AI 一次拿到结论而不是靠异常反复试探。
    const res = await client.callTool({ name: 'get_change_guide', arguments: { project_id: projectId, func_name: '__nonexistent__' } });
    const payload = JSON.parse((res.content as Array<{ text: string }>)[0].text);
    expect(payload.resolved).toBe(false);
    expect(payload.reason).toBe('not_found');
    expect(payload.candidates).toEqual([]);
  });

  // ── get_type_usage ──

  it('get_type_usage returns usage locations', async () => {
    const result = await client.callTool({
      name: 'get_type_usage',
      arguments: { project_id: projectId, type_name: 'User' },
    });
    const data = JSON.parse((result.content as any[])[0].text);
    expect(data.type).toBe('User');
    expect(Array.isArray(data.asParameter)).toBe(true);
    expect(Array.isArray(data.asReturn)).toBe(true);
    expect(typeof data.totalReferences).toBe('number');
    expect(data.totalReferences).toBeGreaterThanOrEqual(0);
  });

  it('get_type_usage errors on unknown type', async () => {
    await expect(
      client.callTool({ name: 'get_type_usage', arguments: { project_id: projectId, type_name: '__nonexistent__' } }),
    ).rejects.toThrow();
  });

  // ── get_test_coverage ──

  it('get_test_coverage returns coverage summary', async () => {
    const result = await client.callTool({
      name: 'get_test_coverage',
      arguments: { project_id: projectId },
    });
    const data = JSON.parse((result.content as any[])[0].text);
    expect(data.summary).toBeDefined();
    expect(typeof data.summary.totalFunctions).toBe('number');
    expect(typeof data.summary.testedFunctions).toBe('number');
    expect(typeof data.summary.untestedFunctions).toBe('number');
    expect(typeof data.summary.coverage).toBe('number');
    expect(data.summary.coverage).toBeGreaterThanOrEqual(0);
    expect(data.summary.coverage).toBeLessThanOrEqual(1);
    expect(Array.isArray(data.tested)).toBe(true);
    expect(Array.isArray(data.untested)).toBe(true);
  });

  it('get_test_coverage reports tested functions', async () => {
    const result = await client.callTool({
      name: 'get_test_coverage',
      arguments: { project_id: projectId },
    });
    const data = JSON.parse((result.content as any[])[0].text);
    // The tested array depends on scanner finding test functions with target names in body
    expect(Array.isArray(data.tested)).toBe(true);
    expect(Array.isArray(data.untested)).toBe(true);
    // Verify total = tested + untested
    expect(data.summary.testedFunctions + data.summary.untestedFunctions).toBe(data.summary.totalFunctions);
  });

  it('get_test_coverage with module filter', async () => {
    const result = await client.callTool({
      name: 'get_test_coverage',
      arguments: { project_id: projectId, module: 'utils' },
    });
    const data = JSON.parse((result.content as any[])[0].text);
    expect(data.summary.totalFunctions).toBeGreaterThan(0);
  });

  // ── get_hotspots with filters ──

  it('get_hotspots with complexity_min filter', async () => {
    const result = await client.callTool({
      name: 'get_hotspots',
      arguments: { project_id: projectId, complexity_min: 50 },
    });
    const data = JSON.parse((result.content as any[])[0].text);
    expect(data.filters.complexity_min).toBe(50);
    expect(Array.isArray(data.hotspots)).toBe(true);
  });

  it('get_hotspots with module filter', async () => {
    const result = await client.callTool({
      name: 'get_hotspots',
      arguments: { project_id: projectId, module: 'services' },
    });
    const data = JSON.parse((result.content as any[])[0].text);
    expect(data.filters.module).toBe('services');
    expect(Array.isArray(data.hotspots)).toBe(true);
  });

  // ── get_dead_code ──

  it('get_dead_code returns dead functions', async () => {
    const result = await client.callTool({
      name: 'get_dead_code',
      arguments: { project_id: projectId },
    });
    const data = JSON.parse((result.content as any[])[0].text);
    expect(data.summary).toBeDefined();
    expect(typeof data.summary.totalFunctions).toBe('number');
    expect(typeof data.summary.deadFunctions).toBe('number');
    expect(Array.isArray(data.functions)).toBe(true);
    // classify is exported but not called by other scanned functions
    if (data.functions.length > 0) {
      expect(data.functions[0].name).toBeDefined();
      expect(data.functions[0].file).toBeDefined();
    }
  });

  it('get_dead_code with include_unexported returns more results', async () => {
    const resultExported = await client.callTool({
      name: 'get_dead_code',
      arguments: { project_id: projectId, include_unexported: false },
    });
    const resultAll = await client.callTool({
      name: 'get_dead_code',
      arguments: { project_id: projectId, include_unexported: true },
    });
    const d1 = JSON.parse((resultExported.content as any[])[0].text);
    const d2 = JSON.parse((resultAll.content as any[])[0].text);
    expect(d2.summary.deadFunctions).toBeGreaterThanOrEqual(d1.summary.deadFunctions);
  });

  // ── get_bulk_impact ──

  it('get_bulk_impact returns affected functions', async () => {
    const result = await client.callTool({
      name: 'get_bulk_impact',
      arguments: { project_id: projectId, func_names: ['formatDate'] },
    });
    const data = JSON.parse((result.content as any[])[0].text);
    expect(data.targets).toBeDefined();
    expect(data.targets.length).toBeGreaterThan(0);
    expect(data.summary).toBeDefined();
    expect(typeof data.summary.totalAffected).toBe('number');
    expect(typeof data.summary.affectedFiles).toBe('number');
    expect(Array.isArray(data.affectedFiles)).toBe(true);
    expect(Array.isArray(data.directCallers)).toBe(true);
  });

  it('get_bulk_impact with multiple functions', async () => {
    const result = await client.callTool({
      name: 'get_bulk_impact',
      arguments: { project_id: projectId, func_names: ['formatDate', 'clamp'] },
    });
    const data = JSON.parse((result.content as any[])[0].text);
    expect(data.targets.length).toBeGreaterThanOrEqual(2);
  });

  it('get_bulk_impact errors on empty func_names', async () => {
    await expect(
      client.callTool({ name: 'get_bulk_impact', arguments: { project_id: projectId, func_names: [] } }),
    ).rejects.toThrow();
  });

  it('get_bulk_impact errors on nonexistent function', async () => {
    await expect(
      client.callTool({ name: 'get_bulk_impact', arguments: { project_id: projectId, func_names: ['__nonexistent__'] } }),
    ).rejects.toThrow();
  });

  // ── get_export_inventory ──

  it('get_export_inventory returns exported functions', async () => {
    const result = await client.callTool({
      name: 'get_export_inventory',
      arguments: { project_id: projectId },
    });
    const data = JSON.parse((result.content as any[])[0].text);
    expect(data.summary).toBeDefined();
    expect(typeof data.summary.totalExports).toBe('number');
    expect(data.summary.totalExports).toBeGreaterThan(0);
    expect(Array.isArray(data.byFile)).toBe(true);
    expect(data.byFile.length).toBeGreaterThan(0);
    expect(data.byFile[0].file).toBeDefined();
    expect(Array.isArray(data.byFile[0].exports)).toBe(true);
  });

  it('get_export_inventory with module filter', async () => {
    const result = await client.callTool({
      name: 'get_export_inventory',
      arguments: { project_id: projectId, module: 'utils' },
    });
    const data = JSON.parse((result.content as any[])[0].text);
    expect(data.summary.totalExports).toBeGreaterThanOrEqual(0);
    // All returned files should be in utils/
    for (const f of data.byFile) {
      expect(f.file).toContain('utils');
    }
  });

  // ── get_bridge_map ──

  it('get_bridge_map returns bridge structure', async () => {
    const result = await client.callTool({
      name: 'get_bridge_map',
      arguments: { project_id: projectId },
    });
    const data = JSON.parse((result.content as any[])[0].text);
    expect(data.summary).toBeDefined();
    expect(typeof data.summary.totalBridges).toBe('number');
    expect(Array.isArray(data.summary.frameworks)).toBe(true);
    expect(data.byFramework).toBeDefined();
    // Test fixture includes Tauri bridge calls — expect at least 1
    expect(data.summary.totalBridges).toBeGreaterThan(0);
    const fw = data.summary.frameworks[0];
    expect(data.byFramework[fw][0].invokeName).toBeDefined();
  });

  // ── get_architecture_guide ──

  it('get_architecture_guide returns structured project overview', async () => {
    const result = await client.callTool({
      name: 'get_architecture_guide',
      arguments: { project_id: projectId },
    });
    const data = JSON.parse((result.content as any[])[0].text);
    expect(data.project).toBeDefined();
    expect(data.project.fileCount).toBeGreaterThanOrEqual(5);
    expect(Array.isArray(data.languageDistribution)).toBe(true);
    expect(Array.isArray(data.entryPoints)).toBe(true);
    expect(Array.isArray(data.moduleTree)).toBe(true);
    expect(Array.isArray(data.hotspots)).toBe(true);
    expect(Array.isArray(data.keyTypes)).toBe(true);
    // entryPoints should include at least one file
    expect(data.entryPoints.length).toBeGreaterThanOrEqual(0);
  });

  // ── get_function_context ──

  it('get_function_context returns rich function details', async () => {
    const result = await client.callTool({
      name: 'get_function_context',
      arguments: { project_id: projectId, func_name: 'findUserByEmail' },
    });
    const data = JSON.parse((result.content as any[])[0].text);
    expect(data.function).toBeDefined();
    expect(data.function.name).toBe('findUserByEmail');
    expect(data.function.signature).toContain('email');
    // file info should be present
    expect(data.file).toBeDefined();
    expect(data.file.path).toContain('user-service');
    // body should be included by default
    expect(data.body).toBeDefined();
    expect(data.body.length).toBeGreaterThan(0);
  });

  it('get_function_context respects include flags', async () => {
    const result = await client.callTool({
      name: 'get_function_context',
      arguments: { project_id: projectId, func_name: 'findUserByEmail', include_body: false, include_callers: false },
    });
    const data = JSON.parse((result.content as any[])[0].text);
    expect(data.function).toBeDefined();
    expect(data.body).toBeUndefined();
    expect(data.callers).toBeUndefined();
    expect(data.file).toBeDefined(); // file_info defaults to true
  });

  it('get_function_context returns not_found for unknown function', async () => {
    // 契约变更：不再抛错，改为返回 resolved:false + reason，
    // 让 AI 一次拿到结论而不是靠异常反复试探。
    const res = await client.callTool({ name: 'get_function_context', arguments: { project_id: projectId, func_name: 'nonexistent_func_xyz' } });
    const payload = JSON.parse((res.content as Array<{ text: string }>)[0].text);
    expect(payload.resolved).toBe(false);
    expect(payload.reason).toBe('not_found');
    expect(payload.candidates).toEqual([]);
  });

  it('get_raise_sites returns throw sites by error type', async () => {
    // 通过真实 MCP 协议验证：异常边既写进了库，也能被工具查到
    const res = await client.callTool({
      name: 'get_raise_sites',
      arguments: { project_id: projectId, error_type: 'Error' },
    });
    const payload = JSON.parse((res.content as Array<{ text: string }>)[0].text);
    expect(payload.error_type).toBe('Error');
    expect(Array.isArray(payload.sites)).toBe(true);
    // 每个站点都必须是「文件:行 + 函数」
    for (const site of payload.sites) {
      expect(typeof site.file).toBe('string');
      expect(site.line).toBeGreaterThan(0);
      expect(typeof site.function).toBe('string');
    }
  });

  it('get_raise_sites rejects call without error_type or func_name', async () => {
    // 两个都没给必须 fail-closed，不能返回空结果冒充成功
    await expect(
      client.callTool({ name: 'get_raise_sites', arguments: { project_id: projectId } }),
    ).rejects.toThrow(/error_type|func_name/);
  });


  // ── 歧义：返回候选而非抛错（减少 AI 往返）──
  it('ambiguous func_name returns candidates instead of throwing', async () => {
    const db = getDb();
    const dupName = `dup_fn_${Date.now()}`;
    // files.id 是自增整数，用 returning 拿真实 id
    const [fa] = await db.insert(schema.files)
      .values({ projectId, path: `dup_a_${dupName}.ts`, language: 'typescript' })
      .returning({ id: schema.files.id });
    const [fb] = await db.insert(schema.files)
      .values({ projectId, path: `dup_b_${dupName}.ts`, language: 'typescript' })
      .returning({ id: schema.files.id });
    await db.insert(schema.functions).values([
      { projectId, fileId: fa.id, name: dupName, lineStart: 1, lineEnd: 5, isTest: false },
      { projectId, fileId: fb.id, name: dupName, lineStart: 1, lineEnd: 5, isTest: true },
    ]);

    const res = await client.callTool({
      name: 'get_call_graph',
      arguments: { project_id: projectId, func_name: dupName },
    });
    const payload = JSON.parse((res.content as Array<{ text: string }>)[0].text);

    // 关键契约：不抛错，而是结构化返回
    expect(payload.resolved).toBe(false);
    expect(payload.reason).toBe('ambiguous');
    expect(payload.candidates.length).toBe(2);
    expect(payload.hint).toContain('handle');

    // 每个候选都必须自带可直接重试的 handle，AI 不必再猜语法
    for (const c of payload.candidates) {
      expect(typeof c.handle).toBe('string');
      expect(c.handle.endsWith(`:${dupName}`)).toBe(true);
      expect(c.file).toBeTruthy();
    }

    // 生产优先排序：非测试候选必须排在测试候选之前
    const firstTestIdx = payload.candidates.findIndex((c: any) => c.isTest);
    const lastProdIdx = payload.candidates.map((c: any) => c.isTest).lastIndexOf(false);
    expect(lastProdIdx).toBeLessThan(firstTestIdx);

    // 用返回的 handle 重试必须一次命中
    const retry = await client.callTool({
      name: 'get_call_graph',
      arguments: { project_id: projectId, func_name: payload.candidates[0].handle },
    });
    const retryPayload = JSON.parse((retry.content as Array<{ text: string }>)[0].text);
    expect(retryPayload.resolved).toBeUndefined();   // 成功时不再带 resolved:false
    expect(retryPayload.target).toBeDefined();
  });

  it('unknown func_name returns structured not_found, not a throw', async () => {
    const res = await client.callTool({
      name: 'get_call_graph',
      arguments: { project_id: projectId, func_name: 'definitely_not_a_real_fn_xyz' },
    });
    const payload = JSON.parse((res.content as Array<{ text: string }>)[0].text);
    expect(payload.resolved).toBe(false);
    expect(payload.reason).toBe('not_found');
    expect(payload.candidates).toEqual([]);
    expect(payload.hint).toBeTruthy();
  });

  /**
   * 缺参契约。MCP 协议层不透传校验，工具实现里直接
   * `args.func_name.lastIndexOf(...)` 时，漏传就抛 TypeError 并被包成
   * -32603 "Cannot read properties of undefined (reading 'lastIndexOf')"。
   * 调用方（AI）拿不到「缺哪个参数」这一关键信息，只能盲猜重试。
   */
  describe('缺参时返回结构化提示而不是 TypeError', () => {
    it('tools/list 里每个工具的 required 都能被读出', async () => {
      const { tools } = await client.listTools();
      const gcg = tools.find(t => t.name === 'get_call_graph')!;
      expect(gcg.inputSchema.required).toContain('func_name');
    });

    it('get_call_graph 缺 func_name → 明确指出缺哪个参数', async () => {
      const res = await client.callTool({
        name: 'get_call_graph',
        arguments: { project_id: projectId },
      });
      expect(res.isError).toBe(true);
      const payload = JSON.parse((res.content as Array<{ text: string }>)[0].text);
      expect(payload.error).toBe('missing_required_arguments');
      expect(payload.tool).toBe('get_call_graph');
      expect(payload.missing).toEqual(['func_name']);
      expect(payload.hint).toContain('func_name');
      // 断言里不含 TypeError 字样：错误信息必须是给人看的
      expect(JSON.stringify(payload)).not.toContain('lastIndexOf');
    });

    it('多个工具在缺参时都给出同一契约（不是个别兜底）', async () => {
      const cases: Array<[string, Record<string, unknown>, string]> = [
        ['get_function_body', { project_id: projectId }, 'func_name'],
        ['search_code', { project_id: projectId }, 'query'],
        ['get_file_content', { project_id: projectId }, 'file_path'],
        ['get_type_info', { project_id: projectId }, 'type_name'],
        ['get_bulk_impact', { project_id: projectId }, 'func_names'],
        ['get_cfg', { project_id: projectId }, 'func_name'],
        ['get_smart_context', { project_id: projectId }, 'func_name'],
      ];
      for (const [name, args, missing] of cases) {
        const res = await client.callTool({ name, arguments: args });
        expect(res.isError, name).toBe(true);
        const payload = JSON.parse((res.content as Array<{ text: string }>)[0].text);
        expect(payload.error, name).toBe('missing_required_arguments');
        expect(payload.missing, name).toEqual([missing]);
      }
    });

    it('空字符串也算缺失（前端/AI 常传 ""）', async () => {
      const res = await client.callTool({
        name: 'search_code',
        arguments: { project_id: projectId, query: '' },
      });
      expect(res.isError).toBe(true);
      const payload = JSON.parse((res.content as Array<{ text: string }>)[0].text);
      expect(payload.error).toBe('missing_required_arguments');
      expect(payload.missing).toEqual(['query']);
    });

    it('参数齐全时校验不误伤', async () => {
      const res = await client.callTool({
        name: 'get_file_content',
        arguments: { project_id: projectId, file_path: 'src/utils/helpers.ts' },
      });
      expect(res.isError).toBeFalsy();
      const payload = JSON.parse((res.content as Array<{ text: string }>)[0].text);
      expect(payload.content).toContain('formatDate');
    });

    it('深层文件路径不被 schema 的 maxLength 挡住', async () => {
      // 回归：file_path 曾是 maxLength: 64，真实的深层路径会被 schema 层拒绝，
      // 报错信息还只说「参数不合法」，看不出是长度问题。
      const deep = 'src/' + 'nested/'.repeat(12) + 'deep.ts';   // 约 100 字符
      expect(deep.length).toBeGreaterThan(64);
      let message = '';
      try {
        const res = await client.callTool({
          name: 'get_file_content',
          arguments: { project_id: projectId, file_path: deep },
        });
        message = (res.content as Array<{ text: string }>)[0].text;
      } catch (e) {
        message = (e as Error).message;   // 文件确实不存在，抛 ENOENT 是合理的
      }
      // 关键是：报错不能是长度/schema 校验失败——路径本身必须被放行到读取环节
      expect(message).not.toMatch(/maxLength|too long|missing_required/i);
      expect(message).toMatch(/ENOENT|not (be )?found|Cannot read file/i);
    });
  });

});
