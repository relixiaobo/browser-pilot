import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { homedir, platform } from 'node:os';

export interface ChromeInfo {
  port: number;
  wsPath: string;
  wsUrl: string;
  browser: string;
  dataDir: string;
}

function getDataDirs(): Array<{ name: string; path: string }> {
  const home = homedir();
  const os = platform();

  if (os === 'darwin') {
    const base = join(home, 'Library', 'Application Support');
    return [
      { name: 'Chrome', path: join(base, 'Google', 'Chrome') },
      { name: 'Chrome Beta', path: join(base, 'Google', 'Chrome Beta') },
      { name: 'Chrome Canary', path: join(base, 'Google', 'Chrome Canary') },
      { name: 'Brave', path: join(base, 'BraveSoftware', 'Brave-Browser') },
      { name: 'Edge', path: join(base, 'Microsoft Edge') },
      { name: 'Chromium', path: join(base, 'Chromium') },
    ];
  }
  if (os === 'linux') {
    return [
      { name: 'Chrome', path: join(home, '.config', 'google-chrome') },
      { name: 'Chromium', path: join(home, '.config', 'chromium') },
      { name: 'Brave', path: join(home, '.config', 'BraveSoftware', 'Brave-Browser') },
      { name: 'Edge', path: join(home, '.config', 'microsoft-edge') },
    ];
  }
  if (os === 'win32') {
    const appData = process.env.LOCALAPPDATA ?? join(home, 'AppData', 'Local');
    return [
      { name: 'Chrome', path: join(appData, 'Google', 'Chrome', 'User Data') },
      { name: 'Brave', path: join(appData, 'BraveSoftware', 'Brave-Browser', 'User Data') },
      { name: 'Edge', path: join(appData, 'Microsoft', 'Edge', 'User Data') },
    ];
  }
  return [];
}

export function discoverChrome(browserFilter?: string): ChromeInfo | null {
  for (const { name, path: dataDir } of getDataDirs()) {
    if (browserFilter && !name.toLowerCase().includes(browserFilter.toLowerCase())) continue;

    const portFile = join(dataDir, 'DevToolsActivePort');
    if (!existsSync(portFile)) continue;

    try {
      const lines = readFileSync(portFile, 'utf-8').trim().split('\n');
      if (lines.length < 2) continue;

      const port = parseInt(lines[0], 10);
      const wsPath = lines[1];
      if (isNaN(port) || !wsPath) continue;

      return {
        port,
        wsPath,
        wsUrl: `ws://127.0.0.1:${port}${wsPath}`,
        browser: name,
        dataDir,
      };
    } catch {
      continue;
    }
  }
  return null;
}
