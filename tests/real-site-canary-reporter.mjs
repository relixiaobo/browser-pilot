import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';

const DEFAULT_REPORT_PATH = 'test-results/real-site-canary/report.json';
const MAX_ERROR_CHARACTERS = 500;

export function sanitizeCanaryError(error) {
  if (!error) return undefined;
  const raw = typeof error.message === 'string' ? error.message : String(error);
  const message = raw.split(/\r?\n/, 1)[0].slice(0, MAX_ERROR_CHARACTERS);
  return message ? { message } : undefined;
}

export function classifyCanaryResults(results, infrastructureErrors = []) {
  if (infrastructureErrors.length > 0) return 'error';
  if (results.some(result => result.outcome === 'drift')) return 'drift';
  if (results.some(result => result.outcome === 'unavailable')) return 'unavailable';
  if (results.length > 0 && results.every(result => result.outcome === 'passed')) return 'healthy';
  return 'error';
}

function resultOutcome(status) {
  if (status === 'passed') return 'passed';
  if (status === 'skipped') return 'unavailable';
  return 'drift';
}

export default class RealSiteCanaryReporter {
  constructor() {
    this.results = [];
    this.infrastructureErrors = [];
  }

  onTestEnd(test, result) {
    const skipAnnotation = test.annotations.find(annotation => annotation.type === 'skip');
    const error = sanitizeCanaryError(result.error);
    this.results.push({
      id: test.id,
      title: test.titlePath().slice(1).join(' > '),
      outcome: resultOutcome(result.status),
      durationMs: Math.max(0, Math.round(result.duration)),
      ...(skipAnnotation?.description
        ? { reason: skipAnnotation.description.slice(0, MAX_ERROR_CHARACTERS) }
        : {}),
      ...(error ? { error } : {}),
    });
  }

  onError(error) {
    const sanitized = sanitizeCanaryError(error);
    if (sanitized) this.infrastructureErrors.push(sanitized);
  }

  async onEnd() {
    const outcome = classifyCanaryResults(this.results, this.infrastructureErrors);
    const summary = {
      total: this.results.length,
      passed: this.results.filter(result => result.outcome === 'passed').length,
      drift: this.results.filter(result => result.outcome === 'drift').length,
      unavailable: this.results.filter(result => result.outcome === 'unavailable').length,
    };
    const report = {
      schemaVersion: 1,
      generatedAt: new Date().toISOString(),
      site: 'https://the-internet.herokuapp.com',
      outcome,
      summary,
      tests: this.results,
      infrastructureErrors: this.infrastructureErrors,
    };
    const reportPath = resolve(process.env.BROWSER_PILOT_CANARY_REPORT ?? DEFAULT_REPORT_PATH);
    await mkdir(dirname(reportPath), { recursive: true });
    await writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`, 'utf8');
    process.stdout.write(
      `[browser-pilot canary] ${outcome}: ${summary.passed} passed, ` +
      `${summary.drift} drift, ${summary.unavailable} unavailable\n` +
      `[browser-pilot canary] report: ${reportPath}\n`,
    );
  }
}
