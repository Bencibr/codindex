import { scanFile } from './scanner-ts.js';
import { resolve, relative, dirname, extname } from 'path';
import { existsSync, readFileSync } from 'fs';

interface ImportEntry {
  source: string;       // original import path (e.g. '../utils/helpers')
  names: string[];      // imported names (e.g. ['formatDate', 'clamp'])
  line: number;
}

interface FileImports {
  filePath: string;     // absolute
  relPath: string;
  module: string;
  imports: ImportEntry[];
  functions: { name: string; isExported: boolean; lineStart: number; lineEnd: number }[];
}

interface ResolvedCall {
  callerFuncId: number;
  calleeFuncId: number;
  callerFileId: number;
  calleeFileId: number;
  callLine: number;
  callType: string;
}

/**
 * Build the full import map for a project: for each file, what names
 * come from which other files.
 */
export function buildImportMap(
  absPath: string,
  filePaths: string[],
  scans: Map<string, ReturnType<typeof scanFile>>,
): Map<string, FileImports> {
  const map = new Map<string, FileImports>();

  for (const fp of filePaths) {
    const relPath = fp.replace(absPath + '/', '');
    const mod = getModuleFromPath(relPath);
    const result = scans.get(fp);

    const entry: FileImports = {
      filePath: fp,
      relPath,
      module: mod,
      imports: result?.imports ?? [],
      functions: (result?.functions ?? []).map(f => ({
        name: f.name,
        isExported: f.isExported,
        lineStart: f.lineStart,
        lineEnd: f.lineEnd,
      })),
    };
    map.set(fp, entry);
    map.set(relPath, entry);
  }

  return map;
}

/**
 * Resolve an import path relative to the importing file to an absolute file path.
 */
export function resolveImportPath(
  importPath: string,
  importerAbsPath: string,
  absProjectRoot: string,
  fileLookup: Set<string>,
): string | null {
  if (importPath.startsWith('.') || importPath.startsWith('/')) {
    const baseDir = dirname(importerAbsPath);
    const resolved = resolve(baseDir, importPath);

    // Try .ts, .tsx, .js, .jsx extensions
    const exts = ['.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs', ''];

    // First: try the path as-is (handles exact matches)
    if (fileLookup.has(resolved)) return resolved;

    // Strip existing extension and try alternatives
    // (TypeScript projects import './foo.js' but the real file is './foo.ts')
    const stripped = resolved.replace(/\.[a-z]+$/i, '');
    if (stripped !== resolved) {
      if (fileLookup.has(stripped)) return stripped;
      for (const e of exts) {
        if (e === '') continue;
        const candidate = stripped + e;
        if (fileLookup.has(candidate)) return candidate;
      }
    }

    for (const e of exts) {
      // Try as file
      const asFile = resolved + e;
      if (fileLookup.has(asFile)) return asFile;

      // Try as index file
      if (!e || e === '') {
        for (const ie of ['.ts', '.tsx', '.js', '.jsx']) {
          const asIndex = resolve(resolved, 'index' + ie);
          if (fileLookup.has(asIndex)) return asIndex;
        }
      }
    }
  }

  // Go module path resolution (e.g., "github.com/tunnel/tunnel/pkg/server" → "pkg/server")
  if (absProjectRoot) {
    const goModPath = resolve(absProjectRoot, 'go.mod');
    if (existsSync(goModPath)) {
      try {
        const goModContent = readFileSync(goModPath, 'utf-8');
        const moduleMatch = goModContent.match(/^module\s+(.+)$/m);
        if (moduleMatch) {
          const goModulePrefix = moduleMatch[1].trim();
          if (importPath.startsWith(goModulePrefix + '/')) {
            const localPath = importPath.slice(goModulePrefix.length + 1);
            const absLocal = resolve(absProjectRoot, localPath);
            if (fileLookup.has(absLocal)) return absLocal;
            // Try Go file extensions
            for (const e of ['.go', '.ts', '.tsx']) {
              if (fileLookup.has(absLocal + e)) return absLocal + e;
            }
            // Try as directory — find first matching file
            const prefix = absLocal + '/';
            for (const f of fileLookup) {
              if (f.startsWith(prefix) && (f.endsWith('.go') || f.endsWith('.ts'))) {
                return f;
              }
            }
          }
        }
      } catch { /* go.mod read failed */ }
    }
  }

  // For bare package imports (e.g. 'react', 'lodash'), return null
  // Phase 2 limitation: we don't resolve node_modules
  return null;
}

/**
 * For each file's calls, resolve which function is being called
 * using the import map and the project's function inventory.
 */
export function resolveCalls(
  fileImportsMap: Map<string, FileImports>,
  funcInventory: Array<{
    id: number; name: string; fileId: number; filePath: string;
    lineStart: number | null; lineEnd: number | null; isExported?: boolean;
    /** 类归属：`full_name` 形如 `ClassName.method` 时取 `ClassName`；顶层函数为 null */
    ownerClass?: string | null;
  }>,
  filePathToId: Map<string, number>,
  absProjectRoot: string,
  filePaths: string[],
  scans: Map<string, ReturnType<typeof scanFile>>,
  /** 类名 → 直接父类名；用于沿继承链解析 self.X() 继承来的方法 */
  parentOf?: Map<string, string>,
): Array<{
  callerFuncId: number | null;
  calleeFuncId: number | null;   // null = 未能静态解析（见 calleeName）
  callerFileId: number;
  calleeFileId: number | null;   // null = 目标不在本仓
  callLine: number;
  callType: string;
  calleeName?: string;           // 未解析时的原始被调用名
  isExternal?: boolean;
}> {
  const resolved: Array<{
    callerFuncId: number | null;
    calleeFuncId: number | null;
    callerFileId: number;
    calleeFileId: number | null;
    callLine: number;
    callType: string;
    calleeName?: string;
    isExternal?: boolean;
  }> = [];

  const fileLookup = new Set(filePaths);
  const funcByName = new Map<string, typeof funcInventory>();
  for (const f of funcInventory) {
    const arr = funcByName.get(f.name) || [];
    arr.push(f);
    funcByName.set(f.name, arr);
  }

  // Build per-file function index (name -> func)
  const fileFuncsMap = new Map<number, Map<string, typeof funcInventory[0]>>();
  for (const f of funcInventory) {
    if (!fileFuncsMap.has(f.fileId)) fileFuncsMap.set(f.fileId, new Map());
    fileFuncsMap.get(f.fileId)!.set(f.name, f);
  }

  // 按文件分组的函数列表：供「找最内层包含某行的函数」用。
  // 直接遍历整个 funcInventory 是 O(calls × functions) —— 实仓 185k 调用 × 18k 函数
  // ≈ 3.4e9 次比较，会把扫描从 ~90s 拖到 5 分钟以上。
  // 按文件预分组后内层只需扫该文件（本仓平均 19 个函数/文件）。
  const funcsByFile = new Map<number, Array<typeof funcInventory[0]>>();
  for (const f of funcInventory) {
    if (f.lineStart == null || f.lineEnd == null) continue;
    const arr = funcsByFile.get(f.fileId);
    if (arr) arr.push(f);
    else funcsByFile.set(f.fileId, [f]);
  }

  // 类归属索引：`类名 -> (方法名 -> 定义)`。
  // 只用于 `self.X()` / `this.X()` 这类**可确定**接收者的解析：
  // 接收者锁定到当前类，方法名再锁定到该类的方法，两级都唯一才建边。
  const classMethodIndex = new Map<string, Map<string, typeof funcInventory[0]>>();
  for (const f of funcInventory) {
    if (!f.ownerClass) continue;
    if (!classMethodIndex.has(f.ownerClass)) classMethodIndex.set(f.ownerClass, new Map());
    const m = classMethodIndex.get(f.ownerClass)!;
    // 同类重名方法（重载）保留第一个；Python/JS 不支持真正重载，属异常代码形态
    if (!m.has(f.name)) m.set(f.name, f);
  }

  // 沿继承链向上收集祖先类（有界：最多 12 层，防御脏数据成环）
  const parentChainOf = (cls: string): string[] => {
    if (!parentOf) return [];
    const out: string[] = [];
    const seen = new Set<string>([cls]);
    let cur = parentOf.get(cls);
    while (cur && out.length < 12 && !seen.has(cur)) {
      out.push(cur);
      seen.add(cur);
      cur = parentOf.get(cur);
    }
    return out;
  };

  for (const [absFilePath, fi] of fileImportsMap) {
    if (!absFilePath.startsWith('/')) continue; // only absolute keys have scans
    const scan = scans.get(absFilePath);
    if (!scan || scan.calls.length === 0) continue;

    const fileId = filePathToId.get(fi.relPath);
    if (!fileId) continue;

    const fileFuncInv = funcInventory.filter(f => f.fileId === fileId);
    const fileFuncNames = new Map(fileFuncInv.map(f => [f.name, f]));

    // Build name -> source file map from imports
    const nameToSource = new Map<string, string | null>();
    for (const imp of fi.imports) {
      const resolvedPath = resolveImportPath(imp.source, absFilePath, absProjectRoot, fileLookup);
      for (const n of imp.names) {
        nameToSource.set(n, resolvedPath);
      }
      // Default import
      if (imp.names.length === 0) {
        // bare import with no named specifiers — skip
      }
    }

    for (const call of scan.calls) {
      // Find caller function in this file.
      // 必须取**最内层**包含该行的函数：方法内部定义的嵌套函数/闭包会让
      // `.find()` 命中外层，导致 `self.X()` 的类归属错位到外层方法所在的类
      // （本仓实测存在此形态，如 extract_version_facts 内嵌 add_target）。
      let caller: (typeof funcInventory)[number] | undefined;
      const fileFuncs = funcsByFile.get(fileId);
      if (fileFuncs) {
        for (const f of fileFuncs) {
          if (call.callLine < f.lineStart! || call.callLine > f.lineEnd!) continue;
          if (!caller) { caller = f; continue; }
          // 区间更小者更内层
          const curSpan = (caller.lineEnd! - caller.lineStart!);
          const newSpan = (f.lineEnd! - f.lineStart!);
          if (newSpan < curSpan) caller = f;
        }
      }
      // Caller func id is null for top-level (module-scope) calls
      const callerFuncId = caller?.id ?? null;

      // ── 高置信度：self.X() / this.X() 方法解析 ──
      // 接收者锁定到调用者所在的类，方法名再锁定到该类的方法。
      // 两级都唯一才建边，因此零误报；解析不到就继续走后续路径。
      // 先查本类；未命中则沿继承链向上找（子类调用继承来的方法）。
      if (call.receiver === 'self' || call.receiver === 'cls' || call.receiver === 'this') {
        const ownerClass = caller?.ownerClass ?? null;
        if (ownerClass) {
          const chain = [ownerClass, ...(parentChainOf(ownerClass) ?? [])];
          let hit: (typeof funcInventory)[number] | undefined;
          let hitClass = '';
          for (const cls of chain) {
            const m = classMethodIndex.get(cls);
            const found = m?.get(call.calleeName);
            if (found) { hit = found; hitClass = cls; break; }
          }
          if (hit) {
            resolved.push({
              callerFuncId,
              calleeFuncId: hit.id,
              callerFileId: fileId,
              calleeFileId: hit.fileId,
              callLine: call.callLine,
              callType: hitClass === ownerClass ? 'self_method' : 'self_method_inherited',
            });
            continue;
          }
        }
      }

      // Find callee — first check same file, then via import map
      const sameFileCallee = fileFuncNames.get(call.calleeName);
      if (sameFileCallee) {
        resolved.push({
          callerFuncId,
          calleeFuncId: sameFileCallee.id,
          callerFileId: fileId,
          calleeFileId: fileId,
          callLine: call.callLine,
          callType: call.callType,
        });
        continue;
      }

      // Cross-file: look up in import map
      const sourceFile = nameToSource.get(call.calleeName);
      if (sourceFile && fileLookup.has(sourceFile)) {
        const calleeRel = sourceFile.replace(absProjectRoot + '/', '');
        const calleeFileId = filePathToId.get(calleeRel);
        if (calleeFileId != null) {
          const calleeFuncs = funcByName.get(call.calleeName)?.filter(f => f.fileId === calleeFileId);
          if (calleeFuncs && calleeFuncs.length > 0) {
            resolved.push({
              callerFuncId,
              calleeFuncId: calleeFuncs[0].id,
              callerFileId: fileId,
              calleeFileId: calleeFileId,
              callLine: call.callLine,
              callType: call.callType + '_cross',
            });
            continue;
          }
        }
      }

      // Fallback: global lookup for exported functions in other files.
      // This catches re-exports, barrel files, and calls that the import
      // map missed. Only match exported functions to avoid false positives
      // from common internal names (e.g. 'init', 'parse').
      const candidates = funcByName.get(call.calleeName);
      if (candidates) {
        const crossFileCandidates = candidates.filter(
          f => f.fileId !== fileId && f.isExported,
        );
        if (crossFileCandidates.length === 1) {
          // Unambiguous match — safe to resolve
          const callee = crossFileCandidates[0];
          resolved.push({
            callerFuncId,
            calleeFuncId: callee.id,
            callerFileId: fileId,
            calleeFileId: callee.fileId,
            callLine: call.callLine,
            callType: call.callType + '_cross',
          });
        }
        // If multiple exported functions with same name exist in different
        // files, skip to avoid false positives.
      }

      // 兜底：静态解析不到目标函数（延迟导入 / 多态 / 动态属性 / 跨仓调用）。
      // 旧行为是丢弃，导致「谁调用 X」在 Python 这类动态语言上召回率极低。
      // 现在保留为按名的外部边：不参与函数级 call graph 遍历，
      // 但可以按 callee_name 检索出调用点。
      resolved.push({
        callerFuncId,
        calleeFuncId: null,
        callerFileId: fileId,
        calleeFileId: null,
        callLine: call.callLine,
        callType: call.callType + '_unresolved',
        calleeName: call.calleeName,
        isExternal: true,
      });
    }
  }

  return resolved;
}

export function getModuleFromPath(relPath: string): string {
  const parts = relPath.split('/');
  return parts.length > 1 ? parts.slice(0, -1).join('/') || '/' : '/';
}