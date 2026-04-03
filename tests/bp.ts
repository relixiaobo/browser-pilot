// Helper: run bp CLI commands and parse JSON output.
import { execSync } from 'node:child_process';
import { resolve } from 'node:path';

const BP = resolve(import.meta.dirname, '../dist/cli.js');

export interface BpResult {
  ok: boolean;
  title?: string;
  url?: string;
  elements?: Array<{
    ref: number;
    backendNodeId: number;
    role: string;
    name: string;
    value?: string;
    checked?: boolean;
  }>;
  error?: string;
  hint?: string;
  value?: any;
  [key: string]: any;
}

function run(args: string): BpResult {
  try {
    const out = execSync(`node ${BP} ${args}`, {
      encoding: 'utf-8',
      timeout: 15_000,
      env: { ...process.env, FORCE_COLOR: '0' },
    }).trim();
    return JSON.parse(out);
  } catch (e: any) {
    // bp exits non-zero on errors but still outputs JSON
    const stdout = e.stdout?.toString().trim() || '';
    try {
      return JSON.parse(stdout);
    } catch {
      return { ok: false, error: e.message };
    }
  }
}

export function bp(command: string): BpResult {
  return run(command);
}

/** Open a URL and return snapshot */
export function open(url: string, opts?: { limit?: number }): BpResult {
  const limit = opts?.limit ? ` --limit ${opts.limit}` : '';
  return bp(`open ${JSON.stringify(url)}${limit}`);
}

/** Click a ref and return snapshot */
export function click(ref: number | string): BpResult {
  return bp(`click ${ref}`);
}

/** Type text into a ref */
export function type(ref: number | string, text: string, opts?: { clear?: boolean; submit?: boolean }): BpResult {
  const flags = [
    opts?.clear ? '--clear' : '',
    opts?.submit ? '--submit' : '',
  ].filter(Boolean).join(' ');
  return bp(`type ${ref} ${JSON.stringify(text)} ${flags}`);
}

/** Press a key */
export function press(key: string): BpResult {
  return bp(`press ${key}`);
}

/** Run eval and return result */
export function evaluate(expression: string): BpResult {
  return bp(`eval ${JSON.stringify(expression)}`);
}

/** Get snapshot */
export function snapshot(opts?: { limit?: number }): BpResult {
  const limit = opts?.limit ? ` --limit ${opts.limit}` : '';
  return bp(`snapshot${limit}`);
}

/** Find ref by name (partial match) */
export function findRef(result: BpResult, name: string): number | undefined {
  return result.elements?.find(e => e.name.includes(name))?.ref;
}

/** Find ref by role and name */
export function findRefByRole(result: BpResult, role: string, name?: string): number | undefined {
  return result.elements?.find(e => e.role === role && (!name || e.name.includes(name)))?.ref;
}

/** Connect to Chrome (call once in beforeAll) */
export function connect(): BpResult {
  return bp('connect');
}

/** Disconnect */
export function disconnect(): BpResult {
  return bp('disconnect');
}
