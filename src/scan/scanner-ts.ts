import Parser from 'tree-sitter';
import { readFileSync } from 'fs';
import { createRequire } from 'node:module';
const _require = createRequire(import.meta.url);

interface FunctionDef {
  name: string;
  fullName: string;
  kind: string;
  signature: string;
  body: string;
  lineStart: number;
  lineEnd: number;
  paramsCount: number;
  linesCount: number;
  isExported: boolean;
  isTest: boolean;
  docComment: string;
  tags: string[];
  complexity: number;
  paramsJson?: string;    // JSON: [{name, type, optional}]
  returnType?: string | null;
  summary?: string;       // one-line semantic summary
}

interface CallEdge {
  calleeName: string;
  callLine: number;
  callType: string;
  /**
   * 调用接收者文本（`obj` 之于 `obj.method()`）。
   * 只在能确定性提取时填入，供 call-graph 做零误报解析：
   *   - `self` / `cls` → 归属当前类，可直接解析
   *   - 其余（变量名等）→ 无法静态确定类型，保持 undefined，不参与解析
   * 绝不按「变量名恰好等于类名」之类的猜测解析，那会产生大规模误连。
   */
  receiver?: string;
}

interface ImportDecl {
  source: string;
  names: string[];
  line: number;
}

interface TypeField {
  name: string;
  fieldType: string;
  visibility?: string;   // pub | private | protected | default
  isOptional: boolean;
  defaultValue?: string;
  lineStart: number;
}

interface TypeDef {
  name: string;
  kind: string;
  parentType: string;
  implements: string[];
  genericParams: string[];
  lineStart: number;
  lineEnd: number;
  fields?: TypeField[];
}

interface BridgeCall {
  invokeName: string;    // e.g. 'add_server'
  callerName: string;    // enclosing function name (filled later)
  line: number;
  framework: string;     // tauri | electron | http
}

/** 抛出点：函数 → 抛出的异常类型。用于异常路径分析（漏洞挖掘核心）。 */
interface RaiseEdge {
  errorType: string;   // ValueError / CliError / HTTPException
  line: number;        // 抛出所在行
  kind: string;        // raise | throw
}

interface FileResult {
  functions: FunctionDef[];
  calls: CallEdge[];
  raises?: RaiseEdge[];
  imports: ImportDecl[];
  types: TypeDef[];
  tags: { name: string; line: number }[];
  bridgeCalls?: BridgeCall[];
}

const FEATURE_TAG_RE = /@feature:\s*([\w-]+)/g;
const TEST_PATTERNS = [/\.(test|spec|e2e)\.(ts|tsx|js|jsx)$/, /__tests__\//];

function isTestFile(filePath: string): boolean {
  return TEST_PATTERNS.some((p) => p.test(filePath));
}

// ─── Summary generation (rule engine, cross-language, no JSDoc required) ───

// Known API patterns → semantic label
const CALLEE_SEMANTICS: Record<string, string> = {
  // File I/O
  readFile: 'file I/O', readFileSync: 'file I/O', writeFile: 'file I/O',
  writeFileSync: 'file I/O', open: 'file I/O', fopen: 'file I/O',
  createReadStream: 'file I/O', createWriteStream: 'file I/O',
  appendFile: 'file I/O', appendFileSync: 'file I/O', unlink: 'file I/O',
  mkdir: 'file I/O', mkdirSync: 'file I/O', readdir: 'file I/O',
  stat: 'file I/O', access: 'file I/O',
  // Network
  fetch: 'network', axios: 'network', request: 'network',
  http: 'network', https: 'network', XMLHttpRequest: 'network',
  // Database
  query: 'database', execute: 'database', prepare: 'database',
  run: 'database', all: 'database', get: 'database',
  insert: 'database', update: 'database', delete: 'database',
  // System
  exec: 'system', spawn: 'system', fork: 'system', execSync: 'system',
  // JSON
  parse: 'parsing', stringify: 'serialization', JSON_parse: 'JSON parsing',
  JSON_stringify: 'JSON serialization',
  // Validation
  validate: 'validation', check: 'validation', verify: 'validation',
  assert: 'validation',
  // Transform
  map: 'data transform', filter: 'data transform', reduce: 'data transform',
  forEach: 'data transform', sort: 'data transform', flatMap: 'data transform',
};

// Meaningful name patterns → verb interpretation
const NAME_PATTERNS: Array<[RegExp, string]> = [
  [/^(get|fetch|load|read|retrieve|find|query|search|lookup)/i, 'get'],
  [/^(set|write|save|store|persist|update|put|patch)/i, 'set'],
  [/^(create|make|build|generate|init|new|construct|produce)/i, 'create'],
  [/^(delete|remove|destroy|drop|clear|clean|purge)/i, 'delete'],
  [/^(parse|decode|deserialize|extract|convert)/i, 'parse'],
  [/^(format|encode|serialize|stringify|render)/i, 'format'],
  [/^(validate|check|verify|assert|test|is|has|can)/i, 'validate'],
  [/^(handle|process|execute|run|perform|do|apply)/i, 'handle'],
  [/^(add|append|insert|push|enqueue)/i, 'add'],
  [/^(remove|pop|dequeue|shift|splice)/i, 'remove'],
  [/^(start|begin|open|launch|boot)/i, 'start'],
  [/^(stop|end|close|shutdown|halt|terminate)/i, 'stop'],
  [/^(send|emit|dispatch|publish|broadcast|notify)/i, 'send'],
  [/^(receive|subscribe|listen|on|watch|observe)/i, 'receive'],
  [/^(connect|link|join|merge|combine|concat)/i, 'connect'],
  [/^(disconnect|split|separate|divide|fork)/i, 'disconnect'],
  [/^(resolve|reject|fulfill|complete|finish|done)/i, 'resolve'],
  [/^(transform|map|convert|cast|coerce)/i, 'transform'],
  [/^(sort|order|rank|compare)/i, 'sort'],
  [/^(filter|select|pick|omit|exclude|include)/i, 'filter'],
  [/^(count|sum|avg|aggregate|accumulate)/i, 'aggregate'],
  [/^(traverse|walk|visit|iterate|loop|each)/i, 'traverse'],
  [/^(match|search|grep|scan)/i, 'search'],
  [/^(classify|categorize|group|partition)/i, 'classify'],
  [/^(register|subscribe|attach|hook)/i, 'register'],
  [/^(unregister|unsubscribe|detach|unhook)/i, 'unregister'],
];

function inferVerb(name: string): string | null {
  for (const [re, verb] of NAME_PATTERNS) {
    if (re.test(name)) return verb;
  }
  return null;
}

/**
 * Generate a one-line semantic summary for a function.
 * Uses structural signals only — no JSDoc or type annotation required.
 * Cross-language: works for any language that tree-sitter can parse.
 */
function generateSummary(params: {
  name: string;
  kind: string;
  paramsCount: number;
  complexity: number;
  linesCount: number;
  isExported: boolean;
  calleeNames: string[];
  body: string;
}): string {
  const parts: string[] = [];

  // 1. Infer verb from function name
  const verb = inferVerb(params.name);
  if (verb) {
    parts.push(verb);
  } else if (params.name.length > 2 && !/^[a-z]$/.test(params.name)) {
    // Use the function name directly if it's meaningful
    parts.push(params.name);
  }

  // 2. Detect side effects from callees
  const effects = new Set<string>();
  for (const callee of params.calleeNames) {
    const semantic = CALLEE_SEMANTICS[callee];
    if (semantic) effects.add(semantic);
  }
  if (effects.size > 0) {
    parts.push([...effects].join('+'));
  }

  // 3. Structure signals
  if (params.complexity > 15) parts.push('high complexity');
  if (params.linesCount > 100) parts.push('long function');
  if (params.complexity > 5 && params.linesCount > 50) parts.push('complex logic');

  // 4. Export signal
  if (params.isExported && parts.length === 0) {
    parts.push('exported ' + params.kind);
  }

  // 5. Fallback
  if (parts.length === 0) {
    if (params.kind === 'constructor') return 'constructor';
    if (params.kind === 'getter') return 'getter';
    if (params.kind === 'setter') return 'setter';
    return params.paramsCount + '-param ' + params.kind;
  }

  return parts.join(' · ');
}

const NESTED_FUNC_TYPES = new Set([
  'function_declaration', 'arrow_function', 'method_definition',
  'generator_function_declaration',
]);

// Control-flow node types that each add +1 to McCabe cyclomatic complexity.
const BRANCH_NODES = new Set([
  'if_statement',
  'for_statement', 'for_in_statement', 'while_statement',
  'do_statement', 'catch_clause', 'ternary_expression',
  'switch_case',
]);

/**
 * McCabe cyclomatic complexity via iterative BFS.
 *
 * Counts each control-flow decision point exactly once.
 * Skips nested function declarations so their branches
 * belong to them, not the parent.
 *
 * Uses a queue instead of recursion to avoid stack overflow
 * on deeply nested ASTs (e.g. a 2000-line function).
 */
function countComplexity(root: Parser.SyntaxNode): number {
  let c = 1; // base complexity
  const queue: Parser.SyntaxNode[] = [root];

  while (queue.length > 0) {
    const node = queue.pop()!;

    // Count control-flow branches
    if (BRANCH_NODES.has(node.type)) c++;

    // Count && and || in binary expressions
    if (node.type === 'binary_expression' && node.childCount >= 2) {
      const op = node.children[1];
      if (op && (op.type === '&&' || op.type === '||' ||
          (op.type === 'operator' && (op.text === '&&' || op.text === '||')))) c++;
    }

    // Enqueue named children, but skip nested function declarations
    for (let i = 0; i < node.namedChildCount; i++) {
      const child = node.namedChildren[i];
      if (NESTED_FUNC_TYPES.has(child.type)) continue;
      queue.push(child);
    }
  }

  return c;
}

function extractJsDocComment(node: Parser.SyntaxNode, src: string): string {
  // Try direct previousSibling first
  let cur: Parser.SyntaxNode | null = node.previousSibling;
  while (cur) {
    if (cur.type === 'comment') {
      const text = src.slice(cur.startIndex, cur.endIndex);
      if (text.startsWith('/**')) return text;
      break;
    }
    if (cur.type === ';' || cur.type === '}') break;
    cur = cur.previousSibling;
  }

  // Walk up to parent to find export_statement as sibling of comment
  let parent: Parser.SyntaxNode | null = node.parent;
  while (parent) {
    // Check if parent has a comment as previousSibling
    const ps = parent.previousSibling;
    if (ps && ps.type === 'comment') {
      const text = src.slice(ps.startIndex, ps.endIndex);
      if (text.startsWith('/**')) return text;
    }
    // Also check previousNamedSibling
    const pns = parent.previousNamedSibling;
    if (pns && pns.type === 'comment') {
      const text = src.slice(pns.startIndex, pns.endIndex);
      if (text.startsWith('/**')) return text;
    }
    parent = parent.parent;
    // Don't walk past program level
    if (parent && parent.type === 'program') break;
  }

  return '';
}

function extractTags(src: string, start: number, end: number): { name: string; line: number }[] {
  const tags: { name: string; line: number }[] = [];
  const text = src.slice(start, end);
  let m: RegExpExecArray | null;
  while ((m = FEATURE_TAG_RE.exec(text)) !== null) {
    const lineNum = src.slice(0, start + m.index).split('\n').length;
    tags.push({ name: m[1].trim(), line: lineNum });
  }
  return tags;
}

// ─── Type field extraction (TypeScript) ───
function extractFieldsTS(node: Parser.SyntaxNode, src: string, kind: string): TypeField[] {
  const fields: TypeField[] = [];

  if (kind === 'interface') {
    // interface_declaration > interface_body > property_signature
    const body = findChild(node, 'interface_body') || node;
    for (let i = 0; i < body.namedChildCount; i++) {
      const child = body.namedChildren[i];
      if (child.type === 'property_signature') {
        const nameNode = child.children.find((c: Parser.SyntaxNode) =>
          c.type === 'property_identifier' || c.type === 'identifier',
        );
        if (!nameNode) continue;
        const name = src.slice(nameNode.startIndex, nameNode.endIndex);
        const isOptional = child.children.some((c: Parser.SyntaxNode) => c.type === '?');
        const typeAnno = child.children.find((c: Parser.SyntaxNode) => c.type === 'type_annotation');
        const fieldType = typeAnno ? src.slice(typeAnno.startIndex + 1, typeAnno.endIndex).trim() : 'any';
        fields.push({
          name,
          fieldType,
          isOptional,
          lineStart: child.startPosition.row + 1,
        });
      } else if (child.type === 'method_signature') {
        const nameNode = child.children.find((c: Parser.SyntaxNode) =>
          c.type === 'property_identifier' || c.type === 'identifier',
        );
        if (!nameNode) continue;
        fields.push({
          name: src.slice(nameNode.startIndex, nameNode.endIndex),
          fieldType: 'method',
          isOptional: child.children.some((c: Parser.SyntaxNode) => c.type === '?'),
          lineStart: child.startPosition.row + 1,
        });
      } else if (child.type === 'index_signature') {
        fields.push({
          name: src.slice(child.startIndex, child.endIndex).split(':')[0].trim(),
          fieldType: 'index_signature',
          isOptional: false,
          lineStart: child.startPosition.row + 1,
        });
      }
    }
  } else if (kind === 'class') {
    // class members: public_field_definition or property_definition
    const body = node.children.find((c: Parser.SyntaxNode) => c.type === 'class_body');
    if (!body) return fields;
    for (let i = 0; i < body.namedChildCount; i++) {
      const child = body.namedChildren[i];
      if (child.type === 'public_field_definition' || child.type === 'property_definition' || child.type === 'field_definition') {
        const nameNode = child.children.find((c: Parser.SyntaxNode) =>
          c.type === 'property_identifier' || c.type === 'identifier',
        );
        if (!nameNode) continue;
        const name = src.slice(nameNode.startIndex, nameNode.endIndex);
        // visibility modifier
        let vis: string | undefined;
        const accessMod = child.children.find((c: Parser.SyntaxNode) =>
          c.type === 'accessibility_modifier' || c.type === 'visibility_modifier',
        );
        if (accessMod) vis = src.slice(accessMod.startIndex, accessMod.endIndex);
        const typeAnno = child.children.find((c: Parser.SyntaxNode) => c.type === 'type_annotation');
        const fieldType = typeAnno ? src.slice(typeAnno.startIndex + 1, typeAnno.endIndex).trim() : 'any';
        fields.push({
          name,
          fieldType,
          visibility: vis || 'default',
          isOptional: false,
          lineStart: child.startPosition.row + 1,
        });
      }
    }
  } else if (kind === 'type_alias') {
    // type alias with object body: type Foo = { x: number; y: string }
    const objType = findChild(node, 'object_type') || findChild(node, 'mapped_type_clause');
    if (objType) {
      for (let i = 0; i < objType.namedChildCount; i++) {
        const child = objType.namedChildren[i];
        if (child.type === 'property_signature') {
          const nameNode = child.children.find((c: Parser.SyntaxNode) =>
            c.type === 'property_identifier' || c.type === 'identifier',
          );
          if (!nameNode) continue;
          const name = src.slice(nameNode.startIndex, nameNode.endIndex);
          const isOptional = child.children.some((c: Parser.SyntaxNode) => c.type === '?');
          const typeAnno = child.children.find((c: Parser.SyntaxNode) => c.type === 'type_annotation');
          const fieldType = typeAnno ? src.slice(typeAnno.startIndex + 1, typeAnno.endIndex).trim() : 'any';
          fields.push({
            name,
            fieldType,
            isOptional,
            lineStart: child.startPosition.row + 1,
          });
        }
      }
    }
  } else if (kind === 'enum') {
    // enum members: property_identifier children inside enum_body
    const body = findChild(node, 'enum_body');
    if (body) {
      for (let i = 0; i < body.namedChildCount; i++) {
        const child = body.namedChildren[i];
        if (child.type === 'property_identifier' || child.type === 'enum_assignment') {
          const nameNode = child.type === 'enum_assignment'
            ? child.children.find((c: Parser.SyntaxNode) => c.type === 'property_identifier')
            : child;
          if (!nameNode) continue;
          const name = src.slice(nameNode.startIndex, nameNode.endIndex);
          fields.push({
            name,
            fieldType: 'enum_member',
            isOptional: false,
            lineStart: child.startPosition.row + 1,
          });
        }
      }
    }
  }

  return fields;
}

// ─── Type field extraction (Rust) ───
function extractFieldsRust(node: Parser.SyntaxNode, src: string, kind: string): TypeField[] {
  const fields: TypeField[] = [];

  if (kind === 'struct') {
    // struct_body contains field_declaration entries
    const body = findChild(node, 'field_declaration_list') || findChild(node, 'struct_body');
    if (!body) return fields;
    for (let i = 0; i < body.namedChildCount; i++) {
      const child = body.namedChildren[i];
      if (child.type === 'field_declaration') {
        const nameNode = child.children.find((c: Parser.SyntaxNode) => c.type === 'field_identifier' || c.type === 'identifier');
        if (!nameNode) continue;
        const name = src.slice(nameNode.startIndex, nameNode.endIndex);
        // visibility: pub keyword
        const hasPub = child.children.some((c: Parser.SyntaxNode) =>
          c.type === 'visibility_modifier' || src.slice(c.startIndex, c.endIndex) === 'pub',
        );
        // Find the type after ':'
        const colonIdx = child.children.findIndex((c: Parser.SyntaxNode) => c.type === ':');
        let fieldType = 'unknown';
        if (colonIdx >= 0 && colonIdx + 1 < child.children.length) {
          fieldType = src.slice(child.children[colonIdx + 1].startIndex, child.children[colonIdx + 1].endIndex).trim();
        }
        fields.push({
          name,
          fieldType,
          visibility: hasPub ? 'pub' : 'private',
          isOptional: false,
          lineStart: child.startPosition.row + 1,
        });
      }
    }
  } else if (kind === 'enum') {
    // enum variants as field-like entries
    const body = findChild(node, 'enum_variant_list') || findChild(node, 'enum_body');
    if (!body) return fields;
    for (let i = 0; i < body.namedChildCount; i++) {
      const child = body.namedChildren[i];
      if (child.type === 'enum_variant') {
        const nameNode = child.children.find((c: Parser.SyntaxNode) => c.type === 'identifier');
        if (!nameNode) continue;
        fields.push({
          name: src.slice(nameNode.startIndex, nameNode.endIndex),
          fieldType: 'enum_variant',
          isOptional: false,
          lineStart: child.startPosition.row + 1,
        });
      }
    }
  }

  return fields;
}

function findChild(node: Parser.SyntaxNode, type: string): Parser.SyntaxNode | null {
  for (let i = 0; i < node.childCount; i++) {
    if (node.children[i].type === type) return node.children[i];
  }
  return null;
}

// ─── Bridge call extraction (invoke patterns) ───
function extractBridgeCalls(src: string, functions: FunctionDef[]): BridgeCall[] {
  const bridges: BridgeCall[] = [];
  // Match: invoke<Type>('xxx') or invoke('xxx') or invoke<Type>("xxx")
  const invokeRe = /invoke\s*(?:<[^>]*>)?\s*\(\s*['"]([\w.\-]+)['"]/g;
  let match: RegExpExecArray | null;
  while ((match = invokeRe.exec(src)) !== null) {
    const line = src.substring(0, match.index).split('\n').length;
    // Find enclosing function
    const caller = functions.find(f => line >= f.lineStart && line <= f.lineEnd);
    bridges.push({
      invokeName: match[1],
      callerName: caller?.name || '',
      line,
      framework: 'tauri',
    });
  }
  return bridges;
}

// ─── Param type extraction from signature ───
function extractParamTypes(paramsNode: Parser.SyntaxNode | null, src: string): { name: string; type: string; optional: boolean }[] {
  if (!paramsNode) return [];
  const result: { name: string; type: string; optional: boolean }[] = [];
  for (const child of paramsNode.namedChildren) {
    if (!['required_parameter', 'optional_parameter', 'rest_parameter'].includes(child.type)) continue;
    const nameNode = child.children.find((c: Parser.SyntaxNode) =>
      c.type === 'identifier' || c.type === 'rest_pattern',
    );
    const name = nameNode ? src.slice(nameNode.startIndex, nameNode.endIndex) : '';
    const typeAnno = child.children.find((c: Parser.SyntaxNode) => c.type === 'type_annotation');
    const type = typeAnno ? src.slice(typeAnno.startIndex + 1, typeAnno.endIndex).trim() : 'any';
    const optional = child.type === 'optional_parameter' || child.children.some((c: Parser.SyntaxNode) => c.type === '?');
    result.push({ name, type, optional });
  }
  return result;
}

function extractReturnType(node: Parser.SyntaxNode, src: string): string | null {
  // Walk tree to find type_annotation that follows formal_parameters
  function findReturn(n: Parser.SyntaxNode): string | null {
    for (let i = 0; i < n.childCount; i++) {
      const child = n.children[i];
      if (child.type === 'type_annotation' && i > 0 && n.children[i - 1].type === 'formal_parameters') {
        return src.slice(child.startIndex + 1, child.endIndex).trim();
      }
    }
    // Recurse into all named children (covers variable_declarator, arrow_function, etc.)
    for (let i = 0; i < n.namedChildCount; i++) {
      const r = findReturn(n.namedChildren[i]);
      if (r) return r;
    }
    return null;
  }
  return findReturn(node);
}

function extractGoSignature(funcNode: Parser.SyntaxNode, src: string): string {
  // Extract func (recv) name(params) returns { — up to first '{'
  const text = src.slice(funcNode.startIndex, funcNode.endIndex);
  const braceIdx = text.indexOf('{');
  if (braceIdx > 0) return text.slice(0, braceIdx).trim();
  // fallback: first line
  const nlIdx = text.indexOf('\n');
  return (nlIdx > 0 ? text.slice(0, nlIdx) : text).trim();
}

// ─── Python helpers ───
// Python 的 import_from_statement 形如：
//   from core.supervisor import task_scheduler
//   from . import lease_manager as lm
//   from .mod import (a, b)
// 拆成 source（含相对前缀）与 names，供调用图与延迟导入解析使用。
function extractPythonImports(
  node: Parser.SyntaxNode,
  src: string,
): { source: string; names: string[]; line: number } | { source: string; names: string[]; line: number }[] {
  const text = src.slice(node.startIndex, node.endIndex);
  const line = node.startPosition.row + 1;

  // import os / import os, sys / import numpy as np
  if (node.type === 'import_statement') {
    const out: { source: string; names: string[]; line: number }[] = [];
    for (const child of node.namedChildren) {
      if (child.type === 'dotted_name') {
        out.push({ source: src.slice(child.startIndex, child.endIndex), names: [], line });
      } else if (child.type === 'aliased_import') {
        const nm = child.namedChildren.find(c => c.type === 'dotted_name');
        const alias = child.namedChildren.find(c => c.type === 'identifier');
        const mod = nm ? src.slice(nm.startIndex, nm.endIndex) : '';
        out.push({
          source: mod,
          names: alias ? [src.slice(alias.startIndex, alias.endIndex)] : [],
          line,
        });
      }
    }
    return out;
  }

  // from X import a, b
  const rel = node.namedChildren.find(c => c.type === 'relative_import');
  const absMod = node.namedChildren.find(c => c.type === 'dotted_name');
  let source = '';
  if (rel) {
    // relative_import 内部含 import_prefix("."/"..") 与可选 dotted_name
    const prefixNode = rel.namedChildren.find(c => c.type === 'import_prefix');
    const modNode = rel.namedChildren.find(c => c.type === 'dotted_name');
    source = (prefixNode ? src.slice(prefixNode.startIndex, prefixNode.endIndex) : '') +
             (modNode ? src.slice(modNode.startIndex, modNode.endIndex) : '');
    if (!source) source = '.';
  } else if (absMod) {
    source = src.slice(absMod.startIndex, absMod.endIndex);
  }

  // import 子句里的名字（可能带圆括号、别名、通配符）
  const names: string[] = [];
  let sawImportWord = false;
  for (const child of node.children) {
    if (child.type === 'import') { sawImportWord = true; continue; }
    if (!sawImportWord) continue;
    collectImportNames(child, src, names);
  }
  return { source, names, line };
}

function collectImportNames(node: Parser.SyntaxNode, src: string, out: string[]): void {
  if (node.type === 'dotted_name') {
    const t = src.slice(node.startIndex, node.endIndex);
    const last = t.split('.').pop();
    if (last) out.push(last);
    return;
  }
  if (node.type === 'identifier') {
    out.push(src.slice(node.startIndex, node.endIndex));
    return;
  }
  if (node.type === 'aliased_import') {
    const alias = node.namedChildren.find(c => c.type === 'identifier');
    const orig = node.namedChildren.find(c => c.type === 'dotted_name');
    const val = alias ? src.slice(alias.startIndex, alias.endIndex)
              : orig ? src.slice(orig.startIndex, orig.endIndex).split('.').pop() : null;
    if (val) out.push(val);
    return;
  }
  if (node.type === 'wildcard_import') { out.push('*'); return; }
  if (node.type === 'import_prefix' || node.type === 'relative_import') return;
  for (const c of node.children) collectImportNames(c, src, out);
}

// Python 函数签名：去掉函数体，保留 def 行（含装饰器之外的 def 与续行）
function extractPythonSignature(funcNode: Parser.SyntaxNode, src: string): string {
  const body = findChild(funcNode, 'block');
  if (body) {
    return src.slice(funcNode.startIndex, body.startIndex).trim().replace(/[\s\n]+$/, '');
  }
  const text = src.slice(funcNode.startIndex, funcNode.endIndex);
  return text.split('\n')[0].trim();
}

// Python 参数：def f(a, b: int = 1, *args, **kwargs)
function extractPythonParams(paramsNode: Parser.SyntaxNode | null, src: string): { name: string; type: string; optional: boolean }[] {
  if (!paramsNode) return [];
  const out: { name: string; type: string; optional: boolean }[] = [];
  for (const child of paramsNode.namedChildren) {
    let nameNode: Parser.SyntaxNode | null = null;
    let typeNode: Parser.SyntaxNode | null = null;
    let hasDefault = false;

    if (child.type === 'identifier') {
      nameNode = child;
    } else if (child.type === 'typed_parameter') {
      nameNode = child.namedChildren.find(c => c.type === 'identifier') ?? null;
      typeNode = child.namedChildren.find(c => c.type === 'type') ?? null;
    } else if (child.type === 'default_parameter') {
      nameNode = child.namedChildren.find(c => c.type === 'identifier') ?? null;
      hasDefault = true;
    } else if (child.type === 'typed_default_parameter') {
      nameNode = child.namedChildren.find(c => c.type === 'identifier') ?? null;
      typeNode = child.namedChildren.find(c => c.type === 'type') ?? null;
      hasDefault = true;
    } else if (child.type === 'list_splat_pattern' || child.type === 'dictionary_splat_pattern') {
      nameNode = child.namedChildren.find(c => c.type === 'identifier') ?? null;
    }

    if (!nameNode) continue;
    const name = src.slice(nameNode.startIndex, nameNode.endIndex);
    if (name === 'self' || name === 'cls') continue;
    out.push({
      name,
      type: typeNode ? src.slice(typeNode.startIndex, typeNode.endIndex) : 'any',
      optional: hasDefault,
    });
  }
  return out;
}

// Python 返回类型：def f(...) -> str:
function extractPythonReturnType(funcNode: Parser.SyntaxNode, src: string): string | null {
  const ret = funcNode.children.find(c => c.type === 'type');
  if (!ret) return null;
  return src.slice(ret.startIndex, ret.endIndex).trim();
}

/**
 * Tree-sitter Query 编译缓存。
 *
 * 实测：`new Parser.Query()` 约 6.3ms/次，而每个文件要建 6~13 个 Query，
 * 980 文件重复编译同一批查询串，光编译就吃掉约 5.8s（占解析阶段 20%）。
 * 查询串与语言一一对应，是纯函数输入，可以安全地按 `语言 + 查询串` 缓存复用。
 * Query 对象不可变且可并发 matches()，跨文件复用无副作用。
 */
const queryCache = new Map<string, Parser.Query>();

function getQuery(langModule: unknown, language: string, source: string): Parser.Query {
  const key = `${language}\u0000${source}`;
  const hit = queryCache.get(key);
  if (hit) return hit;
  const q = new Parser.Query(langModule as never, source);
  queryCache.set(key, q);
  return q;
}

export function scanFile(filePath: string, language: string, source?: string): FileResult {
  const src = source ?? readFileSync(filePath, 'utf-8');
  const testFiles = isTestFile(filePath);
  const fileTags = extractTags(src, 0, src.length);

  const functions: FunctionDef[] = [];
  const calls: CallEdge[] = [];
  const raises: RaiseEdge[] = [];
  const imports: ImportDecl[] = [];
  const types: TypeDef[] = [];
  const allTags: { name: string; line: number }[] = [...fileTags];

  let langModule: any;
  try {
    if (language === 'typescript' || language === 'tsx') langModule = _require('tree-sitter-typescript').typescript;
    else if (language === 'javascript' || language === 'jsx') langModule = _require('tree-sitter-javascript');
    else if (language === 'python') langModule = _require('tree-sitter-python');
    else if (language === 'go') langModule = _require('tree-sitter-go');
    else if (language === 'rust') langModule = _require('tree-sitter-rust');
    else if (language === 'java') langModule = _require('tree-sitter-java');
    else return { functions, calls, raises, imports, types, tags: allTags };
  } catch (e: unknown) {
    console.warn('[codindex] scanner: language not available', (e as Error)?.message ?? String(e));
    return { functions, calls, raises, imports, types, tags: allTags };
  }

  const parser = new Parser();
  parser.setLanguage(langModule);
  const tree = parser.parse(src);
  const root = tree.rootNode;

  // ─── Functions + Calls + Imports + Types (TS/JS only) ───
  const isTS = ['typescript', 'tsx', 'javascript', 'jsx'].includes(language);
  // JavaScript 与 JSX 共用 tree-sitter-javascript 语法，节点类型完全一致：
  // 类名是 identifier、没有 interface/type_alias/enum、class_heritage 是扁平结构。
  // 此前这些判断只写了 'javascript'，导致 .jsx 文件抛 TSQueryErrorNodeType。
  const isPlainJS = language === 'javascript' || language === 'jsx';

  // ponytail: language-specific parsers are inline below.
  // Extract each into scanFileTS/scanFileRust/scanFileGo/scanFilePython
  // when the 93-complexity function is split.

  if (isTS) {
  // ─── Functions ───
  const funcQ = getQuery(langModule, language, `
    (function_declaration name: (identifier) @name) @func
    (lexical_declaration (variable_declarator name: (identifier) @name value: (arrow_function))) @arrow
    (method_definition name: (property_identifier) @name) @method
    (generator_function_declaration name: (identifier) @name) @gen
  `);
  const funcMatches = funcQ.matches(root);

  // Pre-collect class names for fullName resolution
  const classNames = new Map<number, string>();
  // JavaScript 的类名节点是 `identifier`，TypeScript/TSX 才是 `type_identifier`。
  // 两者语法里都不存在对方那个节点类型，所以 `[(a) (b)]` 别名写法会在其中一侧
  // 直接抛 TSQueryErrorNodeType（整个文件提取失败），必须按语言分别构造。
  const classNameNodeType = isPlainJS ? 'identifier' : 'type_identifier';
  const classQ = getQuery(langModule, language, `(class_declaration name: (${classNameNodeType}) @name) @class`);
  for (const m of classQ.matches(root)) {
    const node = m.captures.find(c => c.name === 'class')?.node;
    const nameNode = m.captures.find(c => c.name === 'name')?.node;
    if (node && nameNode) {
      for (let r = node.startPosition.row; r <= node.endPosition.row; r++) {
        classNames.set(r, src.slice(nameNode.startIndex, nameNode.endIndex));
      }
    }
  }

  // H4 fix: extract calls BEFORE functions so generateSummary() can use callee info
  const callQ = getQuery(langModule, language, `
    (call_expression function: (identifier) @callee) @call
    (call_expression function: (member_expression property: (property_identifier) @callee)) @method_call
  `);
  for (const m of callQ.matches(root)) {
    const callNode = m.captures.find(c => c.name === 'call' || c.name === 'method_call')?.node;
    const calleeNode = m.captures.find(c => c.name === 'callee')?.node;
    if (!callNode || !calleeNode) continue;

    // 方法调用时记录接收者（member_expression 的 object），
    // 仅纯标识符或 this 可用于确定性解析；其余留空。
    let receiver: string | undefined;
    if (m.pattern === 1) {
      const memberExpr = callNode.childForFieldName('function');
      const obj = memberExpr?.childForFieldName('object');
      if (obj && (obj.type === 'identifier' || obj.type === 'this')) {
        receiver = src.slice(obj.startIndex, obj.endIndex);
      }
    }

    calls.push({
      calleeName: src.slice(calleeNode.startIndex, calleeNode.endIndex),
      callLine: callNode.startPosition.row + 1,
      callType: m.pattern === 0 ? 'direct' : 'method',
      receiver,
    });
  }

  for (const m of funcMatches) {
    const patIdx = m.pattern;
    const wholeNode = m.captures.find(c => ['func', 'arrow', 'method', 'gen'].includes(c.name))?.node;
    const nameNode = m.captures.find(c => c.name === 'name')?.node;
    if (!wholeNode || !nameNode) continue;

    // BUG-8 fix: skip arrow functions inside JSX attributes (e.g., onMouseEnter={e => ...})
    if (patIdx === 1) {
      let parent = wholeNode.parent;
      let insideJsx = false;
      while (parent) {
        if (parent.type === 'jsx_attribute' || parent.type === 'jsx_expression') {
          insideJsx = true;
          break;
        }
        parent = parent.parent;
      }
      if (insideJsx) continue;
    }

    const name = src.slice(nameNode.startIndex, nameNode.endIndex);
    const startRow = wholeNode.startPosition.row + 1;
    const endRow = wholeNode.endPosition.row + 1;
    const docComment = extractJsDocComment(wholeNode, src);

    let kind = 'function';
    if (patIdx === 1) kind = 'arrow';
    else if (patIdx === 2) kind = 'method';
    else if (patIdx === 3) kind = 'generator';

    // fullName: className.methodName
    let fullName = name;
    const className = classNames.get(wholeNode.startPosition.row);
    if (className) fullName = `${className}.${name}`;

    // signature
    let sig = name;

    // Find formal_parameters anywhere inside the node tree
    function findParams(n: Parser.SyntaxNode): Parser.SyntaxNode | null {
      for (let i = 0; i < n.childCount; i++) {
        if (n.children[i].type === 'formal_parameters') return n.children[i];
        const found = findParams(n.children[i]);
        if (found) return found;
      }
      return null;
    }

    const paramsNode = findParams(wholeNode);
    if (paramsNode) sig = name + src.slice(paramsNode.startIndex, paramsNode.endIndex);

    // params count
    const params = paramsNode
      ? paramsNode.namedChildren.filter((c: Parser.SyntaxNode) =>
          ['required_parameter', 'optional_parameter', 'rest_parameter'].includes(c.type),
        )
      : [];

    // export check
    let isExported = false;
    if (patIdx === 0 || patIdx === 1 || patIdx === 3) {
      let p: Parser.SyntaxNode | null = wholeNode.parent;
      while (p) {
        if (p.type === 'export_statement') { isExported = true; break; }
        p = p.parent;
      }
    }

    const funcTags = extractTags(src, wholeNode.startIndex, wholeNode.endIndex);
    if (docComment) {
      const dcIdx = src.indexOf(docComment);
      if (dcIdx >= 0) funcTags.push(...extractTags(src, dcIdx, dcIdx + docComment.length));
    }
    allTags.push(...funcTags);

    const fnBody = src.slice(wholeNode.startIndex, wholeNode.endIndex);
    const fnComplexity = countComplexity(wholeNode);

    // Collect callee names from calls that fall within this function's range
    const fnCallees: string[] = [];
    for (const c of calls) {
      if (c.callLine >= startRow && c.callLine <= endRow) {
        fnCallees.push(c.calleeName);
      }
    }

    const summary = generateSummary({
      name,
      kind,
      paramsCount: params.length,
      complexity: fnComplexity,
      linesCount: endRow - startRow + 1,
      isExported,
      calleeNames: fnCallees,
      body: fnBody,
    });

    functions.push({
      name,
      fullName,
      kind,
      signature: sig,
      body: fnBody,
      lineStart: startRow,
      lineEnd: endRow,
      paramsCount: params.length,
      linesCount: endRow - startRow + 1,
      isExported,
      isTest: testFiles,
      docComment,
      tags: funcTags.map(t => t.name),
      complexity: fnComplexity,
      paramsJson: JSON.stringify(extractParamTypes(paramsNode, src)),
      returnType: extractReturnType(wholeNode, src),
      summary,
    });
  }

  // ─── Imports ───
  const importQ = getQuery(langModule, language, `
    (import_statement source: (string) @source) @import
  `);
  for (const m of importQ.matches(root)) {
    const importNode = m.captures.find(c => c.name === 'import')?.node;
    const sourceNode = m.captures.find(c => c.name === 'source')?.node;
    if (!importNode || !sourceNode) continue;

    const srcName = src.slice(sourceNode.startIndex + 1, sourceNode.endIndex - 1);
    const line = importNode.startPosition.row + 1;

    // Extract named imports
    const names: string[] = [];
    const clause = importNode.children.find((c: Parser.SyntaxNode) =>
      c.type === 'import_clause' || c.type === 'namespace_import',
    );
    if (clause) {
      // Check direct identifiers (default imports like `import React from 'react'`)
      for (const id of clause.children.filter((c: Parser.SyntaxNode) =>
        c.type === 'identifier',
      )) {
        names.push(src.slice(id.startIndex, id.endIndex));
      }
      // Check named_imports sub-clause (`import { foo, bar } from ...`)
      const named = clause.children.find((c: Parser.SyntaxNode) => c.type === 'named_imports');
      if (named) {
        for (const spec of named.namedChildren.filter((c: Parser.SyntaxNode) =>
          c.type === 'import_specifier',
        )) {
          const nameNode = spec.children.find((c: Parser.SyntaxNode) =>
            c.type === 'identifier' || c.type === 'property_identifier',
          );
          if (nameNode) names.push(src.slice(nameNode.startIndex, nameNode.endIndex));
        }
      }
    }

    imports.push({ source: srcName, names, line });
  }

  // ─── Types ───
  // JavaScript 没有 interface / type_alias 节点，也没有 type_identifier。
  // 把 TS 的四条模式直接套到 JS 上会抛 TSQueryErrorNodeType 并让整个文件
  // 提取失败，因此按语言构造：JS 只查 class + enum。
  const typeQ = isPlainJS
    ? getQuery(langModule, language, `
        (class_declaration name: (identifier) @name) @class
      `)
    : getQuery(langModule, language, `
        (class_declaration name: (type_identifier) @name) @class
        (interface_declaration name: (type_identifier) @name) @interface
        (enum_declaration name: (identifier) @name) @enum
        (type_alias_declaration name: (type_identifier) @name) @type_alias
      `);
  // JS 只有 class（无 interface/type_alias/enum 节点）
  const kindMap: Record<number, string> = isPlainJS
    ? { 0: 'class' }
    : { 0: 'class', 1: 'interface', 2: 'enum', 3: 'type_alias' };

  for (const m of typeQ.matches(root)) {
    const kind = kindMap[m.pattern];
    const node = m.captures.find(c => c.name === kind)?.node;
    const nameNode = m.captures.find(c => c.name === 'name')?.node;
    if (!node || !nameNode) continue;

    const name = src.slice(nameNode.startIndex, nameNode.endIndex);
    const startRow = node.startPosition.row + 1;
    const endRow = node.endPosition.row + 1;

    let parentType = '';
    let implementsList: string[] = [];
    let genericParams: string[] = [];

    if (m.pattern === 0) {
      for (let i = 0; i < node.childCount; i++) {
        const c = node.children[i];
        // TypeScript: class_heritage 内是嵌套的 extends_clause
        if (c.type === 'extends_clause' && c.namedChildCount > 0) {
          parentType = src.slice(c.namedChild(0)!.startIndex, c.namedChild(0)!.endIndex);
        }
        // TS 的 extends_clause 也可能嵌在 class_heritage 里（视语法版本）
        if (c.type === 'class_heritage') {
          const ext = c.namedChildren.find(nc => nc.type === 'extends_clause');
          const inner = ext?.namedChildCount ? ext.namedChild(0) : null;
          if (inner) {
            parentType = src.slice(inner.startIndex, inner.endIndex);
          }
        }
        // JavaScript: class_heritage 是扁平的 [extends, identifier]，
        // 没有 extends_clause 包裹，必须直接取其中的标识符节点。
        if (isPlainJS && c.type === 'class_heritage') {
          const idNode = c.namedChildren.find(
            nc => nc.type === 'identifier' || nc.type === 'member_expression',
          );
          if (idNode) parentType = src.slice(idNode.startIndex, idNode.endIndex);
        }
        if (c.type === 'implements_clause') {
          implementsList = c.namedChildren
            .filter(nc => nc.type === 'type_identifier')
            .map(nc => src.slice(nc.startIndex, nc.endIndex));
        }
      }
    }

    // generic params
    const typeParams = node.children.find((c: Parser.SyntaxNode) => c.type === 'type_parameters');
    if (typeParams) {
      genericParams = typeParams.namedChildren
        .filter(nc => nc.type === 'type_identifier')
        .map(nc => src.slice(nc.startIndex, nc.endIndex));
    }

    types.push({
      name, kind, parentType, implements: implementsList,
      genericParams, lineStart: startRow, lineEnd: endRow,
      fields: extractFieldsTS(node, src, kind),
    });
  }
  } // end if (isTS)

  // ─── Rust Functions ───
  if (language === 'rust') {
    try {
      const rustFuncQ = getQuery(langModule, language, `
        (function_item
          name: (identifier) @name
          parameters: (parameters) @params
        ) @func
      `);
      for (const m of rustFuncQ.matches(root)) {
        const funcNode = m.captures.find(c => c.name === 'func')?.node;
        const nameNode = m.captures.find(c => c.name === 'name')?.node;
        const paramsNode = m.captures.find(c => c.name === 'params')?.node;
        if (!funcNode || !nameNode) continue;

        const name = src.slice(nameNode.startIndex, nameNode.endIndex);
        const funcText = src.slice(funcNode.startIndex, funcNode.endIndex);

        // Check preceding siblings for tauri::command attribute
        const parent = funcNode.parent;
        const hasTauriCommand = parent
          ? [...Array(parent.childCount).keys()]
              .filter(i => i < parent.children.indexOf(funcNode))
              .some(i => {
                const sib = parent.children[i];
                return sib.type === 'attribute_item' &&
                  src.slice(sib.startIndex, sib.endIndex).includes('tauri::command');
              })
          : false;

        // Extract return type from source (after '-> ')
        const retMatch = funcText.match(/->\s*([^\{]+)/);
        const returnType = retMatch ? retMatch[1].trim() : '';
        const sig = name + (paramsNode ? src.slice(paramsNode.startIndex, paramsNode.endIndex) : '') +
          (returnType ? ' -> ' + returnType : '');

        functions.push({
          name,
          fullName: name,
          kind: 'function',
          signature: sig,
          body: funcText,
          lineStart: funcNode.startPosition.row + 1,
          lineEnd: funcNode.endPosition.row + 1,
          paramsCount: paramsNode ? paramsNode.namedChildCount : 0,
          linesCount: funcNode.endPosition.row - funcNode.startPosition.row + 1,
          isExported: funcText.startsWith('pub '),
          isTest: false,
          docComment: '',
          tags: hasTauriCommand ? ['@tauri:command'] : [],
          complexity: countComplexity(funcNode),
          paramsJson: '[]',
          returnType,
        });
      }
    } catch { /* rust func query may fail on some grammars */ }
  }

  // ─── Rust Types (struct / enum) ───
  if (language === 'rust') {
    try {
      const rustTypeQ = getQuery(langModule, language, `
        (struct_item (type_identifier) @name) @struct
        (enum_item (type_identifier) @name) @enum
      `);
      const rustKindMap: Record<number, string> = { 0: 'struct', 1: 'enum' };
      for (const m of rustTypeQ.matches(root)) {
        const kind = rustKindMap[m.pattern];
        const node = m.captures.find(c => c.name === 'struct' || c.name === 'enum')?.node;
        const nameNode = m.captures.find(c => c.name === 'name')?.node;
        if (!node || !nameNode) continue;
        const name = src.slice(nameNode.startIndex, nameNode.endIndex);
        types.push({
          name, kind, parentType: '', implements: [], genericParams: [],
          lineStart: node.startPosition.row + 1,
          lineEnd: node.endPosition.row + 1,
          fields: extractFieldsRust(node, src, kind),
        });
      }
    } catch { /* rust type query may fail on some grammars */ }
  }

  // ─── Go Functions + Imports + Calls ───
  if (language === 'go') {
    try {
      // Go imports: import "path" and import ( "path1" "path2" )
      const goImportQ = getQuery(langModule, language, `
        (import_declaration (import_spec path: (interpreted_string_literal) @path)) @import
        (import_declaration (import_spec_list (import_spec path: (interpreted_string_literal) @path))) @import_group
      `);
      for (const m of goImportQ.matches(root)) {
        const pathNode = m.captures.find(c => c.name === 'path')?.node;
        if (!pathNode) continue;
        const importPath = src.slice(pathNode.startIndex + 1, pathNode.endIndex - 1); // strip quotes
        imports.push({ source: importPath, names: [], line: pathNode.startPosition.row + 1 });
      }

      // Go functions: func name(...) ... { } and func (recv Type) name(...) ... { }
      const goFuncQ = getQuery(langModule, language, `
        (function_declaration name: (identifier) @name) @func
        (method_declaration name: (field_identifier) @name) @method
      `);
      for (const m of goFuncQ.matches(root)) {
        const funcNode = m.captures.find(c => c.name === 'func' || c.name === 'method')?.node;
        const nameNode = m.captures.find(c => c.name === 'name')?.node;
        if (!funcNode || !nameNode) continue;
        const name = src.slice(nameNode.startIndex, nameNode.endIndex);
        const funcText = src.slice(funcNode.startIndex, funcNode.endIndex);
        const isExported = /^[A-Z]/.test(name);
        functions.push({
          name,
          fullName: name,
          kind: m.pattern === 1 ? 'method' : 'function',
          signature: extractGoSignature(funcNode, src),
          body: funcText,
          lineStart: funcNode.startPosition.row + 1,
          lineEnd: funcNode.endPosition.row + 1,
          paramsCount: (() => { const m = funcText.match(/,/g); return m ? m.length + 1 : (funcText.includes('(') && funcText.includes(')') && funcText.match(/\w+\s+\w+/g) ? 1 : 0); })(),
          linesCount: funcNode.endPosition.row - funcNode.startPosition.row + 1,
          isExported,
          isTest: filePath.endsWith('_test.go'),
          docComment: '',
          tags: [],
          complexity: countComplexity(funcNode),
          paramsJson: '[]',
          returnType: '',
        });
      }

      // Go calls: name(...) and recv.method(...)
      const goCallQ = getQuery(langModule, language, `
        (call_expression function: (identifier) @callee) @call
        (call_expression function: (selector_expression field: (field_identifier) @callee)) @method_call
      `);
      for (const m of goCallQ.matches(root)) {
        const callNode = m.captures.find(c => c.name === 'call' || c.name === 'method_call')?.node;
        const calleeNode = m.captures.find(c => c.name === 'callee')?.node;
        if (!callNode || !calleeNode) continue;
        calls.push({
          calleeName: src.slice(calleeNode.startIndex, calleeNode.endIndex),
          callLine: callNode.startPosition.row + 1,
          callType: m.pattern === 0 ? 'direct' : 'method',
        });
      }
    } catch { /* go query may fail on some grammars */ }
  }

  // ─── Python Functions + Classes + Imports + Calls ───
  if (language === 'python') {
    try {
      // ── Imports ──
      const pyImportQ = getQuery(langModule, language, `
        (import_statement) @imp
        (import_from_statement) @imp_from
      `);
      for (const m of pyImportQ.matches(root)) {
        const node = m.captures.find(c => c.name === 'imp' || c.name === 'imp_from')?.node;
        if (!node) continue;
        const r = extractPythonImports(node, src);
        if (Array.isArray(r)) imports.push(...r);
        else imports.push(r);
      }

      // ── Functions / Classes ──
      // 注意：decorated_definition 会包住 function_definition，class_definition 也会包住方法，
      // 所以按「节点自身类型 + 父节点类型」判定，避免重复计数。
      const pyFuncQ = getQuery(langModule, language, `
        (function_definition name: (identifier) @name) @func
        (class_definition name: (identifier) @name) @cls
      `);
      for (const m of pyFuncQ.matches(root)) {
        const node = m.captures.find(c => c.name === 'func' || c.name === 'cls')?.node;
        const nameNode = m.captures.find(c => c.name === 'name')?.node;
        if (!node || !nameNode) continue;

        const name = src.slice(nameNode.startIndex, nameNode.endIndex);
        const isFunc = node.type === 'function_definition';

        // 判定是否为类方法：向上收集所有 class_definition，嵌套类要保留完整层级
        const classChain: string[] = [];
        let parent = node.parent;
        while (parent) {
          if (parent.type === 'class_definition') {
            const cn = parent.namedChildren.find(c => c.type === 'identifier');
            if (cn) classChain.unshift(src.slice(cn.startIndex, cn.endIndex));
          }
          parent = parent.parent;
        }
        const enclosingClass = classChain.length ? classChain.join('.') : null;

        // 收集装饰器名（decorated_definition 包裹时）
        const decorators: string[] = [];
        if (node.parent?.type === 'decorated_definition') {
          for (const c of node.parent.namedChildren) {
            if (c.type !== 'decorator') continue;
            // @property / @functools.cache / @app.route('/x')
            const raw = src.slice(c.startIndex + 1, c.endIndex).trim();
            const clean = raw.replace(/\([\s\S]*\)$/, '').trim();
            if (clean) decorators.push(clean);
          }
        }

        const body = findChild(node, 'block');
        const bodyText = body ? src.slice(body.startIndex, body.endIndex) : '';
        const lineStart = (node.parent?.type === 'decorated_definition'
          ? node.parent.startPosition.row : node.startPosition.row) + 1;
        const lineEnd = node.endPosition.row + 1;

        const paramsNode = isFunc ? findChild(node, 'parameters') : null;
        const pyParams = isFunc ? extractPythonParams(paramsNode, src) : [];

        functions.push({
          name,
          fullName: enclosingClass ? `${enclosingClass}.${name}` : name,
          kind: !isFunc ? 'class' : (enclosingClass ? 'method' : 'function'),
          signature: isFunc ? extractPythonSignature(node, src)
                            : src.slice(node.startIndex, node.endIndex).split('\n')[0].trim(),
          body: bodyText,
          lineStart,
          lineEnd,
          paramsCount: pyParams.length,
          linesCount: lineEnd - lineStart + 1,
          // Python 无 export 关键字：约定非下划线开头即公开
          isExported: !name.startsWith('_'),
          // 测试文件判定：tests/ 目录或 test_*.py / *_test.py
          isTest: /(^|\/)tests?\//.test(filePath) || /(^|\/)test_[^/]*\.py$/.test(filePath) || /_test\.py$/.test(filePath),
          docComment: decorators.length ? `decorators: ${decorators.join(', ')}` : '',
          tags: decorators,
          complexity: countComplexity(node),
          paramsJson: JSON.stringify(pyParams),
          returnType: isFunc ? extractPythonReturnType(node, src) : null,
        });
      }

      // ── Calls ──
      // 关键：Python 大量存在函数内延迟导入（from . import mod; mod.Cls().m()），
      // 仅靠导入别名无法解析类型。这里直接按「被调用名」建边：
      //   attribute 调用 → 取 attribute 的最后一个 identifier（方法名）
      //   identifier 调用 → 直接函数名
      // 这样即使 obj 的真实类型不可知，方法名仍能精确定位到调用点。
      const pyCallQ = getQuery(langModule, language, `
        (call function: (_) @callee) @call
      `);
      for (const m of pyCallQ.matches(root)) {
        const callNode = m.captures.find(c => c.name === 'call')?.node;
        const calleeNode = m.captures.find(c => c.name === 'callee')?.node;
        if (!callNode || !calleeNode) continue;

        let calleeName = '';
        let callType = 'direct';
        let receiver: string | undefined;

        if (calleeNode.type === 'attribute') {
          // obj.method(...) / mod.Cls(...) / a.b.c(...) → 取最后一段
          const ids = calleeNode.namedChildren.filter(c => c.type === 'identifier');
          const last = ids[ids.length - 1];
          if (!last) continue;
          calleeName = src.slice(last.startIndex, last.endIndex);
          callType = 'method';
          // 接收者：attribute 的 object。只在是纯标识符时记录，
          // `a.b.c()` 这类链式接收者静态无法确定类型，留空。
          const obj = calleeNode.childForFieldName('object');
          if (obj && obj.type === 'identifier') {
            receiver = src.slice(obj.startIndex, obj.endIndex);
          }
        } else if (calleeNode.type === 'identifier') {
          calleeName = src.slice(calleeNode.startIndex, calleeNode.endIndex);
        } else {
          // 其他形态（subscript / parenthesized / call 链）尽力取文本末段，无法判定则跳过
          const t = src.slice(calleeNode.startIndex, calleeNode.endIndex);
          const mm = t.match(/([A-Za-z_][A-Za-z0-9_]*)\s*$/);
          if (!mm) continue;
          calleeName = mm[1];
          callType = 'dynamic';
        }

        if (!calleeName || calleeName === 'self' || calleeName === 'cls') continue;

        calls.push({
          calleeName,
          callLine: callNode.startPosition.row + 1,
          callType,
          receiver,
        });
      }

      // ── Raise（异常抛出点）──
      // Python: raise ValueError(...) / raise CliError / raise mod.Error(...) from e
      // 只取被抛出的类型名，不取 `from e` 的链式原因（那是另一个局部变量）。
      const pyRaiseQ = getQuery(langModule, language, `(raise_statement) @raise`);
      for (const m of pyRaiseQ.matches(root)) {
        const node = m.captures.find(c => c.name === 'raise')?.node;
        if (!node) continue;
        const first = node.namedChildren[0];
        if (!first) continue;      // 裸 raise（重新抛出），无类型信息
        let raw = '';
        if (first.type === 'call') {
          // ValueError("x") → 取 function 部分
          const fn = first.childForFieldName('function') ?? first.namedChildren[0];
          raw = fn ? src.slice(fn.startIndex, fn.endIndex) : '';
        } else {
          raw = src.slice(first.startIndex, first.endIndex);
        }
        // mod.CustomError → 取最后一段；内置名字保持原样
        const errorType = raw.trim().split('.').pop() || '';
        if (!errorType || !/^[A-Za-z_]\w*$/.test(errorType)) continue;
        raises.push({
          errorType,
          line: node.startPosition.row + 1,
          kind: 'raise',
        });
      }

      // ── Types（class 定义作为类型）──
      const pyClassQ = getQuery(langModule, language, `
        (class_definition name: (identifier) @name superclasses: (argument_list)? @bases) @cls
      `);
      for (const m of pyClassQ.matches(root)) {
        const clsNode = m.captures.find(c => c.name === 'cls')?.node;
        const nameNode = m.captures.find(c => c.name === 'name')?.node;
        if (!clsNode || !nameNode) continue;
        const cname = src.slice(nameNode.startIndex, nameNode.endIndex);
        const bases = m.captures.find(c => c.name === 'bases')?.node;
        const baseNames = bases
          ? bases.namedChildren.map(c => src.slice(c.startIndex, c.endIndex)).filter(Boolean)
          : [];
        types.push({
          name: cname,
          kind: 'class',
          parentType: baseNames[0] ?? '',
          implements: baseNames.slice(1),
          genericParams: (() => {
            const tp = clsNode.children.find(c => c.type === 'type_parameter');
            if (!tp) return [];
            return tp.namedChildren
              .filter(c => c.type === 'identifier' || c.type === 'type')
              .map(c => src.slice(c.startIndex, c.endIndex));
          })(),
          lineStart: clsNode.startPosition.row + 1,
          lineEnd: clsNode.endPosition.row + 1,
          fields: [],
        });
      }
    } catch (e) {
      console.warn('[codindex] python scan failed', (e as Error)?.message);
    }
  }

  // ─── Throw（异常抛出点 — TS/JS）───
  // throw new Error(...) / throw CustomError / throw new mod.CustomError(...)
  // 与 Python raise 同类语义，统一进 raises 供异常路径分析。
  if (isTS) {
    try {
      const throwQ = getQuery(langModule, language, `(throw_statement) @throw`);
      for (const m of throwQ.matches(root)) {
        const node = m.captures.find(c => c.name === 'throw')?.node;
        if (!node) continue;
        const first = node.namedChildren[0];
        if (!first) continue;
        let raw = '';
        if (first.type === 'new_expression') {
          const ctor = first.childForFieldName('constructor') ?? first.namedChildren[0];
          raw = ctor ? src.slice(ctor.startIndex, ctor.endIndex) : '';
        } else {
          raw = src.slice(first.startIndex, first.endIndex);
        }
        const errorType = raw.trim().split('.').pop() || '';
        if (!errorType || !/^[A-Za-z_]\w*$/.test(errorType)) continue;
        raises.push({
          errorType,
          line: node.startPosition.row + 1,
          kind: 'throw',
        });
      }
    } catch (e) {
      console.warn('[codindex] throw extraction failed', (e as Error)?.message);
    }
  }

  // ─── Bridge calls (invoke patterns — TS/JS only) ───
  const bridgeCalls = isTS ? extractBridgeCalls(src, functions) : undefined;

  return { functions, calls, raises, imports, types, tags: allTags, bridgeCalls };
}
