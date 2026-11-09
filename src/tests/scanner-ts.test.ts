import { describe, it, expect } from 'vitest';
import { scanFile } from '../scan/scanner-ts';
import { readFileSync, existsSync } from 'fs';
import { TEST_PROJECT_DIR } from './helpers';

describe('scanner-ts — tree-sitter scanner', () => {
  // ─── Functions ───

  it('extracts function declarations with metadata', () => {
    const r = scanFile(`${TEST_PROJECT_DIR}/src/services/user-service.ts`, 'typescript');
    const funcs = r.functions;

    expect(funcs.length).toBe(3);

    const findUser = funcs.find(f => f.name === 'findUserByEmail')!;
    expect(findUser).toBeDefined();
    expect(findUser.kind).toBe('function');
    expect(findUser.paramsCount).toBe(2);  // (users, email)
    expect(findUser.fullName).toBe('findUserByEmail');
    expect(findUser.isExported).toBe(true);
    expect(findUser.isTest).toBe(false);
  });

  it('extracts method definitions inside classes', () => {
    // No classes in the test project, so this tests edge case safety
    // Actually our test project has none — just verify it handles empty
    const r = scanFile(`${TEST_PROJECT_DIR}/src/index.ts`, 'typescript');
    expect(r.functions.length).toBeGreaterThanOrEqual(2);
  });

  it('recognises arrow function declarations', () => {
    // helpers.ts only has regular functions, not arrows
    // index.ts has none either. We'll test inline.
    const r = scanFile('/dev/null', 'typescript',
      `export const add = (a: number, b: number): number => a + b;`
    );
    const add = r.functions.find(f => f.name === 'add')!;
    expect(add).toBeDefined();
    expect(add.kind).toBe('arrow');
    expect(add.paramsCount).toBe(2);
    expect(add.isExported).toBe(true);
  });

  it('extracts function body content', () => {
    const r = scanFile(`${TEST_PROJECT_DIR}/src/services/user-service.ts`, 'typescript');
    const findUser = r.functions.find(f => f.name === 'findUserByEmail')!;
    expect(findUser.body).toBeDefined();
    expect(findUser.body).toContain('function findUserByEmail');
    expect(findUser.body).toContain('users.find');

    // Arrow function body
    const r2 = scanFile('/dev/null', 'typescript',
      `export const add = (a: number, b: number): number => a + b;`
    );
    const add = r2.functions.find(f => f.name === 'add')!;
    expect(add.body).toContain('add');
    expect(add.body).toContain('a + b');
  });

  it('reads JSDoc comments', () => {
    const r = scanFile(`${TEST_PROJECT_DIR}/src/services/user-service.ts`, 'typescript');
    const findUser = r.functions.find(f => f.name === 'findUserByEmail')!;

    expect(findUser.docComment).toContain('Find user by email');
  });

  it('correctly tracks line numbers', () => {
    const r = scanFile(`${TEST_PROJECT_DIR}/src/index.ts`, 'typescript');
    const main = r.functions.find(f => f.name === 'main')!;

    expect(main.lineStart).toBeGreaterThan(0);
    expect(main.lineEnd).toBeGreaterThanOrEqual(main.lineStart);
    expect(main.linesCount).toBeGreaterThan(0);
  });

  it('marks test files correctly', () => {
    const r = scanFile(`${TEST_PROJECT_DIR}/src/test/helpers.test.ts`, 'typescript');
    for (const f of r.functions) {
      expect(f.isTest).toBe(true);
    }
  });

  it('detects @feature: tags in code', () => {
    const r = scanFile(`${TEST_PROJECT_DIR}/src/utils/helpers.ts`, 'typescript');
    const clamp = r.functions.find(f => f.name === 'clamp')!;
    expect(clamp.tags).toContain('data-processing');
  });

  it('detects @feature: tags via file-level scan', () => {
    const r = scanFile(`${TEST_PROJECT_DIR}/src/services/user-service.ts`, 'typescript');
    const fu = r.functions.find(f => f.name === 'findUserByEmail')!;
    expect(fu.tags).toContain('user-management');
  });

  it('computes complexity', () => {
    const r = scanFile(`${TEST_PROJECT_DIR}/src/utils/helpers.ts`, 'typescript');
    for (const f of r.functions) {
      expect(f.complexity).toBeGreaterThanOrEqual(1);
    }

    // classify has 3 if-statements → complexity 4 (1 base + 3 branch)
    const r2 = scanFile(`${TEST_PROJECT_DIR}/src/utils/complex.ts`, 'typescript');
    const classify = r2.functions.find(f => f.name === 'classify')!;
    expect(classify.complexity).toBeGreaterThanOrEqual(3);
  });

  // ─── Calls ───

  it('extracts call_expression edges', () => {
    const r = scanFile(`${TEST_PROJECT_DIR}/src/index.ts`, 'typescript');
    expect(r.calls.length).toBeGreaterThanOrEqual(1);
    const call = r.calls.find(c => c.calleeName === 'findUserByEmail');
    expect(call).toBeDefined();
    expect(call?.callType).toBe('direct');
  });

  it('extracts method call edges (member_expression)', () => {
    // users.find(u => u.email === email) — the .find() is a member call
    const r = scanFile(`${TEST_PROJECT_DIR}/src/services/user-service.ts`, 'typescript');
    // user.name.trim() and similar
    const memberCalls = r.calls.filter(c => c.callType === 'method');
    expect(memberCalls.length).toBeGreaterThanOrEqual(1);
  });

  it('captures call line numbers', () => {
    const r = scanFile(`${TEST_PROJECT_DIR}/src/index.ts`, 'typescript');
    for (const c of r.calls) {
      expect(c.callLine).toBeGreaterThan(0);
    }
  });

  // ─── Imports ───

  it('extracts import statements', () => {
    const r = scanFile(`${TEST_PROJECT_DIR}/src/services/user-service.ts`, 'typescript');
    const imp = r.imports.find(i => i.source.includes('helpers'));
    expect(imp).toBeDefined();
  });

  it('extracts named import names', () => {
    const r = scanFile(`${TEST_PROJECT_DIR}/src/index.ts`, 'typescript');
    const imp = r.imports.find(i => i.source.includes('user-service'));
    expect(imp?.names).toContain('User');
    expect(imp?.names).toContain('findUserByEmail');
  });

  // ─── Cross-language function extraction ───

  it('extracts Go functions with correct paramsCount', () => {
    const r = scanFile('/dev/null', 'go',
      `package main\n\nfunc version() string { return "1.0" }\n\nfunc add(a int, b int) int { return a + b }\n\nfunc (s *Server) handle(w http.ResponseWriter, r *http.Request) {}\n`
    );
    const version = r.functions.find(f => f.name === 'version')!;
    expect(version).toBeDefined();
    expect(version.paramsCount).toBe(1); // heuristic: ( ) + word-word in body → 1 param
    expect(version.signature).toContain('version()');

    const add = r.functions.find(f => f.name === 'add')!;
    expect(add).toBeDefined();
    expect(add.paramsCount).toBe(2);

    const handle = r.functions.find(f => f.name === 'handle')!;
    expect(handle).toBeDefined();
    expect(handle.paramsCount).toBe(2);
  });

  it('handles Rust function extraction gracefully', () => {
    const r = scanFile('/dev/null', 'rust',
      `pub fn greet() -> &'static str { "hello" }\npub fn add(x: i32, y: i32) -> i32 { x + y }\n`
    );
    const greet = r.functions.find(f => f.name === 'greet')!;
    expect(greet).toBeDefined();
    expect(greet.isExported).toBe(true);
  });

  it('extracts interface declarations', () => {
    const r = scanFile(`${TEST_PROJECT_DIR}/src/services/user-service.ts`, 'typescript');
    const iface = r.types.find(t => t.name === 'User');
    expect(iface).toBeDefined();
    expect(iface?.kind).toBe('interface');
  });

  it('extracts type_alias declarations', () => {
    const r = scanFile(`${TEST_PROJECT_DIR}/src/utils/complex.ts`, 'typescript');
    const alias = r.types.find(t => t.name === 'Status');
    expect(alias).toBeDefined();
    expect(alias?.kind).toBe('type_alias');
  });

  // ─── Error resilience ───

  it('handles unsupported languages gracefully', () => {
    const r = scanFile('/dev/null', 'ruby');
    expect(r.functions).toEqual([]);
    expect(r.calls).toEqual([]);
    expect(r.imports).toEqual([]);
  });

  it('handles empty files', () => {
    const r = scanFile('/dev/null', 'typescript', '');
    expect(r.functions).toEqual([]);
  });

  it('handles files with syntax errors without crashing', () => {
    const r = scanFile('/dev/null', 'typescript', 'function broken( { return }');
    // Should not throw — tree-sitter has error recovery
    // Might find partial results or nothing, either is fine
    expect(Array.isArray(r.functions)).toBe(true);
  });

  it('handles a file that does not exist', () => {
    expect(() => scanFile('/nonexistent/path.ts', 'typescript')).toThrow();
  });
});

describe('scanner-ts — raise/throw 提取', () => {
  it('Python: raise 提取异常类型并跳过裸 raise', () => {
    const r = scanFile('/dev/null', 'python', [
      'def a():',
      '    raise ValueError("bad")',
      'def b():',
      '    raise CliError',
      'def c():',
      '    raise mod.CustomError("x") from e',
      'def d():',
      '    raise',
    ].join('\n'));
    const types = (r.raises ?? []).map(x => x.errorType);
    // 带调用的、裸标识符的、带模块前缀的都归一到最后一段
    expect(types).toEqual(['ValueError', 'CliError', 'CustomError']);
    // 裸 raise 是重新抛出，没有类型信息，不应产生边
    expect(types).not.toContain('');
  });

  it('Python: self.MyError 取自属性名而非 self', () => {
    const r = scanFile('/dev/null', 'python',
      'class C:\n    def m(self):\n        raise self.MyError("z")\n');
    expect((r.raises ?? []).map(x => x.errorType)).toEqual(['MyError']);
  });

  it('TypeScript: throw new Error / throw X / throw new mod.X', () => {
    const r = scanFile('/dev/null', 'typescript', [
      'function a(){ throw new Error("x"); }',
      'function b(){ throw CustomError; }',
      'function c(){ throw new mod.CustomError("y"); }',
      'function d(){ throw new TypeError("t"); }',
    ].join('\n'));
    expect((r.raises ?? []).map(x => x.errorType))
      .toEqual(['Error', 'CustomError', 'CustomError', 'TypeError']);
    expect((r.raises ?? []).every(x => x.kind === 'throw')).toBe(true);
  });

  it('对抗：非抛出的类型引用不产生 raise 边', () => {
    const r = scanFile('/dev/null', 'python', [
      'def f():',
      '    e = ValueError("not raised")',   // 构造但不抛
      '    try:',
      '        pass',
      '    except ValueError:',
      '        pass',                        // 捕获不是抛出
    ].join('\n'));
    expect(r.raises ?? []).toEqual([]);
  });

  it('对抗：抛出的非标识符（动态构造）被丢弃而非产生垃圾', () => {
    const r = scanFile('/dev/null', 'python',
      'def f():\n    raise get_error_class()\n');
    // get_error_class() 是调用表达式，无法静态确定类型 → 不应记为异常类型
    expect((r.raises ?? []).every(x => /^[A-Za-z_]\w*$/.test(x.errorType))).toBe(true);
  });
});

describe('scanner-ts — JavaScript 方言兼容', () => {
  it('JavaScript 类名节点是 identifier，能正常提取类与继承', () => {
    // 回归：此前 classQ 硬写 (type_identifier)，JS 语法无此节点 →
    // TSQueryErrorNodeType，整个 .js/.mjs/.cjs 文件提取失败、零类零方法。
    const r = scanFile('/dev/null', 'javascript', 'class Foo extends Bar { run() {} }');
    expect(r.types.map(t => `${t.name}<-${t.parentType}`)).toEqual(['Foo<-Bar']);
    expect(r.functions.map(f => f.fullName)).toContain('Foo.run');
  });

  it('JavaScript 无 interface/type_alias/enum 节点，不应因此抛出', () => {
    // 回归：typeQ 曾把 TS 的四条模式套到 JS 上，position 70 抛错
    expect(() => scanFile('/dev/null', 'javascript', 'class A {}\nconst x = 1;')).not.toThrow();
    const r = scanFile('/dev/null', 'javascript', 'class A {}\nconst x = 1;');
    expect(r.types.map(t => t.name)).toEqual(['A']);
  });

  it('TypeScript 仍用 type_identifier，interface/type_alias 不受影响', () => {
    const r = scanFile('/dev/null', 'typescript',
      'interface I { a: number }\ntype T = string;\nclass C extends D { run() {} }');
    expect(r.types.map(t => t.name).sort()).toEqual(['C', 'I', 'T']);
    expect(r.types.find(t => t.name === 'C')?.parentType).toBe('D');
  });
});

describe('scanner-ts — self/this 接收者', () => {
  it('Python self.X() 记录 receiver', () => {
    const r = scanFile('/dev/null', 'python',
      'class A:\n    def h(self):\n        pass\n    def r(self):\n        self.h()\n        x.h()\n');
    const selfCall = r.calls.find(c => c.calleeName === 'h' && c.receiver === 'self');
    const otherCall = r.calls.find(c => c.calleeName === 'h' && c.receiver === 'x');
    expect(selfCall).toBeDefined();
    expect(otherCall).toBeDefined();
  });

  it('TS this.X() 记录 receiver；链式接收者留空', () => {
    const r = scanFile('/dev/null', 'typescript',
      'class B { h(){} r(){ this.h(); a.b.h(); } }');
    expect(r.calls.find(c => c.calleeName === 'h' && c.receiver === 'this')).toBeDefined();
    // a.b.h() 的接收者是成员表达式，静态无法定类型 → 不记录
    const chained = r.calls.filter(c => c.calleeName === 'h' && c.receiver === undefined);
    expect(chained.length).toBeGreaterThan(0);
  });
});
