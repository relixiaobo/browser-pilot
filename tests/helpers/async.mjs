import { access } from 'node:fs/promises';

export async function waitFor(
  operation,
  predicate,
  timeoutMs = 5_000,
  timeoutMessage = 'Timed out waiting for expected value',
) {
  const deadline = Date.now() + timeoutMs;
  let lastError;
  while (Date.now() < deadline) {
    try {
      const value = await operation();
      if (predicate(value)) return value;
    } catch (error) {
      lastError = error;
    }
    await new Promise(resolve => setTimeout(resolve, 20));
  }
  throw lastError ?? new Error(timeoutMessage);
}

export async function waitForFile(path, timeoutMs = 5_000) {
  await waitFor(
    async () => {
      try {
        await access(path);
        return true;
      } catch {
        return false;
      }
    },
    Boolean,
    timeoutMs,
    `Timed out waiting for ${path}`,
  );
}
