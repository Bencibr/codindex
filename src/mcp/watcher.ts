/**
 * File watcher — monitors project directories and triggers incremental scans on change.
 * Uses chokidar for reliable cross-platform file watching with debounce.
 */
import chokidar from 'chokidar';
// chokidar 5 的默认导出是运行时的 `{ watch, FSWatcher }` 值对象，
// 不能当命名空间用（`chokidar.FSWatcher` 作为**类型**解析不到）。
// 类型必须从具名导出取。
import type { FSWatcher } from 'chokidar';
import { getDb } from '../db/connection.js';
import * as schema from '../db/schema.js';
import { scanProjectIncremental } from '../scan/orchestrator.js';
import { eq } from 'drizzle-orm';

interface WatcherEntry {
  watcher: FSWatcher;
  projectId: string;
  projectPath: string;
  debounceTimer: ReturnType<typeof setTimeout> | null;
  lastScan: number;
  changeCount: number;
}

const activeWatchers = new Map<string, WatcherEntry>();

const IGNORED_PATTERNS = [
  '**/node_modules/**',
  '**/.git/**',
  '**/dist/**',
  '**/build/**',
  '**/__pycache__/**',
  '**/.next/**',
  '**/venv/**',
  '**/target/**',
  '**/.claude/**',
];

// Watcher configuration
const DEBOUNCE_MS = 3000;
const WATCHER_DEPTH = 20;
const SOURCE_EXTS = new Set(['.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs', '.py', '.go', '.rs', '.java', '.rb', '.swift', '.kt', '.scala', '.php', '.vue', '.svelte']);

// Clean up all active watchers on graceful exit
['SIGINT', 'SIGTERM', 'exit'].forEach(sig => {
  process.on(sig, () => {
    for (const [id, entry] of activeWatchers) {
      if (entry.debounceTimer) clearTimeout(entry.debounceTimer);
      entry.watcher.close();
    }
    activeWatchers.clear();
  });
});

/**
 * Start watching a project directory for changes.
 * Triggers incremental scan after debounce period.
 */
export function startWatching(projectId: string, projectPath: string): { status: string; message: string } {
  if (activeWatchers.has(projectId)) {
    const entry = activeWatchers.get(projectId)!;
    return {
      status: 'already_watching',
      message: `Already watching ${projectPath} (${entry.changeCount} changes since start)`,
    };
  }

  const watcher = chokidar.watch(projectPath, {
    ignored: IGNORED_PATTERNS,
    persistent: true,
    ignoreInitial: true,
    depth: WATCHER_DEPTH,
  });

  const entry: WatcherEntry = {
    watcher,
    projectId,
    projectPath,
    debounceTimer: null,
    lastScan: Math.floor(Date.now() / 1000),
    changeCount: 0,
  };

  watcher.on('all', (event, filePath) => {
    // Only trigger on source file changes
    const ext = filePath.match(/\.[a-z]+$/i)?.[0] || '';
    if (!SOURCE_EXTS.has(ext)) return;

    entry.changeCount++;

    // Debounce: reset timer on each change
    if (entry.debounceTimer) clearTimeout(entry.debounceTimer);
    entry.debounceTimer = setTimeout(() => {
      triggerIncrementalScan(entry).catch(err => console.error('[codindex] watcher: incremental scan failed', err));
    }, DEBOUNCE_MS);
  });

  activeWatchers.set(projectId, entry);
  return {
    status: 'watching',
    message: `Watching ${projectPath} for changes (debounce ${DEBOUNCE_MS}ms)`,
  };
}

/**
 * Stop watching a project directory.
 */
export function stopWatching(projectId: string): { status: string; message: string } {
  const entry = activeWatchers.get(projectId);
  if (!entry) {
    return { status: 'not_watching', message: `Project ${projectId} is not being watched` };
  }

  if (entry.debounceTimer) clearTimeout(entry.debounceTimer);
  entry.watcher.close();
  activeWatchers.delete(projectId);

  return {
    status: 'stopped',
    message: `Stopped watching ${entry.projectPath} (${entry.changeCount} total changes)`,
  };
}

async function triggerIncrementalScan(entry: WatcherEntry): Promise<void> {
  try {
    const db = getDb();
    const proj = await db.select().from(schema.projects)
      .where(eq(schema.projects.id, entry.projectId)).limit(1);
    if (!proj.length) return;

    const since = entry.lastScan;
    entry.lastScan = Math.floor(Date.now() / 1000);

    await scanProjectIncremental(entry.projectId, entry.projectPath, since);
  } catch (err) {
    console.error(`[watcher] Incremental scan failed for ${entry.projectId}:`, err);
  }
}
