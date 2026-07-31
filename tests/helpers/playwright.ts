import { evaluate, type BpResult } from '../bp.js';

const port = process.env.BROWSER_PILOT_TEST_SERVER_PORT;
if (!port) throw new Error('BROWSER_PILOT_TEST_SERVER_PORT was not set by Playwright config');

export const TEST_BASE_URL = `http://127.0.0.1:${port}`;

export async function waitForEvaluation(
  expression: string,
  predicate: (result: BpResult) => boolean = result => Boolean(result.value),
  timeoutMs = 5_000,
): Promise<BpResult> {
  const deadline = Date.now() + timeoutMs;
  let result: BpResult = { ok: false, error: 'Evaluation has not run' };
  while (Date.now() < deadline) {
    result = evaluate(expression);
    if (predicate(result)) return result;
    await new Promise(resolve => setTimeout(resolve, 50));
  }
  throw new Error(`Timed out waiting for browser evaluation: ${expression}`);
}

export async function waitForValue<T>(
  read: () => T,
  predicate: (value: T) => boolean,
  timeoutMs = 5_000,
): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  let value: T;
  while (Date.now() < deadline) {
    value = read();
    if (predicate(value)) return value;
    await new Promise(resolve => setTimeout(resolve, 50));
  }
  throw new Error('Timed out waiting for expected browser test value');
}
