/**
 * PRD (Product Requirements Document) parser.
 * Reads a Markdown file and extracts feature definitions and requirements.
 *
 * Supported syntax:
 *   # 功能：xxx              → feature record (top-level heading)
 *   ## 需求：xxx             → requirement under current feature
 *   ## 验收：xxx             → acceptance criterion
 *   ### 子需求：xxx          → sub-requirement
 */

import { readFileSync, existsSync } from 'fs';

export interface PrdRequirement {
  name: string;
  type: 'requirement' | 'acceptance' | 'sub';
  line: number;
}

export interface PrdFeature {
  id: string;          // auto-generated: "feat-" + slug
  name: string;
  description: string;
  requirements: PrdRequirement[];
  line: number;
}

export interface PrdResult {
  features: PrdFeature[];
  rawText: string;
}

const FEAT_HEADING_RE = /^#\s+功能[：:]\s*(.+)/;
const REQ_HEADING_RE = /^##\s+需求[：:]\s*(.+)/;
const ACC_HEADING_RE = /^##\s+验收[：:]\s*(.+)/;
const SUB_REQ_RE = /^###\s+子需求[：:]\s*(.+)/;
const FEATURE_TAG_RE = /@feature:\s*([\w-]+)/g;

/** Slugify a Chinese/English string into a kebab-case ID */
export function slugify(text: string): string {
  // Remove Chinese chars for slug, keep alphanumeric + hyphens
  const latin = text
    .replace(/[一-鿿]+/g, '')
    .replace(/[^a-zA-Z0-9-_\s]/g, '')
    .trim()
    .toLowerCase()
    .replace(/\s+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '');
  if (latin) return latin;
  // Pure Chinese — hash the first 4 chars as hex
  let hash = 0;
  for (let i = 0; i < Math.min(text.length, 4); i++) {
    hash = ((hash << 5) - hash) + text.charCodeAt(i);
    hash |= 0;
  }
  return 'feat-' + Math.abs(hash).toString(36);
}

/**
 * Parse a PRD markdown file. Returns structured features and requirements.
 */
export function parsePrd(prdPath: string): PrdResult {
  if (!existsSync(prdPath)) {
    return { features: [], rawText: '' };
  }

  const rawText = readFileSync(prdPath, 'utf-8');
  const lines = rawText.split('\n');

  const features: PrdFeature[] = [];
  let currentFeature: PrdFeature | null = null;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const lineNum = i + 1;

    // Feature heading (# 功能：xxx)
    const featMatch = line.match(FEAT_HEADING_RE);
    if (featMatch) {
      if (currentFeature) features.push(currentFeature);
      const name = featMatch[1].trim();
      const id = 'feat-' + slugify(name);
      currentFeature = {
        id,
        name,
        description: '',
        requirements: [],
        line: lineNum,
      };
      continue;
    }

    if (!currentFeature) continue;

    // Requirement (## 需求：xxx)
    const reqMatch = line.match(REQ_HEADING_RE);
    if (reqMatch) {
      currentFeature.requirements.push({
        name: reqMatch[1].trim(),
        type: 'requirement',
        line: lineNum,
      });
      continue;
    }

    // Acceptance (## 验收：xxx)
    const accMatch = line.match(ACC_HEADING_RE);
    if (accMatch) {
      currentFeature.requirements.push({
        name: accMatch[1].trim(),
        type: 'acceptance',
        line: lineNum,
      });
      continue;
    }

    // Sub-requirement (### 子需求：xxx)
    const subMatch = line.match(SUB_REQ_RE);
    if (subMatch) {
      currentFeature.requirements.push({
        name: subMatch[1].trim(),
        type: 'sub',
        line: lineNum,
      });
      continue;
    }

    // First non-empty, non-heading line after feature heading becomes description
    if (!currentFeature.description && line.trim() && !line.startsWith('#')) {
      currentFeature.description = line.trim();
    }
  }

  // Push last feature
  if (currentFeature) features.push(currentFeature);

  return { features, rawText };
}

/**
 * Extract @feature:xxx tags from source code text.
 * Returns a map of feature ID -> set of function names.
 */
export function extractFeatureTags(code: string): { featureId: string; context: string }[] {
  const results: { featureId: string; context: string }[] = [];
  let m: RegExpExecArray | null;
  while ((m = FEATURE_TAG_RE.exec(code)) !== null) {
    results.push({ featureId: m[1], context: '' });
  }
  return results;
}

/**
 * Calculate feature completion based on how many @feature: tags
 * have corresponding code implementations and tests.
 */
export function calculateCompletion(
  featureId: string,
  taggedFunctions: number,
  testedFunctions: number,
  totalRequirements: number,
): number {
  if (totalRequirements === 0) return taggedFunctions > 0 ? 0.5 : 0;

  // Requirements satisfied by tagged functions
  const reqScore = Math.min(taggedFunctions / totalRequirements, 1);

  // Bonus for having tests
  const testBonus = testedFunctions > 0 ? 0.15 : 0;

  return Math.min(reqScore + testBonus, 1);
}
