import { readFileSync, writeFileSync, existsSync, mkdirSync, unlinkSync } from 'node:fs';
import { STATE_DIR, STATE_FILE } from './paths.js';

export interface PilotState {
  wsEndpoint: string;
  browser: string;
  pilotTargetIds: string[];
  activeTargetId: string;
  activeSessionId?: string;
}

export function loadState(): PilotState | null {
  if (!existsSync(STATE_FILE)) return null;
  try { return JSON.parse(readFileSync(STATE_FILE, 'utf-8')); } catch { return null; }
}

export function saveState(state: PilotState): void {
  if (!existsSync(STATE_DIR)) mkdirSync(STATE_DIR, { recursive: true });
  writeFileSync(STATE_FILE, JSON.stringify(state, null, 2));
}

export function clearState(): void {
  try { unlinkSync(STATE_FILE); } catch { /* ignore */ }
}
