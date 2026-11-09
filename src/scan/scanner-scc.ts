import { execSync, spawnSync } from 'child_process';
import { existsSync, realpathSync } from 'fs';
import { isAbsolute, relative, resolve, sep } from 'path';

export interface FileStats {
  path: string;
  language: string;
  lines: number;
  code: number;
  comment: number;
  complexity: number;
}

/** Run scc on a directory, return file-level stats */
export function scanWithScc(dirPath: string): FileStats[] {
  try {
    const result = spawnSync('scc', ['--format', 'json', '--no-cocomo', dirPath], {
      encoding: 'utf-8',
      timeout: 120_000,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    if (result.error) return [];
    const data = JSON.parse(result.stdout);
    const files: FileStats[] = [];
    for (const lang of data) {
      if (!lang.files) continue;
      for (const f of lang.files) {
        files.push({
          path: f.Location ?? f.Filename ?? f.location ?? f.filename ?? '',
          language: lang.Name ?? lang.name ?? '',
          lines: f.Lines ?? f.lines ?? 0,
          code: f.Code ?? f.code ?? 0,
          comment: f.Comment ?? f.comment ?? 0,
          complexity: f.Complexity ?? f.complexity ?? 0,
        });
      }
    }
    return files;
  } catch {
    return [];
  }
}

export function isSccAvailable(): boolean {
  try {
    execSync('scc --version', { stdio: 'pipe', timeout: 5000 });
    return true;
  } catch {
    return false;
  }
}

export interface GitStats {
  lastModified: number | null;
  authors: string[];
}

/** Git log analysis for a single file (保留给外部的单文件查询；批量扫描请用 getGitStatsBatch) */
export function getGitStats(filePath: string): GitStats {
  try {
    const dir = resolve(filePath, '..');
    const result = spawnSync('git', ['log', '--format=%ai|%an', '--', filePath], {
      cwd: dir,
      encoding: 'utf-8',
      timeout: 10_000,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    if (result.error || result.status !== 0) return { lastModified: null, authors: [] };
    const lines = result.stdout.trim().split('\n').filter(Boolean);
    if (lines.length === 0) return { lastModified: null, authors: [] };

    const dates = lines.map((l) => new Date(l.split('|')[0]).getTime());
    const authors = [...new Set(lines.map((l) => l.split('|')[1]))];
    return {
      lastModified: Math.max(...dates) / 1000,
      authors,
    };
  } catch {
    return { lastModified: null, authors: [] };
  }
}

/**
 * 解码 git 在未加 `core.quotepath=false` 时输出的 C 风格转义路径
 * （例如 `"\344\270\255\346\226\207.ts"`）。即便设了 quotepath=false，
 * 含换行、制表符或双引号的路径仍会被加引号输出，所以这层兜底不能省。
 */
function unquoteGitPath(p: string): string {
  if (p.length < 2 || !p.startsWith('"') || !p.endsWith('"')) return p;
  const body = p.slice(1, -1);
  const bytes: number[] = [];
  for (let i = 0; i < body.length; i++) {
    const ch = body[i];
    if (ch !== '\\') {
      bytes.push(...Buffer.from(ch, 'utf-8'));
      continue;
    }
    const next = body[i + 1];
    const simple: Record<string, number> = { n: 10, t: 9, r: 13, '"': 34, '\\': 92, a: 7, b: 8, f: 12, v: 11 };
    if (next in simple) { bytes.push(simple[next]); i += 1; continue; }
    // 八进制转义：\NNN（git 用三位表示一个 UTF-8 字节）
    const oct = body.slice(i + 1, i + 4);
    if (/^[0-7]{3}$/.test(oct)) { bytes.push(parseInt(oct, 8)); i += 3; continue; }
    bytes.push(...Buffer.from(ch, 'utf-8'));
  }
  return Buffer.from(bytes).toString('utf-8');
}

/** 取 git 仓库根目录的绝对路径；不在仓库内返回 null */
export function getGitToplevel(dirPath: string): string | null {
  try {
    const r = spawnSync('git', ['rev-parse', '--show-toplevel'], {
      cwd: dirPath, encoding: 'utf-8', timeout: 10_000, stdio: ['pipe', 'pipe', 'pipe'],
    });
    if (r.error || r.status !== 0) return null;
    const top = r.stdout.trim();
    return top ? resolve(top) : null;
  } catch {
    return null;
  }
}

/** realpath 的安全封装：路径不存在时退回原值（避免 throws 打断整批解析） */
function realpathOf(p: string): string {
  try {
    return realpathSync(p);
  } catch {
    return p;
  }
}

/**
 * 一次性批量取整仓的 git 元信息，返回 `相对项目路径 -> GitStats`。
 *
 * 为什么必须批量：旧实现对每个文件调一次 spawnSync('git')，
 * 实测单次 ~48ms（0.58s 冷启动），980 个文件 ≈ 47s，占扫描总耗时 40%。
 * 更糟的是 spawnSync 会阻塞事件循环，pLimit(8) 的并发在此完全失效
 * （实测串行 2797ms vs pLimit 3032ms，加速比 0.92x）。
 * 一次 `git log --name-only` 实测 1.38s，替代 980 次子进程，约 36 倍。
 *
 * 语义等价性：只用 lastModified(最大提交时间) 与 authors(去重作者集合)，
 * 已抽样比对逐文件结果，两者完全一致。合并提交在 --name-only 下的展开方式
 * 与逐文件略异（条数不同），但不影响这两个字段。
 *
 * 两个曾经踩过的坑（都必须由本函数自己兜住，调用方无从感知）：
 *
 * 1. **key 的基准是项目根，不是仓库根**。`git log --name-only` 输出的是
 *    「仓库根相对路径」。当 project path 是仓库的子目录时（monorepo 里
 *    把 `packages/app` 单独注册为项目），直接拿 `a.ts` 去查会得到
 *    `packages/app/a.ts`，`Map.get` 全部落空 → last_modified 静默变回 NULL。
 *    这里先 `rev-parse --show-toplevel` 求仓库根，再用 `relative()` 把
 *    每条路径换算到项目根基准，并丢弃项目子树之外的路径。
 *
 * 2. **非 ASCII 路径会被 git 转义**。默认 `core.quotepath=true` 下
 *    `中文.ts` 输出成 `"\344\270\255..."`，与 DB 里的真实路径永不相等。
 *    这里显式传 `-c core.quotepath=false`，并对仍被加引号的路径做
 *    `unquoteGitPath()` 兜底。
 *
 * @param rootPath 项目根目录（可以等于仓库根，也可以是仓库的子目录）
 * @returns 以「项目根相对路径」为键的映射
 */
export function getGitStatsBatch(rootPath: string): Map<string, GitStats> {
  const out = new Map<string, GitStats>();
  try {
    const projectRoot = resolve(rootPath);
    const top = getGitToplevel(projectRoot);
    if (!top) return out;

    // 前缀必须用 realpath 两侧对齐：git 的 --show-toplevel 返回的是解析过
    // 符号链接的真实路径（macOS 上 /tmp 实为 /private/tmp），而调用方传进来的
    // projectRoot 可能还是含符号链接的写法。不归一化会算出 `../../..` 前缀，
    // 于是所有路径都被判定为「项目子树之外」而丢弃 —— 表现就是静默全 NULL。
    const realProject = realpathOf(projectRoot);
    const realTop = realpathOf(top);

    // 项目根相对仓库根的前缀：'' 表示项目根就是仓库根
    const prefixRaw = relative(realTop, realProject);
    const prefix = prefixRaw === '' ? '' : prefixRaw.split(sep).join('/');
    // 项目根不在仓库内（或指向仓库之外）→ 无可归属的路径
    if (prefix === '..' || prefix.startsWith('..' + '/') || isAbsolute(prefix)) return out;

    const result = spawnSync(
      'git',
      ['-c', 'core.quotepath=false', 'log', '--format=CM|codindex|%ai|%an', '--name-only'],
      {
        cwd: top,
        encoding: 'utf-8',
        timeout: 120_000,
        maxBuffer: 64 * 1024 * 1024,
        stdio: ['pipe', 'pipe', 'pipe'],
      },
    );
    if (result.error || result.status !== 0 || !result.stdout) return out;

    // 逐行解析：CM| 行是提交头（日期|作者），其后的非空行是该提交触及的文件
    const acc = new Map<string, { maxTs: number; authors: Set<string> }>();
    let curDate = '';
    let curAuthor = '';
    for (const raw of result.stdout.split('\n')) {
      if (raw.startsWith('CM|codindex|')) {
        const rest = raw.slice('CM|codindex|'.length);
        const sep = rest.indexOf('|');
        curDate = sep >= 0 ? rest.slice(0, sep) : rest;
        curAuthor = sep >= 0 ? rest.slice(sep + 1) : '';
        continue;
      }
      const repoRel = unquoteGitPath(raw.trim());
      if (!repoRel || !curDate) continue;

      // 仓库根相对 → 项目根相对
      let projRel: string;
      if (prefix === '') {
        projRel = repoRel;
      } else if (repoRel.startsWith(prefix + '/')) {
        projRel = repoRel.slice(prefix.length + 1);
      } else {
        continue; // 该文件在项目子树之外，与本项目无关
      }

      const ts = new Date(curDate).getTime();
      if (Number.isNaN(ts)) continue;
      let e = acc.get(projRel);
      if (!e) {
        e = { maxTs: ts, authors: new Set<string>() };
        acc.set(projRel, e);
      } else if (ts > e.maxTs) {
        e.maxTs = ts;
      }
      if (curAuthor) e.authors.add(curAuthor);
    }

    for (const [path, e] of acc) {
      out.set(path, {
        lastModified: e.maxTs > 0 ? e.maxTs / 1000 : null,
        authors: [...e.authors],
      });
    }
    return out;
  } catch {
    return out;
  }
}

/**
 * 判断目录是否受 git 管理。
 *
 * 旧实现只看 `<dir>/.git` 是否存在，把「项目注册在 monorepo 子目录」这一
 * 常见情形误判为「不是 git 仓库」，于是整个扫描跳过 git 元信息，
 * files.last_modified 又回到全表 NULL。这里先用 `.git` 走快路径，
 * 未命中再问 git 自己（会向上查找父目录）。
 */
export function isGitRepo(dirPath: string): boolean {
  try {
    if (existsSync(resolve(dirPath, '.git'))) return true;
    const r = spawnSync('git', ['rev-parse', '--is-inside-work-tree'], {
      cwd: dirPath, encoding: 'utf-8', timeout: 10_000, stdio: ['pipe', 'pipe', 'pipe'],
    });
    return !r.error && r.status === 0 && r.stdout.trim() === 'true';
  } catch {
    return false;
  }
}
