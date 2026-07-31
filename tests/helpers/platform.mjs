import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { resolveBrowserPilotPaths } from '../../dist/services.js';

export const forceKillSignal = process.platform === 'win32' ? 'SIGTERM' : 'SIGKILL';

export function testTempPrefix(prefix) {
  return join(tmpdir(), prefix);
}

export function isolatedBrokerEnvironment(root, overrides = {}) {
  return {
    ...process.env,
    HOME: root,
    USERPROFILE: root,
    LOCALAPPDATA: join(root, 'AppData', 'Local'),
    BROWSER_PILOT_HOME: join(root, '.browser-pilot'),
    ...overrides,
  };
}

export function testBrokerPaths(root, overrides = {}) {
  const env = isolatedBrokerEnvironment(root, overrides);
  return resolveBrowserPilotPaths({ homeDir: root, env });
}

export function forceKillChild(child) {
  if (child.exitCode !== null || child.signalCode !== null) return false;
  return child.kill(forceKillSignal);
}

export function forceKillProcess(pid) {
  process.kill(pid, forceKillSignal);
}
