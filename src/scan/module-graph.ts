import { existsSync, readFileSync } from 'fs';
import { resolve, dirname } from 'path';
import { spawnSync } from 'child_process';

interface ImportEntry {
  source: string;
  line: number;
}

interface ModuleDepEdge {
  fromModule: string;
  toModule: string;
  depType: string;
  weight: number;
}

interface CycleInfo {
  cycle: string[];
  description: string;
}

/**
 * Build a module-level dependency graph from the collected import data.
 * Returns edges, modules list, and any detected cycles.
 */
export function buildModuleGraph(
  fileImports: Map<string, { relPath: string; module: string; imports: { source: string; names: string[]; line: number }[] }>,
  absProjectRoot: string,
  fileLookup: Set<string>,
): {
  modules: { name: string; path: string }[];
  edges: ModuleDepEdge[];
  cycles: CycleInfo[];
} {
  const moduleSet = new Set<string>();
  const fileToModule = new Map<string, string>();
  const edges: ModuleDepEdge[] = [];
  const edgeSet = new Set<string>();

  // Collect all modules
  for (const [fp, fi] of fileImports) {
    if (!fp.startsWith('/')) continue;
    moduleSet.add(fi.module);
    fileToModule.set(fi.relPath, fi.module);
  }

  // Process imports
  for (const [fp, fi] of fileImports) {
    if (!fp.startsWith('/')) continue;
    const fromMod = fi.module;

    for (const imp of fi.imports) {
      let resolved: string | null = null;

      // Resolve relative/absolute paths
      if (imp.source.startsWith('./') || imp.source.startsWith('../') || imp.source.startsWith('/')) {
        const base = dirname(fp);
        const full = resolve(base, imp.source);

        // Try extensions
        const exts = ['.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs', ''];
        for (const e of exts) {
          const asFile = full + e;
          if (fileLookup.has(asFile)) { resolved = asFile; break; }
          if (!e || e === '') {
            for (const ie of ['.ts', '.tsx', '.js', '.jsx']) {
              const asIndex = resolve(full, 'index' + ie);
              if (fileLookup.has(asIndex)) { resolved = asIndex; break; }
            }
            if (resolved) break;
          }
        }
      }

      // Go module path resolution (e.g., "github.com/tunnel/tunnel/pkg/server" → "pkg/server")
      if (!resolved && absProjectRoot) {
        const goModPath = resolve(absProjectRoot, 'go.mod');
        if (existsSync(goModPath)) {
          try {
            const goModContent = readFileSync(goModPath, 'utf-8');
            const moduleMatch = goModContent.match(/^module\s+(.+)$/m);
            if (moduleMatch) {
              const goModulePrefix = moduleMatch[1].trim();
              if (imp.source.startsWith(goModulePrefix + '/')) {
                const localPath = imp.source.slice(goModulePrefix.length + 1);
                const absLocalDir = resolve(absProjectRoot, localPath);
                // Check if any file in fileLookup is under this path
                for (const f of fileLookup) {
                  if (f.startsWith(absLocalDir + '/') && (f.endsWith('.go') || f.endsWith('.ts') || f.endsWith('.tsx'))) {
                    resolved = f;
                    break;
                  }
                }
                // Also try as a direct file
                if (!resolved) {
                  const exts = ['.go', '.ts', '.tsx'];
                  for (const e of exts) {
                    const candidate = absLocalDir + e;
                    if (fileLookup.has(candidate)) { resolved = candidate; break; }
                  }
                }
              }
            }
          } catch { /* go.mod read failed */ }
        }
      }

      if (resolved) {
        const toRel = resolved.replace(absProjectRoot + '/', '');
        const toMod = fileToModule.get(toRel);
        if (toMod && toMod !== fromMod) {
          const key = `${fromMod}->${toMod}`;
          if (!edgeSet.has(key)) {
            edgeSet.add(key);
            edges.push({
              fromModule: fromMod,
              toModule: toMod,
              depType: 'import',
              weight: 1,
            });
          }
        }
      }
    }
  }

  // Cycle detection via DFS
  const adj = new Map<string, string[]>();
  for (const e of edges) {
    if (!adj.has(e.fromModule)) adj.set(e.fromModule, []);
    adj.get(e.fromModule)!.push(e.toModule);
  }

  const cycles = detectCycles([...moduleSet], adj);

  return {
    modules: [...moduleSet].map(m => ({ name: m, path: m })),
    edges,
    cycles,
  };
}

function detectCycles(
  nodes: string[],
  adj: Map<string, string[]>,
): CycleInfo[] {
  const cycles: CycleInfo[] = [];
  const visited = new Set<string>();
  const recStack = new Set<string>();
  const path: string[] = [];

  function dfs(u: string) {
    visited.add(u);
    recStack.add(u);
    path.push(u);

    for (const v of adj.get(u) || []) {
      if (!visited.has(v)) {
        dfs(v);
      } else if (recStack.has(v)) {
        // Found a cycle: trace from v in path
        const idx = path.indexOf(v);
        if (idx >= 0) {
          const cycle = [...path.slice(idx), v];
          cycles.push({
            cycle,
            description: `Cycle: ${cycle.join(' → ')}`,
          });
        }
      }
    }

    path.pop();
    recStack.delete(u);
  }

  for (const n of nodes) {
    if (!visited.has(n)) dfs(n);
  }

  return cycles;
}

/**
 * Simple incremental scan: compare current git HEAD with last scan time
 * to determine which files changed.
 */
export function getChangedFiles(
  projectPath: string,
  lastScanned: number,
): string[] {
  if (!lastScanned) return []; // full scan needed

  try {
    const since = new Date(lastScanned * 1000).toISOString();
    const result = spawnSync('git', ['log', `--since=${since}`, '--name-only', '--pretty=format:'], {
      cwd: projectPath,
      encoding: 'utf-8',
      timeout: 30_000,
    });
    if (result.error || result.status !== 0) return [];
    return result.stdout.trim().split('\n').filter(Boolean);
  } catch {
    return [];
  }
}
