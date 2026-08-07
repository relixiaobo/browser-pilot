import type { SiteKnowledgeDelivery } from '../protocol/model.js';
import type { SiteKnowledgeMatchResult } from './site-knowledge-store.js';

/**
 * Decides how much site knowledge each observation carries.
 *
 * Knowledge must reach the Agent before it acts, so a file is inlined whole the
 * first time an Agent sees that version and shrinks to one line afterwards. The
 * de-duplication key is the file's mtime rather than its frontmatter `updated`
 * field: an Agent repairing a file cannot forget to bump an mtime, and one
 * Agent's repair therefore re-delivers to every other Agent for free.
 *
 * See docs/plans/site-knowledge.md.
 */

const DEFAULT_INLINE_BUDGET_BYTES = 2_048;

export interface SiteKnowledgeDeliveryOptions {
  inlineBudgetBytes?: number;
}

export class SiteKnowledgeDeliveryTracker {
  private readonly inlineBudgetBytes: number;
  /** scope -> site name -> mtime of the version already inlined for that scope. */
  private readonly delivered = new Map<string, Map<string, number>>();
  /** scope -> file path -> reason already reported for that scope. */
  private readonly reportedInvalid = new Map<string, Map<string, string>>();

  constructor(options: SiteKnowledgeDeliveryOptions = {}) {
    this.inlineBudgetBytes = options.inlineBudgetBytes ?? DEFAULT_INLINE_BUDGET_BYTES;
  }

  /**
   * Builds the delivery for one observation. Matches arrive most specific first
   * and keep that order, so the most relevant file wins the inline budget.
   */
  deliver(scope: string, result: SiteKnowledgeMatchResult): SiteKnowledgeDelivery[] {
    const entries: SiteKnowledgeDelivery[] = [];
    const delivered = this.scopeMap(this.delivered, scope);
    let remaining = this.inlineBudgetBytes;

    for (const match of result.matches) {
      const { name, summary, path, updated, body, mtimeMs } = match.record;
      const alreadyDelivered = delivered.get(name) === mtimeMs;
      const size = Buffer.byteLength(body, 'utf8');

      if (!alreadyDelivered && size <= remaining) {
        remaining -= size;
        delivered.set(name, mtimeMs);
        entries.push({
          status: 'full',
          name,
          summary,
          path,
          ...(updated !== undefined ? { updated } : {}),
          body,
        });
        continue;
      }

      // A file skipped for budget is deliberately not marked delivered, so a
      // later observation with fewer matches can still inline it.
      entries.push({ status: 'seen', name, summary, path });
    }

    entries.push(...this.invalidEntries(scope, result.invalid));
    return entries;
  }

  /** Drops the memory for a scope whose workspace was released. */
  releaseScope(scope: string): void {
    this.delivered.delete(scope);
    this.reportedInvalid.delete(scope);
  }

  private invalidEntries(
    scope: string,
    invalid: SiteKnowledgeMatchResult['invalid'],
  ): SiteKnowledgeDelivery[] {
    const reported = this.scopeMap(this.reportedInvalid, scope);
    const entries: SiteKnowledgeDelivery[] = [];
    const current = new Set<string>();

    for (const file of invalid) {
      current.add(file.path);
      // Repeating an unchanged complaint on every observation is noise; a new
      // reason means the file changed and is worth saying again.
      if (reported.get(file.path) === file.reason) continue;
      reported.set(file.path, file.reason);
      entries.push({ status: 'invalid', path: file.path, reason: file.reason });
    }

    // Forget repaired files so a later regression is reported afresh.
    for (const path of [...reported.keys()]) {
      if (!current.has(path)) reported.delete(path);
    }

    return entries;
  }

  private scopeMap<T>(store: Map<string, Map<string, T>>, scope: string): Map<string, T> {
    const existing = store.get(scope);
    if (existing) return existing;
    const created = new Map<string, T>();
    store.set(scope, created);
    return created;
  }
}
