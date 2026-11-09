import {
  sqliteTable,
  text,
  integer,
  real,
  uniqueIndex,
  index,
} from 'drizzle-orm/sqlite-core';
import { sql } from 'drizzle-orm';

// ───────────────────────────
// Core: project registry
// ───────────────────────────
export const projects = sqliteTable(
  'projects',
  {
    id: text('id').primaryKey(),
    name: text('name').notNull(),
    path: text('path').notNull(),
    language: text('language'),
    status: text('status').default('pending'), // pending | scanning | ready | error
    lastScanned: integer('last_scanned'),
    scanProgress: integer('scan_progress'),
    prdPath: text('prd_path'),
    createdAt: integer('created_at').default(sql`(unixepoch())`),
  },
  (t) => [uniqueIndex('idx_project_path').on(t.path)],
);

// ───────────────────────────
// Files
// ───────────────────────────
export const files = sqliteTable(
  'files',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    projectId: text('project_id')
      .notNull()
      .references(() => projects.id, { onDelete: 'cascade' }),
    path: text('path').notNull(),
    module: text('module'),
    language: text('language').notNull(),
    lines: integer('lines').default(0),
    codeLines: integer('code_lines').default(0),
    commentLines: integer('comment_lines').default(0),
    complexity: real('complexity'),
    lastModified: integer('last_modified'),
    authors: text('authors'), // JSON array
  },
  (t) => [uniqueIndex('idx_file_project_path').on(t.projectId, t.path)],
);

// ───────────────────────────
// Functions / methods
// ───────────────────────────
export const functions = sqliteTable(
  'functions',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    projectId: text('project_id')
      .notNull()
      .references(() => projects.id, { onDelete: 'cascade' }),
    fileId: integer('file_id')
      .notNull()
      .references(() => files.id, { onDelete: 'cascade' }),
    name: text('name').notNull(),
    fullName: text('full_name'),
    kind: text('kind'), // function | method | constructor | getter | setter | arrow
    signature: text('signature'),
    body: text('body'),
    summary: text('summary'),       // one-line semantic summary (rule-generated)
    lineStart: integer('line_start'),
    lineEnd: integer('line_end'),
    complexity: real('complexity'),
    paramsCount: integer('params_count').default(0),
    linesCount: integer('lines_count').default(0),
    isExported: integer('is_exported', { mode: 'boolean' }).default(false),
    isTest: integer('is_test', { mode: 'boolean' }).default(false),
    docComment: text('doc_comment'),
    tags: text('tags'), // JSON array: ["@feature:xxx"]
    featureId: text('feature_id'),
    // Reuse scoring fields
    reuseScore: real('reuse_score'),
    couplingCount: integer('coupling_count').default(0),
    dependencyCount: integer('dependency_count').default(0),
    paramSimilarity: real('param_similarity'),
    genericLevel: integer('generic_level').default(0),
    // Enhanced fields (Phase 1)
    paramsJson: text('params_json'),   // JSON: [{name, type, optional}]
    returnType: text('return_type'),
    isPlaceholder: integer('is_placeholder', { mode: 'boolean' }).default(false),
  },
  (t) => [
    uniqueIndex('idx_func_project_file_name')
      .on(t.projectId, t.fileId, t.name, t.lineStart),
    index('idx_func_project').on(t.projectId),
    index('idx_func_file').on(t.fileId),
  ],
);

// ───────────────────────────
// Call edges (bloodline)
// ───────────────────────────
export const calls = sqliteTable(
  'calls',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    projectId: text('project_id')
      .notNull()
      .references(() => projects.id, { onDelete: 'cascade' }),
    callerFuncId: integer('caller_func_id')
      .references(() => functions.id, { onDelete: 'cascade' }),
    // 可空：跨文件/多态/延迟导入的调用常常无法静态解析到具体函数定义。
    // 这类边不再丢弃，而是保留 callee_name + is_external=1，供「谁调用 X」按名检索。
    calleeFuncId: integer('callee_func_id')
      .references(() => functions.id, { onDelete: 'cascade' }),
    callerFileId: integer('caller_file_id')
      .notNull()
      .references(() => files.id, { onDelete: 'cascade' }),
    // 可空：未解析调用的目标文件未知
    calleeFileId: integer('callee_file_id')
      .references(() => files.id, { onDelete: 'cascade' }),
    callLine: integer('call_line'),
    callType: text('call_type'), // direct | dynamic | callback | import | tauri_bridge | electron_bridge
    // 未解析调用的原始被调用名（方法名或函数名）。已解析的边此列为 null。
    calleeName: text('callee_name'),
    isExternal: integer('is_external', { mode: 'boolean' }).default(false),
    bridgeTarget: text('bridge_target'),     // invoke target name e.g. 'add_server'
    bridgeFramework: text('bridge_framework'), // tauri | electron | http
  },
  (t) => [
    uniqueIndex('idx_call_edge').on(
      t.projectId,
      t.callerFuncId,
      t.calleeFuncId,
      t.callLine,
    ),
    index('idx_call_caller').on(t.callerFuncId),
    index('idx_call_callee').on(t.calleeFuncId),
  ],
);

// ───────────────────────────
// Types (class / interface / enum / struct / trait)
// ───────────────────────────
export const types = sqliteTable(
  'types',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    projectId: text('project_id')
      .notNull()
      .references(() => projects.id, { onDelete: 'cascade' }),
    fileId: integer('file_id')
      .notNull()
      .references(() => files.id, { onDelete: 'cascade' }),
    name: text('name').notNull(),
    kind: text('kind'), // class | interface | enum | type_alias | struct | trait
    parentType: text('parent_type'),
    implements: text('implements'), // JSON array
    genericParams: text('generic_params'), // JSON array
    lineStart: integer('line_start'),
    lineEnd: integer('line_end'),
  },
  (t) => [
    uniqueIndex('idx_type_project_file_name').on(t.projectId, t.fileId, t.name),
  ],
);

// ───────────────────────────
// Modules (directory-level)
// ───────────────────────────
export const modules = sqliteTable(
  'modules',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    projectId: text('project_id')
      .notNull()
      .references(() => projects.id, { onDelete: 'cascade' }),
    name: text('name').notNull(),
    path: text('path').notNull(),
    parentId: integer('parent_id'),
    depth: integer('depth').default(0),
  },
  (t) => [uniqueIndex('idx_module_project_path').on(t.projectId, t.path)],
);

// ───────────────────────────
// Module dependencies
// ───────────────────────────
export const moduleDeps = sqliteTable(
  'module_deps',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    projectId: text('project_id')
      .notNull()
      .references(() => projects.id, { onDelete: 'cascade' }),
    moduleId: integer('module_id')
      .notNull()
      .references(() => modules.id, { onDelete: 'cascade' }),
    depModuleId: integer('dep_module_id')
      .notNull()
      .references(() => modules.id, { onDelete: 'cascade' }),
    depType: text('dep_type'), // import | require | call | inherit
    weight: integer('weight').default(1),
  },
  (t) => [
    uniqueIndex('idx_module_dep').on(t.moduleId, t.depModuleId, t.depType),
  ],
);

// ───────────────────────────
// Feature tracking
// ───────────────────────────
export const features = sqliteTable('features', {
  id: text('id').primaryKey(), // "feat-login"
  projectId: text('project_id')
    .notNull()
    .references(() => projects.id, { onDelete: 'cascade' }),
  name: text('name').notNull(),
  description: text('description'),
  prdSection: text('prd_section'),
  priority: text('priority').default('medium'), // critical | high | medium | low
  status: text('status').default('unknown'), // unknown | planned | partial | complete
  completion: real('completion').default(0), // 0~1
  createdAt: integer('created_at').default(sql`(unixepoch())`),
});

// ───────────────────────────
// Feature <-> code mapping
// ───────────────────────────
export const featureCode = sqliteTable('feature_code', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  featureId: text('feature_id')
    .notNull()
    .references(() => features.id, { onDelete: 'cascade' }),
  funcId: integer('func_id')
    .notNull()
    .references(() => functions.id, { onDelete: 'cascade' }),
  fileId: integer('file_id')
    .notNull()
    .references(() => files.id, { onDelete: 'cascade' }),
  mappingType: text('mapping_type'), // primary | supporting | test | related
});

// ───────────────────────────
// Type fields (struct/interface members)
// ───────────────────────────
export const typeFields = sqliteTable(
  'type_fields',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    typeId: integer('type_id')
      .notNull()
      .references(() => types.id, { onDelete: 'cascade' }),
    projectId: text('project_id')
      .notNull()
      .references(() => projects.id, { onDelete: 'cascade' }),
    name: text('name').notNull(),
    fieldType: text('field_type').notNull(),
    visibility: text('visibility'),   // pub | private | protected | crate | default
    isOptional: integer('is_optional', { mode: 'boolean' }).default(false),
    defaultValue: text('default_value'),
    lineStart: integer('line_start'),
  },
  (t) => [
    uniqueIndex('idx_type_field').on(t.typeId, t.name),
    index('idx_type_field_project').on(t.projectId),
  ],
);

// ───────────────────────────
// Test -> target function mapping
// ───────────────────────────
export const testMappings = sqliteTable(
  'test_mappings',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    projectId: text('project_id')
      .notNull()
      .references(() => projects.id, { onDelete: 'cascade' }),
    testFuncId: integer('test_func_id')
      .notNull()
      .references(() => functions.id, { onDelete: 'cascade' }),
    targetFuncId: integer('target_func_id')
      .references(() => functions.id, { onDelete: 'set null' }),
    confidence: real('confidence').default(0.8),
  },
  (t) => [
    uniqueIndex('idx_test_mapping').on(t.projectId, t.testFuncId, t.targetFuncId),
  ],
);

// ───────────────────────────
// Type usage edges (function → type references)
// ───────────────────────────
export const typeUsageEdges = sqliteTable(
  'type_usage_edges',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    projectId: text('project_id')
      .notNull()
      .references(() => projects.id, { onDelete: 'cascade' }),
    funcId: integer('func_id')
      .notNull()
      .references(() => functions.id, { onDelete: 'cascade' }),
    typeId: integer('type_id')
      .notNull()
      .references(() => types.id, { onDelete: 'cascade' }),
    usageType: text('usage_type').notNull(), // parameter | return | body_ref
  },
  (t) => [
    uniqueIndex('idx_type_usage').on(t.projectId, t.funcId, t.typeId, t.usageType),
    index('idx_type_usage_type').on(t.typeId),
  ],
);

// ───────────────────────────
// Control Flow Graph (CFG) nodes
// ───────────────────────────
/**
 * Raise/throw 边：`函数 → 抛出的异常类型`。
 *
 * 为什么单独建表而不复用 type_usage_edges：那个表是「函数体文本里出现了类型名」
 * 的正向引用（usage_type=body_ref），无法区分「抛出」「捕获」「仅提及」。
 * 漏洞挖掘关心的是抛出点——异常路径的起点，必须方向明确。
 *
 * target 存字符串而非 typeId：异常类型可能是标准库/第三方（ValueError、
 * RequestException），不在本仓 types 表里；硬性外键会静默丢边。
 */
export const raiseEdges = sqliteTable(
  'raise_edges',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    projectId: text('project_id')
      .notNull()
      .references(() => projects.id, { onDelete: 'cascade' }),
    funcId: integer('func_id')
      .notNull()
      .references(() => functions.id, { onDelete: 'cascade' }),
    fileId: integer('file_id')
      .notNull()
      .references(() => files.id, { onDelete: 'cascade' }),
    /** 抛出的异常类型名，如 ValueError / CliError / HTTPException */
    errorType: text('error_type').notNull(),
    line: integer('line'),
    /** raise / throw；便于区分 Python raise 与 JS throw 语义 */
    kind: text('kind'),
  },
  (t) => [
    uniqueIndex('idx_raise_unique').on(t.projectId, t.funcId, t.errorType, t.line),
    index('idx_raise_project').on(t.projectId),
    index('idx_raise_error').on(t.projectId, t.errorType),
    index('idx_raise_func').on(t.funcId),
  ],
);

export const controlFlowNodes = sqliteTable(
  'control_flow_nodes',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    projectId: text('project_id')
      .notNull()
      .references(() => projects.id, { onDelete: 'cascade' }),
    funcId: integer('func_id')
      .notNull()
      .references(() => functions.id, { onDelete: 'cascade' }),
    nodeId: text('node_id').notNull(),       // e.g. 'n1','n2'
    nodeType: text('node_type').notNull(),   // start|end|condition|loop|action|switch|try|catch|return
    label: text('label'),
    lineStart: integer('line_start'),
    lineEnd: integer('line_end'),
    calleeFuncId: integer('callee_func_id'), // optional: referenced function
    conditionExpr: text('condition_expr'),    // condition expression text
  },
  (t) => [
    index('idx_cfg_node_project').on(t.projectId),
    index('idx_cfg_node_func').on(t.funcId),
  ],
);

// ───────────────────────────
// Control Flow Graph (CFG) edges
// ───────────────────────────
export const controlFlowEdges = sqliteTable(
  'control_flow_edges',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    projectId: text('project_id')
      .notNull()
      .references(() => projects.id, { onDelete: 'cascade' }),
    funcId: integer('func_id')
      .notNull()
      .references(() => functions.id, { onDelete: 'cascade' }),
    sourceNodeId: text('source_node_id').notNull(),
    targetNodeId: text('target_node_id').notNull(),
    edgeLabel: text('edge_label'),            // true|false|default|loop-body|after-loop
    edgeType: text('edge_type'),              // control|call
  },
  (t) => [
    index('idx_cfg_edge_project').on(t.projectId),
    index('idx_cfg_edge_func').on(t.funcId),
  ],
);