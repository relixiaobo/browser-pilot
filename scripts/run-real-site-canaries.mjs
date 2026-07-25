import { spawn } from 'node:child_process';
import { readFile, rm } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { canaryExitCode } from './real-site-canary-policy.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const reportPath = resolve(
  process.env.BROWSER_PILOT_CANARY_REPORT ??
  join(root, 'test-results/real-site-canary/report.json'),
);
const strict = process.argv.includes('--strict');
const playwrightCli = join(root, 'node_modules/@playwright/test/cli.js');
const reporter = join(root, 'tests/real-site-canary-reporter.mjs');

await rm(reportPath, { force: true });

const exitCode = await new Promise((resolveExit, reject) => {
  const child = spawn(process.execPath, [
    playwrightCli,
    'test',
    '--project',
    'integration',
    `--reporter=${reporter}`,
  ], {
    cwd: root,
    env: { ...process.env, BROWSER_PILOT_CANARY_REPORT: reportPath },
    stdio: 'inherit',
  });
  child.once('error', reject);
  child.once('exit', code => resolveExit(code ?? 1));
});

let report;
try {
  report = JSON.parse(await readFile(reportPath, 'utf8'));
} catch (error) {
  process.stderr.write(`[browser-pilot canary] report unavailable: ${error.message}\n`);
}

process.exitCode = canaryExitCode(report, exitCode, strict);
