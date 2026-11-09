/**
 * Global test setup — runs once per worker process.
 */
import { createTestProject, destroyTestProject } from './helpers';

beforeAll(() => {
  createTestProject();
});

afterAll(() => {
  destroyTestProject();
});
