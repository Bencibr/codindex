import { describe, it, expect } from 'vitest';
import { scoreFunction } from '../scoring/reuse-score';
import { parsePrd, extractFeatureTags, calculateCompletion, slugify } from '../scan/prd-parser';
import { writeFileSync, mkdirSync } from 'fs';
import { resolve } from 'path';

describe('Phase 3 — reuse scoring', () => {
  it('scores a clean utility function as high reuse', () => {
    const score = scoreFunction({
      name: 'formatDate',
      fullName: 'formatDate',
      complexity: 2,
      paramsCount: 1,
      linesCount: 3,
      isExported: true,
      docComment: '/** Format a date string */',
      tags: '["@feature:data"]',
      couplingCount: 12,
      dependencyCount: 0,
    });
    expect(score.overall).toBeGreaterThanOrEqual(75);
    expect(score.grade).toContain('高复用');
  });

  it('scores complex business function as low reuse', () => {
    const score = scoreFunction({
      name: 'processUserOrderPayment',
      fullName: 'OrderService.processUserOrderPayment',
      complexity: 28,
      paramsCount: 0,
      linesCount: 120,
      isExported: false,
      docComment: '',
      tags: '[]',
      couplingCount: 0,
      dependencyCount: 8,
    });
    expect(score.overall).toBeLessThanOrEqual(40);
    // 原写法 `expect(a).toContain(x) || expect(b).toContain(y)` 里的 `||`
    // 是死代码：expect 失败就抛，短路后第二句永不执行，读起来像「二者皆可」，
    // 实际只校验了第一个。改成对候选集合做单次断言。
    expect(['❌难复用', '⚠️有限']).toContain(score.grade);
  });

  it('scores medium complexity exported function as medium reuse', () => {
    const score = scoreFunction({
      name: 'findUserByEmail',
      fullName: 'findUserByEmail',
      complexity: 4,
      paramsCount: 2,
      linesCount: 3,
      isExported: true,
      docComment: '/** Find user */\n* @param users list\n* @returns found user',
      tags: '["@feature:user"]',
      couplingCount: 3,
      dependencyCount: 1,
    });
    expect(score.overall).toBeGreaterThan(40);
    expect(score.overall).toBeLessThanOrEqual(90);
  });

  it('utility functions with generic name score well', () => {
    const score = scoreFunction({
      name: 'parseCsvLine',
      fullName: 'parseCsvLine',
      complexity: 5,
      paramsCount: 1,
      linesCount: 12,
      isExported: true,
      docComment: '/** Parse a CSV line into fields */',
      tags: '["@feature:data"]',
      couplingCount: 5,
      dependencyCount: 0,
    });
    expect(score.overall).toBeGreaterThanOrEqual(60);
  });
});

describe('Phase 3 — PRD parser', () => {
  const testPrdPath = resolve('/tmp', 'codindex-test-prd.md');

  it('parses Chinese PRD headings correctly', () => {
    const content = '# 功能：用户登录\n  实现邮箱登录功能\n\n## 需求：邮箱密码登录\n## 需求：短信验证码登录\n## 验收：登录成功跳转首页\n### 子需求：记住密码\n\n# 功能：数据导出\n## 需求：导出CSV格式\n';
    mkdirSync('/tmp', { recursive: true });
    writeFileSync(testPrdPath, content);
    const result = parsePrd(testPrdPath);

    expect(result.features.length).toBe(2);

    const login = result.features.find(f => f.name === '用户登录');
    expect(login).toBeDefined();
    expect(login!.description).toContain('邮箱登录功能');
    expect(login!.requirements.length).toBe(4); // 2需求 + 1验收 + 1子需求

    const exportFeat = result.features.find(f => f.name === '数据导出');
    expect(exportFeat).toBeDefined();
    expect(exportFeat!.requirements.length).toBe(1);
  });

  it('handles non-existent PRD file gracefully', () => {
    const result = parsePrd('/nonexistent/prd.md');
    expect(result.features).toEqual([]);
    expect(result.rawText).toBe('');
  });

  it('handles empty PRD content', () => {
    writeFileSync(testPrdPath, '');
    const result = parsePrd(testPrdPath);
    expect(result.features).toEqual([]);
  });
});

describe('Phase 3 — feature tag extraction', () => {
  it('extracts @feature tags from code', () => {
    const code = `
      // @feature: user-login
      function login() {}
      /* @feature: data-export */
      function exportData() {}
    `;
    const tags = extractFeatureTags(code);
    expect(tags.length).toBe(2);
    expect(tags[0].featureId).toBe('user-login');
    expect(tags[1].featureId).toBe('data-export');
  });

  it('returns empty array for code without tags', () => {
    const tags = extractFeatureTags('function foo() { return 1; }');
    expect(tags.length).toBe(0);
  });
});

describe('Phase 3 — completion calculation', () => {
  it('returns 0 for no tagged functions', () => {
    expect(calculateCompletion('feat-x', 0, 0, 3)).toBe(0);
  });

  it('returns partial for some functions tagged', () => {
    const c = calculateCompletion('feat-x', 2, 0, 4);
    expect(c).toBeGreaterThan(0);
    expect(c).toBeLessThan(1);
  });

  it('returns high completion with test coverage', () => {
    const c = calculateCompletion('feat-x', 4, 2, 4);
    expect(c).toBeGreaterThanOrEqual(0.8);
  });
});

describe('Phase 3 — slugify', () => {
  it('converts English text', () => {
    expect(slugify('User Login')).toBe('user-login');
  });

  it('handles Chinese text gracefully', () => {
    const result = slugify('用户登录');
    // Should produce a non-empty kebab string
    expect(result.length).toBeGreaterThan(0);
    expect(result.startsWith('feat-')).toBe(true);
  });
});
