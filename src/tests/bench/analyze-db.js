const Database = require('better-sqlite3');
const db = new Database('data/codindex.db');
const pid = db.prepare('SELECT id FROM projects').all()[0]?.id;

const total = db.prepare('SELECT COUNT(*) as c FROM functions WHERE project_id = ?').get(pid);
const withBody = db.prepare("SELECT COUNT(*) as c FROM functions WHERE project_id = ? AND body IS NOT NULL AND body != ''").get(pid);
console.log('With body:', withBody.c, '/', total.c);

const kinds = db.prepare('SELECT kind, COUNT(*) as c FROM functions WHERE project_id = ? GROUP BY kind ORDER BY c DESC').all(pid);
console.log('\nFunction kinds:');
for (const k of kinds) console.log('  ' + k.kind + ': ' + k.c);

const exported = db.prepare('SELECT COUNT(*) as c FROM functions WHERE project_id = ? AND is_exported = 1').get(pid);
console.log('\nExported:', exported.c, '/', total.c);

console.log('\nComplexity distribution:');
for (const [lo, hi] of [[0,5],[5,10],[10,20],[20,50],[50,90],[90,100]]) {
  const c = db.prepare('SELECT COUNT(*) as c FROM functions WHERE project_id = ? AND complexity >= ? AND complexity < ?').get(pid, lo, hi);
  console.log('  ' + lo + '-' + hi + ': ' + c.c);
}

// Key functions missing from index
const missing = ['extractAll', 'handleTool', 'resolveSwiftObjcBridges', 'parseWorker'];
console.log('\nMissing key functions:');
for (const name of missing) {
  const f = db.prepare('SELECT id FROM functions WHERE project_id = ? AND name = ?').get(pid, name);
  console.log('  ' + name + ': ' + (f ? 'FOUND' : 'NOT FOUND'));
}

// search_code test
const searchTests = ['extractAll', 'handleTool', 'handleExplore', 'parseWorker'];
console.log('\nsearch_code results:');
for (const q of searchTests) {
  const r = db.prepare("SELECT name FROM functions WHERE project_id = ? AND name LIKE ? LIMIT 3").all(pid, '%' + q + '%');
  console.log('  "' + q + '":', r.length > 0 ? r.map(x => x.name).join(', ') : 'NO RESULTS');
}

db.close();
