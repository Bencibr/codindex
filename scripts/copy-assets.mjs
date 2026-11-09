/**
 * 把非 TypeScript 资源（Web UI 的 index.html）复制进 dist。
 *
 * 为什么需要：`tsc` 只编译 .ts，不搬运静态资源。而 src/index.ts 在模块顶层
 * 用 `readFileSync(new URL('web/ui/index.html', import.meta.url))` 读 UI，
 * 所以 `npm run build` 之后直接 `node dist/index.js` 会 ENOENT 崩溃——
 * 构建"成功"了，产物却跑不起来。这里在 build 脚本里补上搬运步骤。
 */
import { cpSync, existsSync, mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const src = resolve(root, 'src/web');
const dest = resolve(root, 'dist/web');

if (!existsSync(src)) {
  console.error('[codindex] 找不到 src/web，跳过静态资源复制');
  process.exit(0);
}

mkdirSync(dirname(dest), { recursive: true });
cpSync(src, dest, { recursive: true });
console.log(`[codindex] 静态资源已复制到 ${dest}`);
