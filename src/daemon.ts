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

// ── Stateful event tracking ─────────────────────────

// HTTP Basic Auth credentials (set via /auth endpoint)
let authCredentials: { username: string; password: string } | null = null;

interface DialogInfo {
  url: string;
  message: string;
  type: string;
  defaultPrompt: string;
  sessionId?: string;
  timestamp: number;
}

// Dialogs that were auto-handled (kept for CLI to query)
const handledDialogs: DialogInfo[] = [];

// New targets discovered (popups, window.open)
const discoveredTargets: Array<{ targetId: string; url: string; openerTargetId?: string; timestamp: number }> = [];

async function main() {
  const cdp = new CDPClient();
  await cdp.connect(wsUrl);

  // ── Dialog auto-handling ──────────────────────────
  // Register on every session that gets attached
  cdp.on('Page.javascriptDialogOpening', (params: any, sessionId?: string) => {
    const info: DialogInfo = {
      url: params.url,
      message: params.message,
      type: params.type,
      defaultPrompt: params.defaultPrompt || '',
      sessionId,
      timestamp: Date.now(),
    };
    handledDialogs.push(info);
    if (handledDialogs.length > 20) handledDialogs.shift();

    // Auto-accept with correct sessionId (required for flattened sessions)
    cdp.send('Page.handleJavaScriptDialog', { accept: true }, sessionId).catch(() => {});
  });

  // ── Popup / new window tracking ───────────────────
  // Enable target discovery at browser level (no sessionId)
  await cdp.send('Target.setDiscoverTargets', { discover: true });

  cdp.on('Target.targetCreated', (params: any) => {
    const { targetInfo } = params;
    // Track all new page targets (popups start as about:blank then navigate)
    if (targetInfo.type === 'page' && targetInfo.openerId) {
      discoveredTargets.push({
        targetId: targetInfo.targetId,
        url: targetInfo.url || 'about:blank',
        openerTargetId: targetInfo.openerId,
        timestamp: Date.now(),
      });
      if (discoveredTargets.length > 50) discoveredTargets.shift();
    }
  });

  // ── HTTP Auth handling ─────────────────────────────
  cdp.on('Fetch.authRequired', (params: any, sessionId?: string) => {
    if (authCredentials) {
      cdp.send('Fetch.continueWithAuth', {
        requestId: params.requestId,
        authChallengeResponse: {
          response: 'ProvideCredentials',
          username: authCredentials.username,
          password: authCredentials.password,
        },
      }, sessionId).catch(() => {});
    } else {
      cdp.send('Fetch.continueWithAuth', {
        requestId: params.requestId,
        authChallengeResponse: { response: 'CancelAuth' },
      }, sessionId).catch(() => {});
    }
  });

  // Continue non-auth paused requests (Fetch.enable intercepts all when handleAuthRequests is on)
  cdp.on('Fetch.requestPaused', (params: any, sessionId?: string) => {
    cdp.send('Fetch.continueRequest', { requestId: params.requestId }, sessionId).catch(() => {});
  });

  // Update URL when targets navigate
  cdp.on('Target.targetInfoChanged', (params: any) => {
    const { targetInfo } = params;
    const existing = discoveredTargets.find(d => d.targetId === targetInfo.targetId);
    if (existing) existing.url = targetInfo.url;
  });

  // ── HTTP server ───────────────────────────────────

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

      // Query handled dialogs
      if (req.method === 'GET' && req.url === '/dialogs') {
        res.writeHead(200);
        res.end(JSON.stringify({ dialogs: handledDialogs }));
        return;
      }

      // Set auth credentials
      if (req.method === 'POST' && req.url === '/auth') {
        const body = await readBody(req);
        const { username, password } = JSON.parse(body);
        authCredentials = username ? { username, password } : null;
        res.writeHead(200);
        res.end(JSON.stringify({ ok: true }));
        return;
      }

      // Query discovered targets (popups / new windows)
      if (req.method === 'GET' && req.url === '/discovered') {
        res.writeHead(200);
        res.end(JSON.stringify({ targets: discoveredTargets }));
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
