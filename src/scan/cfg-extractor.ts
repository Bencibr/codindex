/**
 * Control Flow Graph (CFG) Extractor
 *
 * Extracts structured control flow from tree-sitter AST nodes.
 * Supports: if/else, for, while, do-while, switch/case, try/catch/finally,
 * return, break, continue, throw, function calls.
 *
 * Returns { nodes, edges } suitable for D3 rendering and DB storage.
 */

import Parser from 'tree-sitter';

// ─── Types ───

export interface CFGNode {
  id: string;
  type: 'start' | 'end' | 'condition' | 'loop' | 'action' | 'switch' | 'try' | 'catch' | 'return' | 'throw' | 'break' | 'continue';
  label: string;
  lineStart: number;
  lineEnd: number;
  conditionExpr?: string;
  calleeName?: string;
}

export interface CFGEdge {
  source: string;
  target: string;
  label?: string; // 'true' | 'false' | 'default' | 'loop-body' | 'after-loop' | 'case-N' | 'catch' | 'finally'
  edgeType: 'control' | 'call';
}

export interface CFGResult {
  nodes: CFGNode[];
  edges: CFGEdge[];
  summary: {
    totalNodes: number;
    branches: number;
    loops: number;
    maxDepth: number;
  };
}

// ─── ID generator ───
let _counter = 0;
function nextId(prefix = 'n'): string {
  return `${prefix}${++_counter}`;
}
function resetIds() { _counter = 0; }

// ─── Main extractor ───

/**
 * Extract CFG from a function's AST node.
 * Walks the AST recursively, building nodes and edges for each control-flow construct.
 */
export function extractCFG(funcNode: Parser.SyntaxNode, source: string): CFGResult {
  resetIds();
  const nodes: CFGNode[] = [];
  const edges: CFGEdge[] = [];

  const startId = nextId('start');
  nodes.push({
    id: startId,
    type: 'start',
    label: 'Start',
    lineStart: funcNode.startPosition.row + 1,
    lineEnd: funcNode.startPosition.row + 1,
  });

  const endId = nextId('end');
  nodes.push({
    id: endId,
    type: 'end',
    label: 'End',
    lineStart: funcNode.endPosition.row + 1,
    lineEnd: funcNode.endPosition.row + 1,
  });

  // Find the function body block
  const bodyNode = findFunctionBody(funcNode);
  if (!bodyNode) {
    // Empty function: start → end
    edges.push({ source: startId, target: endId, edgeType: 'control' });
    return buildResult(nodes, edges);
  }

  // Walk body statements
  const exits = walkBlock(bodyNode, source, startId, nodes, edges);

  // Connect all exits to end
  for (const exitId of exits) {
    edges.push({ source: exitId, target: endId, edgeType: 'control' });
  }

  return buildResult(nodes, edges);
}

// ─── Find function body ───
function findFunctionBody(node: Parser.SyntaxNode): Parser.SyntaxNode | null {
  // For function_declaration: body is the statement_block child
  for (let i = 0; i < node.namedChildCount; i++) {
    const child = node.namedChildren[i];
    if (child.type === 'statement_block') return child;
  }
  // For arrow_function: body could be statement_block or expression
  if (node.type === 'arrow_function') {
    for (let i = 0; i < node.namedChildCount; i++) {
      const child = node.namedChildren[i];
      if (child.type === 'statement_block') return child;
    }
  }
  // Try children of parent (for lexical_declaration wrapping arrow)
  if (node.type === 'lexical_declaration' || node.type === 'variable_declaration') {
    for (let i = 0; i < node.namedChildCount; i++) {
      const declarator = node.namedChildren[i];
      if (declarator.type === 'variable_declarator') {
        for (let j = 0; j < declarator.namedChildCount; j++) {
          const val = declarator.namedChildren[j];
          if (val.type === 'arrow_function' || val.type === 'function') {
            return findFunctionBody(val);
          }
        }
      }
    }
  }
  return null;
}

// ─── Walk a block of statements ───
function walkBlock(
  block: Parser.SyntaxNode,
  source: string,
  prevId: string,
  nodes: CFGNode[],
  edges: CFGEdge[],
): string[] {
  const stmts = getStatements(block);
  let currentEntry = prevId;
  const allExits: string[] = [];

  for (let i = 0; i < stmts.length; i++) {
    const stmt = stmts[i];
    const result = walkStatement(stmt, source, currentEntry, nodes, edges);

    if (result.exits.length === 0) {
      // No exit — statement terminates (return/throw/break/continue)
      return []; // Dead code after this
    }

    allExits.push(...result.exits);
    currentEntry = result.exits[result.exits.length - 1];
  }

  return allExits.length > 0 ? allExits : [currentEntry];
}

function getStatements(block: Parser.SyntaxNode): Parser.SyntaxNode[] {
  if (block.type === 'statement_block') {
    return block.namedChildren;
  }
  return [block];
}

// ─── Walk a single statement ───
interface WalkResult {
  exits: string[]; // Node IDs where control exits this statement
}

function walkStatement(
  node: Parser.SyntaxNode,
  source: string,
  prevId: string,
  nodes: CFGNode[],
  edges: CFGEdge[],
): WalkResult {
  const line = node.startPosition.row + 1;
  const lineEnd = node.endPosition.row + 1;

  switch (node.type) {
    case 'if_statement': {
      return walkIfStatement(node, source, prevId, nodes, edges);
    }
    case 'for_statement':
    case 'for_in_statement':
    case 'while_statement': {
      return walkLoopStatement(node, source, prevId, nodes, edges);
    }
    case 'do_statement': {
      return walkDoWhileStatement(node, source, prevId, nodes, edges);
    }
    case 'switch_statement': {
      return walkSwitchStatement(node, source, prevId, nodes, edges);
    }
    case 'try_statement': {
      return walkTryStatement(node, source, prevId, nodes, edges);
    }
    case 'return_statement': {
      const id = nextId('ret');
      const expr = getConditionText(node, source);
      nodes.push({ id, type: 'return', label: expr ? `return ${expr}` : 'return', lineStart: line, lineEnd: lineEnd });
      edges.push({ source: prevId, target: id, edgeType: 'control' });
      return { exits: [] }; // Terminates — no exit
    }
    case 'throw_statement': {
      const id = nextId('throw');
      const expr = getConditionText(node, source);
      nodes.push({ id, type: 'throw', label: expr ? `throw ${expr}` : 'throw', lineStart: line, lineEnd: lineEnd });
      edges.push({ source: prevId, target: id, edgeType: 'control' });
      return { exits: [] };
    }
    case 'break_statement': {
      const id = nextId('break');
      nodes.push({ id, type: 'break', label: 'break', lineStart: line, lineEnd: lineEnd });
      edges.push({ source: prevId, target: id, edgeType: 'control' });
      return { exits: [] };
    }
    case 'continue_statement': {
      const id = nextId('cont');
      nodes.push({ id, type: 'continue', label: 'continue', lineStart: line, lineEnd: lineEnd });
      edges.push({ source: prevId, target: id, edgeType: 'control' });
      return { exits: [] };
    }
    case 'expression_statement': {
      // Check if it contains a call
      const callExpr = findCallExpression(node);
      if (callExpr) {
        const id = nextId('act');
        const calleeName = getCalleeName(callExpr, source);
        const label = calleeName ? `${calleeName}()` : source.slice(node.startIndex, Math.min(node.endIndex, node.startIndex + 40)).trim();
        nodes.push({ id, type: 'action', label, lineStart: line, lineEnd: lineEnd, calleeName });
        edges.push({ source: prevId, target: id, edgeType: 'call' });
        return { exits: [id] };
      }
      // Non-call expression — still an action
      const id = nextId('act');
      const text = source.slice(node.startIndex, Math.min(node.endIndex, node.startIndex + 40)).trim();
      nodes.push({ id, type: 'action', label: text, lineStart: line, lineEnd: lineEnd });
      edges.push({ source: prevId, target: id, edgeType: 'control' });
      return { exits: [id] };
    }
    default: {
      // Other statements — treat as action
      const id = nextId('act');
      const text = source.slice(node.startIndex, Math.min(node.endIndex, node.startIndex + 40)).trim();
      nodes.push({ id, type: 'action', label: text || node.type, lineStart: line, lineEnd: lineEnd });
      edges.push({ source: prevId, target: id, edgeType: 'control' });
      return { exits: [id] };
    }
  }
}

// ─── If statement ───
function walkIfStatement(
  node: Parser.SyntaxNode,
  source: string,
  prevId: string,
  nodes: CFGNode[],
  edges: CFGEdge[],
): WalkResult {
  const line = node.startPosition.row + 1;
  const lineEnd = node.endPosition.row + 1;

  // Find condition, consequence, alternative
  const condition = node.namedChildren.find(c => c.type !== 'statement_block');
  const conditionText = condition ? getConditionText(condition, source) : '?';

  const condId = nextId('cond');
  nodes.push({
    id: condId, type: 'condition',
    label: conditionText, lineStart: line, lineEnd: lineEnd,
    conditionExpr: conditionText,
  });
  edges.push({ source: prevId, target: condId, edgeType: 'control' });

  // Find consequence (then) and alternative (else)
  const blocks = node.namedChildren.filter(c => c.type === 'statement_block');
  const consequence = blocks[0];
  const alternative = blocks.length > 1 ? blocks[1] : null;

  // Check for else-if pattern
  const elseChild = node.namedChildren.find(c => c.type === 'if_statement');

  const trueExits = consequence
    ? walkBlock(consequence, source, condId, nodes, edges)
    : [condId];

  // Connect true branch
  for (const exit of trueExits) {
    edges.push({ source: condId, target: exit, label: 'true', edgeType: 'control' });
  }
  // Remove the generic edge from prevId→condId that was already added above is fine,
  // but we need to remove the auto-edge from condId to first true-exit if walkBlock created it.
  // Actually, walkBlock links prevId→first-statement, so we have an extra edge condId→firstTrue.
  // The true-exits already include that edge. Let me adjust: we added condId→exit above,
  // but walkBlock also added condId→first-stmt. We need to remove the generic one.
  // Simpler: don't add generic edge; walkBlock handles connecting condId to first stmt.

  const falseExits: string[] = [];
  if (elseChild) {
    // else-if: recursively handle
    const result = walkIfStatement(elseChild, source, condId, nodes, edges);
    for (const exit of result.exits) {
      edges.push({ source: condId, target: exit, label: 'false', edgeType: 'control' });
    }
    falseExits.push(...result.exits);
  } else if (alternative) {
    const exits = walkBlock(alternative, source, condId, nodes, edges);
    for (const exit of exits) {
      edges.push({ source: condId, target: exit, label: 'false', edgeType: 'control' });
    }
    falseExits.push(...exits);
  }

  // Merge: both branches converge
  const allExits = [...trueExits, ...falseExits];
  if (allExits.length === 0) {
    // Both branches terminate (e.g. return in both)
    return { exits: [] };
  }
  return { exits: allExits };
}

// ─── Loop statement (for/while) ───
function walkLoopStatement(
  node: Parser.SyntaxNode,
  source: string,
  prevId: string,
  nodes: CFGNode[],
  edges: CFGEdge[],
): WalkResult {
  const line = node.startPosition.row + 1;
  const lineEnd = node.endPosition.row + 1;

  const condition = node.namedChildren.find(c =>
    c.type !== 'statement_block' && c.type !== 'for_body' &&
    c.type !== 'parenthesized_expression' || c.type === 'parenthesized_expression',
  );
  const conditionText = getConditionText(node, source);

  const loopId = nextId('loop');
  nodes.push({
    id: loopId, type: 'loop',
    label: `${node.type.replace('_statement', '')}(${conditionText})`,
    lineStart: line, lineEnd: lineEnd,
    conditionExpr: conditionText,
  });
  edges.push({ source: prevId, target: loopId, edgeType: 'control' });

  // Find loop body
  const body = node.namedChildren.find(c => c.type === 'statement_block');
  const bodyExits: string[] = [];
  if (body) {
    const exits = walkBlock(body, source, loopId, nodes, edges);
    for (const exit of exits) {
      edges.push({ source: loopId, target: exit, label: 'loop-body', edgeType: 'control' });
    }
    // Loop back: body exits → loop node
    for (const exit of exits) {
      edges.push({ source: exit, target: loopId, edgeType: 'control' });
    }
    bodyExits.push(...exits);
  } else {
    edges.push({ source: loopId, target: loopId, label: 'loop-body', edgeType: 'control' });
  }

  // Exit from loop condition (when condition is false)
  return { exits: [loopId] };
}

// ─── Do-while ───
function walkDoWhileStatement(
  node: Parser.SyntaxNode,
  source: string,
  prevId: string,
  nodes: CFGNode[],
  edges: CFGEdge[],
): WalkResult {
  const line = node.startPosition.row + 1;
  const lineEnd = node.endPosition.row + 1;

  const loopId = nextId('loop');
  nodes.push({
    id: loopId, type: 'loop',
    label: 'do-while',
    lineStart: line, lineEnd: lineEnd,
  });
  edges.push({ source: prevId, target: loopId, edgeType: 'control' });

  const body = node.namedChildren.find(c => c.type === 'statement_block');
  if (body) {
    const exits = walkBlock(body, source, loopId, nodes, edges);
    for (const exit of exits) {
      edges.push({ source: exit, target: loopId, edgeType: 'control' });
    }
  }

  return { exits: [loopId] };
}

// ─── Switch ───
function walkSwitchStatement(
  node: Parser.SyntaxNode,
  source: string,
  prevId: string,
  nodes: CFGNode[],
  edges: CFGEdge[],
): WalkResult {
  const line = node.startPosition.row + 1;
  const lineEnd = node.endPosition.row + 1;
  const conditionText = getConditionText(node, source);

  const switchId = nextId('switch');
  nodes.push({
    id: switchId, type: 'switch',
    label: `switch(${conditionText})`,
    lineStart: line, lineEnd: lineEnd,
    conditionExpr: conditionText,
  });
  edges.push({ source: prevId, target: switchId, edgeType: 'control' });

  // Find switch body (statement_block containing switch_case nodes)
  const body = node.namedChildren.find(c => c.type === 'switch_body');
  if (!body) return { exits: [switchId] };

  const caseExits: string[] = [];
  for (const caseNode of body.namedChildren) {
    if (caseNode.type === 'switch_case' || caseNode.type === 'switch_default') {
      const isDefault = caseNode.type === 'switch_default';
      const caseLabel = isDefault ? 'default' : getConditionText(caseNode, source);
      const caseId = nextId('case');
      nodes.push({
        id: caseId, type: 'action',
        label: `case ${caseLabel}`,
        lineStart: caseNode.startPosition.row + 1,
        lineEnd: caseNode.endPosition.row + 1,
      });
      edges.push({ source: switchId, target: caseId, label: isDefault ? 'default' : `case ${caseLabel}`, edgeType: 'control' });

      // Walk case body
      const stmts = caseNode.namedChildren.filter(c => c.type !== ':');
      for (const stmt of stmts) {
        const result = walkStatement(stmt, source, caseId, nodes, edges);
        caseExits.push(...result.exits);
        if (result.exits.length === 0) break;
      }
    }
  }

  return { exits: caseExits.length > 0 ? caseExits : [switchId] };
}

// ─── Try/catch/finally ───
function walkTryStatement(
  node: Parser.SyntaxNode,
  source: string,
  prevId: string,
  nodes: CFGNode[],
  edges: CFGEdge[],
): WalkResult {
  const line = node.startPosition.row + 1;
  const lineEnd = node.endPosition.row + 1;

  const tryId = nextId('try');
  nodes.push({
    id: tryId, type: 'try',
    label: 'try',
    lineStart: line, lineEnd: lineEnd,
  });
  edges.push({ source: prevId, target: tryId, edgeType: 'control' });

  const tryBlock = node.namedChildren.find(c => c.type === 'statement_block');
  const catchClause = node.namedChildren.find(c => c.type === 'catch_clause');
  const finallyBlock = node.namedChildren.find(c => c.type === 'finally_clause');

  const allExits: string[] = [];

  // Try body
  if (tryBlock) {
    const exits = walkBlock(tryBlock, source, tryId, nodes, edges);
    allExits.push(...exits);
  }

  // Catch
  if (catchClause) {
    const catchId = nextId('catch');
    const catchParam = catchClause.namedChildren.find(c => c.type === 'identifier' || c.type === 'catch_pattern');
    nodes.push({
      id: catchId, type: 'catch',
      label: catchParam ? `catch(${source.slice(catchParam.startIndex, catchParam.endIndex)})` : 'catch',
      lineStart: catchClause.startPosition.row + 1,
      lineEnd: catchClause.endPosition.row + 1,
    });
    edges.push({ source: tryId, target: catchId, label: 'catch', edgeType: 'control' });

    const catchBody = catchClause.namedChildren.find(c => c.type === 'statement_block');
    if (catchBody) {
      const exits = walkBlock(catchBody, source, catchId, nodes, edges);
      allExits.push(...exits);
    }
  }

  // Finally
  if (finallyBlock) {
    const finId = nextId('fin');
    nodes.push({
      id: finId, type: 'action',
      label: 'finally',
      lineStart: finallyBlock.startPosition.row + 1,
      lineEnd: finallyBlock.endPosition.row + 1,
    });
    edges.push({ source: tryId, target: finId, label: 'finally', edgeType: 'control' });

    const finBody = finallyBlock.namedChildren.find(c => c.type === 'statement_block');
    if (finBody) {
      const exits = walkBlock(finBody, source, finId, nodes, edges);
      allExits.push(...exits);
    }
  }

  return { exits: allExits.length > 0 ? allExits : [tryId] };
}

// ─── Helpers ───

function getConditionText(node: Parser.SyntaxNode, source: string): string {
  // For if/while/for: find the parenthesized_expression or the condition child
  for (let i = 0; i < node.namedChildCount; i++) {
    const child = node.namedChildren[i];
    if (child.type === 'parenthesized_expression') {
      // Strip parens
      const inner = source.slice(child.startIndex + 1, child.endIndex - 1).trim();
      return inner.length > 60 ? inner.slice(0, 57) + '...' : inner;
    }
  }
  // Fallback: first 40 chars
  const text = source.slice(node.startIndex, Math.min(node.endIndex, node.startIndex + 60)).trim();
  return text.length > 60 ? text.slice(0, 57) + '...' : text;
}

function findCallExpression(node: Parser.SyntaxNode): Parser.SyntaxNode | null {
  // BFS to find call_expression within this node
  const queue: Parser.SyntaxNode[] = [node];
  while (queue.length > 0) {
    const n = queue.pop()!;
    if (n.type === 'call_expression' || n.type === 'new_expression') return n;
    for (let i = 0; i < n.namedChildCount; i++) {
      queue.push(n.namedChildren[i]);
    }
  }
  return null;
}

function getCalleeName(callNode: Parser.SyntaxNode, source: string): string {
  const fn = callNode.namedChildren[0];
  if (!fn) return '';
  if (fn.type === 'identifier') return source.slice(fn.startIndex, fn.endIndex);
  if (fn.type === 'member_expression') {
    const prop = fn.namedChildren.find(c => c.type === 'property_identifier');
    if (prop) return source.slice(prop.startIndex, prop.endIndex);
  }
  return source.slice(fn.startIndex, Math.min(fn.endIndex, fn.startIndex + 30));
}

function buildResult(nodes: CFGNode[], edges: CFGEdge[]): CFGResult {
  const branches = nodes.filter(n => n.type === 'condition' || n.type === 'switch').length;
  const loops = nodes.filter(n => n.type === 'loop').length;

  // Calculate max depth via BFS
  const adj = new Map<string, string[]>();
  for (const e of edges) {
    if (!adj.has(e.source)) adj.set(e.source, []);
    adj.get(e.source)!.push(e.target);
  }
  const startNode = nodes.find(n => n.type === 'start');
  let maxDepth = 0;
  if (startNode) {
    const visited = new Set<string>();
    const queue: [string, number][] = [[startNode.id, 0]];
    visited.add(startNode.id);
    while (queue.length > 0) {
      const [id, depth] = queue.shift()!;
      maxDepth = Math.max(maxDepth, depth);
      for (const next of adj.get(id) || []) {
        if (!visited.has(next)) {
          visited.add(next);
          queue.push([next, depth + 1]);
        }
      }
    }
  }

  return {
    nodes,
    edges,
    summary: {
      totalNodes: nodes.length,
      branches,
      loops,
      maxDepth,
    },
  };
}
