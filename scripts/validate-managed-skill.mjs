#!/usr/bin/env node

import { execFile } from 'node:child_process';
import { lstat, readFile, readdir } from 'node:fs/promises';
import { basename, dirname, extname, relative, resolve, sep } from 'node:path';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { parseDocument } from 'yaml';

const execFileAsync = promisify(execFile);
const MAX_FILES = 512;
const MAX_FILE_BYTES = 1024 * 1024;
const MAX_TOTAL_BYTES = 16 * 1024 * 1024;
const ALLOWED_EXTENSIONS = new Set([
  '.bash', '.cjs', '.gif', '.jpeg', '.jpg', '.js', '.json', '.md', '.mjs',
  '.pdf', '.png', '.py', '.sh', '.ts', '.txt', '.webp', '.yaml', '.yml', '.zsh',
]);
const BINARY_EXTENSIONS = new Set(['.gif', '.jpeg', '.jpg', '.pdf', '.png', '.webp']);

function fail(message) {
  throw new Error(`Managed skill validation failed: ${message}`);
}

function portablePath(path) {
  return path.split(sep).join('/');
}

function hasMagic(extension, bytes) {
  switch (extension) {
    case '.png':
      return bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]));
    case '.jpg':
    case '.jpeg':
      return bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff;
    case '.gif':
      return bytes.subarray(0, 6).toString('ascii') === 'GIF87a' ||
        bytes.subarray(0, 6).toString('ascii') === 'GIF89a';
    case '.webp':
      return bytes.subarray(0, 4).toString('ascii') === 'RIFF' &&
        bytes.subarray(8, 12).toString('ascii') === 'WEBP';
    case '.pdf':
      return bytes.subarray(0, 5).toString('ascii') === '%PDF-';
    default:
      return true;
  }
}

export function parseSkillFrontmatter(source) {
  const match = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/u.exec(source);
  if (!match) fail('SKILL.md must begin with YAML frontmatter');
  const document = parseDocument(match[1], { prettyErrors: true, uniqueKeys: true });
  if (document.errors.length > 0) {
    fail(`SKILL.md frontmatter is invalid YAML: ${document.errors[0].message}`);
  }
  const metadata = document.toJS();
  if (!metadata || typeof metadata !== 'object' || Array.isArray(metadata)) {
    fail('SKILL.md frontmatter must be a YAML mapping');
  }
  if (typeof metadata.description !== 'string' || metadata.description.trim().length === 0) {
    fail('SKILL.md frontmatter requires a non-empty description');
  }
  if (Array.from(metadata.description).length > 2_000) {
    fail('SKILL.md description exceeds 2000 characters');
  }
  if (metadata.name !== undefined) {
    if (
      typeof metadata.name !== 'string' ||
      metadata.name.length > 64 ||
      !/^[a-z0-9]+(?:-[a-z0-9]+)*$/u.test(metadata.name)
    ) {
      fail('SKILL.md name must be at most 64 lowercase letters, digits, or hyphens');
    }
  }
  return metadata;
}

async function walkSkillTree(skillRoot) {
  const files = [];
  async function visit(directory) {
    const entries = await readdir(directory, { withFileTypes: true });
    entries.sort((left, right) => left.name.localeCompare(right.name));
    for (const entry of entries) {
      const path = resolve(directory, entry.name);
      const relativePath = portablePath(relative(skillRoot, path));
      if (entry.name.startsWith('.')) fail(`hidden path is not allowed: ${relativePath}`);
      const stats = await lstat(path);
      if (stats.isSymbolicLink()) fail(`symbolic link is not allowed: ${relativePath}`);
      if (stats.isDirectory()) {
        await visit(path);
        continue;
      }
      if (!stats.isFile()) fail(`unsupported filesystem entry: ${relativePath}`);
      if ((stats.mode & 0o111) !== 0) fail(`executable file is not allowed: ${relativePath}`);
      if (stats.size > MAX_FILE_BYTES) fail(`file exceeds 1MB: ${relativePath}`);
      const extension = extname(entry.name).toLowerCase();
      if (!ALLOWED_EXTENSIONS.has(extension)) fail(`unsupported file extension: ${relativePath}`);
      if (BINARY_EXTENSIONS.has(extension)) {
        const bytes = await readFile(path);
        if (!hasMagic(extension, bytes)) fail(`file magic does not match ${extension}: ${relativePath}`);
      }
      files.push({ path, relativePath, size: stats.size });
    }
  }
  await visit(skillRoot);
  return files;
}

export async function managedSkillGitModes(skillRoot) {
  const { stdout: repositoryOutput } = await execFileAsync('git', ['rev-parse', '--show-toplevel'], {
    cwd: skillRoot,
    encoding: 'utf8',
  });
  const repositoryRoot = resolve(repositoryOutput.trim());
  const repositoryPath = portablePath(relative(repositoryRoot, skillRoot));
  if (repositoryPath === '..' || repositoryPath.startsWith('../')) {
    fail('skill directory must be inside the Git repository');
  }
  const { stdout } = await execFileAsync(
    'git',
    ['ls-files', '--stage', '-z', '--', repositoryPath],
    { cwd: repositoryRoot, encoding: 'utf8', maxBuffer: 4 * 1024 * 1024 },
  );
  const modes = new Map();
  for (const record of stdout.split('\0').filter(Boolean)) {
    const match = /^(\d{6}) [0-9a-f]+ (\d)\t(.+)$/u.exec(record);
    if (!match) fail(`cannot parse Git index entry: ${record}`);
    if (match[2] !== '0') fail(`unmerged Git index entry is not allowed: ${match[3]}`);
    const relativePath = match[3].slice(repositoryPath.length + 1);
    modes.set(relativePath, match[1]);
  }
  return modes;
}

export async function validateManagedSkillDirectory(skillRoot, options = {}) {
  const root = resolve(skillRoot);
  const rootStats = await lstat(root).catch(() => undefined);
  if (!rootStats?.isDirectory() || rootStats.isSymbolicLink()) {
    fail('skill root must be a real directory');
  }
  const files = await walkSkillTree(root);
  if (files.length > MAX_FILES) fail(`skill contains more than ${MAX_FILES} files`);
  const totalBytes = files.reduce((sum, file) => sum + file.size, 0);
  if (totalBytes > MAX_TOTAL_BYTES) fail('skill exceeds the 16MB total size limit');

  const skillFiles = files.filter(file => basename(file.relativePath) === 'SKILL.md');
  if (skillFiles.length !== 1 || skillFiles[0].relativePath !== 'SKILL.md') {
    fail('skill root must contain exactly one SKILL.md and nested SKILL.md files are forbidden');
  }
  const metadata = parseSkillFrontmatter(await readFile(skillFiles[0].path, 'utf8'));

  const gitModes = options.gitModes;
  if (gitModes) {
    if (gitModes.size !== files.length) fail('every skill file must be tracked exactly once by Git');
    for (const file of files) {
      const mode = gitModes.get(file.relativePath);
      if (mode !== '100644') {
        fail(`Git mode must be 100644 for ${file.relativePath}; received ${mode ?? 'untracked'}`);
      }
    }
  }

  return {
    ok: true,
    name: metadata.name ?? basename(root),
    files: files.length,
    totalBytes,
  };
}

async function main() {
  const scriptDirectory = dirname(fileURLToPath(import.meta.url));
  const root = resolve(process.argv[2] ?? resolve(scriptDirectory, '..', 'plugin', 'skills', 'browser-pilot'));
  const result = await validateManagedSkillDirectory(root, {
    gitModes: await managedSkillGitModes(root),
  });
  process.stdout.write(`${JSON.stringify({ ...result, root })}\n`);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await main();
}
