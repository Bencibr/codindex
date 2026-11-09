#!/usr/bin/env node
import { Hono } from 'hono';
import { cors } from 'hono/cors';
import { serve } from '@hono/node-server';
import { getDb, getSqlite } from './db/connection.js';
import * as schema from './db/schema.js';
import { startMcpServer } from './mcp/server.js';
import { scanProject, clearProjectData } from './scan/orchestrator.js';
import { eq, desc, sql, and, inArray } from 'drizzle-orm';
import { v4 as uuid } from 'uuid';
import { resolve } from 'path';
import { readFileSync, realpathSync } from 'fs';
import { fileURLToPath } from 'url';

const app = new Hono();

// Global error handler — generic messages to client, details to server log
app.onError((err, c) => {
  console.error('[codindex]', err.message || 'Internal error', err.stack || '');
  return c.json({ error: 'Internal server error' }, 500);
});

// H8 fix: restrict CORS to localhost origins。
// 端口必须跟着 PORT 走 —— 之前写死 3100，用户按排错文档用 `PORT=3199` 起服务时，
// Web UI 的同源请求能过，但任何跨端口/跨主机名的 localhost 访问都会被 CORS 拦掉。
const PORT = Number(process.env.PORT || '3100');
const ALLOWED_ORIGINS = [
  `http://localhost:${PORT}`,
  `http://127.0.0.1:${PORT}`,
];
app.use('/*', cors({ origin: ALLOWED_ORIGINS }));

// ─── Serve static UI (SPA — all paths serve index.html) ───
const UI_HTML = readFileSync(new URL('web/ui/index.html', import.meta.url), 'utf-8');
const SPA_PATHS = ['/', '/projects', '/projects/', '/projects/:id'];
app.get('/', (c) => c.html(UI_HTML));
app.get('/projects/:id', (c) => c.html(UI_HTML));
app.get('/projects/:id/functions', (c) => c.html(UI_HTML));
app.get('/projects/:id/functions/:fid', (c) => c.html(UI_HTML));
app.get('/projects/:id/features', (c) => c.html(UI_HTML));
app.get('/projects/:id/reuse', (c) => c.html(UI_HTML));
app.get('/projects/:id/deps', (c) => c.html(UI_HTML));
app.get('/projects/:id/files', (c) => c.html(UI_HTML));
app.get('/projects/:id/files/:fid', (c) => c.html(UI_HTML));
app.get('/projects/:id/cfg', (c) => c.html(UI_HTML));
app.get('/projects/:id/flowchart', (c) => c.html(UI_HTML));

// ─── API Routes ───

// GET /api/projects
app.get('/api/projects', async (c) => {
  const db = getDb();
  const projects = await db
    .select()
    .from(schema.projects)
    .orderBy(desc(schema.projects.createdAt));
  return c.json(projects);
});

// POST /api/projects (idempotent — returns existing if path matches)
app.post('/api/projects', async (c) => {
  const db = getDb();
  const body = await c.req.json<{ name: string; path: string; prdPath?: string }>();
  const absPath = resolve(body.path);

  // Check for existing project with same path
  const existing = await db.select().from(schema.projects)
    .where(eq(schema.projects.path, absPath)).limit(1);
  if (existing.length > 0) {
    return c.json(existing[0], 200);
  }

  const id = uuid();
  await db.insert(schema.projects).values({
    id,
    name: body.name,
    path: absPath,
    prdPath: body.prdPath || null,
    status: 'pending',
  });
  const proj = await db.select().from(schema.projects).where(eq(schema.projects.id, id)).limit(1);
  return c.json(proj[0], 201);
});

// GET /api/projects/:id  （/overview 是等价别名，README 一直按别名写）
async function projectOverview(id: string) {
  const db = getDb();
  const proj = await db.select().from(schema.projects).where(eq(schema.projects.id, id)).limit(1);
  if (!proj.length) return null;

  // Stats — parallel
  const counts = await Promise.all([
    db.select({ count: sql<number>`count(*)` }).from(schema.files).where(eq(schema.files.projectId, id)),
    db.select({ count: sql<number>`count(*)` }).from(schema.functions).where(eq(schema.functions.projectId, id)),
    db.select({ count: sql<number>`count(*)` }).from(schema.types).where(eq(schema.types.projectId, id)),
    db.select({ count: sql<number>`count(*)` }).from(schema.calls).where(eq(schema.calls.projectId, id)),
    db.select({ count: sql<number>`count(*)` }).from(schema.modules).where(eq(schema.modules.projectId, id)),
    db.select({ count: sql<number>`count(*)` }).from(schema.moduleDeps).where(eq(schema.moduleDeps.projectId, id)),
  ]);

  return { ...proj[0], stats: {
    files: counts[0][0].count,
    functions: counts[1][0].count,
    types: counts[2][0].count,
    calls: counts[3][0].count,
    modules: counts[4][0].count,
    module_deps: counts[5][0].count,
  }};
}

app.get('/api/projects/:id', async (c) => {
  const data = await projectOverview(c.req.param('id'));
  if (!data) return c.json({ error: 'not found' }, 404);
  return c.json(data);
});

// GET /api/projects/:id/overview —— README「快速开始」里文档化的路径。
// 此前只有 /api/projects/:id，照文档敲 curl 会拿到 404；两者现在指向同一实现。
app.get('/api/projects/:id/overview', async (c) => {
  const data = await projectOverview(c.req.param('id'));
  if (!data) return c.json({ error: 'not found' }, 404);
  return c.json(data);
});

// POST /api/projects/:id/scan
app.post('/api/projects/:id/scan', async (c) => {
  const db = getDb();
  const id = c.req.param('id');
  const proj = await db.select().from(schema.projects).where(eq(schema.projects.id, id)).limit(1);
  if (!proj.length) return c.json({ error: 'not found' }, 404);

  // 旧数据清理由 scanProject 内部完成（见 orchestrator 的 clearProjectData）。
  // 这里不再预删一遍：两处清理逻辑各写一份必然会漂移——此前这里漏了
  // type_usage_edges / raise_edges / test_mappings，重扫时残留旧行会因为
  // 指向已删除的 functions/files 而被外键拦下。
  //
  // features 例外：PRD 解析结果属于用户资产，scanProject 只重建 feature_code
  // 映射，不删 features 本体。
  try {
    const result = await scanProject(id, proj[0].path);
    return c.json({ status: 'complete', ...result });
  } catch (err) {
    console.error('[codindex] Scan error:', (err as Error).message, (err as Error).stack);
    return c.json({ error: (err as Error).message }, 500);
  }
});

// GET /api/projects/:id/functions
app.get('/api/projects/:id/functions', async (c) => {
  const db = getDb();
  const id = c.req.param('id');
  const sort = c.req.query('sort') || 'name';
  const search = c.req.query('search') || '';
  const rawLimit = parseInt(c.req.query('limit') || '500', 10);
  const limit = Number.isFinite(rawLimit) ? Math.min(rawLimit, 2000) : 500;
  const modFilter = c.req.query('module') || '';

  let query = db
    .select({
      id: schema.functions.id,
      name: schema.functions.name,
      fullName: schema.functions.fullName,
      kind: schema.functions.kind,
      signature: schema.functions.signature,
      lineStart: schema.functions.lineStart,
      lineEnd: schema.functions.lineEnd,
      complexity: schema.functions.complexity,
      paramsCount: schema.functions.paramsCount,
      linesCount: schema.functions.linesCount,
      isExported: schema.functions.isExported,
      isTest: schema.functions.isTest,
      tags: schema.functions.tags,
      reuseScore: schema.functions.reuseScore,
      couplingCount: schema.functions.couplingCount,
    })
    .from(schema.functions);

  const conditions = [eq(schema.functions.projectId, id)];

  if (search) {
    conditions.push(sql`${schema.functions.name} LIKE ${'%' + search.replace(/%/g, '\\%').replace(/_/g, '\\_') + '%'}`);
  }

  if (modFilter) {
    // Join files to filter by module path
    conditions.push(sql`file_id IN (SELECT id FROM files WHERE module = ${modFilter} AND project_id = ${id})`);
  }

  query = query.where(and(...conditions)) as any;

  const orderMap: Record<string, any> = {
    name: schema.functions.name,
    complexity: schema.functions.complexity,
    reuse_score: schema.functions.reuseScore,
    line_start: schema.functions.lineStart,
    lines: schema.functions.linesCount,
  };

  const order = orderMap[sort] || schema.functions.name;
  const result = await (query as any).orderBy(order).limit(limit);
  return c.json(result);
});

// GET /api/projects/:id/functions/:fid
app.get('/api/projects/:id/functions/:fid', async (c) => {
  const db = getDb();
  const rawFid = c.req.param('fid');
  const fid = Number(rawFid);
  if (!Number.isFinite(fid)) return c.json({ error: 'invalid function id' }, 400);

  const fn = await db.select().from(schema.functions).where(eq(schema.functions.id, fid)).limit(1);
  if (!fn.length) return c.json({ error: 'not found' }, 404);

  // Get source file path
  const sourceFile = await db.select({ id: schema.files.id, path: schema.files.path })
    .from(schema.files).where(eq(schema.files.id, fn[0].fileId)).limit(1);

  // Get callees (this function calls ->)
  const callees = await db
    .select({
      id: schema.calls.id,
      callLine: schema.calls.callLine,
      callType: schema.calls.callType,
      calleeFuncId: schema.calls.calleeFuncId,
    })
    .from(schema.calls)
    .where(and(eq(schema.calls.projectId, c.req.param('id')), eq(schema.calls.callerFuncId, fid)))
    .limit(100);

  // Get callers (-> this function is called by)
  // Includes both function-level and file-level (callerFuncId is null) calls
  const callers = await db
    .select({
      id: schema.calls.id,
      callLine: schema.calls.callLine,
      callType: schema.calls.callType,
      callerFuncId: schema.calls.callerFuncId,
      callerFileId: schema.calls.callerFileId,
    })
    .from(schema.calls)
    .where(and(eq(schema.calls.projectId, c.req.param('id')), eq(schema.calls.calleeFuncId, fid)))
    .limit(200);

  // Resolve callee function names and file paths
  // calleeFuncId 可空（未解析的跨文件/多态调用会以 is_external=1 保留），
  // 直接 Set 会带进 null 让 inArray 报类型错，也会把 null 当 id 查。
  const calleeIds = [...new Set(callees.map(c => c.calleeFuncId).filter((x): x is number => x != null))];
  const callerFuncIds = [...new Set(callers.filter(c => c.callerFuncId != null).map(c => c.callerFuncId!))];
  const callerFileIds = [...new Set(callers.map(c => c.callerFileId))];

  const resolveFuncs = async (ids: number[]) => {
    if (!ids.length) return [];
    return db.select({
      id: schema.functions.id,
      name: schema.functions.name,
      kind: schema.functions.kind,
      fileId: schema.functions.fileId,
    }).from(schema.functions).where(inArray(schema.functions.id, ids)).limit(200);
  };

  const [calleeFuncs, callerFuncs, callerFiles] = await Promise.all([
    resolveFuncs(calleeIds),
    resolveFuncs(callerFuncIds),
    callerFileIds.length
      ? db.select({ id: schema.files.id, path: schema.files.path })
          .from(schema.files).where(inArray(schema.files.id, callerFileIds)).limit(200)
      : Promise.resolve([]),
  ]);

  // Build file path map
  const allFileIds = [...new Set([
    ...calleeFuncs.map(f => f.fileId),
    ...callerFuncs.map(f => f.fileId),
  ])];
  const fileMap = new Map<number, { id: number; path: string }>();
  const filesFromDb = allFileIds.length
    ? await db.select({ id: schema.files.id, path: schema.files.path })
        .from(schema.files).where(inArray(schema.files.id, allFileIds)).limit(500)
    : [];
  for (const f of filesFromDb) fileMap.set(f.id, f);
  for (const f of callerFiles) fileMap.set(f.id, f);

  // Group callers by file for summary
  const callersByFile = new Map<string, { path: string; count: number }>();
  for (const call of callers) {
    const file = callerFiles.find(f => f.id === call.callerFileId);
    if (!file) continue;
    const existing = callersByFile.get(file.path);
    if (existing) {
      existing.count++;
    } else {
      callersByFile.set(file.path, { path: file.path, count: 1 });
    }
  }

  const enrichCall = (call: any, funcList: any[]) => {
    const func = funcList.find(f => f.id === (call.calleeFuncId || call.callerFuncId));
    const file = func ? fileMap.get(func.fileId) : null;
    return {
      funcId: func?.id,
      funcName: func?.name || 'unknown',
      funcKind: func?.kind || '',
      fileId: file?.id,
      filePath: file?.path || '',
      callLine: call.callLine,
      callType: call.callType,
    };
  };

  return c.json({
    ...fn[0],
    sourceFile: sourceFile[0] || null,
    callCount: callers.length,
    callersByFile: [...callersByFile.values()].sort((a, b) => b.count - a.count),
    calls_to: callees.map(c => enrichCall(c, calleeFuncs)),
    calls_from: callers.map(c => {
      const func = callerFuncs.find(f => f.id === c.callerFuncId);
      const file = func ? fileMap.get(func.fileId) : callerFiles.find(f => f.id === c.callerFileId);
      return {
        funcId: func?.id,
        funcName: func?.name || '(top-level)',
        funcKind: func?.kind || '',
        fileId: file?.id,
        filePath: file?.path || '',
        callLine: c.callLine,
        callType: c.callType,
      };
    }),
  });
});

// GET /api/projects/:id/features
app.get('/api/projects/:id/features', async (c) => {
  const db = getDb();
  const features = await db
    .select()
    .from(schema.features)
    .where(eq(schema.features.projectId, c.req.param('id')));

  return c.json(features);
});

// GET /api/projects/:id/deps
app.get('/api/projects/:id/deps', async (c) => {
  const db = getDb();
  const id = c.req.param('id');
  const mods = await db.select().from(schema.modules).where(eq(schema.modules.projectId, id));
  const deps = await db.select().from(schema.moduleDeps).where(eq(schema.moduleDeps.projectId, id));

  // Build adjacency for cycle detection
  const adj = new Map<number, number[]>();
  for (const d of deps) {
    if (!adj.has(d.moduleId)) adj.set(d.moduleId, []);
    adj.get(d.moduleId)!.push(d.depModuleId);
  }
  const cycles: number[][] = [];
  const visited = new Set<number>();
  const stack = new Set<number>();
  const path: number[] = [];
  function dfs(u: number) {
    visited.add(u); stack.add(u); path.push(u);
    for (const v of adj.get(u) || []) {
      if (!visited.has(v)) dfs(v);
      else if (stack.has(v)) {
        const idx = path.indexOf(v);
        if (idx >= 0) cycles.push(path.slice(idx).concat(v));
      }
    }
    path.pop(); stack.delete(u);
  }
  for (const m of mods) { if (!visited.has(m.id)) dfs(m.id); }

  return c.json({ modules: mods, dependencies: deps, cycles });
});

// GET /api/projects/:id/cfg/:func_id — MUST come before /api/projects/:id/cfg
app.get('/api/projects/:id/cfg/:func_id', async (c) => {
  const db = getDb();
  const projectId = c.req.param('id');
  const funcId = Number(c.req.param('func_id'));
  if (!Number.isFinite(funcId)) return c.json({ error: 'invalid function id' }, 400);

  const nodes = await db.select().from(schema.controlFlowNodes)
    .where(eq(schema.controlFlowNodes.funcId, funcId));
  const edges = await db.select().from(schema.controlFlowEdges)
    .where(eq(schema.controlFlowEdges.funcId, funcId));

  return c.json({
    nodes: nodes.map(n => ({ id: n.nodeId, type: n.nodeType, label: n.label, lineStart: n.lineStart, lineEnd: n.lineEnd, conditionExpr: n.conditionExpr })),
    edges: edges.map(e => ({ source: e.sourceNodeId, target: e.targetNodeId, label: e.edgeLabel, type: e.edgeType })),
    summary: {
      totalNodes: nodes.length,
      branches: nodes.filter(n => n.nodeType === 'condition' || n.nodeType === 'switch').length,
      loops: nodes.filter(n => n.nodeType === 'loop').length,
    },
  });
});

// GET /api/projects/:id/cfg (list all CFGs for project) — MUST come after /cfg/:func_id
app.get('/api/projects/:id/cfg', async (c) => {
  const db = getDb();
  const projectId = c.req.param('id');
  const modules = await db.select().from(schema.modules).where(eq(schema.modules.projectId, projectId));
  const files = await db.select().from(schema.files).where(eq(schema.files.projectId, projectId));
  const fileMap = new Map(files.map(f => [f.id, f]));
  const functions = await db.select().from(schema.functions).where(eq(schema.functions.projectId, projectId)).limit(500);
  // Get CFG summaries
  const cfgNodes = await db.select({ funcId: schema.controlFlowNodes.funcId, nodeType: schema.controlFlowNodes.nodeType })
    .from(schema.controlFlowNodes).where(eq(schema.controlFlowNodes.projectId, projectId));
  const cfgSummaries = new Map<number, { totalNodes: number; branches: number; loops: number }>();
  for (const n of cfgNodes) {
    const ex = cfgSummaries.get(n.funcId) || { totalNodes: 0, branches: 0, loops: 0 };
    ex.totalNodes++;
    if (n.nodeType === 'condition' || n.nodeType === 'switch') ex.branches++;
    if (n.nodeType === 'loop') ex.loops++;
    cfgSummaries.set(n.funcId, ex);
  }
  const funcs = functions.map(f => ({
    id: f.id, name: f.name, fullName: f.fullName || f.name, kind: f.kind,
    lineStart: f.lineStart, lineEnd: f.lineEnd,
    path: fileMap.get(f.fileId)?.path || '',
    cfgSummary: cfgSummaries.get(f.id) || { totalNodes: 0, branches: 0, loops: 0 },
  }));
  return c.json({ modules, functions: funcs });
});

// GET /api/projects/:id/flowchart?func_name=X&depth=N
app.get('/api/projects/:id/flowchart', async (c) => {
  const db = getDb();
  const projectId = c.req.param('id');
  const funcName = c.req.query('func_name') || '';
  const depth = parseInt(c.req.query('depth') || '3', 10);
  const maxDepth = Math.min(Math.max(depth, 1), 10);

  if (!funcName) return c.json({ error: '?func_name required' }, 400);

  // Find entry function
  const funcs = await db.select().from(schema.functions)
    .where(and(eq(schema.functions.projectId, projectId), eq(schema.functions.name, funcName)))
    .limit(5);
  if (!funcs.length) return c.json({ error: `Function "${funcName}" not found` }, 404);
  const entryId = funcs[0].id;

  const sqlite = getSqlite();
  const stmt = sqlite.prepare(`
    WITH RECURSIVE chain(id, depth, path) AS (
      SELECT callee_func_id, 1, CAST(caller_func_id AS TEXT)
      FROM calls WHERE caller_func_id = ? AND project_id = ?
      UNION
      SELECT c.callee_func_id, chain.depth + 1, chain.path || '>' || CAST(c.caller_func_id AS TEXT)
      FROM calls c JOIN chain ON c.caller_func_id = chain.id
      WHERE chain.depth < ? AND c.project_id = ?
    )
    SELECT DISTINCT f.id, f.name, f.signature, MIN(chain.depth) as depth
    FROM functions f JOIN chain ON f.id = chain.id
    WHERE f.project_id = ? GROUP BY f.id ORDER BY depth, f.name
  `);
  const rows = stmt.all(entryId, projectId, maxDepth, projectId, projectId) as {
    id: number; name: string; signature: string; depth: number;
  }[];

  // Extract edges from recursive chain query
  const chainRows = sqlite.prepare(`
    WITH RECURSIVE chain(id, depth, path) AS (
      SELECT callee_func_id, 1, CAST(caller_func_id AS TEXT)
      FROM calls WHERE caller_func_id = ? AND project_id = ?
      UNION
      SELECT c.callee_func_id, chain.depth + 1, chain.path || '>' || CAST(c.caller_func_id AS TEXT)
      FROM calls c JOIN chain ON c.caller_func_id = chain.id
      WHERE chain.depth < ? AND c.project_id = ?
    )
    SELECT path FROM chain
  `).all(entryId, projectId, maxDepth, projectId) as { path: string }[];

  // Build edges from paths
  const funcIdToName = new Map(rows.map(r => [r.id, r.name]));
  const edges: { from: string; to: string }[] = [];
  const seen = new Set<string>();
  for (const cr of chainRows) {
    const parts = cr.path.split('>');
    for (let i = 0; i < parts.length - 1; i++) {
      const fromName = funcIdToName.get(Number(parts[i])) || '';
      const toName = funcIdToName.get(Number(parts[i + 1])) || '';
      if (fromName && toName) {
        const key = `${fromName}->${toName}`;
        if (!seen.has(key)) { seen.add(key); edges.push({ from: fromName, to: toName }); }
      }
    }
  }

  // CFG summaries
  const funcIds = rows.map(r => r.id);
  const cfgNodes = await db.select({ funcId: schema.controlFlowNodes.funcId, nodeType: schema.controlFlowNodes.nodeType })
    .from(schema.controlFlowNodes).where(inArray(schema.controlFlowNodes.funcId, funcIds));
  const cfgSummaries = new Map<number, { nodes: number; branches: number; loops: number }>();
  for (const n of cfgNodes) {
    const ex = cfgSummaries.get(n.funcId) || { nodes: 0, branches: 0, loops: 0 };
    ex.nodes++;
    if (n.nodeType === 'condition' || n.nodeType === 'switch') ex.branches++;
    if (n.nodeType === 'loop') ex.loops++;
    cfgSummaries.set(n.funcId, ex);
  }

  // Resolve file paths
  const fileIds = [funcs[0].fileId, ...funcIds];
  const files = await db.select({ id: schema.files.id, path: schema.files.path })
    .from(schema.files).where(inArray(schema.files.id, fileIds)).limit(200);
  const fileMap = new Map(files.map(f => [f.id, f.path]));
  const funcFileMap = new Map<number, string>();
  for (const r of rows) {
    const fn = await db.select({ fileId: schema.functions.fileId }).from(schema.functions)
      .where(eq(schema.functions.id, r.id)).limit(1);
    if (fn[0]) funcFileMap.set(r.id, fileMap.get(fn[0].fileId) || '');
  }

  return c.json({
    entry: funcName,
    maxDepth,
    chainLength: rows.length,
    nodes: rows.map(r => ({
      name: r.name, signature: r.signature, depth: r.depth,
      file: funcFileMap.get(r.id) || '',
      cfgSummary: cfgSummaries.get(r.id) || { nodes: 0, branches: 0, loops: 0 },
    })),
    edges,
  });
});

// GET /api/projects/:id/reuse
app.get('/api/projects/:id/reuse', async (c) => {
  const db = getDb();
  const id = c.req.param('id');
  const minScore = Number(c.req.query('min_score') || '0');
  const sort = c.req.query('sort') || 'reuse';

  const orderCol = sort === 'complexity' ? schema.functions.complexity : schema.functions.reuseScore;
  const orderDir = sort === 'reuse' ? desc(orderCol) : orderCol;

  const funcs = await db
    .select()
    .from(schema.functions)
    .where(and(
      eq(schema.functions.projectId, id),
      sql`reuse_score >= ${minScore}`,
    ))
    .orderBy(orderDir)
    .limit(200);

  const groups = { high: funcs.filter(f => (f.reuseScore ?? 0) >= 85).length,
    medium: funcs.filter(f => (f.reuseScore ?? 0) >= 60 && (f.reuseScore ?? 0) < 85).length,
    low: funcs.filter(f => (f.reuseScore ?? 0) < 60).length };

  return c.json({ total: funcs.length, groups, functions: funcs });
});

// GET /api/projects/:id/files
app.get('/api/projects/:id/files', async (c) => {
  const db = getDb();
  const files = await db
    .select({
      id: schema.files.id,
      path: schema.files.path,
      module: schema.files.module,
      language: schema.files.language,
      lines: schema.files.lines,
      codeLines: schema.files.codeLines,
      commentLines: schema.files.commentLines,
      complexity: schema.files.complexity,
    })
    .from(schema.files)
    .where(eq(schema.files.projectId, c.req.param('id')))
    .orderBy(schema.files.path)
    .limit(2000);

  return c.json(files);
});

// GET /api/projects/:id/files/:fid
app.get('/api/projects/:id/files/:fid', async (c) => {
  const db = getDb();
  const fid = Number(c.req.param('fid'));
  if (!Number.isFinite(fid)) return c.json({ error: 'invalid file id' }, 400);

  const file = await db.select().from(schema.files).where(eq(schema.files.id, fid)).limit(1);
  if (!file.length) return c.json({ error: 'not found' }, 404);

  // Get functions in this file
  const funcs = await db
    .select({
      id: schema.functions.id,
      name: schema.functions.name,
      kind: schema.functions.kind,
      lineStart: schema.functions.lineStart,
      lineEnd: schema.functions.lineEnd,
      complexity: schema.functions.complexity,
      isExported: schema.functions.isExported,
      reuseScore: schema.functions.reuseScore,
    })
    .from(schema.functions)
    .where(and(
      eq(schema.functions.projectId, c.req.param('id')),
      eq(schema.functions.fileId, fid),
    ))
    .orderBy(schema.functions.lineStart)
    .limit(500);

  return c.json({ ...file[0], functions: funcs });
});

// GET /api/projects/:id/diff?since=<timestamp>
// Compare current scan snapshot against a previous timestamp
app.get('/api/projects/:id/diff', async (c) => {
  const db = getDb();
  const id = c.req.param('id');
  const since = parseInt(c.req.query('since') || '0', 10);
  if (!since) return c.json({ error: '?since=<unix_timestamp> required' }, 400);

  // Get functions that exist now but not at `since` (i.e. new)
  const currentFuncs = await db.select({name:schema.functions.name,fullName:schema.functions.fullName,complexity:schema.functions.complexity,lineStart:schema.functions.lineStart})
    .from(schema.functions).where(eq(schema.functions.projectId, id));
  const funcNames = new Set(currentFuncs.map(f => f.name));

  // Files with last_modified > since (approximate "new/changed")
  const newFiles = await db.select({path:schema.files.path,lines:schema.files.lines,codeLines:schema.files.codeLines})
    .from(schema.files).where(and(eq(schema.files.projectId, id), sql`last_modified > ${since}`)).limit(100);

  return c.json({
    snapshot_since: new Date(since*1000).toISOString(),
    current: { functions: currentFuncs.length, files: 0 /* counted below */ },
    new_files: newFiles,
  });
});

// DELETE /api/projects/:id
app.delete('/api/projects/:id', async (c) => {
  const db = getDb();
  const id = c.req.param('id');

  // 先确认项目存在：删除一个不存在的 id 一律回 200 会让调用方
  // 分不清「删掉了」和「id 打错了」，前端只能靠重新拉列表去猜。
  const exists = await db
    .select({ id: schema.projects.id })
    .from(schema.projects)
    .where(eq(schema.projects.id, id))
    .limit(1);
  if (!exists.length) return c.json({ error: 'not found' }, 404);

  // 派生数据的清理统一走 clearProjectData，不再在这里维护第二份删除清单
  // （旧清单漏了 type_usage_edges / raise_edges / test_mappings / type_fields）。
  //
  // 另外旧代码写成 `db.transaction((tx) => {...})()`：drizzle 的
  // better-sqlite3 transaction 是**同步立即执行**的，返回值已经是 fn 的结果，
  // 再调一次就是对 undefined 调用 → "is not a function"，删除接口整个是坏的。
  await clearProjectData(id);
  await db.delete(schema.features).where(eq(schema.features.projectId, id));
  await db.delete(schema.projects).where(eq(schema.projects.id, id));
  return c.json({ deleted: true });
});

// ─── Start ───

async function main() {
  const args = process.argv.slice(2);

  // --version / --help 必须在起服务之前处理：以前敲 `codindex --version`
  // 会直接去占 3100 端口，用户拿不到版本号还多出一个僵死进程。
  if (args.includes('--version') || args.includes('-v')) {
    const { VERSION } = await import('./mcp/server.js');
    console.log(`codindex ${VERSION}`);
    return;
  }

  if (args.includes('--help') || args.includes('-h')) {
    console.log(`Codindex — 本地代码索引服务

用法：
  codindex                  启动 Web API + UI（默认 http://localhost:3100）
  codindex --mcp            以 MCP stdio 模式运行，交给编辑器挂载
  codindex --version        打印版本号
  codindex --help           显示本帮助

环境变量：
  PORT                  Web API 端口，默认 3100
  CODINDEX_DB           SQLite 文件路径，默认 data/codindex.db（支持 :memory:）
  CODINDEX_SQLITE       设为 better-sqlite3 时改用原生驱动

文档：https://github.com/Bencibr/codindex`);
    return;
  }

  if (args.includes('--mcp')) {
    // MCP server mode
    await startMcpServer();
  } else {
    // Web API + UI mode (MCP also on separate transport).
    // 端口在模块顶部已解析成 PORT 常量，CORS 白名单也用它，不能再解一次。
    serve({ fetch: app.fetch, port: PORT }, (info) => {
      console.log(`Codindex Web API listening on http://localhost:${info.port}`);
      console.log(`Codindex Web UI:     http://localhost:${info.port}`);
      console.log(`Codindex API:        http://localhost:${info.port}/api/projects`);
    });
  }
}

// 只有「被当作程序执行」时才启动服务。
//
// 之前的写法在模块顶层无条件调用 main()：任何人 `import { app } from 'codindex'`
// 都会立刻占用 3100 端口并开始监听，没法当库用，也没法在测试里复用 app。
// ESM 下用「入口脚本路径 === 本模块路径」判断是否直接执行。
const isDirectRun = (() => {
  try {
    return !!process.argv[1] && realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
})();

if (isDirectRun) {
  main().catch((err) => {
    console.error('[codindex]', err?.message || 'Internal error');
    process.exit(1);
  });
}

export { app, main };
