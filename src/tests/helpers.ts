import { execSync } from 'child_process';
import { existsSync, mkdirSync, rmSync, writeFileSync } from 'fs';
import { resolve } from 'path';

/** Check if git is available on this system */
export function isGitAvailable(): boolean {
  try {
    execSync('git --version', { stdio: 'pipe' });
    return true;
  } catch {
    return false;
  }
}

/** Create a temporary test project tree for scanning tests */
const WORKER_ID = process.env.VITEST_WORKER_ID || '0';
export const TEST_PROJECT_DIR = resolve('/tmp', `codindex-test-project-${WORKER_ID}`);

export function createTestProject(): void {
  if (existsSync(TEST_PROJECT_DIR)) rmSync(TEST_PROJECT_DIR, { recursive: true });
  mkdirSync(TEST_PROJECT_DIR, { recursive: true });
  mkdirSync(`${TEST_PROJECT_DIR}/src/utils`, { recursive: true });
  mkdirSync(`${TEST_PROJECT_DIR}/src/services`, { recursive: true });
  mkdirSync(`${TEST_PROJECT_DIR}/src/test`, { recursive: true });

  writeFileSync(`${TEST_PROJECT_DIR}/src/utils/helpers.ts`, `
/** Date formatter */
export function formatDate(d: Date): string {
  return d.toISOString().split('T')[0];
}

/** Clamp a value */
export function clamp(value: number, min: number, max: number): number {
  // @feature: data-processing
  if (value < min) return min;
  if (value > max) return max;
  return value;
}
`.trimStart());

  writeFileSync(`${TEST_PROJECT_DIR}/src/services/user-service.ts`, `
import { formatDate, clamp } from '../utils/helpers';

export interface User {
  id: number;
  name: string;
  email: string;
}

/**
 * Find user by email.
 * @feature: user-management
 */
export function findUserByEmail(users: User[], email: string): User | undefined {
  return users.find(u => u.email === email);
}

export function formatUserName(user: User): string {
  const n = user.name.trim();
  return n.charAt(0).toUpperCase() + n.slice(1);
}

export function getGreeting(user: User): string {
  const hour = new Date().getHours();
  const timeStr = formatDate(new Date());
  const name = formatUserName(user);
  if (hour < 12) return \`Good morning, \${name}! (\${timeStr})\`;
  if (hour < 18) return \`Good afternoon, \${name}! (\${timeStr})\`;
  return \`Good evening, \${name}! (\${timeStr})\`;
}
`.trimStart());

  writeFileSync(`${TEST_PROJECT_DIR}/src/index.ts`, `
import { findUserByEmail, User } from './services/user-service';
import { clamp } from './utils/helpers';

const users: User[] = [
  { id: 1, name: 'alice', email: 'alice@example.com' },
  { id: 2, name: 'bob', email: 'bob@example.com' },
];

export function getUserByEmail(email: string): User | undefined {
  return findUserByEmail(users, email);
}

export function main() {
  const user = getUserByEmail('alice@example.com');
  if (user) console.log(\`Welcome \${user.name}\`);
  return 0;
}
`.trimStart());

  // Two more tricky files for edge cases
  writeFileSync(`${TEST_PROJECT_DIR}/src/utils/complex.ts`, `
/** High-complexity function with many branches */
export function classify(x: number): string {
  if (x > 100) return 'big';
  if (x > 50) return 'medium';
  if (x < 0) return 'negative';
  return 'small';
}

type Status = 'active' | 'inactive' | 'pending';

export interface Config {
  timeout: number;
  retries: number;
}
`.trimStart());

  writeFileSync(`${TEST_PROJECT_DIR}/src/test/helpers.test.ts`, `
import { clamp } from '../utils/helpers';

describe('clamp', () => {
  it('should clamp within range', () => {
    expect(clamp(5, 0, 10)).toBe(5);
  });
});
`.trimStart());

  // ── Rust backend files (Tauri-like) ──
  mkdirSync(`${TEST_PROJECT_DIR}/src-tauri/src/commands`, { recursive: true });

  writeFileSync(`${TEST_PROJECT_DIR}/src-tauri/src/lib.rs`, `
mod commands;

use commands::server::{get_servers, add_server};
use commands::key::generate_key_pair;

pub fn run() {
    tauri::Builder::default()
        .invoke_handler(tauri::generate_handler![
            get_servers,
            add_server,
            generate_key_pair,
        ])
        .run(tauri::generate_context!())
        .expect("error");
}
`.trimStart());

  writeFileSync(`${TEST_PROJECT_DIR}/src-tauri/src/commands/server.rs`, `
use serde::{Deserialize, Serialize};

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct ServerInfo {
    pub id: String,
    pub name: String,
    pub host: String,
    pub port: u16,
}

#[tauri::command]
pub fn get_servers() -> Result<Vec<ServerInfo>, String> {
    Ok(vec![])
}

#[tauri::command]
pub fn add_server(name: String, host: String) -> Result<ServerInfo, String> {
    Ok(ServerInfo { id: "1".into(), name, host, port: 22 })
}
`.trimStart());

  writeFileSync(`${TEST_PROJECT_DIR}/src-tauri/src/commands/key.rs`, `
#[tauri::command]
pub fn generate_key_pair(name: String, algorithm: String) -> Result<String, String> {
    // placeholder: will be implemented in v0.2.0
    Ok(String::new())
}
`.trimStart());

  // ── Frontend service with invoke bridge calls ──
  mkdirSync(`${TEST_PROJECT_DIR}/src/services`, { recursive: true });

  writeFileSync(`${TEST_PROJECT_DIR}/src/services/serverService.ts`, `
export async function listServers() {
  const servers = await invoke<ServerInfoDto[]>('get_servers');
  return servers;
}

export async function addServer(input: AddServerInput) {
  return invoke<ServerInfoDto>('add_server', { name: input.name, host: input.host });
}
`.trimStart());

  writeFileSync(`${TEST_PROJECT_DIR}/src/services/keyService.ts`, `
export async function generateKey(name: string, algorithm: string) {
  return invoke<string>('generate_key_pair', { name, algorithm });
}
`.trimStart());
}

export function destroyTestProject(): void {
  if (existsSync(TEST_PROJECT_DIR)) rmSync(TEST_PROJECT_DIR, { recursive: true });
}

/** Init a git repo in test project for git-history tests */
export function initTestGitRepo(): void {
  try {
    execSync('git init', { cwd: TEST_PROJECT_DIR, stdio: 'pipe' });
    execSync('git config user.email test@codindex.test', { cwd: TEST_PROJECT_DIR, stdio: 'pipe' });
    execSync('git config user.name Tester', { cwd: TEST_PROJECT_DIR, stdio: 'pipe' });
    execSync('git add -A && git commit -m "initial"', { cwd: TEST_PROJECT_DIR, stdio: 'pipe' });
  } catch {
    // git may not be available
  }
}
