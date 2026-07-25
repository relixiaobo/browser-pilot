import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

declare const __BROWSER_PILOT_SELF_CONTAINED__: boolean;

export type InternalProcessRole = 'daemon' | 'janitor';

export interface InternalProcessInvocation {
  command: string;
  argumentsPrefix: string[];
}

export function isSelfContainedRuntime(): boolean {
  return __BROWSER_PILOT_SELF_CONTAINED__;
}

export function publicExecutablePath(moduleUrl?: string): string {
  if (isSelfContainedRuntime()) {
    return process.execPath;
  }
  if (!moduleUrl) throw new Error('Browser Pilot module URL is unavailable');
  return fileURLToPath(new URL('cli.js', moduleUrl));
}

export function internalProcessInvocation(
  role: InternalProcessRole,
  moduleUrl?: string,
): InternalProcessInvocation {
  if (isSelfContainedRuntime()) {
    return {
      command: process.execPath,
      argumentsPrefix: [`--browser-pilot-internal=${role}`],
    };
  }
  if (!moduleUrl) throw new Error('Browser Pilot module URL is unavailable');
  const script = role === 'daemon' ? 'daemon.js' : 'managed-target-janitor.js';
  return {
    command: process.execPath,
    argumentsPrefix: [fileURLToPath(new URL(script, moduleUrl))],
  };
}
