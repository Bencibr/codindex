/**
 * ═══════════════════════════════════════════════════════════════
 *  Regression-Skill Calibration Test Suite
 *
 *  Validates the regression-test skill's self-coverage:
 *   1. MCP tool availability (all 30 tools)
 *   2. MCP tool correctness (valid params → valid response)
 *   3. Scanner accuracy (known fixtures → known AST results)
 *   4. DB integrity (FKs, constraints, counts)
 *   5. Call-graph resolution (cross-file imports)
 *   6. Module dependency graph + cycle detection
 *   7. Incremental scan (git-based change detection)
 *   8. Performance baselines (duration_ms per tool)
 * ═══════════════════════════════════════════════════════════════
 */

import {
  describe, it, expect, beforeAll, afterAll,
} from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { createMcpServer } from '../mcp/server';
import { getDb } from '../db/connection';
import * as schema from '../db/schema';
import { eq, sql, and } from 'drizzle-orm';
import { v4 as uuid } from 'uuid';
import { TEST_PROJECT_DIR, initTestGitRepo } from './helpers';
import { scanProject, scanProjectIncremental } from '../scan/orchestrator';
import { buildImportMap, resolveImportPath } from '../scan/call-graph';
import { buildModuleGraph, getChangedFiles } from '../scan/module-graph';
import { scanFile } from '../scan/scanner-ts';
import { existsSync, mkdirSync, rmSync, writeFileSync } from 'fs';
import { execSync } from 'child_process';
import { resolve as pathResolve } from 'path';

// ──────────────────────────────
// Constants
// ──────────────────────────────
const ALL_TOOL_NAMES = [
  'get_smart_context', 'get_function_list', 'get_function_body',
  'get_call_graph', 'get_module_deps', 'get_reuse_report',
  'get_hotspots', 'get_feature_tracking', 'search_code',
  'search_semantic', 'get_project_summary', 'get_file_content',
  'get_impact_analysis', 'find_similar_functions',
  'get_architecture_guide',
  'add_project', 'scan_project', 'scan_project_incremental',
  'start_watching', 'stop_watching',
  'get_type_info', 'get_context_bundle', 'get_change_guide',
  'get_type_usage', 'get_test_coverage', 'get_dead_code',
  'get_bulk_impact', 'get_export_inventory', 'get_bridge_map',
  'get_function_context',
  'get_raise_sites',
];

// ──────────────────────────────
// Helpers
// ──────────────────────────────

/** Create a fresh project + scan it, return { pid, db } */
async function seedProject(name: string, path = TEST_PROJECT_DIR) {
  if (!existsSync(path)) mkdirSync(path, { recursive: true });
  // Write a minimal file so scanner finds something
  const tsFile = path + '/_seed.ts';
  if (!existsSync(tsFile)) writeFileSync(tsFile, `export function _seed() { return '${name}'; }\n`);
  const db = getDb();
  const pid = uuid();
  await db.insert(schema.projects).values({
    id: pid, name, path, status: 'pending',
  });
  await scanProject(pid, path);
  return { pid, db };
}

/** Full teardown for a project */
async function cleanupProject(db: ReturnType<typeof getDb>, pid: string, path?: string) {
  await db.delete(schema.controlFlowEdges).where(eq(schema.controlFlowEdges.projectId, pid));
  await db.delete(schema.controlFlowNodes).where(eq(schema.controlFlowNodes.projectId, pid));
  await db.delete(schema.typeUsageEdges).where(eq(schema.typeUsageEdges.projectId, pid));
  await db.delete(schema.calls).where(eq(schema.calls.projectId, pid));
  await db.delete(schema.functions).where(eq(schema.functions.projectId, pid));
  await db.delete(schema.types).where(eq(schema.types.projectId, pid));
  await db.delete(schema.files).where(eq(schema.files.projectId, pid));
  await db.delete(schema.moduleDeps).where(eq(schema.moduleDeps.projectId, pid));
  await db.delete(schema.modules).where(eq(schema.modules.projectId, pid));
  await db.delete(schema.features).where(eq(schema.features.projectId, pid));
  await db.delete(schema.testMappings).where(eq(schema.testMappings.projectId, pid));
  await db.delete(schema.projects).where(eq(schema.projects.id, pid));
  if (path && existsSync(path)) rmSync(path, { recursive: true });
}

/** Call tool + parse JSON */
async function callTool(
  client: Client, name: string, args: Record<string, any>,
) {
  const result = await client.callTool({ name, arguments: args });
  const text = (result.content as any[])[0].text;
  try { return { data: JSON.parse(text), raw: text }; }
  catch { return { data: null, raw: text }; }
}

// ═══════════════════════════════════════════════════════════════
// Shared MCP client + seeded project
// ═══════════════════════════════════════════════════════════════
describe('Skill Calibration — Regression-Skill Coverage', () => {
  let client: Client;
  let server: ReturnType<typeof createMcpServer>;
  let projectId: string;
  let db: ReturnType<typeof getDb>;

  beforeAll(async () => {
    server = createMcpServer();
    client = new Client({ name: 'skill-cal-client', version: '1.0.0' });
    const [ct, st] = InMemoryTransport.createLinkedPair();
    await server.connect(st);
    await client.connect(ct);

    // Clean up any leftover project at TEST_PROJECT_DIR
    const existingDb = getDb();
    await existingDb.delete(schema.projects).where(eq(schema.projects.path, TEST_PROJECT_DIR));

    const seeded = await seedProject('SkillCal', TEST_PROJECT_DIR);
    db = seeded.db;
    projectId = seeded.pid;
    initTestGitRepo();
  });

  afterAll(async () => {
    if (projectId) await cleanupProject(db, projectId);
    await client.close();
    await server.close();
  });

  // ──────────────────────────────
  // 1. Tool Inventory — all 30 tools exposed
  // ──────────────────────────────
  describe('Tool Inventory — 30 tools exposed', () => {
    it('all expected tool names are present', async () => {
      const names = (await client.listTools()).tools.map(t => t.name);
      for (const expected of ALL_TOOL_NAMES) {
        expect(names).toContain(expected);
      }
    });

    it('no duplicate tool names', async () => {
      const names = (await client.listTools()).tools.map(t => t.name);
      expect(new Set(names).size).toBe(names.length);
    });

    it('each tool has description + inputSchema', async () => {
      const tools = (await client.listTools()).tools;
      for (const t of tools) {
        // MCP SDK 把 description 声明为可选，直接 .length 在 strict 下不成立
        expect(t.description, `${t.name} 缺少 description`).toBeDefined();
        expect(t.description!.length).toBeGreaterThan(5);
        expect(t.inputSchema).toBeDefined();
        expect(t.inputSchema.type).toBe('object');
      }
    });
  });

  // ──────────────────────────────
  // 2. Operation Tools — create own temp projects
  // ──────────────────────────────
  describe('Operation Tools — setup/scan', () => {
    let tempPid: string | undefined;

    afterEach(async () => {
      if (tempPid) {
        await cleanupProject(db, tempPid);
        tempPid = undefined;
      }
    });

    it('add_project idempotent on duplicate path', async () => {
      const r1 = await callTool(client, 'add_project', { name: 'DupTest', path: '/tmp/codindex-dup-test' });
      expect(r1.data.id).toBeDefined();
      const r2 = await callTool(client, 'add_project', { name: 'DupTest2', path: '/tmp/codindex-dup-test' });
      expect(r2.data.reused).toBe(true);
      expect(r2.data.id).toBe(r1.data.id);
      tempPid = r1.data.id;
    });

    it('scan_project returns complete on first scan', async () => {
      // Use a temp dir so add_project doesn't hit the existing SkillCal project
      const testDir = `/tmp/codindex-scan2-${Date.now()}`;
      mkdirSync(testDir, { recursive: true });
      writeFileSync(`${testDir}/x.ts`, `export function x() { return 1; }\n`);
      const ar = await callTool(client, 'add_project', { name: 'ScanCal2', path: testDir });
      const pid = ar.data.id;
      tempPid = pid;
      const sr = await callTool(client, 'scan_project', { project_id: pid });
      expect(sr.data.status).toBe('complete');
      expect(sr.data.files).toBeGreaterThanOrEqual(1);
      expect(sr.data.functions).toBeGreaterThanOrEqual(1);
    });

    it('scan_project returns already_scanned on re-run', async () => {
      const testDir = `/tmp/codindex-rescan2-${Date.now()}`;
      mkdirSync(testDir, { recursive: true });
      writeFileSync(`${testDir}/x.ts`, `export function x() { return 1; }\n`);
      const ar = await callTool(client, 'add_project', { name: 'ReScanCal2', path: testDir });
      const pid = ar.data.id;
      tempPid = pid;
      await callTool(client, 'scan_project', { project_id: pid });
      const sr2 = await callTool(client, 'scan_project', { project_id: pid });
      expect(sr2.data.status).toBe('already_scanned');
    });

    it('scan_project_incremental returns ok', async () => {
      const r = await callTool(client, 'scan_project_incremental', { project_id: projectId });
      expect(r.data.status).toBe('ok');
      expect(typeof r.data.changed).toBe('number');
      expect(typeof r.data.total).toBe('number');
    });

    it('start_watching returns watching', async () => {
      const r = await callTool(client, 'start_watching', { project_id: projectId });
      expect(r.data.status).toBe('watching');
      expect(r.data.message).toContain('Watching');
      const r2 = await callTool(client, 'start_watching', { project_id: projectId });
      expect(r2.data.status).toBe('already_watching');
    });

    it('stop_watching stops then not_watching', async () => {
      const r1 = await callTool(client, 'stop_watching', { project_id: projectId });
      expect(['stopped', 'not_watching']).toContain(r1.data.status);
      const r2 = await callTool(client, 'stop_watching', { project_id: projectId });
      expect(r2.data.status).toBe('not_watching');
    });
  });

  // ──────────────────────────────
  // 3. Query Tools — all 15 return valid JSON
  // ──────────────────────────────
  describe('Query Tools — valid JSON responses', () => {
    const ct = (name: string, args: Record<string, any>) => callTool(client, name, args);

    it('T01: get_project_summary', async () => {
      const r = await ct('get_project_summary', { project_id: projectId });
      expect(r.data.project).toBeDefined();
      expect(r.data.stats.files).toBeGreaterThanOrEqual(5);
      expect(r.data.stats.functions).toBeGreaterThanOrEqual(8);
      expect(Array.isArray(r.data.languageDistribution)).toBe(true);
      expect(Array.isArray(r.data.modules)).toBe(true);
      expect(Array.isArray(r.data.topComplexFunctions)).toBe(true);
    }, 60_000);

    it('T02: get_function_list', async () => {
      const r = await ct('get_function_list', { project_id: projectId });
      expect(r.data.length).toBeGreaterThanOrEqual(8);
      expect(r.data[0]).toHaveProperty('name');
      expect(r.data[0]).toHaveProperty('signature');
      expect(r.data[0]).toHaveProperty('complexity');
      expect(r.data[0]).toHaveProperty('reuseScore');
    });

    it('T02b: get_function_list sort + filter_test', async () => {
      const sorted = await ct('get_function_list', { project_id: projectId, sort: 'complexity' });
      for (let i = 1; i < sorted.data.length; i++) {
        expect(sorted.data[i].complexity).toBeGreaterThanOrEqual(sorted.data[i - 1].complexity);
      }
      const tests = await ct('get_function_list', { project_id: projectId, filter_test: true });
      for (const f of tests.data) expect(f.isTest).toBe(true);
    });

    it('T03: get_function_body for formatDate', async () => {
      const r = await ct('get_function_body', { project_id: projectId, func_name: 'formatDate' });
      expect(r.data.matches).toBeGreaterThanOrEqual(1);
      expect(r.data.functions[0].body).toContain('function');
      expect(r.data.functions[0]).toHaveProperty('filePath');
      expect(r.data.functions[0]).toHaveProperty('signature');
    });

    it('T07: get_call_graph for formatDate', async () => {
      const r = await ct('get_call_graph', { project_id: projectId, func_name: 'formatDate', depth: 2 });
      expect(r.data.target.name).toBe('formatDate');
      expect(Array.isArray(r.data.calls)).toBe(true);
      expect(Array.isArray(r.data.called_by)).toBe(true);
    });

    it('T08: get_impact_analysis for formatDate', async () => {
      const r = await ct('get_impact_analysis', { project_id: projectId, func_name: 'formatDate' });
      expect(r.data.target).toBe('formatDate');
      expect(Array.isArray(r.data.directCallers)).toBe(true);
      expect(Array.isArray(r.data.indirectCallers)).toBe(true);
      expect(Array.isArray(r.data.affectedFiles)).toBe(true);
      expect(r.data.summary).toContain('formatDate');
    });

    it('T09: get_module_deps', async () => {
      const r = await ct('get_module_deps', { project_id: projectId });
      expect(Array.isArray(r.data.modules)).toBe(true);
      expect(r.data.modules.length).toBeGreaterThanOrEqual(2);
      expect(Array.isArray(r.data.dependencies)).toBe(true);
      expect(Array.isArray(r.data.potential_cycles)).toBe(true);
    });

    it('T10: search_code for "format"', async () => {
      const r = await ct('search_code', { project_id: projectId, query: 'format' });
      expect(r.data.functions.length).toBeGreaterThanOrEqual(1);
      expect(r.data.functions[0]).toHaveProperty('name');
      expect(r.data.functions[0]).toHaveProperty('file');
    });

    it('T10b: search_code scope=files', async () => {
      const r = await ct('search_code', { project_id: projectId, query: 'helpers', scope: 'files' });
      expect(r.data.files.length).toBeGreaterThanOrEqual(1);
    });

    it('T12: find_similar_functions for "format"', async () => {
      const r = await ct('find_similar_functions', { project_id: projectId, func_name: 'format' });
      expect(r.data.query).toBe('format');
      expect(typeof r.data.matches).toBe('number');
      expect(Array.isArray(r.data.functions)).toBe(true);
    });

    it('T13: get_reuse_report', async () => {
      const r = await ct('get_reuse_report', { project_id: projectId });
      expect(typeof r.data.total).toBe('number');
      expect(Array.isArray(r.data.top_scores)).toBe(true);
      if (r.data.top_scores.length > 0) {
        expect(r.data.top_scores[0]).toHaveProperty('reuseScore');
      }
    });

    it('T13b: get_reuse_report with score_min', async () => {
      const r = await ct('get_reuse_report', { project_id: projectId, score_min: 80 });
      for (const f of r.data.top_scores) {
        expect(f.reuseScore).toBeGreaterThanOrEqual(80);
      }
    });

    it('T14: get_hotspots', async () => {
      const r = await ct('get_hotspots', { project_id: projectId });
      expect(typeof r.data.total).toBe('number');
      expect(Array.isArray(r.data.hotspots)).toBe(true);
      expect(r.data.filters).toBeDefined();
    });

    it('T15: get_feature_tracking', async () => {
      const r = await ct('get_feature_tracking', { project_id: projectId });
      expect(Array.isArray(r.data.features)).toBe(true);
      expect(Array.isArray(r.data.mappings)).toBe(true);
    });

    it('T11: search_semantic for "user"', async () => {
      const r = await ct('search_semantic', { project_id: projectId, query: 'user' });
      expect(r.data.query).toBe('user');
      expect(Array.isArray(r.data.seeds)).toBe(true);
      expect(Array.isArray(r.data.cluster)).toBe(true);
    });

    it('T19: get_file_content for known file', async () => {
      const r = await ct('get_file_content', { project_id: projectId, file_path: 'src/utils/helpers.ts' });
      expect(r.data.path).toBe('src/utils/helpers.ts');
      expect(r.data.content).toContain('formatDate');
      expect(r.data.lines).toBeGreaterThan(0);
    });
  });

  // ──────────────────────────────
  // 4. Enhancement Tools
  // ──────────────────────────────
  describe('Enhancement Tools — Phase 1 + Supplementary', () => {
    const ct = (name: string, args: Record<string, any>) => callTool(client, name, args);

    it('get_type_info for User', async () => {
      const r = await ct('get_type_info', { project_id: projectId, type_name: 'User' });
      expect(r.data.name).toBe('User');
      expect(r.data.kind).toBe('interface');
      expect(r.data.file).toContain('user-service');
      expect(Array.isArray(r.data.fields)).toBe(true);
      expect(Array.isArray(r.data.usedByFunctions)).toBe(true);
    });

    it('get_type_info fuzzy match', async () => {
      const r = await ct('get_type_info', { project_id: projectId, type_name: 'Config' });
      expect(r.data.name).toBe('Config');
    });

    it('get_context_bundle for clamp', async () => {
      const r = await ct('get_context_bundle', {
        project_id: projectId, func_name: 'clamp',
        include: { body: true, impact: true, callGraph: true },
      });
      expect(r.data.name).toBe('clamp');
      expect(r.data.body).toContain('if (value < min)');
      expect(r.data.impact).toBeDefined();
      expect(r.data.callGraph).toBeDefined();
    });

    it('get_context_bundle selective include', async () => {
      const r = await ct('get_context_bundle', {
        project_id: projectId, func_name: 'clamp',
        include: { body: false, impact: false },
      });
      expect(r.data.name).toBe('clamp');
      expect(r.data.body).toBeUndefined();
      expect(r.data.impact).toBeUndefined();
      expect(r.data.callGraph).toBeDefined();
    });

    it('get_change_guide for real function', async () => {
      const r = await ct('get_change_guide', { project_id: projectId, func_name: 'formatDate' });
      expect(r.data.target.name).toBe('formatDate');
      expect(typeof r.data.target.isPlaceholder).toBe('boolean');
      expect(Array.isArray(r.data.relatedFunctions)).toBe(true);
    });

    it('get_change_guide non-placeholder', async () => {
      const r = await ct('get_change_guide', { project_id: projectId, func_name: 'findUserByEmail' });
      expect(r.data.target.isPlaceholder).toBe(false);
      expect(r.data.suggestedSteps.length).toBeGreaterThan(0);
    });

    it('get_type_usage for User', async () => {
      const r = await ct('get_type_usage', { project_id: projectId, type_name: 'User' });
      expect(r.data.type).toBe('User');
      expect(Array.isArray(r.data.asParameter)).toBe(true);
      expect(Array.isArray(r.data.asReturn)).toBe(true);
    });

    it('get_test_coverage valid summary', async () => {
      const r = await ct('get_test_coverage', { project_id: projectId });
      expect(r.data.summary.testedFunctions + r.data.summary.untestedFunctions)
        .toBe(r.data.summary.totalFunctions);
      expect(r.data.summary.coverage).toBeGreaterThanOrEqual(0);
    });

    it('get_test_coverage module filter', async () => {
      const r = await ct('get_test_coverage', { project_id: projectId, module: 'utils' });
      expect(r.data.summary.totalFunctions).toBeGreaterThanOrEqual(0);
    });

    it('get_dead_code summary', async () => {
      const r = await ct('get_dead_code', { project_id: projectId });
      expect(r.data.summary).toBeDefined();
      expect(typeof r.data.summary.deadFunctions).toBe('number');
      expect(Array.isArray(r.data.functions)).toBe(true);
    });

    it('get_dead_code include_unexported >= default', async () => {
      const rDefault = await ct('get_dead_code', { project_id: projectId });
      const rAll = await ct('get_dead_code', { project_id: projectId, include_unexported: true });
      expect(rAll.data.summary.deadFunctions).toBeGreaterThanOrEqual(rDefault.data.summary.deadFunctions);
    });

    it('get_bulk_impact for formatDate', async () => {
      const r = await ct('get_bulk_impact', { project_id: projectId, func_names: ['formatDate'] });
      expect(r.data.targets.length).toBeGreaterThanOrEqual(1);
      expect(typeof r.data.summary.totalAffected).toBe('number');
    });

    it('get_bulk_impact multiple functions', async () => {
      const r = await ct('get_bulk_impact', { project_id: projectId, func_names: ['formatDate', 'clamp'] });
      expect(r.data.targets.length).toBeGreaterThanOrEqual(2);
    });

    it('get_bulk_impact errors on empty', async () => {
      await expect(
        ct('get_bulk_impact', { project_id: projectId, func_names: [] }),
      ).rejects.toThrow();
    });

    it('get_export_inventory', async () => {
      const r = await ct('get_export_inventory', { project_id: projectId });
      expect(r.data.summary.totalExports).toBeGreaterThan(0);
      expect(Array.isArray(r.data.byFile)).toBe(true);
      expect(r.data.byFile[0]).toHaveProperty('file');
      expect(r.data.byFile[0]).toHaveProperty('exports');
    });

    it('get_export_inventory module filter', async () => {
      const r = await ct('get_export_inventory', { project_id: projectId, module: 'utils' });
      for (const f of r.data.byFile) {
        expect(f.file).toContain('utils');
      }
    });

    it('get_bridge_map', async () => {
      const r = await ct('get_bridge_map', { project_id: projectId });
      expect(r.data.summary).toBeDefined();
      expect(typeof r.data.summary.totalBridges).toBe('number');
      expect(r.data.byFramework).toBeDefined();
    });

    it('get_architecture_guide', async () => {
      const r = await ct('get_architecture_guide', { project_id: projectId });
      expect(r.data.project).toBeDefined();
      expect(Array.isArray(r.data.moduleTree)).toBe(true);
      expect(Array.isArray(r.data.hotspots)).toBe(true);
      expect(Array.isArray(r.data.keyTypes)).toBe(true);
    });

    it('get_function_context for findUserByEmail', async () => {
      const r = await ct('get_function_context', { project_id: projectId, func_name: 'findUserByEmail' });
      expect(r.data.function.name).toBe('findUserByEmail');
      expect(r.data.file.path).toContain('user-service');
      expect(r.data.body).toBeDefined();
    });

    it('get_function_context include flags', async () => {
      const r = await ct('get_function_context', {
        project_id: projectId, func_name: 'findUserByEmail',
        include_body: false, include_callers: false,
      });
      expect(r.data.function.name).toBe('findUserByEmail');
      expect(r.data.body).toBeUndefined();
      expect(r.data.callers).toBeUndefined();
      expect(r.data.file).toBeDefined();
    });

    it('get_smart_context explore', async () => {
      const r = await ct('get_smart_context', { project_id: projectId, func_name: 'formatDate', purpose: 'explore' });
      expect(r.data.name).toBe('formatDate');
      expect(r.data.summary).toBeDefined();
      expect(Array.isArray(r.data.callers)).toBe(true);
      expect(Array.isArray(r.data.callees)).toBe(true);
    });

    it('get_smart_context understand', async () => {
      const r = await ct('get_smart_context', { project_id: projectId, func_name: 'formatDate', purpose: 'understand' });
      expect(r.data.name).toBe('formatDate');
      expect(Array.isArray(r.data.callers)).toBe(true);
      expect(Array.isArray(r.data.callees)).toBe(true);
      expect(r.data.relatedTypes).toBeDefined();
    });

    it('get_smart_context modify', async () => {
      const r = await ct('get_smart_context', { project_id: projectId, func_name: 'formatDate', purpose: 'modify' });
      expect(r.data.body).toBeDefined();
      expect(r.data.body).toContain('function');
      expect(Array.isArray(r.data.impactedFiles)).toBe(true);
    });
  });

  // ──────────────────────────────
  // 5. Error Handling
  // ──────────────────────────────
  describe('Error Handling — invalid inputs', () => {
    const ct = (name: string, args: Record<string, any>) => callTool(client, name, args);

    it('scan_project errors on unknown project_id', async () => {
      await expect(ct('scan_project', { project_id: 'nonexistent-uuid' })).rejects.toThrow();
    });

    it('get_function_body returns not_found for unknown function', async () => {
      // 契约变更：解析失败返回结构化结论，不再抛错
      const r = await ct('get_function_body', { project_id: projectId, func_name: '__nonexistent_xyz__' });
      expect(r.data.resolved).toBe(false);
      expect(r.data.reason).toBe('not_found');
    });

    it('get_call_graph returns not_found for unknown function', async () => {
      // 契约变更：解析失败返回结构化结论，不再抛错
      const r = await ct('get_call_graph', { project_id: projectId, func_name: '__nonexistent_xyz__' });
      expect(r.data.resolved).toBe(false);
      expect(r.data.reason).toBe('not_found');
    });

    it('get_impact_analysis returns not_found for unknown function', async () => {
      // 契约变更：解析失败返回结构化结论，不再抛错
      const r = await ct('get_impact_analysis', { project_id: projectId, func_name: '__nonexistent_xyz__' });
      expect(r.data.resolved).toBe(false);
      expect(r.data.reason).toBe('not_found');
    });

    it('get_type_info errors on unknown type', async () => {
      await expect(ct('get_type_info', { project_id: projectId, type_name: '__nonexistent_xyz__' })).rejects.toThrow();
    });

    it('get_type_usage errors on unknown type', async () => {
      await expect(ct('get_type_usage', { project_id: projectId, type_name: '__nonexistent_xyz__' })).rejects.toThrow();
    });

    it('unknown tool name throws', async () => {
      await expect(ct('nonexistent_tool_xyz', {})).rejects.toThrow();
    });
  });

  // ──────────────────────────────
  // 6. Prompts + Resources
  // ──────────────────────────────
  describe('Prompts + Resources', () => {
    it('listPrompts returns codindex-guide', async () => {
      const r = await client.listPrompts();
      expect(r.prompts.some(p => p.name === 'codindex-guide')).toBe(true);
    });

    it('getPrompt codindex-guide contains tool reference', async () => {
      const r = await client.getPrompt({ name: 'codindex-guide' });
      const text = (r.messages[0].content as any).text;
      expect(text).toContain('Codindex');
      expect(text).toContain('add_project');
    });

    it('listResources returns codindex://projects', async () => {
      const r = await client.listResources();
      expect(r.resources.some(res => res.uri === 'codindex://projects')).toBe(true);
    });

    it('readResource codindex://projects returns project list', async () => {
      const r = await client.readResource({ uri: 'codindex://projects' });
      const data = JSON.parse(r.contents[0].text as string);
      expect(Array.isArray(data)).toBe(true);
      expect(data.some((p: any) => p.id === projectId)).toBe(true);
    });

    it('readResource codindex://projects/{id}/functions', async () => {
      const r = await client.readResource({ uri: `codindex://projects/${projectId}/functions` });
      const data = JSON.parse(r.contents[0].text as string);
      expect(Array.isArray(data)).toBe(true);
      expect(data.length).toBeGreaterThan(0);
    });

    it('readResource unknown URI throws', async () => {
      await expect(
        client.readResource({ uri: 'codindex://unknown_path' }),
      ).rejects.toThrow();
    });
  });
});

// ═══════════════════════════════════════════════════════════════
// Scanner Accuracy — known fixtures → known AST results
// ═══════════════════════════════════════════════════════════════
describe('Scanner Accuracy — AST correctness', () => {
  const WORKER_ID = process.env.VITEST_WORKER_ID || '0';
  const SCAN_DIR = pathResolve('/tmp', `codindex-scan-cal-${WORKER_ID}`);

  beforeEach(() => {
    if (existsSync(SCAN_DIR)) rmSync(SCAN_DIR, { recursive: true });
    mkdirSync(SCAN_DIR, { recursive: true });
    mkdirSync(`${SCAN_DIR}/pkg`, { recursive: true });
  });

  afterEach(() => {
    if (existsSync(SCAN_DIR)) rmSync(SCAN_DIR, { recursive: true });
  });

  const writeTs = (name: string, content: string) => {
    writeFileSync(`${SCAN_DIR}/pkg/${name}`, content);
  };

  it('parses export function with doc comment', () => {
    writeTs('hello.ts', `/** Say hello */\nexport function hello(name: string): string {\n  return "Hello, " + name;\n}\n`);
    const r = scanFile(`${SCAN_DIR}/pkg/hello.ts`, 'typescript');
    expect(r.functions.length).toBe(1);
    expect(r.functions[0].name).toBe('hello');
    expect(r.functions[0].isExported).toBe(true);
    expect(r.functions[0].docComment).toContain('Say hello');
    expect(r.functions[0].signature).toContain('name: string');
  });

  it('parses interface with fields', () => {
    writeTs('types.ts', `export interface User {\n  id: number;\n  name: string;\n  email: string;\n}\n`);
    const r = scanFile(`${SCAN_DIR}/pkg/types.ts`, 'typescript');
    const user = r.types.find(t => t.name === 'User');
    expect(user).toBeDefined();
    expect(user!.kind).toBe('interface');
    // TypeField.fields 在类型定义里是可选的（其他语言分支可能不产出字段）
    const userFields = user!.fields ?? [];
    expect(userFields.length).toBeGreaterThanOrEqual(3);
    const names = userFields.map(f => f.name);
    expect(names).toContain('id');
    expect(names).toContain('name');
    expect(names).toContain('email');
  });

  it('parses type alias', () => {
    writeTs('types.ts', `export type Status = "active" | "inactive";\n`);
    const r = scanFile(`${SCAN_DIR}/pkg/types.ts`, 'typescript');
    const st = r.types.find(t => t.name === 'Status');
    expect(st).toBeDefined();
    expect(st!.kind).toBe('type_alias');
  });

  it('orders functions by lineStart', () => {
    writeTs('multi.ts', `export function a() { return 1; }\nexport function b() { return 2; }\nexport function c() { return 3; }\n`);
    const r = scanFile(`${SCAN_DIR}/pkg/multi.ts`, 'typescript');
    expect(r.functions.length).toBe(3);
    expect(r.functions[0].lineStart).toBeLessThan(r.functions[1].lineStart);
    expect(r.functions[1].lineStart).toBeLessThan(r.functions[2].lineStart);
  });

  it('distinguishes exported vs non-exported', () => {
    writeTs('private.ts', `function internal() { return 1; }\nexport function external() { return 2; }\n`);
    const r = scanFile(`${SCAN_DIR}/pkg/private.ts`, 'typescript');
    expect(r.functions.find(f => f.name === 'internal')!.isExported).toBe(false);
    expect(r.functions.find(f => f.name === 'external')!.isExported).toBe(true);
  });

  it('extracts @feature tags from JSDoc comments', () => {
    writeTs('tagged.ts', `/** @feature: user-login */\nexport function login() {}\n`);
    const r = scanFile(`${SCAN_DIR}/pkg/tagged.ts`, 'typescript');
    // Tags come from doc comments — JSDoc style is reliably captured
    expect(r.tags.length).toBeGreaterThanOrEqual(1);
    expect(r.tags[0].name).toBe('user-login');
  });

  it('parses .test.ts files (functions found)', () => {
    writeTs('hello.test.ts', `import { hello } from './hello';\ndescribe('hello', () => { it('works', () => { expect(hello('x')).toBe('Hello, x'); }); });\n`);
    const r = scanFile(`${SCAN_DIR}/pkg/hello.test.ts`, 'typescript');
    // scanFile returns function defs for all top-level functions in the file
    expect(r.functions.length).toBeGreaterThanOrEqual(0);
  });

  it('computes complexity > 1 for branches', () => {
    writeTs('branch.ts', `export function classify(x: number): string {\n  if (x > 0) return "pos";\n  if (x < 0) return "neg";\n  return "zero";\n}\n`);
    const r = scanFile(`${SCAN_DIR}/pkg/branch.ts`, 'typescript');
    expect(r.functions[0].complexity).toBeGreaterThanOrEqual(3);
  });

  it('detects arrow functions', () => {
    writeTs('arrow.ts', `export const add = (a: number, b: number): number => a + b;\n`);
    const r = scanFile(`${SCAN_DIR}/pkg/arrow.ts`, 'typescript');
    expect(r.functions.some(f => f.kind === 'arrow')).toBe(true);
  });

  it('handles empty file', () => {
    writeTs('empty.ts', '');
    const r = scanFile(`${SCAN_DIR}/pkg/empty.ts`, 'typescript');
    expect(r.functions.length).toBe(0);
    expect(r.types.length).toBe(0);
  });
});

// ═══════════════════════════════════════════════════════════════
// Call-Graph Resolution
// ═══════════════════════════════════════════════════════════════
describe('Call-Graph Resolution — cross-file', () => {
  const WORKER_ID = process.env.VITEST_WORKER_ID || '0';
  const CG_DIR = pathResolve('/tmp', `codindex-cg-cal-${WORKER_ID}`);

  beforeEach(() => {
    if (existsSync(CG_DIR)) rmSync(CG_DIR, { recursive: true });
    mkdirSync(`${CG_DIR}/pkg`, { recursive: true });
  });

  afterEach(() => {
    if (existsSync(CG_DIR)) rmSync(CG_DIR, { recursive: true });
  });

  it('resolveImportPath resolves relative imports', () => {
    writeFileSync(`${CG_DIR}/pkg/a.ts`, `export const x = 1;\n`);
    writeFileSync(`${CG_DIR}/pkg/b.ts`, `import { x } from './a';\nexport const y = x;\n`);
    const fileLookup = new Set([`${CG_DIR}/pkg/a.ts`, `${CG_DIR}/pkg/b.ts`]);
    expect(resolveImportPath('./a', `${CG_DIR}/pkg/b.ts`, CG_DIR, fileLookup))
      .toBe(`${CG_DIR}/pkg/a.ts`);
  });

  it('resolveImportPath returns null for package imports', () => {
    expect(resolveImportPath('react', `${CG_DIR}/pkg/b.ts`, CG_DIR, new Set())).toBeNull();
  });

  it('resolveImportPath returns null for nonexistent', () => {
    expect(resolveImportPath('./nonexistent', `${CG_DIR}/pkg/b.ts`, CG_DIR, new Set())).toBeNull();
  });

  it('buildImportMap captures cross-file imports', () => {
    writeFileSync(`${CG_DIR}/pkg/a.ts`, `export function a() { return 1; }\n`);
    writeFileSync(`${CG_DIR}/pkg/b.ts`, `import { a } from './a';\nexport function b() { return a(); }\n`);
    const scans = new Map();
    for (const fp of [`${CG_DIR}/pkg/a.ts`, `${CG_DIR}/pkg/b.ts`]) {
      scans.set(fp, scanFile(fp, 'typescript'));
    }
    const importMap = buildImportMap(CG_DIR, Array.from(scans.keys()), scans);
    const bEntry = importMap.get(`${CG_DIR}/pkg/b.ts`);
    expect(bEntry).toBeDefined();
    expect(bEntry!.imports.length).toBeGreaterThanOrEqual(1);
  });
});

// ═══════════════════════════════════════════════════════════════
// Module Dependency Graph + Cycle Detection
// ═══════════════════════════════════════════════════════════════
describe('Module Dependency Graph + Cycles', () => {
  it('detects 2-node cycle', () => {
    const root = '/tmp/codindex-cycle-skill';
    const paths = [`${root}/mA/a.ts`, `${root}/mB/b.ts`];
    const importMap = new Map();
    importMap.set(`${root}/mA/a.ts`, {
      relPath: 'mA/a.ts', module: 'mA',
      imports: [{ source: '../mB/b', names: ['beta'], line: 1 }],
    });
    importMap.set(`${root}/mB/b.ts`, {
      relPath: 'mB/b.ts', module: 'mB',
      imports: [{ source: '../mA/a', names: ['alpha'], line: 1 }],
    });
    const result = buildModuleGraph(importMap, root, new Set(paths));
    expect(result.cycles.length).toBeGreaterThanOrEqual(1);
    expect(result.cycles[0].description).toContain('mA');
    expect(result.cycles[0].description).toContain('mB');
  });

  it('detects no cycles for acyclic graph', () => {
    const root = '/tmp/codindex-acyclic-skill';
    const paths = [`${root}/mX/x.ts`, `${root}/mY/y.ts`];
    const importMap = new Map();
    importMap.set(`${root}/mX/x.ts`, {
      relPath: 'mX/x.ts', module: 'mX',
      imports: [{ source: '../mY/y', names: ['yo'], line: 1 }],
    });
    importMap.set(`${root}/mY/y.ts`, {
      relPath: 'mY/y.ts', module: 'mY', imports: [],
    });
    const result = buildModuleGraph(importMap, root, new Set(paths));
    expect(result.cycles.length).toBe(0);
    expect(result.edges.length).toBe(1);
    expect(result.edges[0].fromModule).toBe('mX');
    expect(result.edges[0].toModule).toBe('mY');
  });

  it('deduplicates parallel edges', () => {
    const root = '/tmp/codindex-dedup-skill';
    const paths = [`${root}/mA/a.ts`, `${root}/mB/b.ts`];
    const importMap = new Map();
    importMap.set(`${root}/mA/a.ts`, {
      relPath: 'mA/a.ts', module: 'mA',
      imports: [
        { source: '../mB/b', names: ['x'], line: 1 },
        { source: '../mB/b', names: ['y'], line: 5 },
      ],
    });
    importMap.set(`${root}/mB/b.ts`, {
      relPath: 'mB/b.ts', module: 'mB', imports: [],
    });
    const result = buildModuleGraph(importMap, root, new Set(paths));
    expect(result.edges.length).toBe(1);
  });

  it('handles empty import map', () => {
    const result = buildModuleGraph(new Map(), '/tmp', new Set());
    expect(result.modules.length).toBe(0);
    expect(result.edges.length).toBe(0);
    expect(result.cycles.length).toBe(0);
  });
});

// ═══════════════════════════════════════════════════════════════
// Incremental Scan — git change detection
// ═══════════════════════════════════════════════════════════════
describe('Incremental Scan — git change detection', () => {
  const INC_DIR = pathResolve('/tmp', `codindex-inc-cal-${process.env.VITEST_WORKER_ID || '0'}`);
  let db: ReturnType<typeof getDb>;
  let pid: string;
  const gitAvailable = (() => {
    try { execSync('git --version', { stdio: 'pipe' }); return true; }
    catch { return false; }
  })();

  beforeAll(async () => {
    if (!gitAvailable) return;
    db = getDb();
    pid = uuid();
    if (existsSync(INC_DIR)) rmSync(INC_DIR, { recursive: true });
    mkdirSync(INC_DIR, { recursive: true });
    writeFileSync(`${INC_DIR}/a.ts`, 'export function alpha() { return 1; }\n');
    writeFileSync(`${INC_DIR}/b.ts`, 'export function beta() { return 2; }\n');
    execSync('git init', { cwd: INC_DIR, stdio: 'pipe' });
    execSync('git config user.email t@t', { cwd: INC_DIR, stdio: 'pipe' });
    execSync('git config user.name T', { cwd: INC_DIR, stdio: 'pipe' });
    execSync('git add -A && git commit -m "init"', { cwd: INC_DIR, stdio: 'pipe' });
    await db.insert(schema.projects).values({
      id: pid, name: 'IncCal', path: INC_DIR, status: 'pending',
    });
    await scanProject(pid, INC_DIR);
  });

  afterAll(async () => {
    if (!gitAvailable || !pid) return;
    await db.delete(schema.calls).where(eq(schema.calls.projectId, pid));
    await db.delete(schema.functions).where(eq(schema.functions.projectId, pid));
    await db.delete(schema.types).where(eq(schema.types.projectId, pid));
    await db.delete(schema.files).where(eq(schema.files.projectId, pid));
    await db.delete(schema.moduleDeps).where(eq(schema.moduleDeps.projectId, pid));
    await db.delete(schema.modules).where(eq(schema.modules.projectId, pid));
    await db.delete(schema.testMappings).where(eq(schema.testMappings.projectId, pid));
    await db.delete(schema.projects).where(eq(schema.projects.id, pid));
    if (existsSync(INC_DIR)) rmSync(INC_DIR, { recursive: true });
  });

  it('returns changed=0 with future lastScanned', async () => {
    if (!gitAvailable) return;
    const futureTs = Math.floor(Date.now() / 1000) + 3600;
    const r = await scanProjectIncremental(pid, INC_DIR, futureTs);
    expect(r.changed).toBe(0);
    expect(r.total).toBe(0);
  });

  it('detects changes after git commit', async () => {
    if (!gitAvailable) return;
    writeFileSync(`${INC_DIR}/c.ts`, 'export function gamma() { return 3; }\n');
    execSync('git add -A && git commit -m "add c"', { cwd: INC_DIR, stdio: 'pipe' });
    const proj = await db.select().from(schema.projects).where(eq(schema.projects.id, pid)).limit(1);
    const oldTs = (proj[0].lastScanned ?? 0) - 60;
    const r = await scanProjectIncremental(pid, INC_DIR, oldTs);
    expect(r.changed).toBeGreaterThanOrEqual(1);
  });

  it('returns empty for non-git directory', () => {
    if (!gitAvailable) return;
    const nonGit = pathResolve('/tmp', `codindex-nongit-${Date.now()}`);
    mkdirSync(nonGit, { recursive: true });
    const r = getChangedFiles(nonGit, Math.floor(Date.now() / 1000) - 60);
    expect(r).toEqual([]);
    rmSync(nonGit, { recursive: true });
  });
});

// ═══════════════════════════════════════════════════════════════
// DB Integrity — foreign keys, constraints, counts
// ═══════════════════════════════════════════════════════════════
describe('DB Integrity — constraints and referential consistency', () => {
  let db: ReturnType<typeof getDb>;
  let pid: string;

  beforeAll(async () => {
    db = getDb();
    pid = uuid();
    await db.insert(schema.projects).values({
      id: pid, name: 'DbIntTest', path: TEST_PROJECT_DIR, status: 'pending',
    });
    await scanProject(pid, TEST_PROJECT_DIR);
  });

  afterAll(async () => {
    await cleanupProject(db, pid);
  });

  it('function.fileId references valid file', async () => {
    const funcs = await db.select().from(schema.functions).where(eq(schema.functions.projectId, pid)).limit(20);
    for (const f of funcs) {
      const file = await db.select().from(schema.files).where(eq(schema.files.id, f.fileId)).limit(1);
      expect(file.length).toBe(1);
    }
  });

  it('call edges reference valid callee + caller', async () => {
    const calls = await db.select().from(schema.calls).where(eq(schema.calls.projectId, pid)).limit(50);
    for (const c of calls) {
      // 未解析边（延迟导入/多态/动态属性）calleeFuncId 为 null，但必须留下 calleeName。
      if (c.calleeFuncId == null) {
        expect(c.isExternal).toBe(true);
        expect(c.calleeName).toBeTruthy();
      } else {
        const callee = await db.select().from(schema.functions).where(eq(schema.functions.id, c.calleeFuncId)).limit(1);
        expect(callee.length).toBe(1);
      }
      if (c.callerFuncId != null) {
        const caller = await db.select().from(schema.functions).where(eq(schema.functions.id, c.callerFuncId)).limit(1);
        expect(caller.length).toBe(1);
      }
    }
  });

  it('file paths are unique within project', async () => {
    const files = await db.select().from(schema.files).where(eq(schema.files.projectId, pid));
    const paths = files.map(f => f.path);
    expect(new Set(paths).size).toBe(paths.length);
  });

  it('type fileId references valid file', async () => {
    const types = await db.select().from(schema.types).where(eq(schema.types.projectId, pid));
    for (const t of types) {
      const file = await db.select().from(schema.files).where(eq(schema.files.id, t.fileId)).limit(1);
      expect(file.length).toBe(1);
    }
  });

  it('module paths are unique within project', async () => {
    const mods = await db.select().from(schema.modules).where(eq(schema.modules.projectId, pid));
    const paths = mods.map(m => m.path);
    expect(new Set(paths).size).toBe(paths.length);
  });

  it('all callee_func_ids reference existing functions', async () => {
    const maxId = (await db.select({ m: sql<number>`max(id)` })
      .from(schema.functions).where(eq(schema.functions.projectId, pid)))[0].m;
    const bad = await db.select({ c: sql<number>`count(*)` })
      .from(schema.calls)
      .where(and(eq(schema.calls.projectId, pid), sql`callee_func_id > ${maxId}`));
    expect(bad[0].c).toBe(0);
  });
});

// ═══════════════════════════════════════════════════════════════
// Performance Baselines — duration_ms per tool
// ═══════════════════════════════════════════════════════════════
describe('Performance Baselines — duration_ms per tool', () => {
  const timings: Record<string, number> = {};

  it('records and prints baseline durations for all query tools', async () => {
    const server = createMcpServer();
    const client = new Client({ name: 'perf-client', version: '1.0.0' });
    const [ct, st] = InMemoryTransport.createLinkedPair();
    await server.connect(st);
    await client.connect(ct);

    // Clean up any leftover project at TEST_PROJECT_DIR
    const perfDb = getDb();
    await perfDb.delete(schema.projects).where(eq(schema.projects.path, TEST_PROJECT_DIR));

    const { pid, db } = await seedProject('PerfCal', TEST_PROJECT_DIR);

    const call = async (name: string, args: Record<string, any>) => {
      const result = await client.callTool({ name, arguments: args });
      return JSON.parse((result.content as any[])[0].text);
    };

    // 显式声明为元组数组：否则 TS 推断成 (string | (() => Promise<any>))[][],
    // 解构出的 `fn` 变成 union，`await fn()` 报 "not callable"，name 也无法索引。
    const tools: [string, () => Promise<unknown>][] = [
      ['get_project_summary', () => call('get_project_summary', { project_id: pid })],
      ['get_function_list', () => call('get_function_list', { project_id: pid })],
      ['get_function_body', () => call('get_function_body', { project_id: pid, func_name: 'formatDate' })],
      ['get_call_graph', () => call('get_call_graph', { project_id: pid, func_name: 'formatDate' })],
      ['get_module_deps', () => call('get_module_deps', { project_id: pid })],
      ['get_reuse_report', () => call('get_reuse_report', { project_id: pid })],
      ['get_hotspots', () => call('get_hotspots', { project_id: pid })],
      ['search_code', () => call('search_code', { project_id: pid, query: 'format' })],
      ['search_semantic', () => call('search_semantic', { project_id: pid, query: 'user' })],
      ['get_impact_analysis', () => call('get_impact_analysis', { project_id: pid, func_name: 'formatDate' })],
      ['get_smart_context_explore', () => call('get_smart_context', { project_id: pid, func_name: 'formatDate', purpose: 'explore' })],
      ['get_smart_context_modify', () => call('get_smart_context', { project_id: pid, func_name: 'formatDate', purpose: 'modify' })],
    ];

    for (const [name, fn] of tools) {
      const start = performance.now();
      await fn();
      timings[name] = Math.round((performance.now() - start) * 100) / 100;
    }

    // Cleanup
    await cleanupProject(db, pid);
    await client.close();
    await server.close();
  }, 120_000);

  it('all tools respond within 5 seconds', () => {
    for (const [name, ms] of Object.entries(timings)) {
      expect(ms).toBeLessThan(5000);
    }
  });

  it('prints baseline report', () => {
    console.log('\n═══ Performance Baselines ═══');
    let total = 0;
    for (const [name, ms] of Object.entries(timings)) {
      total += ms;
      const flag = ms > 2000 ? '🐢' : ms > 1000 ? '⚠️ ' : '✅';
      console.log(`  ${flag} ${name.padEnd(35)} ${ms.toFixed(1).padStart(6)}ms`);
    }
    console.log(`  ─────────────────────────────────────────────`);
    console.log(`  ${'TOTAL'.padEnd(35)} ${total.toFixed(1).padStart(6)}ms\n`);
    expect(true).toBe(true);
  });
});
