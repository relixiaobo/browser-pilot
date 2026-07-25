import { join } from 'node:path';
import { homedir } from 'node:os';

export const STATE_DIR = join(homedir(), '.browser-pilot');
export const SOCKET_PATH = join(STATE_DIR, 'daemon.sock');
export const PID_FILE = join(STATE_DIR, 'daemon.pid');
export const ARTIFACT_DIR = join(STATE_DIR, 'artifacts');
export const DOWNLOAD_DIR = join(STATE_DIR, 'downloads');
