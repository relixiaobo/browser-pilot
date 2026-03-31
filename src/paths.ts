import { join } from 'node:path';
import { homedir } from 'node:os';

export const STATE_DIR = join(homedir(), '.browser-pilot');
export const STATE_FILE = join(STATE_DIR, 'state.json');
export const SOCKET_PATH = join(STATE_DIR, 'daemon.sock');
export const PID_FILE = join(STATE_DIR, 'daemon.pid');
export const REFS_FILE = join(STATE_DIR, 'refs.json');
