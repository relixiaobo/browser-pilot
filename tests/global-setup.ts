// Global setup: ensure bp is connected before all tests
import { bp, connect } from './bp.js';

export default function globalSetup() {
  // Try a simple command to see if already connected
  const check = bp('snapshot --limit 1');
  if (check.ok) {
    console.log('bp already connected');
    return;
  }
  // Not connected — connect fresh
  const result = connect();
  if (!result.ok) {
    throw new Error(`bp connect failed: ${result.error}`);
  }
  console.log('bp connected');
}
