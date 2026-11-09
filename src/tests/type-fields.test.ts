import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { getDb } from '../db/connection';
import * as schema from '../db/schema';
import { eq } from 'drizzle-orm';
import { v4 as uuid } from 'uuid';
import { TEST_PROJECT_DIR, createTestProject, destroyTestProject, initTestGitRepo } from './helpers';
import { scanFile } from '../scan/scanner-ts';
import { scanProject } from '../scan/orchestrator';

describe('Type Fields extraction', () => {
  // ──────────────────────────────────────
  // Scanner unit tests (inline source)
  // ──────────────────────────────────────

  describe('scanner unit — TypeScript', () => {
    it('extracts fields from interface', async () => {
      const source = `
export interface User {
  id: number;
  name: string;
  email: string;
  avatar?: string;
}`;
      const result = await scanFile('test.ts', 'typescript', source);
      const user = result.types.find(t => t.name === 'User');
      expect(user).toBeDefined();
      expect(user!.kind).toBe('interface');
      expect(user!.fields).toBeDefined();
      expect(user!.fields!.length).toBe(4);

      const id = user!.fields!.find(f => f.name === 'id')!;
      expect(id.fieldType).toBe('number');
      expect(id.isOptional).toBe(false);

      const avatar = user!.fields!.find(f => f.name === 'avatar')!;
      expect(avatar.isOptional).toBe(true);
    });

    it('extracts fields from class with visibility', async () => {
      const source = `
export class Database {
  public host: string;
  private conn: Connection;
  protected pool: Pool;
}`;
      const result = await scanFile('test.ts', 'typescript', source);
      const db = result.types.find(t => t.name === 'Database');
      expect(db).toBeDefined();
      expect(db!.kind).toBe('class');

      const fields = db!.fields!;
      expect(fields.length).toBe(3);
      expect(fields[0].name).toBe('host');
      expect(fields[0].visibility).toBe('public');
      expect(fields[1].name).toBe('conn');
      expect(fields[1].visibility).toBe('private');
      expect(fields[2].name).toBe('pool');
      expect(fields[2].visibility).toBe('protected');
    });

    it('extracts fields from type alias with object', async () => {
      const source = `
export type Config = {
  timeout: number;
  retries: number;
  debug?: boolean;
}`;
      const result = await scanFile('test.ts', 'typescript', source);
      const config = result.types.find(t => t.name === 'Config');
      expect(config).toBeDefined();
      expect(config!.kind).toBe('type_alias');
      expect(config!.fields!.length).toBe(3);

      const debug = config!.fields!.find(f => f.name === 'debug')!;
      expect(debug.isOptional).toBe(true);
    });

    it('extracts enum members', async () => {
      const source = `
enum Direction {
  Up = 'UP',
  Down = 'DOWN',
  Left = 'LEFT',
  Right = 'RIGHT',
}`;
      const result = await scanFile('test.ts', 'typescript', source);
      const dir = result.types.find(t => t.name === 'Direction');
      expect(dir).toBeDefined();
      expect(dir!.kind).toBe('enum');
      expect(dir!.fields!.length).toBe(4);
      expect(dir!.fields![0].fieldType).toBe('enum_member');
    });

    it('returns empty fields for union type alias', async () => {
      const source = `type Status = 'active' | 'inactive' | 'pending';`;
      const result = await scanFile('test.ts', 'typescript', source);
      const status = result.types.find(t => t.name === 'Status');
      expect(status).toBeDefined();
      // Union type has no object body → no fields
      expect(status!.fields!.length).toBe(0);
    });
  });

  describe('scanner unit — Rust', () => {
    it('extracts fields from struct with pub visibility', async () => {
      const source = `
pub struct ServerInfo {
    pub id: String,
    pub name: String,
    pub port: u16,
    internal: Vec<u8>,
}`;
      const result = await scanFile('test.rs', 'rust', source);
      const struct = result.types.find(t => t.name === 'ServerInfo');
      expect(struct).toBeDefined();
      expect(struct!.kind).toBe('struct');

      const fields = struct!.fields!;
      expect(fields.length).toBe(4);
      expect(fields[0].name).toBe('id');
      expect(fields[0].visibility).toBe('pub');
      expect(fields[0].fieldType).toContain('String');
      expect(fields[3].name).toBe('internal');
      expect(fields[3].visibility).toBe('private');
    });

    it('extracts enum variants', async () => {
      const source = `
enum Color {
    Red,
    Green,
    Blue(u8),
}`;
      const result = await scanFile('test.rs', 'rust', source);
      const color = result.types.find(t => t.name === 'Color');
      expect(color).toBeDefined();
      expect(color!.kind).toBe('enum');
      expect(color!.fields!.length).toBeGreaterThanOrEqual(3);
    });

    it('handles empty struct', async () => {
      const source = `pub struct Empty;`;
      const result = await scanFile('test.rs', 'rust', source);
      const empty = result.types.find(t => t.name === 'Empty');
      // Empty struct might be detected but with no fields
      if (empty) {
        expect(empty.fields!.length).toBe(0);
      }
    });
  });

  // ──────────────────────────────────────
  // Integration tests (full scan → DB)
  // ──────────────────────────────────────

  describe('integration — DB write', () => {
    let projectId: string;
    const db = getDb();

    beforeAll(async () => {
      createTestProject();
      initTestGitRepo();
      projectId = uuid();
      const db = getDb();
      // Clean up any leftover project at TEST_PROJECT_DIR
      await db.delete(schema.projects).where(eq(schema.projects.path, TEST_PROJECT_DIR));
      await db.insert(schema.projects).values({
        id: projectId, name: 'TypeFieldTest', path: TEST_PROJECT_DIR, status: 'pending',
      });
      await scanProject(projectId, TEST_PROJECT_DIR);
    });

    afterAll(async () => {
      if (!projectId) return;
      await db.delete(schema.typeFields).where(eq(schema.typeFields.projectId, projectId));
    await db.delete(schema.typeUsageEdges).where(eq(schema.typeUsageEdges.projectId, projectId));
      await db.delete(schema.calls).where(eq(schema.calls.projectId, projectId));
      await db.delete(schema.functions).where(eq(schema.functions.projectId, projectId));
      await db.delete(schema.types).where(eq(schema.types.projectId, projectId));
      await db.delete(schema.files).where(eq(schema.files.projectId, projectId));
      await db.delete(schema.moduleDeps).where(eq(schema.moduleDeps.projectId, projectId));
      await db.delete(schema.modules).where(eq(schema.modules.projectId, projectId));
      await db.delete(schema.features).where(eq(schema.features.projectId, projectId));
      await db.delete(schema.featureCode).where(eq(schema.featureCode.featureId, projectId));
      await db.delete(schema.projects).where(eq(schema.projects.id, projectId));
      destroyTestProject();
    });

    it('type_fields table has records after scan', async () => {
      const fields = await db.select().from(schema.typeFields)
        .where(eq(schema.typeFields.projectId, projectId));
      // User interface has 3 fields, Config has 2, ServerInfo has 4
      expect(fields.length).toBeGreaterThanOrEqual(3);
    });

    it('User interface fields are stored correctly', async () => {
      const types = await db.select().from(schema.types)
        .where(eq(schema.types.projectId, projectId));
      const user = types.find(t => t.name === 'User');
      expect(user).toBeDefined();

      if (user) {
        const fields = await db.select().from(schema.typeFields)
          .where(eq(schema.typeFields.typeId, user.id))
          .orderBy(schema.typeFields.lineStart);
        const fieldNames = fields.map(f => f.name);
        expect(fieldNames).toContain('id');
        expect(fieldNames).toContain('name');
        expect(fieldNames).toContain('email');

        const emailField = fields.find(f => f.name === 'email')!;
        expect(emailField.fieldType).toBe('string');
        expect(emailField.isOptional).toBe(false);
      }
    });

    it('Rust ServerInfo struct fields are stored', async () => {
      const types = await db.select().from(schema.types)
        .where(eq(schema.types.projectId, projectId));
      const serverInfo = types.find(t => t.name === 'ServerInfo');
      expect(serverInfo).toBeDefined();
      expect(serverInfo!.kind).toBe('struct');

      if (serverInfo) {
        const fields = await db.select().from(schema.typeFields)
          .where(eq(schema.typeFields.typeId, serverInfo.id));
        expect(fields.length).toBe(4);

        const idField = fields.find(f => f.name === 'id')!;
        expect(idField.visibility).toBe('pub');
      }
    });

    it('type_fields cascade deletes with project', async () => {
      const before = await db.select().from(schema.typeFields)
        .where(eq(schema.typeFields.projectId, projectId));
      expect(before.length).toBeGreaterThan(0);

      await db.delete(schema.projects).where(eq(schema.projects.id, projectId));

      const after = await db.select().from(schema.typeFields)
        .where(eq(schema.typeFields.projectId, projectId));
      expect(after.length).toBe(0);

      // Re-create for other tests
      projectId = uuid();
      const db2 = getDb();
      await db2.delete(schema.projects).where(eq(schema.projects.path, TEST_PROJECT_DIR));
      await db2.insert(schema.projects).values({
        id: projectId, name: 'TypeFieldTest2', path: TEST_PROJECT_DIR, status: 'pending',
      });
      await scanProject(projectId, TEST_PROJECT_DIR);
    });
  });
});
