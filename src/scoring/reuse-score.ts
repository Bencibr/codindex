/**
 * Reuse scoring engine.
 * Scores each function on how easily it can be reused across the project.
 *
 * 6 dimensions:
 *  - Complexity (25%) — McCabe cyclomatic complexity, lower = better
 *  - Coupling (20%) — times called from other files, higher = more generic
 *  - Dependency (15%) — internal module deps, fewer = easier to extract
 *  - Abstraction (15%) — uses generics/interfaces, params as configuration
 *  - Documentation (10%) — has JSDoc/type annotations
 *  - Specificity (15%) — business keyword density, less = more generic
 */

export interface ReuseScore {
  overall: number;       // 0–100
  grade: string;         // ⭐高复用 | 👍可复用 | ⚠️有限 | ❌难复用
  dimensions: {
    complexity: number;  // 0–100 (inverted: high complexity → low score)
    coupling: number;
    dependency: number;
    abstraction: number;
    documentation: number;
    specificity: number;
  };
  details: string[];
}

const WEIGHTS = {
  complexity: 0.25,
  coupling: 0.20,
  dependency: 0.15,
  abstraction: 0.15,
  documentation: 0.10,
  specificity: 0.15,
};

/** Keywords that indicate business-specific logic (lower specificity) */
const BUSINESS_KEYWORDS = [
  'user', 'account', 'order', 'payment', 'invoice', 'checkout',
  'login', 'register', 'auth', 'permission', 'role', 'tenant',
  'email', 'notification', 'sms', 'template', 'workflow',
  'report', 'dashboard', 'analytics', 'metric',
  'subscription', 'billing', 'pricing', 'plan',
  'customer', 'client', 'vendor', 'partner',
  'product', 'inventory', 'shipment', 'cart',
  'validate', 'approve', 'reject', 'audit',
  'transaction', 'receipt', 'refund', 'discount',
];

/**
 * Score a single function for reusability.
 */
export function scoreFunction(params: {
  name: string;
  fullName: string;
  complexity: number | null;
  paramsCount: number | null;
  linesCount: number | null;
  isExported: boolean;
  docComment: string | null;
  tags: string | null;
  couplingCount: number | null;
  dependencyCount: number | null;
}): ReuseScore {
  const dims = {
    complexity: scoreComplexity(params.complexity ?? 1, params.linesCount ?? 1),
    coupling: scoreCoupling(params.couplingCount ?? 0, params.isExported),
    dependency: scoreDependency(params.dependencyCount ?? 0),
    abstraction: scoreAbstraction(params.paramsCount ?? 0, params.fullName),
    documentation: scoreDocumentation(params.docComment ?? '', params.isExported, params.tags ?? ''),
    specificity: scoreSpecificity(params.name, params.fullName),
  };

  const overall = Math.round(
    dims.complexity * WEIGHTS.complexity +
    dims.coupling * WEIGHTS.coupling +
    dims.dependency * WEIGHTS.dependency +
    dims.abstraction * WEIGHTS.abstraction +
    dims.documentation * WEIGHTS.documentation +
    dims.specificity * WEIGHTS.specificity,
  );

  const details = buildDetails(dims, params);

  return {
    overall,
    grade: gradeScore(overall),
    dimensions: dims,
    details,
  };
}

function scoreComplexity(complexity: number, lines: number): number {
  // Complexity: 1–5 → 100, 6–10 → 80, 11–20 → 50, 21+ → 20
  // Also penalize very long functions
  let score = 100;
  if (complexity > 20) score -= 60;
  else if (complexity > 10) score -= 40;
  else if (complexity > 5) score -= 20;
  else if (complexity > 3) score -= 10;

  if (lines > 100) score -= 30;
  else if (lines > 50) score -= 15;
  else if (lines > 30) score -= 5;

  return Math.max(0, score);
}

function scoreCoupling(couplingCount: number, isExported: boolean): number {
  // Being called many times means it's generic/reusable
  if (couplingCount >= 10) return 100;
  if (couplingCount >= 5) return 80;
  if (couplingCount >= 2) return 60;
  if (couplingCount >= 1) return 40;
  // Exported functions are designed for external use — give them
  // the benefit of the doubt even with 0 internal callers.
  if (isExported) return 50;
  return 20; // never called, not exported — might be dead code
}

function scoreDependency(dependencyCount: number): number {
  // Fewer internal dependencies = easier to extract
  if (dependencyCount === 0) return 100;
  if (dependencyCount <= 2) return 75;
  if (dependencyCount <= 5) return 50;
  return 20;
}

function scoreAbstraction(paramsCount: number, fullName: string): number {
  let score = 20; // base: no params, low abstraction
  if (paramsCount >= 1) score += 15;  // at least takes input
  if (paramsCount >= 2) score += 15;  // configured by params
  if (paramsCount >= 3) score += 10;
  if (paramsCount >= 4) score += 10;

  // Method names with "generic" indicators
  const genericIndicators = /(get|set|parse|format|validate|create|build|find|map|reduce|filter|forEach|transform|convert|serialize|deserialize)/i;
  if (genericIndicators.test(fullName)) score += 15;

  return Math.min(100, score);
}

function scoreDocumentation(docComment: string, isExported: boolean, tags: string): number {
  let score = isExported ? 30 : 20; // exported functions are more documented-worthy

  if (docComment && docComment.trim().length > 0) {
    score += 40;
    // Bonus for parameter docs
    if (docComment.includes('@param')) score += 15;
    if (docComment.includes('@returns') || docComment.includes('@return')) score += 15;
  }

  // Has feature tag – some documentation exists
  if (tags && tags.length > 2) score += 10;

  return Math.min(100, score);
}

function scoreSpecificity(name: string, fullName: string): number {
  // Check for business keywords in function/class name
  const combined = `${fullName} ${name}`.toLowerCase();
  let matchCount = 0;

  for (const kw of BUSINESS_KEYWORDS) {
    if (combined.includes(kw)) matchCount++;
  }

  // Utility/framework names get high scores
  const utilityPattern = /(util|helper|common|base|abstract|generic|types?|format|parse|convert|transform|validate)/i;
  const isUtility = utilityPattern.test(name);

  // Start at 70, deduct for each business keyword
  let score = isUtility ? 90 : 70;
  score -= matchCount * 12;

  // Heavily business-named functions are low specificity
  if (matchCount >= 3) score -= 15;

  return Math.max(0, Math.min(100, score));
}

function gradeScore(score: number): string {
  if (score >= 85) return '⭐高复用';
  if (score >= 60) return '👍可复用';
  if (score >= 30) return '⚠️有限';
  return '❌难复用';
}

function buildDetails(
  dims: ReuseScore['dimensions'],
  params: Parameters<typeof scoreFunction>[0],
): string[] {
  const d: string[] = [];

  if (dims.complexity >= 80) d.push('低复杂度，易于理解');
  else if (dims.complexity < 50) d.push('复杂度偏高，建议重构');

  if (dims.coupling >= 60) d.push(`被调用 ${params.couplingCount ?? 0} 次，已有复用验证`);
  else if (dims.coupling < 30) d.push('调用少，可能是内部工具函数');

  if (dims.dependency >= 75) d.push('依赖少，可独立抽取');
  else if (dims.dependency < 50) d.push('内部依赖较多，抽取需同步搬迁');

  if (dims.documentation >= 70) d.push('文档注释完整');
  else if (dims.documentation < 40 && params.isExported) d.push('导出函数缺少文档注释');

  if (dims.specificity >= 80) d.push('通用性强，无业务侵入');
  else if (dims.specificity < 40) d.push('业务耦合度高，复用受限');

  return d;
}
