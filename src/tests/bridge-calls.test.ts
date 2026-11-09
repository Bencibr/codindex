import { describe, it, expect } from 'vitest';
import { scanFile } from '../scan/scanner-ts';

describe('Bridge call extraction (scanner)', () => {

  it('extracts Tauri invoke() calls', async () => {
    const source = `
import { invoke } from '@tauri-apps/api/core';

export async function listServers() {
  const servers = await invoke<ServerInfoDto[]>('get_servers');
  return servers;
}

export async function addServer(input: AddServerInput) {
  return invoke<ServerInfoDto>('add_server', { request: input });
}`;
    const result = await scanFile('serverService.ts', 'typescript', source);
    expect(result.bridgeCalls).toBeDefined();
    expect(result.bridgeCalls!.length).toBe(2);
    expect(result.bridgeCalls![0].invokeName).toBe('get_servers');
    expect(result.bridgeCalls![0].framework).toBe('tauri');
    expect(result.bridgeCalls![1].invokeName).toBe('add_server');
  });

  it('extracts invoke with generic type parameter', async () => {
    const source = `
export async function getKey(id: string) {
  return invoke<KeyInfoDto>('get_key', { id });
}`;
    const result = await scanFile('test.ts', 'typescript', source);
    expect(result.bridgeCalls).toBeDefined();
    expect(result.bridgeCalls!.length).toBe(1);
    expect(result.bridgeCalls![0].invokeName).toBe('get_key');
  });

  it('ignores non-invoke function calls', async () => {
    const source = `
export function helper() {
  console.log('not an invoke');
  fetch('/api/data');
  getData('param');
}`;
    const result = await scanFile('test.ts', 'typescript', source);
    expect(result.bridgeCalls).toBeDefined();
    expect(result.bridgeCalls!.length).toBe(0);
  });

  it('handles invoke inside try/catch', async () => {
    const source = `
export async function safeCall() {
  try {
    const r = await invoke<boolean>('delete_server', { id: '1' });
    return r;
  } catch (e) {
    return false;
  }
}`;
    const result = await scanFile('test.ts', 'typescript', source);
    expect(result.bridgeCalls!.length).toBe(1);
    expect(result.bridgeCalls![0].invokeName).toBe('delete_server');
  });

  it('assigns correct line numbers', async () => {
    const source = `import { invoke } from '@tauri-apps/api/core';

// some comment
export async function doStuff() {
  const x = await invoke('my_command');
}`;
    const result = await scanFile('test.ts', 'typescript', source);
    expect(result.bridgeCalls!.length).toBe(1);
    expect(result.bridgeCalls![0].line).toBe(5);
  });

  it('assigns caller name from enclosing function', async () => {
    const source = `
export async function listServers() {
  const r = await invoke('get_servers');
}

export async function addServer() {
  const r = await invoke('add_server');
}`;
    const result = await scanFile('test.ts', 'typescript', source);
    expect(result.bridgeCalls!.length).toBe(2);
    expect(result.bridgeCalls![0].callerName).toBe('listServers');
    expect(result.bridgeCalls![1].callerName).toBe('addServer');
  });

  it('returns empty bridgeCalls for non-bridge code', async () => {
    const source = `
export function add(a: number, b: number): number {
  return a + b;
}`;
    const result = await scanFile('test.ts', 'typescript', source);
    expect(result.bridgeCalls).toBeDefined();
    expect(result.bridgeCalls!.length).toBe(0);
  });
});

describe('Function paramsJson and returnType extraction', () => {

  it('extracts param types from TypeScript function', async () => {
    const source = `
export function greet(name: string, age: number): string {
  return \`Hello \${name}, age \${age}\`;
}`;
    const result = await scanFile('test.ts', 'typescript', source);
    const fn = result.functions.find(f => f.name === 'greet');
    expect(fn).toBeDefined();
    expect(fn!.paramsJson).toBeDefined();
    const params = JSON.parse(fn!.paramsJson!);
    expect(params.length).toBe(2);
    expect(params[0].name).toBe('name');
    expect(params[0].type).toBe('string');
    expect(params[0].optional).toBe(false);
    expect(params[1].name).toBe('age');
    expect(params[1].type).toBe('number');
  });

  it('extracts optional params', async () => {
    const source = `
export function configure(host?: string, port: number = 8080) {
  // ...
}`;
    const result = await scanFile('test.ts', 'typescript', source);
    const fn = result.functions.find(f => f.name === 'configure');
    expect(fn).toBeDefined();
    const params = JSON.parse(fn!.paramsJson!);
    const host = params.find((p: any) => p.name === 'host');
    expect(host).toBeDefined();
    expect(host.optional).toBe(true);
  });

  it('extracts return type', async () => {
    const source = `
export function getUser(id: string): User | null {
  return null;
}`;
    const result = await scanFile('test.ts', 'typescript', source);
    const fn = result.functions.find(f => f.name === 'getUser');
    expect(fn).toBeDefined();
    expect(fn!.returnType).toBe('User | null');
  });

  it('returns empty params for no-arg function', async () => {
    const source = `
export function now(): number {
  return Date.now();
}`;
    const result = await scanFile('test.ts', 'typescript', source);
    const fn = result.functions.find(f => f.name === 'now');
    expect(fn).toBeDefined();
    const params = JSON.parse(fn!.paramsJson!);
    expect(params.length).toBe(0);
    expect(fn!.returnType).toBe('number');
  });
});
