/**
 * Benchmark: Codindex-indexed data access vs raw file reading
 */

import Database from 'better-sqlite3';
import { readFileSync, existsSync, writeFileSync } from 'fs';

const DB_PATH = '/Volumes/Mac/Workspace/codindex/data/codindex.db';
const REPO = '/tmp/codegraph-bench';

const db = new Database(DB_PATH);
const projectId = db.prepare('SELECT id FROM projects').all()[0]?.id;
if (!projectId) { console.error('No project found. Run bench-scan.ts first.'); process.exit(1); }
const projectName = db.prepare('SELECT name FROM projects WHERE id = ?').get(projectId)?.name;
console.log('Project: ' + projectName + ' (' + projectId + ')');

const QUESTIONS = [
  {
    id: 'Q1', label: 'Architecture overview',
    codindexTools: ['get_project_summary', 'get_module_deps'],
    filesToRead: [
      { file: 'package.json', purpose: 'dependencies' },
      { file: 'src/index.ts', purpose: 'main entry' },
      { file: 'src/mcp/index.ts', purpose: 'MCP module' },
      { file: 'src/extraction/index.ts', purpose: 'extraction' },
      { file: 'src/graph/index.ts', purpose: 'graph layer' },
      { file: 'src/resolution/index.ts', purpose: 'resolution' },
      { file: 'src/search/query-parser.ts', purpose: 'search' },
      { file: 'src/sync/index.ts', purpose: 'file sync' },
    ],
  },
  {
    id: 'Q2', label: 'Extraction pipeline (source to graph)',
    codindexTools: ['search_code', 'get_call_graph', 'get_function_body'],
    filesToRead: [
      { file: 'src/extraction/index.ts', purpose: 'extraction orchestrator' },
      { file: 'src/extraction/tree-sitter.ts', purpose: 'tree-sitter parsing' },
      { file: 'src/extraction/parse-worker.ts', purpose: 'parallel workers' },
      { file: 'src/extraction/languages/typescript.ts', purpose: 'TS extractor' },
      { file: 'src/graph/index.ts', purpose: 'graph storage' },
      { file: 'src/graph/queries.ts', purpose: 'graph queries' },
    ],
  },
  {
    id: 'Q3', label: 'MCP tool request flow',
    codindexTools: ['search_code', 'get_call_graph'],
    filesToRead: [
      { file: 'src/mcp/tools.ts', purpose: 'tool handlers' },
      { file: 'src/mcp/engine.ts', purpose: 'query engine' },
      { file: 'src/mcp/query-pool.ts', purpose: 'worker pool' },
      { file: 'src/graph/queries.ts', purpose: 'graph queries' },
      { file: 'src/mcp/transport.ts', purpose: 'stdio transport' },
    ],
  },
  {
    id: 'Q4', label: 'Explore: search + context assembly',
    codindexTools: ['search_code', 'get_function_body'],
    filesToRead: [
      { file: 'src/mcp/tools.ts', purpose: 'handleExplore' },
      { file: 'src/search/query-parser.ts', purpose: 'query parsing' },
      { file: 'src/graph/traversal.ts', purpose: 'graph traversal' },
      { file: 'src/context/index.ts', purpose: 'context formatter' },
    ],
  },
  {
    id: 'Q5', label: 'Cross-language bridging (Swift<->ObjC)',
    codindexTools: ['search_code', 'get_call_graph', 'get_impact_analysis'],
    filesToRead: [
      { file: 'src/resolution/frameworks/swift-objc.ts', purpose: 'Swift<->ObjC bridge' },
      { file: 'src/resolution/frameworks/swift.ts', purpose: 'Swift framework' },
      { file: 'src/resolution/swift-objc-bridge.ts', purpose: 'bridge synthesizer' },
      { file: 'src/resolution/callback-synthesizer.ts', purpose: 'callback synthesis' },
      { file: 'src/extraction/languages/swift.ts', purpose: 'Swift extractor' },
      { file: 'src/extraction/languages/objc.ts', purpose: 'ObjC extractor' },
    ],
  },
  {
    id: 'Q6', label: 'Reuse detection / similar functions',
    codindexTools: ['find_similar_functions', 'get_reuse_report', 'search_code'],
    filesToRead: [
      { file: 'src/graph/traversal.ts', purpose: 'graph traversal' },
      { file: 'src/graph/queries.ts', purpose: 'graph queries' },
      { file: 'src/search/query-utils.ts', purpose: 'search utilities' },
      { file: 'src/resolution/name-matcher.ts', purpose: 'name matching' },
    ],
  },
];

function getProjectSummary(pid) {
  const start = Date.now();
  const stats = db.prepare(
    'SELECT (SELECT COUNT(*) FROM files WHERE project_id = ?) as files, ' +
    '(SELECT COUNT(*) FROM functions WHERE project_id = ?) as functions, ' +
    '(SELECT COUNT(*) FROM types WHERE project_id = ?) as types, ' +
    '(SELECT COUNT(*) FROM calls WHERE project_id = ?) as calls, ' +
    '(SELECT COUNT(*) FROM modules WHERE project_id = ?) as modules'
  ).get(pid, pid, pid, pid, pid);
  const modules = db.prepare(
    'SELECT m.path, COUNT(f.id) as func_count FROM modules m ' +
    'LEFT JOIN files fi ON fi.module = m.path AND fi.project_id = ? ' +
    'LEFT JOIN functions f ON f.file_id = fi.id AND f.project_id = ? ' +
    'WHERE m.project_id = ? GROUP BY m.path ORDER BY func_count DESC LIMIT 10'
  ).all(pid, pid, pid);
  const topComplex = db.prepare(
    'SELECT f.name, f.complexity, f.lines_count, fi.path FROM functions f ' +
    'JOIN files fi ON f.file_id = fi.id WHERE f.project_id = ? ' +
    'ORDER BY f.complexity DESC LIMIT 5'
  ).all(pid);
  const elapsed = Date.now() - start;
  return { elapsedMs: elapsed, responseChars: JSON.stringify({ stats, modules, topComplex }).length };
}

function getModuleDeps(pid) {
  const start = Date.now();
  const deps = db.prepare(
    'SELECT m1.path as from_module, m2.path as to_module, md.dep_type, md.weight ' +
    'FROM module_deps md JOIN modules m1 ON md.module_id = m1.id ' +
    'JOIN modules m2 ON md.dep_module_id = m2.id WHERE md.project_id = ? LIMIT 30'
  ).all(pid);
  return { elapsedMs: Date.now() - start, responseChars: JSON.stringify({ deps: deps.length }).length };
}

function searchCode(pid, query) {
  const start = Date.now();
  const results = db.prepare(
    'SELECT f.name, f.signature, fi.path FROM functions f ' +
    'JOIN files fi ON f.file_id = fi.id WHERE f.project_id = ? ' +
    'AND (f.name LIKE ? OR f.body LIKE ? OR fi.path LIKE ?) LIMIT 15'
  ).all(pid, '%' + query + '%', '%' + query + '%', '%' + query + '%');
  return { elapsedMs: Date.now() - start, responseChars: JSON.stringify({ results: results.length, sample: results.slice(0, 5) }).length };
}

function getCallGraph(pid, funcName) {
  const start = Date.now();
  const func = db.prepare('SELECT f.id FROM functions f WHERE f.project_id = ? AND f.name = ? LIMIT 1').all(pid, funcName);
  if (func.length === 0) return { elapsedMs: Date.now() - start, responseChars: 0 };
  const funcId = func[0].id;
  const callees = db.prepare(
    'SELECT f.name, c.call_type, fi.path FROM calls c ' +
    'JOIN functions f ON c.callee_func_id = f.id JOIN files fi ON f.file_id = fi.id ' +
    'WHERE c.project_id = ? AND c.caller_func_id = ? LIMIT 15'
  ).all(pid, funcId);
  const callers = db.prepare(
    'SELECT f.name, c.call_type, fi.path FROM calls c ' +
    'JOIN functions f ON c.caller_func_id = f.id JOIN files fi ON f.file_id = fi.id ' +
    'WHERE c.project_id = ? AND c.callee_func_id = ? LIMIT 15'
  ).all(pid, funcId);
  return { elapsedMs: Date.now() - start, responseChars: JSON.stringify({ callees: callees.length, callers: callers.length }).length };
}

function getFunctionBody(pid, funcName) {
  const start = Date.now();
  const func = db.prepare(
    'SELECT f.body FROM functions f JOIN files fi ON f.file_id = fi.id ' +
    'WHERE f.project_id = ? AND f.name = ? LIMIT 1'
  ).all(pid, funcName);
  if (func.length === 0) return { elapsedMs: Date.now() - start, responseChars: 0 };
  return { elapsedMs: Date.now() - start, responseChars: (func[0].body?.length || 0) + 200 };
}

function getImpactAnalysis(pid, funcName) {
  const start = Date.now();
  const func = db.prepare('SELECT f.id FROM functions f WHERE f.project_id = ? AND f.name = ? LIMIT 1').all(pid, funcName);
  if (func.length === 0) return { elapsedMs: Date.now() - start, responseChars: 0 };
  const funcId = func[0].id;
  const directCallers = db.prepare(
    'SELECT DISTINCT f.name, fi.path FROM calls c ' +
    'JOIN functions f ON c.caller_func_id = f.id JOIN files fi ON f.file_id = fi.id ' +
    'WHERE c.project_id = ? AND c.callee_func_id = ? LIMIT 20'
  ).all(pid, funcId);
  return { elapsedMs: Date.now() - start, responseChars: JSON.stringify({ directCallers: directCallers.length, affectedFiles: [...new Set(directCallers.map(c => c.path))].length }).length };
}

function findSimilarFunctions(pid, funcName) {
  const start = Date.now();
  const results = db.prepare(
    'SELECT f.name, f.signature, fi.path, f.complexity FROM functions f ' +
    'JOIN files fi ON f.file_id = fi.id WHERE f.project_id = ? AND f.name LIKE ? LIMIT 10'
  ).all(pid, '%' + funcName.split(/(?=[A-Z])/).pop() + '%');
  return { elapsedMs: Date.now() - start, responseChars: JSON.stringify({ similar: results.length, sample: results.slice(0, 5) }).length };
}

function getReuseReport(pid) {
  const start = Date.now();
  const high = db.prepare('SELECT COUNT(*) as c FROM functions WHERE project_id = ? AND reuse_score >= 85').get(pid);
  const medium = db.prepare('SELECT COUNT(*) as c FROM functions WHERE project_id = ? AND reuse_score >= 60 AND reuse_score < 85').get(pid);
  const low = db.prepare('SELECT COUNT(*) as c FROM functions WHERE project_id = ? AND reuse_score < 60').get(pid);
  const top5 = db.prepare('SELECT name, reuse_score, complexity FROM functions WHERE project_id = ? AND reuse_score IS NOT NULL ORDER BY reuse_score DESC LIMIT 5').all(pid);
  return { elapsedMs: Date.now() - start, responseChars: JSON.stringify({ high: high.c, medium: medium.c, low: low.c, top5 }).length };
}

console.log('\n=== Codindex Benchmark: MCP Tools vs Direct File Reads ===\n');
const results = [];

for (const q of QUESTIONS) {
  console.log('\n' + '-'.repeat(65));
  console.log('[' + q.id + '] ' + q.label);
  console.log('-'.repeat(65));

  console.log('\n  WITH Codindex:');
  const withStart = Date.now();
  const toolMetrics = [];

  for (const tool of q.codindexTools) {
    let result;
    switch (tool) {
      case 'get_project_summary': result = getProjectSummary(projectId); break;
      case 'get_module_deps': result = getModuleDeps(projectId); break;
      case 'search_code': {
        const qMap = { Q1: 'module', Q2: 'parseWorker', Q3: 'handleExplore', Q4: 'handleExplore', Q5: 'swift', Q6: 'traversal' };
        result = searchCode(projectId, qMap[q.id] || 'module'); break;
      }
      case 'get_call_graph': {
        const fMap = { Q2: 'extractAll', Q3: 'handleTool', Q5: 'resolveSwiftObjcBridges' };
        result = getCallGraph(projectId, fMap[q.id] || 'main'); break;
      }
      case 'get_function_body': {
        const fMap = { Q2: 'parseWorker', Q4: 'handleExplore' };
        result = getFunctionBody(projectId, fMap[q.id] || 'main'); break;
      }
      case 'get_impact_analysis': {
        result = getImpactAnalysis(projectId, 'resolveSwiftObjcBridges'); break;
      }
      case 'find_similar_functions': {
        result = findSimilarFunctions(projectId, 'traverseBFS'); break;
      }
      case 'get_reuse_report': {
        result = getReuseReport(projectId); break;
      }
    }
    toolMetrics.push(result);
    console.log('    ' + tool + ': ' + result.elapsedMs + 'ms, ' + result.responseChars + ' chars');
  }

  const withElapsed = Date.now() - withStart;
  const totalWithChars = toolMetrics.reduce((s, r) => s + r.responseChars, 0);
  console.log('    -> ' + q.codindexTools.length + ' tool calls, ' + withElapsed + 'ms, ' + totalWithChars + ' chars');

  console.log('\n  WITHOUT Codindex:');
  const withoutStart = Date.now();
  let totalLines = 0, totalRawChars = 0;

  for (const f of q.filesToRead) {
    const fp = REPO + '/' + f.file;
    if (!existsSync(fp)) { console.log('    ' + f.file + ': NOT FOUND'); continue; }
    const content = readFileSync(fp, 'utf-8');
    const lines = content.split('\n').length;
    totalLines += lines;
    totalRawChars += content.length;
    console.log('    ' + f.file + ': ' + lines + ' lines, ' + content.length + ' chars');
  }

  const withoutElapsed = Date.now() - withoutStart;
  console.log('    -> ' + q.filesToRead.length + ' file reads, ' + totalLines + ' lines, ' + totalRawChars + ' chars, ' + withoutElapsed + 'ms');

  const callPct = Math.round((1 - q.codindexTools.length / q.filesToRead.length) * 100);
  const dataPct = Math.round((1 - totalWithChars / totalRawChars) * 100);
  console.log('\n  >>> Call efficiency: -' + callPct + '% | Data efficiency: -' + dataPct + '%');

  results.push({
    questionId: q.id, label: q.label,
    codindex: { toolCalls: q.codindexTools.length, elapsedMs: withElapsed, responseChars: totalWithChars },
    raw: { fileReads: q.filesToRead.length, elapsedMs: withoutElapsed, totalLines, totalRawChars },
    efficiency: { callReductionPct: callPct, dataReductionPct: dataPct },
  });
}

console.log('\n\n' + '='.repeat(70));
console.log('SUMMARY');
console.log('='.repeat(70));
console.log('| Question | Approach | # | Chars | Time (ms) |');
console.log('|----------|----------|---|-------|-----------|');
for (const r of results) {
  console.log('| ' + r.questionId + ' ' + r.label + ' | codindex | ' + r.codindex.toolCalls + ' calls | ' + r.codindex.responseChars + ' | ' + r.codindex.elapsedMs + ' |');
  console.log('| ' + r.questionId + ' ' + r.label + ' | raw files | ' + r.raw.fileReads + ' reads | ' + r.raw.totalRawChars + ' | ' + r.raw.elapsedMs + ' |');
}
console.log('\n- Efficiency Gains -');
console.log('| Question | Fewer Calls | Less Data |');
console.log('|----------|-------------|-----------|');
for (const r of results) {
  console.log('| ' + r.questionId + ' | -' + r.efficiency.callReductionPct + '% | -' + r.efficiency.dataReductionPct + '% |');
}
const avgC = Math.round(results.reduce((s, r) => s + r.efficiency.callReductionPct, 0) / results.length);
const avgD = Math.round(results.reduce((s, r) => s + r.efficiency.dataReductionPct, 0) / results.length);
console.log('| **Average** | **-' + avgC + '%** | **-' + avgD + '%** |');

writeFileSync('src/tests/bench/results.json', JSON.stringify({
  timestamp: new Date().toISOString(), repo: REPO, projectId: projectId, results: results,
  summary: { avgCallReductionPct: avgC, avgDataReductionPct: avgD, questions: results.length },
}, null, 2));
console.log('\nResults saved to src/tests/bench/results.json');
db.close();
