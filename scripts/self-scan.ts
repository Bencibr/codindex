/**
 * 自扫描冒烟：真的把本仓库当项目索引一遍，验证扫描链路端到端可用。
 *
 * 为什么用脚本而不是 CI 里的内联 node -e：
 * 旧 CI 先用 `npx drizzle-kit push` 建表（错误被 2>/dev/null 吞掉），再用
 * 裸 SQL `INSERT INTO projects` 塞一行，最后用 `require()` 调 ESM 的
 * orchestrator —— 三个环节任一处失败都会让 CI 直接崩或静默跳过，
 * 而且完全绕过了应用自身代码路径，不是真的冒烟。
 *
 * 这里只走公开 API：getDb() 会建表（connection.ts 的 runMigrations），
 * scanProject() 是真实扫描入口。数据落在临时库，不污染 data/。
 */
import { resolve } from 'node:path';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { v4 as uuid } from 'uuid';

// 必须在导入 connection 之前设置：它会在模块加载时读取并缓存路径。
const dir = mkdtempSync(resolve(tmpdir(), 'codindex-selfscan-'));
process.env.CODINDEX_DB = resolve(dir, 'selfscan.db');

const { getDb } = await import('../src/db/connection.js');
const schema = await import('../src/db/schema.js');
const { scanProject } = await import('../src/scan/orchestrator.js');

const root = resolve(process.cwd());
const id = uuid();

try {
  const db = getDb();
  await db.insert(schema.projects).values({
    id, name: 'codindex-self', path: root, status: 'pending',
  });

  const result = await scanProject(id, root);
  console.log('[self-scan]', JSON.stringify(result));

  const failures: string[] = [];
  if (!result.files || result.files < 20) failures.push(`files=${result.files}（应 ≥ 20）`);
  if (!result.functions || result.functions < 50) failures.push(`functions=${result.functions}（应 ≥ 50）`);
  if (!result.types) failures.push(`types=${result.types}（不应为 0）`);
  if (!result.calls) failures.push(`calls=${result.calls}（不应为 0）`);

  if (failures.length) {
    console.error('[self-scan] 失败：' + failures.join('；'));
    process.exitCode = 1;
  } else {
    console.log('[self-scan] ok');
  }
} finally {
  try { rmSync(dir, { recursive: true, force: true }); } catch { /* ignore */ }
}
