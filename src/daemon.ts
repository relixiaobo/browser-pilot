import http from 'node:http';
import { writeFileSync, unlinkSync, existsSync, mkdirSync, readFileSync } from 'node:fs';
import { STATE_DIR, SOCKET_PATH, PID_FILE } from './paths.js';
import { CDPClient } from './cdp.js';

const wsUrl = process.argv[2];
if (!wsUrl) { process.stderr.write('Usage: daemon <wsUrl>\n'); process.exit(1); }
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

let authCredentials: { username: string; password: string } | null = null;

interface DialogInfo { url: string; message: string; type: string; defaultPrompt: string; sessionId?: string; timestamp: number; }
const handledDialogs: DialogInfo[] = [];

const discoveredTargets: Array<{ targetId: string; url: string; openerTargetId?: string; timestamp: number }> = [];

// ── Network monitoring state ────────────────────────

interface TrackedRequest {
  id: number;
  networkId: string;
  sessionId?: string;
  method: string;
  url: string;
  type: string;
  requestHeaders: Record<string, string>;
  postData?: string;
  status?: number;
  statusText?: string;
  responseHeaders?: Record<string, string>;
  mimeType?: string;
  size?: number;
  startTime: number;
  endTime?: number;
  error?: string;
  bodyAvailable: boolean;
}

let nextReqId = 1;
const MAX_TRACKED = 1000;
const trackedRequests: TrackedRequest[] = [];
const requestsByNetworkId = new Map<string, TrackedRequest>();
const networkEnabledSessions = new Set<string>();

// ── Interception rules ──────────────────────────────

interface BlockRule { id: number; type: 'block'; pattern: string; }
interface MockRule { id: number; type: 'mock'; pattern: string; status: number; headers: Array<{ name: string; value: string }>; body: string; }
interface HeaderRule { id: number; type: 'headers'; pattern: string; headers: Array<{ name: string; value: string }>; }
type InterceptRule = BlockRule | MockRule | HeaderRule;

let nextRuleId = 1;
const interceptRules: InterceptRule[] = [];
let fetchEnabledForIntercept = false;

function wildcardMatch(url: string, pattern: string): boolean {
  const re = new RegExp('^' + pattern.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*') + '$', 'i');
  return re.test(url);
}

async function syncFetch(cdp: CDPClient, sessionId?: string) {
  if (!sessionId) return;
  const need = interceptRules.length > 0;
  if (need && !fetchEnabledForIntercept) {
    await cdp.send('Fetch.enable', { patterns: [{ urlPattern: '*' }], handleAuthRequests: !!authCredentials }, sessionId).catch(() => {});
    fetchEnabledForIntercept = true;
  } else if (!need && fetchEnabledForIntercept) {
    if (authCredentials) {
      await cdp.send('Fetch.enable', { handleAuthRequests: true }, sessionId).catch(() => {});
    } else {
      await cdp.send('Fetch.disable', {}, sessionId).catch(() => {});
    }
    fetchEnabledForIntercept = false;
  }
}

function enableNetworkTracking(cdp: CDPClient, sessionId: string) {
  if (networkEnabledSessions.has(sessionId)) return Promise.resolve();
  networkEnabledSessions.add(sessionId);
  return cdp.send('Network.enable', { maxPostDataSize: 65536 }, sessionId);
}

// ── Main ────────────────────────────────────────────

async function main() {
  const cdp = new CDPClient();
  await cdp.connect(wsUrl);

  // Track active session for Network.getResponseBody calls
  let activeSessionId: string | undefined;

  // ── Dialog auto-handling ──────────────────────────
  cdp.on('Page.javascriptDialogOpening', (params: any, sessionId?: string) => {
    handledDialogs.push({ url: params.url, message: params.message, type: params.type, defaultPrompt: params.defaultPrompt || '', sessionId, timestamp: Date.now() });
    if (handledDialogs.length > 20) handledDialogs.shift();
    cdp.send('Page.handleJavaScriptDialog', { accept: true }, sessionId).catch(() => {});
  });

  // ── Popup tracking ────────────────────────────────
  await cdp.send('Target.setDiscoverTargets', { discover: true });
  cdp.on('Target.targetCreated', (params: any) => {
    const { targetInfo } = params;
    if (targetInfo.type === 'page' && targetInfo.openerId) {
      discoveredTargets.push({ targetId: targetInfo.targetId, url: targetInfo.url || 'about:blank', openerTargetId: targetInfo.openerId, timestamp: Date.now() });
      if (discoveredTargets.length > 50) discoveredTargets.shift();
    }
  });
  cdp.on('Target.targetInfoChanged', (params: any) => {
    const e = discoveredTargets.find(d => d.targetId === params.targetInfo.targetId);
    if (e) e.url = params.targetInfo.url;
  });

  // ── Auth handling ─────────────────────────────────
  cdp.on('Fetch.authRequired', (params: any, sessionId?: string) => {
    const resp = authCredentials
      ? { response: 'ProvideCredentials' as const, username: authCredentials.username, password: authCredentials.password }
      : { response: 'CancelAuth' as const };
    cdp.send('Fetch.continueWithAuth', { requestId: params.requestId, authChallengeResponse: resp }, sessionId).catch(() => {});
  });

  // ── Fetch interception (rules + passthrough) ──────
  cdp.on('Fetch.requestPaused', (params: any, sessionId?: string) => {
    const url = params.request.url;
    for (const rule of interceptRules) {
      if (!wildcardMatch(url, rule.pattern)) continue;
      if (rule.type === 'block') {
        cdp.send('Fetch.failRequest', { requestId: params.requestId, reason: 'BlockedByClient' }, sessionId).catch(() => {});
        return;
      }
      if (rule.type === 'mock') {
        cdp.send('Fetch.fulfillRequest', { requestId: params.requestId, responseCode: rule.status, responseHeaders: rule.headers, body: rule.body }, sessionId).catch(() => {});
        return;
      }
      if (rule.type === 'headers') {
        const existing = Object.entries(params.request.headers || {}).map(([name, value]) => ({ name, value: value as string }));
        const overrides = new Set(rule.headers.map(h => h.name.toLowerCase()));
        const merged = existing.filter(h => !overrides.has(h.name.toLowerCase()));
        merged.push(...rule.headers);
        cdp.send('Fetch.continueRequest', { requestId: params.requestId, headers: merged }, sessionId).catch(() => {});
        return;
      }
    }
    cdp.send('Fetch.continueRequest', { requestId: params.requestId }, sessionId).catch(() => {});
  });

  // ── Network monitoring events ─────────────────────
  cdp.on('Network.requestWillBeSent', (params: any, sessionId?: string) => {
    const entry: TrackedRequest = {
      id: nextReqId++, networkId: params.requestId, sessionId,
      method: params.request.method, url: params.request.url, type: params.type || 'Other',
      requestHeaders: params.request.headers || {}, postData: params.request.postData,
      startTime: Date.now(), bodyAvailable: false,
    };
    trackedRequests.push(entry);
    requestsByNetworkId.set(params.requestId, entry);
    if (trackedRequests.length > MAX_TRACKED) {
      const old = trackedRequests.shift()!;
      requestsByNetworkId.delete(old.networkId);
    }
  });
  cdp.on('Network.responseReceived', (params: any) => {
    const e = requestsByNetworkId.get(params.requestId);
    if (e) { e.status = params.response.status; e.statusText = params.response.statusText; e.responseHeaders = params.response.headers; e.mimeType = params.response.mimeType; }
  });
  cdp.on('Network.loadingFinished', (params: any) => {
    const e = requestsByNetworkId.get(params.requestId);
    if (e) { e.size = params.encodedDataLength; e.endTime = Date.now(); e.bodyAvailable = true; }
  });
  cdp.on('Network.loadingFailed', (params: any) => {
    const e = requestsByNetworkId.get(params.requestId);
    if (e) { e.error = params.errorText; e.endTime = Date.now(); }
  });

  // ── HTTP server ───────────────────────────────────

  const server = http.createServer(async (req, res) => {
    res.setHeader('Content-Type', 'application/json');
    const url = new URL(req.url || '/', 'http://localhost');
    try {
      // ── Core endpoints ────────────────────────────
      if (req.method === 'GET' && url.pathname === '/health') {
        res.writeHead(200); res.end(JSON.stringify({ ok: true })); return;
      }
      if (req.method === 'POST' && url.pathname === '/cdp') {
        const body = await readBody(req);
        const { method, params, sessionId } = JSON.parse(body);
        if (sessionId) activeSessionId = sessionId;
        const result = await cdp.send(method, params, sessionId);
        res.writeHead(200); res.end(JSON.stringify({ result })); return;
      }
      if (req.method === 'GET' && url.pathname === '/dialogs') {
        res.writeHead(200); res.end(JSON.stringify({ dialogs: handledDialogs })); return;
      }
      if (req.method === 'POST' && url.pathname === '/auth') {
        const body = await readBody(req);
        const { username, password } = JSON.parse(body);
        authCredentials = username ? { username, password } : null;
        res.writeHead(200); res.end(JSON.stringify({ ok: true })); return;
      }
      if (req.method === 'GET' && url.pathname === '/discovered') {
        res.writeHead(200); res.end(JSON.stringify({ targets: discoveredTargets })); return;
      }
      if (req.method === 'POST' && url.pathname === '/shutdown') {
        res.writeHead(200); res.end(JSON.stringify({ ok: true }));
        setTimeout(() => { server.close(); cdp.close(); cleanup(); process.exit(0); }, 50); return;
      }

      // ── Network: enable ───────────────────────────
      if (req.method === 'POST' && url.pathname === '/net/enable') {
        const body = await readBody(req);
        const { sessionId } = JSON.parse(body);
        await enableNetworkTracking(cdp, sessionId);
        if (sessionId) activeSessionId = sessionId;
        res.writeHead(200); res.end(JSON.stringify({ ok: true })); return;
      }

      // ── Network: list requests ────────────────────
      if (req.method === 'GET' && url.pathname === '/net/requests') {
        const limit = parseInt(url.searchParams.get('limit') || '20', 10);
        const urlF = url.searchParams.get('url');
        const methodF = url.searchParams.get('method')?.toUpperCase();
        const statusF = url.searchParams.get('status');
        const typeF = url.searchParams.get('type')?.split(',').map(t => t.trim().toLowerCase());
        const afterId = parseInt(url.searchParams.get('after') || '0', 10);

        let results = trackedRequests.slice();
        if (afterId > 0) results = results.filter(r => r.id > afterId);
        if (urlF) results = results.filter(r => wildcardMatch(r.url, urlF));
        if (methodF) results = results.filter(r => r.method === methodF);
        if (statusF) {
          if (statusF.endsWith('xx')) { const p = parseInt(statusF[0], 10); results = results.filter(r => r.status && Math.floor(r.status / 100) === p); }
          else { const c = parseInt(statusF, 10); results = results.filter(r => r.status === c); }
        }
        if (typeF) results = results.filter(r => typeF.includes(r.type.toLowerCase()));

        const sliced = results.slice(-limit);
        res.writeHead(200); res.end(JSON.stringify({ requests: sliced.map(r => ({ id: r.id, method: r.method, url: r.url, status: r.status, type: r.type, size: r.size, time: r.endTime && r.startTime ? r.endTime - r.startTime : null, error: r.error })), total: trackedRequests.length })); return;
      }

      // ── Network: request detail ────────────────────
      if (req.method === 'GET' && url.pathname.startsWith('/net/request/')) {
        const id = parseInt(url.pathname.split('/').pop()!, 10);
        const entry = trackedRequests.find(r => r.id === id);
        if (!entry) { res.writeHead(404); res.end(JSON.stringify({ error: 'Request not found' })); return; }
        res.writeHead(200); res.end(JSON.stringify(entry)); return;
      }

      // ── Network: response body ────────────────────
      if (req.method === 'GET' && url.pathname.startsWith('/net/body/')) {
        const id = parseInt(url.pathname.split('/').pop()!, 10);
        const entry = trackedRequests.find(r => r.id === id);
        if (!entry) { res.writeHead(404); res.end(JSON.stringify({ error: 'Request not found' })); return; }
        if (!entry.bodyAvailable) { res.writeHead(400); res.end(JSON.stringify({ error: 'Body not available' })); return; }
        const sid = entry.sessionId || activeSessionId;
        const result = await cdp.send('Network.getResponseBody', { requestId: entry.networkId }, sid);
        const body = result.base64Encoded ? Buffer.from(result.body, 'base64').toString('utf-8') : result.body;
        res.writeHead(200); res.end(JSON.stringify({ id: entry.id, body, mimeType: entry.mimeType })); return;
      }

      // ── Network: clear ────────────────────────────
      if (req.method === 'POST' && url.pathname === '/net/clear') {
        trackedRequests.length = 0; requestsByNetworkId.clear(); nextReqId = 1;
        res.writeHead(200); res.end(JSON.stringify({ ok: true })); return;
      }

      // ── Network: add rule ─────────────────────────
      if (req.method === 'POST' && url.pathname === '/net/rules') {
        const b = JSON.parse(await readBody(req));
        let rule: InterceptRule;
        if (b.type === 'block') {
          rule = { id: nextRuleId++, type: 'block', pattern: b.pattern };
        } else if (b.type === 'mock') {
          const content = b.file ? readFileSync(b.file, 'utf-8') : (b.body || '');
          rule = { id: nextRuleId++, type: 'mock', pattern: b.pattern, status: b.status || 200, headers: b.headers || [{ name: 'Content-Type', value: 'application/json' }], body: Buffer.from(content).toString('base64') };
        } else if (b.type === 'headers') {
          rule = { id: nextRuleId++, type: 'headers', pattern: b.pattern, headers: b.headers };
        } else { res.writeHead(400); res.end(JSON.stringify({ error: `Unknown rule type: ${b.type}` })); return; }
        interceptRules.push(rule);
        await syncFetch(cdp, activeSessionId);
        res.writeHead(200); res.end(JSON.stringify({ ok: true, rule })); return;
      }

      // ── Network: list rules ───────────────────────
      if (req.method === 'GET' && url.pathname === '/net/rules') {
        res.writeHead(200); res.end(JSON.stringify({ rules: interceptRules })); return;
      }

      // ── Network: remove rule(s) ───────────────────
      if (req.method === 'POST' && url.pathname === '/net/rules/remove') {
        const b = JSON.parse(await readBody(req));
        if (b.all) { interceptRules.length = 0; }
        else if (b.id !== undefined) {
          const idx = interceptRules.findIndex(r => r.id === b.id);
          if (idx >= 0) interceptRules.splice(idx, 1);
        }
        await syncFetch(cdp, activeSessionId);
        res.writeHead(200); res.end(JSON.stringify({ ok: true })); return;
      }

      res.writeHead(404); res.end(JSON.stringify({ error: 'Not found' }));
    } catch (err: any) {
      res.writeHead(500); res.end(JSON.stringify({ error: err.message }));
    }
  });

  server.listen(SOCKET_PATH, () => { writeFileSync(PID_FILE, String(process.pid)); });
  process.on('SIGTERM', () => { cdp.close(); cleanup(); process.exit(0); });
  process.on('SIGINT', () => { cdp.close(); cleanup(); process.exit(0); });
}

main().catch((err) => { process.stderr.write(`Daemon error: ${err.message}\n`); process.exit(1); });
