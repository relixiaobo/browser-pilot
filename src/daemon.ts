import http from 'node:http';
import { writeFileSync, unlinkSync, existsSync, mkdirSync } from 'node:fs';
import { STATE_DIR, SOCKET_PATH, PID_FILE } from './paths.js';
import { CDPClient } from './cdp.js';

const wsUrl = process.argv[2];
if (!wsUrl) {
  process.stderr.write('Usage: daemon <wsUrl>\n');
  process.exit(1);
}

if (!existsSync(STATE_DIR)) mkdirSync(STATE_DIR, { recursive: true });
try { unlinkSync(SOCKET_PATH); } catch { /* ignore */ }

function cleanup() {
  try { unlinkSync(SOCKET_PATH); } catch { /* ignore */ }
  try { unlinkSync(PID_FILE); } catch { /* ignore */ }
}

function readBody(req: http.IncomingMessage): Promise<string> {
  return new Promise(resolve => {
    let body = '';
    req.on('data', (chunk: Buffer) => { body += chunk.toString(); });
    req.on('end', () => resolve(body));
  });
}

async function main() {
  const cdp = new CDPClient();
  await cdp.connect(wsUrl);

  const server = http.createServer(async (req, res) => {
    res.setHeader('Content-Type', 'application/json');
    try {
      if (req.method === 'GET' && req.url === '/health') {
        res.writeHead(200);
        res.end(JSON.stringify({ ok: true }));
        return;
      }
      if (req.method === 'POST' && req.url === '/cdp') {
        const body = await readBody(req);
        const { method, params, sessionId } = JSON.parse(body);
        const result = await cdp.send(method, params, sessionId);
        res.writeHead(200);
        res.end(JSON.stringify({ result }));
        return;
      }
      if (req.method === 'POST' && req.url === '/shutdown') {
        res.writeHead(200);
        res.end(JSON.stringify({ ok: true }));
        setTimeout(() => { server.close(); cdp.close(); cleanup(); process.exit(0); }, 50);
        return;
      }
      res.writeHead(404);
      res.end(JSON.stringify({ error: 'Not found' }));
    } catch (err: any) {
      res.writeHead(500);
      res.end(JSON.stringify({ error: err.message }));
    }
  });

  server.listen(SOCKET_PATH, () => { writeFileSync(PID_FILE, String(process.pid)); });
  process.on('SIGTERM', () => { cdp.close(); cleanup(); process.exit(0); });
  process.on('SIGINT', () => { cdp.close(); cleanup(); process.exit(0); });
}

main().catch((err) => {
  process.stderr.write(`Daemon error: ${err.message}\n`);
  process.exit(1);
});
