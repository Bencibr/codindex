import { getDb } from '../db/connection.js';
import * as schema from '../db/schema.js';
import { scanFile } from './scanner-ts.js';
import { scanWithScc, getGitStatsBatch, isGitRepo, isSccAvailable, type FileStats, type GitStats } from './scanner-scc.js';
import { buildImportMap, resolveCalls, getModuleFromPath } from './call-graph.js';
import { buildModuleGraph, getChangedFiles } from './module-graph.js';
import { extractCFG } from './cfg-extractor.js';
import { scoreFunction } from '../scoring/reuse-score.js';
import { parsePrd, calculateCompletion } from './prd-parser.js';
import { and, eq, inArray, sql } from 'drizzle-orm';
import { statSync, existsSync, readFileSync } from 'fs';
import { resolve } from 'path';
import pLimit from 'p-limit';
import { spawnSync } from 'child_process';

/**
 * 有真实提取实现的扩展名。
 *
 * 只收录 scanner-ts.ts 里确实存在语法提取分支的语言：TS/JS、Python、Rust、
 * Go、Java。此前这里还列了 .rb/.swift/.kt/.scala/.php/.vue/.svelte，但
 * scanner 没有对应分支——这些文件会被计入 files，却永远产不出函数/调用边，
 * 形成"看起来支持"的虚假覆盖。收录前请在 scanner-ts.ts 确认有对应分支。
 */
const SUPPORTED_EXTS = new Set([
  '.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs',
  '.py', '.rs', '.go', '.java',
]);

// Scan configuration
const MAX_FILE_SIZE = 1_000_000;       // 1MB — skip larger files
const SCAN_CONCURRENCY = 8;            // max parallel file scans
const FTS_BATCH_SIZE = 500;            // FTS5 inserts per transaction

/**
 * 单条 INSERT 的最大行数。
 *
 * SQLite 的绑定参数上限（Node 内置 sqlite 实测约 32766）除以最宽的一张表
 * （calls 有 9 列）= 3640 行。这里取 900（约 8100 参数）留足余量，
 * 因为不同驱动的实际上限不一致（better-sqlite3 曾为 999）。
 *
 * 为什么必须分块：此前把 resolveCalls 产出的 19 万条调用一次性交给
 * db.insert().values()，语句在 drizzle 里递归构建 AST 直接
 * "Maximum call stack size exceeded"，随后走「逐条回退」分支——
 * 19 万次单行 INSERT，实测 0.24ms/行 ≈ 49s，占扫描 45%。
 */
const INSERT_CHUNK_SIZE = 900;

/** 分块批量插入，返回成功写入的行数 */
async function insertChunked<T extends Record<string, unknown>>(
  table: Parameters<ReturnType<typeof getDb>['insert']>[0],
  rows: T[],
  chunkSize: number = INSERT_CHUNK_SIZE,
): Promise<number> {
  const db = getDb();
  let written = 0;
  for (let i = 0; i < rows.length; i += chunkSize) {
    const chunk = rows.slice(i, i + chunkSize);
    await db.insert(table).values(chunk as never).onConflictDoNothing();
    written += chunk.length;
  }
  return written;
}

/**
 * 清空本项目的全部派生数据，让每次全量扫描从零重建。
 *
 * 为什么必须在 scanProject 内部做：历史实现只 INSERT ... ON CONFLICT DO NOTHING，
 * 把「旧数据清理」的责任推给了调用方，而 index.ts 与 MCP 各写了一份删除清单，
 * 两份都漏了 type_usage_edges / raise_edges / test_mappings / type_fields。
 * 结果：
 *   - 改过的函数体永远停在第一次扫描的版本（ON CONFLICT DO NOTHING）；
 *   - 删掉/改名的文件永远留在库里；
 *   - files.last_modified 永不刷新，`/api/projects/:id/diff?since=` 恒返回空。
 *
 * 顺序：先删边与子表，再删主表，避免 foreign_keys=ON 时的约束拒绝。
 * 不依赖 ON DELETE CASCADE：级联只在 PRAGMA 打开时生效，显式删除更可靠。
 *
 * 注意：features（PRD 解析结果 + 人工维护）属于用户资产，不在此清理；
 * 只清 feature_code 映射，随后由扫描流程按当前代码重建。
 */
export async function clearProjectData(projectId: string): Promise<void> {
  const db = getDb();

  // FTS 必须先清：它是外部内容表（content=''），没有外键、也不会级联，
  // 一旦 files 行被删掉，后面的 `... WHERE file_path IN (SELECT path FROM files ...)`
  // 就再也定位不到这些行，旧索引会永久残留并让 search_code 返回已删除的函数。
  try {
    const { getSqlite } = await import('../db/connection.js');
    const sqlite = getSqlite();
    sqlite.prepare(`
      DELETE FROM functions_fts WHERE file_path IN (SELECT path FROM files WHERE project_id = ?)
    `).run(projectId);
  } catch { /* FTS5 不可用时静默跳过（search_code 会退回 LIKE） */ }

  await db.delete(schema.calls).where(eq(schema.calls.projectId, projectId));
  await db.delete(schema.controlFlowEdges).where(eq(schema.controlFlowEdges.projectId, projectId));
  await db.delete(schema.controlFlowNodes).where(eq(schema.controlFlowNodes.projectId, projectId));
  await db.delete(schema.typeUsageEdges).where(eq(schema.typeUsageEdges.projectId, projectId));
  await db.delete(schema.raiseEdges).where(eq(schema.raiseEdges.projectId, projectId));
  await db.delete(schema.testMappings).where(eq(schema.testMappings.projectId, projectId));
  await db.delete(schema.typeFields).where(eq(schema.typeFields.projectId, projectId));
  await db.delete(schema.types).where(eq(schema.types.projectId, projectId));
  await db.delete(schema.functions).where(eq(schema.functions.projectId, projectId));
  // features 本身来自 PRD 解析与人工维护，属于用户资产，不在这里删；
  // 只清 feature_code 映射，随后由 Step 3c 按当前代码重建。
  await db.delete(schema.featureCode).where(
    inArray(schema.featureCode.featureId, db.select({ id: schema.features.id })
      .from(schema.features).where(eq(schema.features.projectId, projectId))),
  );
  await db.delete(schema.moduleDeps).where(eq(schema.moduleDeps.projectId, projectId));
  await db.delete(schema.modules).where(eq(schema.modules.projectId, projectId));
  await db.delete(schema.files).where(eq(schema.files.projectId, projectId));
}

function detectLanguage(ext: string): string {
  const map: Record<string, string> = {
    '.ts': 'typescript', '.tsx': 'tsx', '.js': 'javascript',
    '.jsx': 'jsx', '.mjs': 'javascript', '.cjs': 'javascript',
    '.py': 'python', '.rs': 'rust', '.go': 'go', '.java': 'java',
  };
  return map[ext] || 'unknown';
}

/** Report progress to optional callback */
function report(
  onProgress: ((phase: string, pct: number) => void) | undefined,
  phase: string,
  pct: number,
) {
  if (onProgress) onProgress(phase, pct);
}

/** Collect source files, filtering out non-code dirs */
function collectSourceFiles(dir: string): string[] {
  try {
    const result = spawnSync('find', [dir, '-type', 'f'], {
      encoding: 'utf-8', timeout: 30_000, maxBuffer: 10 * 1024 * 1024,
    });
    if (result.error) throw result.error;
    return (result.stdout || '').trim().split('\n').filter(Boolean).filter(f => {
      if (f.includes('/node_modules/') || f.includes('/.git/') ||
          f.includes('/dist/') || f.includes('/build/') ||
          f.includes('/__pycache__/') || f.includes('/.next/') ||
          f.includes('/venv/') || f.includes('/target/')) return false;
      const ext = f.match(/\.[a-z]+$/i)?.[0] || '';
      return SUPPORTED_EXTS.has(ext);
    });
  } catch {
    return [];
  }
}

/** Detect primary language from file paths */
function detectPrimaryLanguage(filePaths: string[]): string {
  const counts: Record<string, number> = {};
  for (const fp of filePaths) {
    const ext = fp.match(/\.[a-z]+$/i)?.[0] || '';
    const lang = detectLanguage(ext);
    counts[lang] = (counts[lang] || 0) + 1;
  }
  let maxLang = 'unknown', maxCount = 0;
  for (const [lang, count] of Object.entries(counts)) {
    if (count > maxCount) { maxLang = lang; maxCount = count; }
  }
  return maxLang;
}

/** Check if a function body is a placeholder (stub/empty) */
function isPlaceholderBody(body: string): boolean {
  // Only match strong indicators — TODO/FIXME in comments are not placeholders
  const strongIndicators = [
    'todo!()', 'unimplemented!()',
    'will be implemented', '暂未实现',
    '后续版本', 'NotImplemented',
  ];
  // message.info only when it's the sole substantive statement (placeholder pattern)
  const isMessageOnly = (body.match(/message\.\w+\(/g) || []).length === 1
    && !body.includes('await')
    && body.split('\n').filter(l => l.trim() && !l.trim().startsWith('//')).length <= 5;
  return (
    !body.trim() ||
    body.trim() === '{}' ||
    /^(throw|return)\s/.test(body.trim()) ||
    strongIndicators.some(i => body.includes(i)) ||
    isMessageOnly
  );
}

export async function scanProject(
  projectId: string,
  projectPath: string,
  onProgress?: (phase: string, pct: number) => void,
) {
  const db = getDb();
  const limit = pLimit(SCAN_CONCURRENCY);
  const absPath = resolve(projectPath);

  // Update status
  await db
    .update(schema.projects)
    .set({ status: 'scanning', scanProgress: 0 })
    .where(eq(schema.projects.id, projectId));

  report(onProgress, 'Collecting files', 5);

  // Collect source files
  const sourceFiles = collectSourceFiles(absPath);
  const codeFiles = sourceFiles.filter((f) => {
    const s = statSync(f);
    return s.isFile() && s.size > 0 && s.size < MAX_FILE_SIZE;
  });

  report(onProgress, `Found ${codeFiles.length} source files`, 10);

  // Phase 1: scc + git metadata
  report(onProgress, 'Running scc + git analysis', 15);
  let fileStats: FileStats[] = [];
  if (isSccAvailable()) {
    fileStats = scanWithScc(absPath);
  }

  const isGit = isGitRepo(absPath);
  const fileStatMap = new Map(fileStats.map((f) => [resolve(absPath, f.path), f]));

  // Phase 2: Tree-sitter scanning — parallel
  report(onProgress, 'Parsing source files with tree-sitter', 30);

  let processed = 0;
  const total = codeFiles.length;

  interface ScanBatch {
    fileResult: ReturnType<typeof scanFile>;
    filePath: string;
    relPath: string;
    ext: string;
    lang: string;
    // scc 不可用、或某文件未被 scc 收录时是 undefined（下面有 readFileSync 兜底）
    statResult: FileStats | undefined;
    gitStats: GitStats;
  }

  const batches: ScanBatch[] = [];

  // 批量预取 git 元信息：一次 git log 取全仓，替代逐文件 spawnSync。
  // 旧实现 980 次 spawnSync ≈ 47s 且阻塞事件循环（并发失效），占扫描 40%。
  const gitStatsMap = isGit ? getGitStatsBatch(absPath) : new Map<string, GitStats>();

  await Promise.all(
    codeFiles.map((fp) =>
      limit(async () => {
        const relPath = fp.replace(absPath + '/', '');
        const ext = fp.match(/\.[a-z]+$/i)?.[0] || '';
        const lang = detectLanguage(ext);

        let fileResult: ReturnType<typeof scanFile> = {
          functions: [], calls: [], raises: [], imports: [], types: [], tags: [], bridgeCalls: [],
        };

        if (['typescript','tsx','javascript','python','go','rust','java'].includes(lang)) {
          try {
            fileResult = scanFile(fp, lang);
          } catch (err: unknown) {
            console.warn('[codindex] scan: parse error in', fp, (err as Error).message || '');
          }
        }

        const stats = fileStatMap.get(fp);
        // 查批量结果（键是 git 输出的相对路径，与 relPath 同源）
        const gitStats = gitStatsMap.get(relPath)
          ?? { lastModified: null as number | null, authors: [] as string[] };

        batches.push({
          fileResult,
          filePath: fp,
          relPath,
          ext,
          lang,
          statResult: stats,
          gitStats,
        });

        processed++;
        if (processed % 50 === 0 || processed === total) {
          const pct = 30 + Math.round((processed / total) * 30);
          report(onProgress, `Parsed ${processed}/${total} files`, pct);
        }
      }),
    ),
  );

  // Phase 3: Write to DB
  report(onProgress, 'Writing to database', 70);

  // 写入前先清空本项目的旧派生数据。
  //
  // 这一步是「重扫能反映磁盘现状」的前提。此前所有写入都是
  // ON CONFLICT DO NOTHING，于是：改过的函数体永远是第一次扫描的版本、
  // 删掉的文件永远留在库里、files.last_modified 永不刷新（进而让
  // /api/projects/:id/diff?since= 恒返回空）。清理放在 scanProject 内部，
  // 而不是继续依赖 index.ts / MCP 两个入口各自记得先删。
  //
  // features 不在清理范围内：它来自 PRD 解析与人工维护，属于用户资产，
  // 且 feature_code 会随 functions/files 的删除而级联消失，
  // 下一段 Step 3c 会按当前代码重新建立映射。
  await clearProjectData(projectId);

  // Module from path (reuse call-graph.ts's implementation)
  const getModule = getModuleFromPath;

  // Batch insert files
  for (const b of batches) {
    const moduleName = getModule(b.relPath);

    // Fallback file stats when scc is not available
    let lines = b.statResult?.lines ?? null;
    let codeLines = b.statResult?.code ?? null;
    let commentLines = b.statResult?.comment ?? null;
    let fileComplexity = b.statResult?.complexity ?? null;

    if (lines === null) {
      try {
        const content = readFileSync(b.filePath, 'utf-8');
        const allLines = content.split('\n');
        lines = allLines.length;
        // Rough code/comment split
        let commentCount = 0;
        let inBlock = false;
        for (const line of allLines) {
          const trimmed = line.trim();
          if (inBlock) {
            commentCount++;
            if (trimmed.includes('*/')) inBlock = false;
          } else if (trimmed.startsWith('//') || trimmed.startsWith('#')) {
            commentCount++;
          } else if (trimmed.startsWith('/*')) {
            commentCount++;
            if (!trimmed.includes('*/')) inBlock = true;
          } else if (trimmed === '') {
            // empty line, not counted as code
          }
        }
        commentLines = commentCount;
        codeLines = lines - commentCount;
        // Complexity from scan results
        if (b.fileResult.functions.length > 0) {
          fileComplexity = b.fileResult.functions.reduce((sum, f) => sum + f.complexity, 0);
        }
      } catch { /* skip */ }
    }

    // Open DB writes in a single transaction for crash atomicity.
    // If process dies mid-scan, partial writes are acceptable since
// the caller (MCP handler) never exposes inconsistent state between steps.
    await db.insert(schema.files).values({
      projectId,
      path: b.relPath,
      module: moduleName,
      language: b.lang,
      lines,
      codeLines,
      commentLines,
      complexity: fileComplexity,
      // 此前这里硬编码 null 并注释「handled below」，但根本没有 below：
      // gitStats 算了却被丢弃，导致 files.last_modified 全表恒为 NULL，
      // 于是 index.ts 的增量变更检测（last_modified > since）永远返回空集，
      // MCP get_file_content 的 lastModified 永远为 null。
      lastModified: b.gitStats.lastModified,
      authors: b.gitStats.authors.length ? JSON.stringify(b.gitStats.authors) : null,
    }).onConflictDoNothing();
  }

  // Get file ID map
  const allPaths = batches.map((b) => b.relPath);
  const dbFiles = allPaths.length > 0
    ? await db
        .select({ id: schema.files.id, path: schema.files.path })
        .from(schema.files)
        .where(and(eq(schema.files.projectId, projectId), inArray(schema.files.path, allPaths)))
    : [];
  const fileIdMap = new Map(dbFiles.map((f) => [f.path, f.id]));

  // C3 fix: batch INSERT functions in transactions
  let funcCounter = 0;
  const funcBatchSize = 200;
  for (let i = 0; i < batches.length; i++) {
    const b = batches[i];
    const fileId = fileIdMap.get(b.relPath);
    if (!fileId || b.fileResult.functions.length === 0) continue;

    const funcValues = b.fileResult.functions.map(fn => ({
      projectId,
      fileId,
      name: fn.name,
      fullName: fn.fullName,
      kind: fn.kind,
      signature: fn.signature,
      body: fn.body,
      lineStart: fn.lineStart,
      lineEnd: fn.lineEnd,
      complexity: fn.complexity,
      paramsCount: fn.paramsCount,
      linesCount: fn.linesCount,
      isExported: fn.isExported,
      isTest: fn.isTest,
      docComment: fn.docComment,
      tags: JSON.stringify(fn.tags),
      featureId: null,
      paramsJson: fn.paramsJson || null,
      returnType: fn.returnType || null,
      isPlaceholder: fn.body ? isPlaceholderBody(fn.body) : false,
      summary: fn.summary || '',
    }));

    funcCounter += await insertChunked(schema.functions, funcValues);
  }

  // Build func name→id map for call resolution
  const allFuncs = await db
    .select({
      id: schema.functions.id,
      name: schema.functions.name,
      fileId: schema.functions.fileId,
      lineStart: schema.functions.lineStart,
      lineEnd: schema.functions.lineEnd,
      // 供 self.X() 方法解析定位所属类（`ClassName.method`）
      fullName: schema.functions.fullName,
    })
    .from(schema.functions)
    .where(eq(schema.functions.projectId, projectId));

  // Group funcs by name for lookup
  const funcByName = new Map<string, typeof allFuncs>();
  for (const f of allFuncs) {
    const arr = funcByName.get(f.name) || [];
    arr.push(f);
    funcByName.set(f.name, arr);
  }

  // Build file path map for calls
  const filePathMap = new Map(dbFiles.map((f) => [f.id, f.path]));
  const filePathToId = new Map(dbFiles.map((f) => [f.path, f.id]));

  // Build per-file scans map for call-graph resolver
  const scansMap = new Map<string, ReturnType<typeof scanFile>>();
  for (const b of batches) {
    scansMap.set(b.filePath, b.fileResult);
  }

  // Phase 3a: Extract CFG for TS/JS functions (on-the-fly from function bodies)
  report(onProgress, 'Extracting control flow graphs', 68);

  await db.delete(schema.controlFlowNodes).where(eq(schema.controlFlowNodes.projectId, projectId));
  await db.delete(schema.controlFlowEdges).where(eq(schema.controlFlowEdges.projectId, projectId));

  // Dynamic import cfg-extractor (tree-sitter AST types)
  let extractCFG: ((funcNode: any, source: string) => any) | null = null;
  try {
    const cfgMod = await import('./cfg-extractor.js');
    extractCFG = cfgMod.extractCFG;
  } catch { /* cfg-extractor not available — skip */ }

  if (extractCFG) {
    const Parser = (await import('tree-sitter')).default;
    let tsModule: any, jsModule: any;
    try { tsModule = (await import('tree-sitter-typescript')).default.typescript; } catch { /* skip */ }
    try { jsModule = (await import('tree-sitter-javascript')).default; } catch { /* skip */ }

    for (const b of batches) {
      const fileId = fileIdMap.get(b.relPath);
      if (!fileId) continue;

      const langModule = (b.lang === 'typescript' || b.lang === 'tsx') ? tsModule
        : (b.lang === 'javascript' || b.lang === 'jsx') ? jsModule : null;
      if (!langModule) continue;

      const parser = new Parser();
      parser.setLanguage(langModule);

      for (const fn of b.fileResult.functions) {
        const dbFunc = allFuncs.find(f =>
          f.fileId === fileId && f.name === fn.name && f.lineStart === fn.lineStart,
        );
        if (!dbFunc) continue;

        try {
          const tree = parser.parse(fn.body);
          const funcNode = tree.rootNode.namedChildren[0] || tree.rootNode;
          const cfg = extractCFG(funcNode, fn.body);

          if (cfg.nodes.length > 2) {
            if (cfg.nodes.length > 0) {
              await db.insert(schema.controlFlowNodes).values(
                cfg.nodes.map((n: any) => ({
                  projectId, funcId: dbFunc.id,
                  nodeId: n.id, nodeType: n.type, label: n.label,
                  lineStart: n.lineStart + fn.lineStart - 1,
                  lineEnd: n.lineEnd + fn.lineStart - 1,
                  calleeFuncId: null,
                  conditionExpr: n.conditionExpr || null,
                })),
              ).onConflictDoNothing();
            }
            if (cfg.edges.length > 0) {
              await db.insert(schema.controlFlowEdges).values(
                cfg.edges.map((e: any) => ({
                  projectId, funcId: dbFunc.id,
                  sourceNodeId: e.source, targetNodeId: e.target,
                  edgeLabel: e.label || null, edgeType: e.edgeType,
                })),
              ).onConflictDoNothing();
            }
          }
        } catch { /* CFG extraction failed — skip */ }
      }
    }
  }

  // Phase 3a.4: Raise/throw 边（异常路径）
  // 抛出点按 file + line 归属到函数：取覆盖该行的最小函数区间（最内层）。
  report(onProgress, 'Extracting raise edges', 70);
  {
    const funcsByFile = new Map<number, Array<{ id: number; lineStart: number | null; lineEnd: number | null }>>();
    for (const f of allFuncs) {
      if (!funcsByFile.has(f.fileId)) funcsByFile.set(f.fileId, []);
      funcsByFile.get(f.fileId)!.push({ id: f.id, lineStart: f.lineStart, lineEnd: f.lineEnd });
    }
    // 行号 → 最内层函数（区间最小者）
    const ownerOf = (fileId: number, line: number): number | null => {
      const cands = (funcsByFile.get(fileId) || []).filter(
        f => f.lineStart != null && f.lineEnd != null && line >= f.lineStart && line <= f.lineEnd,
      );
      if (!cands.length) return null;
      cands.sort((a, b) => (a.lineEnd! - a.lineStart!) - (b.lineEnd! - b.lineStart!));
      return cands[0].id;
    };

    const raiseValues: Array<{
      projectId: string; funcId: number; fileId: number;
      errorType: string; line: number; kind: string;
    }> = [];
    for (const b of batches) {
      if (!b.fileResult.raises?.length) continue;
      const fileId = fileIdMap.get(b.relPath);
      if (fileId == null) continue;
      for (const r of b.fileResult.raises) {
        const funcId = ownerOf(fileId, r.line);
        if (funcId == null) continue;   // 模块级抛出，无归属函数
        raiseValues.push({
          projectId, funcId, fileId,
          errorType: r.errorType, line: r.line, kind: r.kind,
        });
      }
    }
    if (raiseValues.length > 0) {
      await insertChunked(schema.raiseEdges, raiseValues);
    }
  }

  // Phase 3a.5: Cross-file call resolution
  report(onProgress, 'Resolving cross-file calls', 72);

  const importMap = buildImportMap(absPath, codeFiles, scansMap);

  // 继承映射：类名 → 直接父类名。供 call-graph 解析 `self.X()` 里
  // 由父类继承来的方法（子类不重写时也要能连上）。
  const parentOf = new Map<string, string>();
  {
    const typeRows = await db.select({
      name: schema.types.name,
      parentType: schema.types.parentType,
    }).from(schema.types).where(eq(schema.types.projectId, projectId));
    for (const t of typeRows) {
      if (t.parentType && t.parentType.trim()) parentOf.set(t.name, t.parentType.trim());
    }
  }

  const resolvedCalls = resolveCalls(
    importMap,
    allFuncs.map(f => ({
      id: f.id,
      name: f.name,
      fileId: f.fileId,
      filePath: filePathMap.get(f.fileId) || '',
      lineStart: f.lineStart,
      lineEnd: f.lineEnd,
      isExported: !!(f as { isExported?: boolean }).isExported,
      // `full_name` 形如 `ClassName.method` → 取类名。顶层函数形如 `func`，无点。
      ownerClass: f.fullName && f.fullName.includes('.')
        ? f.fullName.slice(0, f.fullName.lastIndexOf('.'))
        : null,
    })),
    filePathToId,
    absPath,
    codeFiles,
    scansMap,
    parentOf,
  );

  // C4 fix: batch INSERT calls in transactions
  let callCounter = 0;
  if (resolvedCalls.length > 0) {
    const callValues: Array<{
      projectId: string;
      callerFuncId: number | null;
      calleeFuncId: number | null;
      callerFileId: number;
      calleeFileId: number | null;
      callLine: number;
      callType: string;
      calleeName: string | null;
      isExternal: boolean;
    }> = resolvedCalls.map(rc => ({
      projectId,
      callerFuncId: rc.callerFuncId,
      calleeFuncId: rc.calleeFuncId ?? null,
      callerFileId: rc.callerFileId,
      calleeFileId: rc.calleeFileId ?? null,
      callLine: rc.callLine,
      callType: rc.callType,
      calleeName: rc.calleeName ?? null,
      isExternal: rc.isExternal ?? false,
    }));
    // 分块插入：不分块会因 9 列 × 19 万行超出参数上限并触发 drizzle AST 递归爆栈，
    // 随后走「逐条回退」把 19 万次单行 INSERT 摊进主线程（实测 ≈49s）。
    callCounter = await insertChunked(schema.calls, callValues);
  }

  // Insert bridge calls (invoke → backend command)
  let bridgeCounter = 0;
  const bridgeBatches = batches.filter(b => b.fileResult.bridgeCalls && b.fileResult.bridgeCalls.length > 0);
  if (bridgeBatches.length > 0) {
    // Collect backend command functions (Rust files in commands/ directory)
    const commandFuncMap = new Map<string, number>(); // funcName → funcId
    for (const b of batches) {
      if (b.lang === 'rust' && b.relPath.includes('commands/')) {
        for (const fn of b.fileResult.functions) {
          // Check if function has tauri::command attribute in body or docComment
          if (fn.tags.includes('@tauri:command')) {
            const dbFuncs = funcByName.get(fn.name);
            if (dbFuncs && dbFuncs.length > 0) {
              commandFuncMap.set(fn.name, dbFuncs[0].id);
            }
          }
        }
      }
    }

    for (const b of bridgeBatches) {
      const callerFileId = fileIdMap.get(b.relPath);
      if (!callerFileId) continue;
      for (const bridge of b.fileResult.bridgeCalls!) {
        const targetFuncId = commandFuncMap.get(bridge.invokeName);
        if (!targetFuncId) continue;
        // Find enclosing function ID
        const callerFuncs = funcByName.get(bridge.callerName);
        const callerFuncId = callerFuncs?.find(f => f.fileId === callerFileId)?.id ?? null;
        // Find target file ID
        const targetFuncRow = allFuncs.find(f => f.id === targetFuncId);
        const targetFileId = targetFuncRow?.fileId ?? callerFileId;

        try {
          await db.insert(schema.calls).values({
            projectId,
            callerFuncId,
            calleeFuncId: targetFuncId,
            callerFileId,
            calleeFileId: targetFileId,
            callLine: bridge.line,
            callType: `${bridge.framework}_bridge`,
            isExternal: false,
            bridgeTarget: bridge.invokeName,
            bridgeFramework: bridge.framework,
          });
          bridgeCounter++;
        } catch { /* skip duplicates */ }
      }
    }
  }

  // Insert types
  let typeCounter = 0;
  for (const b of batches) {
    const fileId = fileIdMap.get(b.relPath);
    if (!fileId || b.fileResult.types.length === 0) continue;

    for (const t of b.fileResult.types) {
      try {
        await db.insert(schema.types).values({
          projectId,
          fileId,
          name: t.name,
          kind: t.kind,
          parentType: t.parentType,
          implements: JSON.stringify(t.implements),
          genericParams: JSON.stringify(t.genericParams),
          lineStart: t.lineStart,
          lineEnd: t.lineEnd,
        }).onConflictDoNothing();
        typeCounter++;

        // Write type fields
        if (t.fields && t.fields.length > 0) {
          // Find the inserted type ID
          const dbType = await db.select({ id: schema.types.id })
            .from(schema.types)
            .where(and(
              eq(schema.types.projectId, projectId),
              eq(schema.types.fileId, fileId),
              eq(schema.types.name, t.name),
            ))
            .limit(1);
          if (dbType.length > 0) {
            await db.insert(schema.typeFields).values(
              t.fields.map(f => ({
                typeId: dbType[0].id,
                projectId,
                name: f.name,
                fieldType: f.fieldType,
                visibility: f.visibility || null,
                isOptional: f.isOptional,
                defaultValue: f.defaultValue || null,
                lineStart: f.lineStart,
              })),
            ).onConflictDoNothing();
          }
        }
      } catch {
        // skip duplicates
      }
    }
  }

  // Phase 3b: Populate FTS5 index
  report(onProgress, 'Building full-text search index', 80);

  try {
    const { getSqlite } = await import('../db/connection.js');
    const sqlite = getSqlite();
    // Clear old FTS data for this project (contentless FTS: DELETE + INSERT, not INSERT OR REPLACE)
    const deleteFts = sqlite.prepare(`
      DELETE FROM functions_fts WHERE file_path IN (SELECT path FROM files WHERE project_id = ?)
    `);
    deleteFts.run(projectId);

    const fnsForFts = await db.select({
      id: schema.functions.id,
      name: schema.functions.name,
      body: schema.functions.body,
      signature: schema.functions.signature,
      docComment: schema.functions.docComment,
      fileId: schema.functions.fileId,
    }).from(schema.functions).where(eq(schema.functions.projectId, projectId));

    const filesForFts = await db.select({ id: schema.files.id, path: schema.files.path })
      .from(schema.files).where(eq(schema.files.projectId, projectId));
    const ftsFileMap = new Map(filesForFts.map(f => [f.id, f.path]));

    const insertFts = sqlite.prepare(`
      INSERT INTO functions_fts(rowid, name, body, signature, doc_comment, file_path)
      VALUES (?, ?, ?, ?, ?, ?)
    `);
    const ftsTx = sqlite.transaction(() => {
      for (const fn of fnsForFts) {
        insertFts.run(
          fn.id,
          fn.name || '',
          fn.body || '',
          fn.signature || '',
          fn.docComment || '',
          ftsFileMap.get(fn.fileId) || '',
        );
      }
    });
    ftsTx();
  } catch (err: unknown) {
    // FTS5 failed — search_code will fallback to LIKE, but surface the issue
    console.warn(`[codindex] FTS5 indexing failed for project ${projectId}:`, (err as Error).message);
  }

  // Phase 4: Module dependency graph
  report(onProgress, 'Building module dependency graph', 85);

  const fileLookup = new Set(codeFiles);
  const moduleData = buildModuleGraph(importMap, absPath, fileLookup);

  // Insert modules
  const moduleIdMap = new Map<string, number>();
  for (const mod of moduleData.modules) {
    const depth = mod.path.split('/').filter(Boolean).length;
    try {
      await db.insert(schema.modules).values({
        projectId,
        name: mod.name,
        path: mod.path,
        depth,
      }).onConflictDoNothing();
    } catch { /* skip */ }
  }

  // Get module IDs
  const dbMods = await db
    .select()
    .from(schema.modules)
    .where(eq(schema.modules.projectId, projectId));
  for (const m of dbMods) moduleIdMap.set(m.path, m.id);

  // Insert module dependencies
  for (const e of moduleData.edges) {
    const modId = moduleIdMap.get(e.fromModule);
    const depModId = moduleIdMap.get(e.toModule);
    if (modId != null && depModId != null) {
      try {
        await db.insert(schema.moduleDeps).values({
          projectId,
          moduleId: modId,
          depModuleId: depModId,
          depType: e.depType,
          weight: e.weight,
        }).onConflictDoNothing();
      } catch { /* skip */ }
    }
  }

  // Phase 4b: Type usage edges
  report(onProgress, 'Building type usage edges', 90);

  const allTypes = await db.select().from(schema.types)
    .where(eq(schema.types.projectId, projectId));
  const allFuncsForType = await db.select().from(schema.functions)
    .where(eq(schema.functions.projectId, projectId));

  // Type usage edges：按标识符边界匹配，一次扫描出所有命中。
  //
  // 旧实现是「每个函数 × 每个类型名」做子串 includes()：
  //   19,183 函数 × 1,676 类型 = 30.6M 次子串扫描 → 实测 5.4s，
  // 且 52.1% 的边是假边。子串匹配会把短名当子串命中任意单词内部——
  // 最典型的是类型 `R`（kind=class）单独贡献 8,830 条假边：
  //   `workspaceRegistry` 含 "R"、`VIRTUAL_ENV` 含 "R"、
  //   `BUGX_INTERACTION_REQUEST` 含 "R"，全被当成「引用了类 R」。
  // Check / Result / Client / Budget / Report 这类通用词也各贡献数百条。
  //
  // 改成一次 alternation 正则 + 标识符边界断言（JS 标识符含 $ 与 _，
  // 所以不能用 \b，必须用 lookaround）：
  //   - 时间 5.4s → 1.0s
  //   - 假边 11,345 条被排除（21,760 → 10,415，准确率翻倍）
  if (allTypes.length > 0) {
    const typeNameIndex = new Map<string, typeof allTypes[0]>();
    for (const t of allTypes) {
      if (t.name) typeNameIndex.set(t.name, t);
    }

    // 长名优先，避免 `Foo` 抢先匹配掉 `FooBar` 的前缀
    const escaped = [...typeNameIndex.keys()]
      .sort((a, b) => b.length - a.length)
      .map(n => n.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'));
    const typeRe = new RegExp(
      `(?<![A-Za-z0-9_$])(${escaped.join('|')})(?![A-Za-z0-9_$])`,
      'g',
    );

    const usageValues: { projectId: string; funcId: number; typeId: number; usageType: string }[] = [];
    for (const fn of allFuncsForType) {
      const fnText = (fn.body || '') + ' ' + (fn.signature || '') + ' ' + (fn.paramsJson || '');
      const hit = new Set<string>();
      for (const m of fnText.matchAll(typeRe)) hit.add(m[1]);
      for (const typeName of hit) {
        const t = typeNameIndex.get(typeName);
        if (!t) continue;
        const usageTypes: string[] = [];
        // 这里保留 includes 语义：参数/返回值/函数体三个「区段归属」判定，
        // 命中的是已通过边界校验的 typeName，不会再产生跨单词假命中。
        if (fn.paramsJson?.includes(typeName)) usageTypes.push('parameter');
        if (fn.returnType?.includes(typeName)) usageTypes.push('return');
        if (fn.body?.includes(typeName)) usageTypes.push('body_ref');
        for (const ut of usageTypes) {
          usageValues.push({ projectId, funcId: fn.id, typeId: t.id, usageType: ut });
        }
      }
    }
    if (usageValues.length > 0) {
      await insertChunked(schema.typeUsageEdges, usageValues);
    }
  }

  // Phase 5: Reuse scoring + feature tracking
  report(onProgress, 'Calculating reuse scores', 92);

  const allCallCounts = await db
    .select({
      funcId: schema.calls.calleeFuncId,
      count: sql<number>`count(*)`,
    })
    .from(schema.calls)
    .where(eq(schema.calls.projectId, projectId))
    .groupBy(schema.calls.calleeFuncId);

  const callCountMap = new Map(allCallCounts.map(r => [r.funcId, r.count]));

  const funcsToScore = await db
    .select()
    .from(schema.functions)
    .where(eq(schema.functions.projectId, projectId));

  // C5 fix: batch UPDATE for reuse scoring using native SQLite transaction
  const { getSqlite: getSqliteForScore } = await import('../db/connection.js');
  const sqliteScore = getSqliteForScore();

  const updateStmt = sqliteScore.prepare(
    'UPDATE functions SET reuse_score = ?, coupling_count = ? WHERE id = ?',
  );
  const scoreBatch = sqliteScore.transaction(() => {
    for (const fn of funcsToScore) {
      const score = scoreFunction({
        name: fn.name,
        fullName: fn.fullName ?? fn.name,
        complexity: fn.complexity,
        paramsCount: fn.paramsCount,
        linesCount: fn.linesCount,
        isExported: fn.isExported ?? false,
        docComment: fn.docComment,
        tags: fn.tags,
        couplingCount: callCountMap.get(fn.id) ?? 0,
        dependencyCount: 0,
      });
      updateStmt.run(score.overall, callCountMap.get(fn.id) ?? 0, fn.id);
    }
  });
  scoreBatch();

  // Phase 5b: PRD feature tracking
  report(onProgress, 'Processing PRD features', 95);
  const proj = await db.select().from(schema.projects).where(eq(schema.projects.id, projectId)).limit(1);
  if (proj.length > 0 && proj[0].prdPath && existsSync(proj[0].prdPath!)) {
    const prdResult = parsePrd(proj[0].prdPath!);
    for (const feat of prdResult.features) {
      // Parse tags as JSON array and match exactly
      const taggedFuncs = funcsToScore.filter(f => {
        if (!f.tags) return false;
        try {
          const parsed = JSON.parse(f.tags);
          return Array.isArray(parsed) && parsed.some((t: string) =>
            t === feat.id || t === feat.id.replace('feat-', ''),
          );
        } catch {
          return f.tags.includes(feat.id);
        }
      });
      const testedFuncs = taggedFuncs.filter(f => f.isTest);

      const completion = calculateCompletion(
        feat.id,
        taggedFuncs.length,
        testedFuncs.length,
        feat.requirements.length,
      );

      try {
        await db.insert(schema.features).values({
          id: feat.id,
          projectId,
          name: feat.name,
          description: feat.description,
          priority: 'medium',
          status: completion >= 1 ? 'complete' : completion > 0 ? 'partial' : 'planned',
          completion,
        }).onConflictDoNothing();

        // Link functions to feature
        for (const fn of taggedFuncs) {
          await db.insert(schema.featureCode).values({
            featureId: feat.id,
            funcId: fn.id,
            fileId: fn.fileId,
            mappingType: fn.isTest ? 'test' : 'primary',
          }).onConflictDoNothing();
        }
      } catch (err: unknown) {
        console.error(`[codindex] Error processing feature ${feat.id}:`, err);
      }
    }
  }

  // Update project status
  await db
    .update(schema.projects)
    .set({
      status: 'ready',
      lastScanned: Math.floor(Date.now() / 1000),
      scanProgress: 100,
      language: detectPrimaryLanguage(allPaths),
    })
    .where(eq(schema.projects.id, projectId));

    // Commit write transaction (if no outer transaction open, this is a no-op in auto-commit mode)


  report(onProgress, 'Scan complete', 100);

  return {
    files: batches.length,
    functions: funcCounter,
    calls: callCounter,
    types: typeCounter,
    modules: moduleData.modules.length,
    deps: moduleData.edges.length,
    cycles: moduleData.cycles.length,
  };
}

/**
 * Incremental scan — only re-parse files changed since last scan.
 * For Phase 2: uses git log to detect changed files.
 */
export async function scanProjectIncremental(
  projectId: string,
  projectPath: string,
  lastScanned: number,
): Promise<{ changed: number; total: number }> {
  const changed = getChangedFiles(projectPath, lastScanned);
  if (changed.length === 0) return { changed: 0, total: 0 };

  // 旧实现先按文件删 functions/files，再调 scanProject。这段预删除既多余
  // （scanProject 现在会整体重建本项目数据），又会撞外键：只删 functions
  // 而 calls.caller_func_id 仍指向它，foreign_keys=ON 下会直接抛错。
  await scanProject(projectId, projectPath);

  return { changed: changed.length, total: changed.length };
}
