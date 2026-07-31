import http from 'node:http';

const endpointTokens = new Map();

export function setDaemonToken(socketPath, token) {
  endpointTokens.set(socketPath, token);
}

export function daemonRequest(socketPath, path, body, token = endpointTokens.get(socketPath)) {
  return new Promise((resolve, reject) => {
    const request = http.request({
      socketPath,
      path,
      method: body === undefined ? 'GET' : 'POST',
      headers: {
        ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
        ...(path !== '/health' && token ? { Authorization: `Bearer ${token}` } : {}),
      },
    }, response => {
      const chunks = [];
      response.on('data', chunk => chunks.push(chunk));
      response.on('end', () => {
        try {
          resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')));
        } catch (error) {
          reject(error);
        }
      });
    });
    request.once('error', reject);
    request.end(body === undefined ? undefined : JSON.stringify(body));
  });
}

export async function stopDaemon(socketPath) {
  const health = await daemonRequest(socketPath, '/health');
  if (!health.ok) return;
  return daemonRequest(socketPath, '/shutdown', {
    brokerProcessIdentity: health.brokerProcessIdentity,
    executableVersion: health.executableVersion,
    executableIdentity: health.executableIdentity,
  });
}
