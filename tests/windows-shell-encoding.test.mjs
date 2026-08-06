import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import test from 'node:test';
import { testTempPrefix } from './helpers/platform.mjs';

// Browser Pilot carries Agent-authored text across a Windows shell boundary in
// both directions: inbound as a command argument (`bp type <ref> <text>`) and
// outbound as JSON on stdout (`bp read` returning page text). A shell that
// re-encodes non-ASCII corrupts that text silently -- the Agent observes a
// successful command while the page receives `????` -- so the boundary is
// pinned here rather than assumed.
//
// Scope: this covers the shell boundary only. The CLI parses `<text>` from argv
// without transcoding it, so an intact argv round trip is sufficient evidence
// for the inbound CLI leg; browser-side input behavior is covered by
// editable-actions and page-primitives.
//
// The Agent host chooses the shell, so every shell an Agent host realistically
// uses on Windows is exercised: powershell.exe (5.1), cmd.exe, pwsh (7+), and
// git-bash, which is what Claude Code uses on Windows.

const skip = process.platform === 'win32'
  ? false
  : 'Windows shell encoding contract applies to win32 only';

const PAYLOADS = [
  '中文输入测试',
  '日本語テキスト',
  'Grüße naïve café',
  '🚀 emoji 🌏',
  'mixed 中文 and ASCII 123',
];

function quotePowerShell(value) {
  return `'${value.replaceAll("'", "''")}'`;
}

function quoteCmd(value) {
  return `"${value}"`;
}

function quotePosix(value) {
  return `'${value.replaceAll("'", `'\\''`)}'`;
}

// Each shell receives one command string. Node passes that string to the shell
// through CreateProcessW as UTF-16, so the node -> shell leg is lossless by
// construction and the shell -> node leg is the only variable under test.
//
// cmd.exe needs `verbatim`: Node's default argument quoting escapes inner
// double quotes as `\"` per MSVCRT rules, but cmd.exe does not parse its
// command line that way and would receive the escapes literally. Passing the
// arguments verbatim with the whole command wrapped in one more quote pair is
// what `/s` expects, and is how Node itself spawns `shell: true` on Windows.
const SHELLS = [
  {
    id: 'powershell.exe',
    executable: 'powershell.exe',
    args: ['-NoProfile', '-NonInteractive', '-Command'],
    build: parts => `& ${parts.map(quotePowerShell).join(' ')}`,
  },
  {
    id: 'cmd.exe',
    executable: 'cmd.exe',
    args: ['/d', '/s', '/c'],
    verbatim: true,
    build: parts => `"${parts.map(quoteCmd).join(' ')}"`,
  },
  {
    id: 'pwsh',
    executable: 'pwsh',
    args: ['-NoProfile', '-NonInteractive', '-Command'],
    build: parts => `& ${parts.map(quotePowerShell).join(' ')}`,
  },
  {
    id: 'bash.exe',
    executable: 'bash.exe',
    args: ['-c'],
    build: parts => parts.map(quotePosix).join(' '),
  },
];

const REQUIRED_SHELLS = new Set(['powershell.exe', 'cmd.exe']);

function runShell(executable, args, verbatim = false) {
  return new Promise((resolve, reject) => {
    const child = spawn(executable, args, {
      windowsHide: true,
      windowsVerbatimArguments: verbatim,
    });
    const stdout = [];
    const stderr = [];
    child.stdout.on('data', chunk => stdout.push(chunk));
    child.stderr.on('data', chunk => stderr.push(chunk));
    child.once('error', reject);
    child.once('exit', (code, signal) => {
      resolve({
        code,
        signal,
        stdout: Buffer.concat(stdout).toString('utf8'),
        stderr: Buffer.concat(stderr).toString('utf8'),
      });
    });
  });
}

const PROBE_SOURCE = [
  "import { writeFileSync } from 'node:fs';",
  'const [outputPath, ...values] = process.argv.slice(2);',
  'const payload = JSON.stringify(values);',
  // The file write records argv independently of stdout so a stdout-only
  // regression stays distinguishable from an argv regression.
  "writeFileSync(outputPath, payload, 'utf8');",
  'process.stdout.write(payload);',
  '',
].join('\n');

test('Windows shells deliver non-ASCII text to the CLI without re-encoding it', { skip }, async t => {
  const directory = await mkdtemp(testTempPrefix('bp-win-shell-encoding-'));
  t.after(() => rm(directory, { recursive: true, force: true }));

  const probePath = join(directory, 'argv-probe.mjs');
  await writeFile(probePath, PROBE_SOURCE, 'utf8');

  const expected = JSON.stringify(PAYLOADS);
  const observed = [];

  for (const shell of SHELLS) {
    const outputPath = join(directory, `argv-${shell.id.replace(/[^a-z0-9]+/gi, '-')}.json`);
    const command = shell.build([process.execPath, probePath, outputPath, ...PAYLOADS]);

    let result;
    try {
      result = await runShell(shell.executable, [...shell.args, command], shell.verbatim === true);
    } catch (error) {
      if (error.code === 'ENOENT' && !REQUIRED_SHELLS.has(shell.id)) {
        t.diagnostic(`${shell.id}: not installed, skipped`);
        continue;
      }
      throw error;
    }

    assert.equal(
      result.code,
      0,
      `${shell.id} exited with ${result.code}${result.signal ? ` (${result.signal})` : ''}: ${result.stderr}`,
    );

    const argv = await readFile(outputPath, 'utf8');
    observed.push({ shell: shell.id, argv, stdout: result.stdout });
  }

  assert.ok(observed.length >= REQUIRED_SHELLS.size, 'powershell.exe and cmd.exe must both run');

  for (const { shell, argv, stdout } of observed) {
    assert.equal(argv, expected, `${shell} corrupted inbound argv text: ${argv}`);
    assert.equal(stdout, expected, `${shell} corrupted outbound stdout text: ${stdout}`);
  }
});
