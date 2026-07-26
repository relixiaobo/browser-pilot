#!/usr/bin/env node

import {
  hostAcceptanceHelpText,
  parseHostAcceptanceArguments,
  runHostIntegrationAcceptance,
  writeHostAcceptanceReport,
} from './run-host-integration-acceptance.mjs';
import { startIsolatedChromeFixture } from './isolated-chrome-fixture.mjs';

let fixture;
let options;
try {
  options = parseHostAcceptanceArguments(process.argv.slice(2));
  if (options.help) {
    process.stdout.write(hostAcceptanceHelpText());
  } else {
    fixture = await startIsolatedChromeFixture('browser-pilot-host-acceptance-');
    const report = await runHostIntegrationAcceptance({
      ...options,
      env: { ...process.env, ...fixture.environment },
      browserLifecycle: {
        stopBrowser: fixture.stopBrowser,
        startBrowser: fixture.startBrowser,
      },
    });
    await writeHostAcceptanceReport(report, options.reportPath);
    process.exitCode = report.outcome === 'passed' ? 0 : 1;
  }
} catch (error) {
  process.stderr.write(`Host integration acceptance failed to start: ${error instanceof Error ? error.message : error}\n`);
  process.exitCode = 2;
} finally {
  if (fixture) await fixture.stop();
}
