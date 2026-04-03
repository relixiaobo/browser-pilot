// Global teardown: keep connection alive for subsequent test runs.
// Disconnecting would require user to click "Allow" again on next run.
export default function globalTeardown() {
  console.log('bp session kept alive');
}
