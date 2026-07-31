import http from 'node:http';
import { rm } from 'node:fs/promises';

export async function startFakeDaemonServer({ socketPath, cleanupDirectory, onRequest }) {
  const server = http.createServer((request, response) => {
    void onRequest(request, response).catch(error => {
      response.statusCode = 500;
      response.end(JSON.stringify({ error: error.message }));
    });
  });
  try {
    await new Promise((resolve, reject) => {
      server.once('error', reject);
      server.listen(socketPath, resolve);
    });
  } catch (error) {
    if (cleanupDirectory) await rm(cleanupDirectory, { recursive: true, force: true });
    throw error;
  }
  return {
    server,
    async close() {
      await new Promise(resolve => server.close(resolve));
      if (cleanupDirectory) await rm(cleanupDirectory, { recursive: true, force: true });
    },
  };
}
