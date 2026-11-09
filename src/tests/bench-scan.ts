/**
 * Scan CodeGraph repo with Codindex and report results.
 * Usage: npx tsx src/tests/bench-scan.ts
 */

import { getDb, getSqlite } from '../db/connection.js';
import * as schema from '../db/schema.js';
import { scanProject } from '../scan/orchestrator.js';
import { eq } from 'drizzle-orm';
import { existsSync } from 'fs';

const PROJECT_PATH = '/tmp/codegraph-bench';
const PROJECT_ID = 'bench-codegraph-' + Date.now();
const db = getDb();
const sqlite = getSqlite();

// Clean stale project data for this path if exists
const existing = db.select().from(schema.projects).all();
for (const p of (existing as any[])) {
  const pid = String(p.id);
  sqlite.prepare('DELETE FROM type_usage_edges WHERE project_id = ?').run(pid);
  sqlite.prepare('DELETE FROM calls WHERE project_id = ?').run(pid);
  sqlite.prepare('DELETE FROM functions WHERE project_id = ?').run(pid);
  sqlite.prepare('DELETE FROM types WHERE project_id = ?').run(pid);
  sqlite.prepare('DELETE FROM type_fields WHERE project_id = ?').run(pid);
  sqlite.prepare('DELETE FROM files WHERE project_id = ?').run(pid);
  sqlite.prepare('DELETE FROM module_deps WHERE project_id = ?').run(pid);
  sqlite.prepare('DELETE FROM modules WHERE project_id = ?').run(pid);
  sqlite.prepare('DELETE FROM features WHERE project_id = ?').run(pid);
  sqlite.prepare('DELETE FROM projects WHERE id = ?').run(pid);
}

async function main() {
  if (!existsSync(PROJECT_PATH)) {
    console.error('CodeGraph repo not found at', PROJECT_PATH);
    process.exit(1);
  }

  // Register project
  console.log('Registering project...');
  sqlite.prepare('INSERT INTO projects (id, name, path, status) VALUES (?, ?, ?, ?)').run(
    PROJECT_ID, 'codegraph-bench', PROJECT_PATH, 'pending'
  );

  // Scan
  console.log('Scanning (this may take a minute)...');
  const t0 = Date.now();
  const result = await scanProject(PROJECT_ID, PROJECT_PATH);
  const elapsed = ((Date.now() - t0) / 1000).toFixed(1);

  console.log('\n=== Scan Results ===');
  console.log(`Files:     ${result.files}`);
  console.log(`Functions: ${result.functions}`);
  console.log(`Types:     ${result.types}`);
  console.log(`Calls:     ${result.calls}`);
  console.log(`Modules:   ${result.modules}`);
  console.log(`Time:      ${elapsed}s`);

  // Verify DB contents
  const fileCount = db.select().from(schema.files).where(eq(schema.files.projectId, PROJECT_ID)).all();
  const funcCount = db.select().from(schema.functions).where(eq(schema.functions.projectId, PROJECT_ID)).all();
  const callCount = db.select().from(schema.calls).where(eq(schema.calls.projectId, PROJECT_ID)).all();
  const typeCount = db.select().from(schema.types).where(eq(schema.types.projectId, PROJECT_ID)).all();
  const moduleCount = db.select().from(schema.modules).where(eq(schema.modules.projectId, PROJECT_ID)).all();

  console.log('\n=== DB Verification ===');
  console.log(`Files in DB:     ${fileCount.length}`);
  console.log(`Functions in DB: ${funcCount.length}`);
  console.log(`Calls in DB:     ${callCount.length}`);
  console.log(`Types in DB:     ${typeCount.length}`);
  console.log(`Modules in DB:   ${moduleCount.length}`);

  // Top 5 complex functions
  const topComplex = sqlite.prepare(
    'SELECT name, complexity, lines_count FROM functions WHERE project_id = ? ORDER BY complexity DESC LIMIT 5'
  ).all(PROJECT_ID);

  console.log('\n=== Top 5 Most Complex Functions ===');
  for (const f of topComplex) {
    console.log(`  ${f.name} complexity=${f.complexity}, lines=${f.lines_count}`);
  }

  // Reuse score distribution
  const withScore = funcCount.filter((f: any) => f.reuseScore != null);
  const high = withScore.filter((f: any) => f.reuseScore >= 85).length;
  const medium = withScore.filter((f: any) => f.reuseScore >= 60 && f.reuseScore < 85).length;
  const low = withScore.filter((f: any) => f.reuseScore < 60).length;
  console.log(`\n=== Reuse Score Distribution ===`);
  console.log(`  High (>=85): ${high}`);
  console.log(`  Medium (60-84): ${medium}`);
  console.log(`  Low (<60): ${low}`);
  console.log(`  Unscored: ${funcCount.length - withScore.length}`);

  // Top 5 most reused
  const topReuse = sqlite.prepare(
    'SELECT name, reuse_score AS score, complexity, is_exported FROM functions WHERE project_id = ? AND reuse_score IS NOT NULL ORDER BY reuse_score DESC LIMIT 5'
  ).all(PROJECT_ID);

  console.log('\n=== Top 5 Highest Reuse Score ===');
  for (const f of topReuse) {
    console.log(`  ${f.name} score=${f.score}, complexity=${f.complexity}, exported=${f.is_exported}`);
  }

  // Language distribution
  const langs = sqlite.prepare(
    'SELECT language, COUNT(*) as cnt FROM files WHERE project_id = ? GROUP BY language ORDER BY cnt DESC'
  ).all(PROJECT_ID);
  console.log('\n=== Language Distribution ===');
  for (const l of langs) {
    console.log(`  ${l.language}: ${l.cnt} files`);
  }

  // Module breakdown
  console.log('\n=== Module Breakdown ===');
  const mods = db.select().from(schema.modules).where(eq(schema.modules.projectId, PROJECT_ID)).all();
  for (const m of mods) {
    const fnCount = sqlite.prepare(
      'SELECT COUNT(*) as c FROM functions f JOIN files fi ON f.file_id = fi.id WHERE fi.module = ? AND f.project_id = ?'
    ).get(m.path, PROJECT_ID);
    console.log(`  ${m.path} -- ${(fnCount as any).c} functions`);
  }

  // NOTE: Data preserved in DB for MCP testing.
  // Cleanup manually with: node bench-clean.mjs
  console.log('\nScan data preserved in DB for testing.');
  console.log('Project ID:', PROJECT_ID);
  console.log('Done.');
}

main().catch(err => {
  console.error('Error:', err);
  process.exit(1);
});
