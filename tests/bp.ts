// Helper: run bp CLI commands and parse JSON output.
import { execSync, spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { isAbsolute, relative, resolve } from 'node:path';

const BP = resolve(import.meta.dirname, '../dist/cli.js');
const USER_CHROME_OPT_IN = 'BROWSER_PILOT_TEST_USER_CHROME';
const BP_COMMAND_TIMEOUT_MS = 40_000;

function assertSafeBrowserEnvironment(): void {
  if (process.env[USER_CHROME_OPT_IN] === '1') return;
  const root = process.env.BROWSER_PILOT_TEST_ROOT;
  const brokerHome = process.env.BROWSER_PILOT_HOME;
  if (!root || !brokerHome || !isAbsolute(root) || !isAbsolute(brokerHome)) {
    throw new Error(
      'Browser CLI tests require the isolated global setup. ' +
      `Set ${USER_CHROME_OPT_IN}=1 only for an intentional manual run against user Chrome.`,
    );
  }
  const brokerRelative = relative(root, brokerHome);
  if (!brokerRelative || brokerRelative.startsWith('..') || isAbsolute(brokerRelative)) {
    throw new Error('Browser CLI test Broker must be contained by BROWSER_PILOT_TEST_ROOT');
  }
}

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
  assertSafeBrowserEnvironment();
  try {
    const out = execSync(`node ${BP} ${args}`, {
      encoding: 'utf-8',
      // The service navigation watchdog is 30s; the caller must allow it to
      // return a structured unknown_outcome instead of killing the CLI first.
      timeout: BP_COMMAND_TIMEOUT_MS,
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

export function startBp(args: string[]): {
  child: ChildProcessWithoutNullStreams;
  completed: Promise<BpResult>;
} {
  assertSafeBrowserEnvironment();
  const child = spawn(process.execPath, [BP, ...args], {
    env: { ...process.env, FORCE_COLOR: '0' },
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  let stdout = '';
  let stderr = '';
  child.stdout.setEncoding('utf8');
  child.stderr.setEncoding('utf8');
  child.stdout.on('data', value => { stdout += value; });
  child.stderr.on('data', value => { stderr += value; });
  const completed = new Promise<BpResult>(resolveResult => {
    const timer = setTimeout(() => child.kill('SIGTERM'), BP_COMMAND_TIMEOUT_MS);
    timer.unref();
    child.once('close', () => {
      clearTimeout(timer);
      try {
        resolveResult(JSON.parse(stdout.trim()));
      } catch {
        resolveResult({
          ok: false,
          error: stderr.trim() || stdout.trim() || 'Browser Pilot command returned no JSON result',
        });
      }
    });
  });
  return { child, completed };
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
