import { readFile, readdir, stat } from 'node:fs/promises';
import { basename, extname, join } from 'node:path';
import { SITES_DIR } from '../paths.js';
import { wildcardMatch } from '../wildcard.js';

/**
 * Site knowledge is durable, per-site operating guidance written as Markdown
 * with a small frontmatter header. The Broker never executes, validates, or
 * interprets a file body; it only matches files to the selected tab's URL and
 * hands them to the Agent. See docs/plans/site-knowledge.md.
 */

const FRONTMATTER_DELIMITER = '---';
const SITE_FILE_EXTENSION = '.md';
const DEFAULT_MAX_FILES = 256;
const DEFAULT_MAX_FILE_BYTES = 64 * 1024;

export interface SiteKnowledgeRecord {
  /** Identifier; always equal to the file's basename without extension. */
  name: string;
  /** Match patterns, `host[/path-glob]`, never carrying a scheme. */
  domains: string[];
  /** One line used by the short delivery form. */
  summary: string;
  /** Author-supplied date for the model's trust discounting. Never parsed. */
  updated?: string;
  /** Everything after the frontmatter, verbatim. */
  body: string;
  path: string;
  /** Delivery de-duplication key. Machine-owned, unlike `updated`. */
  mtimeMs: number;
}

export interface InvalidSiteKnowledgeFile {
  path: string;
  reason: string;
}

export interface SiteKnowledgeScan {
  records: SiteKnowledgeRecord[];
  invalid: InvalidSiteKnowledgeFile[];
}

export interface SiteKnowledgeMatch {
  record: SiteKnowledgeRecord;
  /** The longest pattern on the record that matched the URL. */
  pattern: string;
}

export interface SiteKnowledgeMatchResult {
  matches: SiteKnowledgeMatch[];
  invalid: InvalidSiteKnowledgeFile[];
}

export interface SiteKnowledgeStoreOptions {
  directory?: string;
  maxFiles?: number;
  maxFileBytes?: number;
}

function unquote(value: string): string {
  const trimmed = value.trim();
  if (trimmed.length >= 2) {
    const first = trimmed[0];
    const last = trimmed[trimmed.length - 1];
    if ((first === '"' && last === '"') || (first === "'" && last === "'")) {
      return trimmed.slice(1, -1);
    }
  }
  return trimmed;
}

function parseFlowSequence(value: string): string[] {
  const trimmed = value.trim();
  if (!trimmed.startsWith('[') || !trimmed.endsWith(']')) return [];
  const inner = trimmed.slice(1, -1).trim();
  if (inner === '') return [];
  return inner.split(',').map(entry => unquote(entry)).filter(entry => entry !== '');
}

/**
 * Parses the restricted frontmatter subset the format needs: scalars, flow
 * sequences, and block sequences. A full YAML parser is deliberately avoided —
 * only four machine-consumed fields exist, and the runtime carries no YAML
 * dependency.
 */
function parseFields(lines: readonly string[]): Map<string, string | string[]> {
  const fields = new Map<string, string | string[]>();
  let pendingKey: string | undefined;
  let pendingList: string[] | undefined;

  const flush = (): void => {
    if (pendingKey !== undefined && pendingList !== undefined) {
      fields.set(pendingKey, pendingList);
    }
    pendingKey = undefined;
    pendingList = undefined;
  };

  for (const line of lines) {
    const trimmed = line.trim();
    if (trimmed === '' || trimmed.startsWith('#')) continue;

    const listItem = /^-\s+(.*)$/.exec(trimmed);
    if (listItem && pendingList !== undefined) {
      pendingList.push(unquote(listItem[1]));
      continue;
    }

    const pair = /^([A-Za-z][A-Za-z0-9_-]*)\s*:\s*(.*)$/.exec(trimmed);
    if (!pair) {
      flush();
      continue;
    }
    flush();

    const key = pair[1];
    const value = pair[2].trim();
    if (value === '') {
      pendingKey = key;
      pendingList = [];
      continue;
    }
    fields.set(key, value.startsWith('[') ? parseFlowSequence(value) : unquote(value));
  }

  flush();
  return fields;
}

interface ParsedDocument {
  fields: Map<string, string | string[]>;
  body: string;
}

function parseDocument(content: string): ParsedDocument | undefined {
  const normalized = content.replace(/^\uFEFF/, '').replace(/\r\n/g, '\n');
  const lines = normalized.split('\n');
  if (lines[0]?.trim() !== FRONTMATTER_DELIMITER) return undefined;

  let end = -1;
  for (let index = 1; index < lines.length; index += 1) {
    if (lines[index].trim() === FRONTMATTER_DELIMITER) {
      end = index;
      break;
    }
  }
  if (end === -1) return undefined;

  return {
    fields: parseFields(lines.slice(1, end)),
    body: lines.slice(end + 1).join('\n').trim(),
  };
}

function readString(fields: Map<string, string | string[]>, key: string): string | undefined {
  const value = fields.get(key);
  return typeof value === 'string' && value !== '' ? value : undefined;
}

function readStringList(fields: Map<string, string | string[]>, key: string): string[] {
  const value = fields.get(key);
  if (Array.isArray(value)) return value.filter(entry => entry !== '');
  return typeof value === 'string' && value !== '' ? [value] : [];
}

/**
 * Strips the case, trailing dot, and `www.` prefix that must never decide a
 * match. Leniency is deliberate: an unwanted match costs a few tokens the Agent
 * ignores, while a missed match fails silently.
 */
function normalizeHost(value: string): string {
  const lower = value.trim().toLowerCase();
  const withoutTrailingDot = lower.endsWith('.') ? lower.slice(0, -1) : lower;
  return withoutTrailingDot.startsWith('www.') ? withoutTrailingDot.slice(4) : withoutTrailingDot;
}

/**
 * Matches a URL against one `host[/path-glob]` pattern.
 *
 * The host part matches the hostname itself, any subdomain on a dot boundary,
 * and `*` wildcards. The path part, when present, is matched against the URL
 * pathname with `*` spanning `/` as well. Query strings never participate.
 */
export function matchesSiteDomain(url: string, pattern: string): boolean {
  const trimmedPattern = pattern.trim();
  if (trimmedPattern === '') return false;

  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return false;
  }
  if (parsed.hostname === '') return false;

  const separator = trimmedPattern.indexOf('/');
  const hostPattern = separator === -1 ? trimmedPattern : trimmedPattern.slice(0, separator);
  const pathPattern = separator === -1 ? '' : trimmedPattern.slice(separator);

  const host = normalizeHost(parsed.hostname);
  const expectedHost = normalizeHost(hostPattern);
  if (expectedHost === '') return false;

  const hostMatches = host === expectedHost
    || host.endsWith(`.${expectedHost}`)
    || (expectedHost.includes('*') && wildcardMatch(host, expectedHost));
  if (!hostMatches) return false;

  if (pathPattern === '' || pathPattern === '/') return true;
  return wildcardMatch(parsed.pathname, pathPattern);
}

export class SiteKnowledgeStore {
  private readonly directory: string;
  private readonly maxFiles: number;
  private readonly maxFileBytes: number;

  constructor(options: SiteKnowledgeStoreOptions = {}) {
    this.directory = options.directory ?? SITES_DIR;
    this.maxFiles = options.maxFiles ?? DEFAULT_MAX_FILES;
    this.maxFileBytes = options.maxFileBytes ?? DEFAULT_MAX_FILE_BYTES;
  }

  /**
   * Reads every valid site file. A missing directory is the normal state before
   * the corpus exists and yields an empty scan without an error. Files that
   * cannot be used are reported rather than dropped silently, so an Agent can
   * repair a file it wrote itself.
   */
  async scan(): Promise<SiteKnowledgeScan> {
    const records: SiteKnowledgeRecord[] = [];
    const invalid: InvalidSiteKnowledgeFile[] = [];

    let entries;
    try {
      entries = await readdir(this.directory, { withFileTypes: true });
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code !== 'ENOENT' && code !== 'ENOTDIR') {
        invalid.push({
          path: this.directory,
          reason: `Cannot read the site knowledge directory: ${code ?? 'unknown error'}`,
        });
      }
      return { records, invalid };
    }

    const candidates = entries
      .filter(entry => extname(entry.name).toLowerCase() === SITE_FILE_EXTENSION)
      .sort((left, right) => left.name.localeCompare(right.name));

    const selected = candidates.slice(0, this.maxFiles);
    if (candidates.length > selected.length) {
      invalid.push({
        path: this.directory,
        reason: `Directory holds ${candidates.length} site files; only the first ${this.maxFiles} were read`,
      });
    }

    for (const entry of selected) {
      const path = join(this.directory, entry.name);
      if (!entry.isFile()) {
        invalid.push({ path, reason: 'Not a regular file' });
        continue;
      }

      const record = await this.readRecord(path, entry.name);
      if ('reason' in record) invalid.push(record);
      else records.push(record);
    }

    return { records, invalid };
  }

  /** Returns every site file whose patterns match the URL, most specific first. */
  async match(url: string): Promise<SiteKnowledgeMatchResult> {
    const { records, invalid } = await this.scan();
    const matches: SiteKnowledgeMatch[] = [];

    for (const record of records) {
      let best: string | undefined;
      for (const pattern of record.domains) {
        if (!matchesSiteDomain(url, pattern)) continue;
        if (best === undefined || pattern.length > best.length) best = pattern;
      }
      if (best !== undefined) matches.push({ record, pattern: best });
    }

    matches.sort((left, right) => (
      right.pattern.length - left.pattern.length
      || left.record.name.localeCompare(right.record.name)
    ));
    return { matches, invalid };
  }

  private async readRecord(
    path: string,
    fileName: string,
  ): Promise<SiteKnowledgeRecord | InvalidSiteKnowledgeFile> {
    let mtimeMs: number;
    try {
      const stats = await stat(path);
      if (stats.size > this.maxFileBytes) {
        return { path, reason: `File exceeds the ${this.maxFileBytes}-byte site file limit` };
      }
      mtimeMs = stats.mtimeMs;
    } catch (error) {
      return { path, reason: `Cannot stat file: ${(error as NodeJS.ErrnoException).code ?? 'unknown error'}` };
    }

    let content: string;
    try {
      content = await readFile(path, 'utf8');
    } catch (error) {
      return { path, reason: `Cannot read file: ${(error as NodeJS.ErrnoException).code ?? 'unknown error'}` };
    }

    const parsed = parseDocument(content);
    if (!parsed) {
      return { path, reason: 'Missing a frontmatter block delimited by ---' };
    }

    const expectedName = basename(fileName, SITE_FILE_EXTENSION);
    const name = readString(parsed.fields, 'name');
    if (name === undefined) return { path, reason: 'Frontmatter is missing a non-empty name' };
    if (name !== expectedName) {
      return { path, reason: `Frontmatter name "${name}" does not match the file name "${expectedName}"` };
    }

    const domains = readStringList(parsed.fields, 'domains');
    if (domains.length === 0) {
      return { path, reason: 'Frontmatter is missing a non-empty domains list' };
    }

    const summary = readString(parsed.fields, 'summary');
    if (summary === undefined) return { path, reason: 'Frontmatter is missing a non-empty summary' };

    const updated = readString(parsed.fields, 'updated');
    return {
      name,
      domains,
      summary,
      ...(updated !== undefined ? { updated } : {}),
      body: parsed.body,
      path,
      mtimeMs,
    };
  }
}
