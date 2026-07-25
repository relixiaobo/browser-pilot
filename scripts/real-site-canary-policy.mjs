const CANARY_OUTCOMES = new Set(['healthy', 'drift', 'unavailable', 'error']);

export function canaryExitCode(report, runnerExitCode, strict = false) {
  if (
    !report || report.schemaVersion !== 1 ||
    typeof report.outcome !== 'string' || !CANARY_OUTCOMES.has(report.outcome)
  ) return runnerExitCode || 1;
  if (report.outcome === 'error') return runnerExitCode || 1;
  if (strict && report.outcome !== 'healthy') return 1;
  return 0;
}
