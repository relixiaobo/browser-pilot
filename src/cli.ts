import { Command } from 'commander';
import { writeFileSync, readFileSync, existsSync } from 'node:fs';
import { resolve as resolvePath } from 'node:path';
import { connectFresh, resume, resumeExisting, withPilot, disconnect, waitForLoad, saveState, clearState, initSession } from './session.js';
import { takeSnapshot, resolveTarget, formatTarget, type SnapshotResult } from './snapshot.js';
import { GET_CLICK_COORDS, SET_VALUE, PAGE_DIMENSIONS, elementRect, IS_CONTENTEDITABLE, CONTENTEDITABLE_SELECT_ALL } from './page-scripts.js';
import type { Transport } from './transport.js';

const program = new Command();
program
  .name('bp')
  .description('Control your browser from the command line')
  .version('0.1.0')
  .option('--human', 'force human-readable output (default when TTY)')
  .addHelpText('after', `
Workflow:
  bp connect                          # one-time setup (click Allow in Chrome)
  bp open <url>                       # navigate — returns snapshot with [ref] numbers
  bp click <ref>                      # interact — returns updated snapshot
  bp type <ref> <text>                # input text — returns updated snapshot
  bp press <key>                      # keyboard — returns updated snapshot
  bp eval <js>                        # run JavaScript (escape hatch for anything)

Refs:
  open/click/type/press return numbered interactive elements like:
    [1] link "Home"  [2] textbox "Search"  [3] button "Submit"
  Use the number in subsequent commands: bp click 1, bp type 2 "hello"

Output:
  JSON by default when piped (for LLM/script use).
  Human-readable when run in a terminal (TTY). Force with --human.
  Actions return: {"ok":true, "title":"...", "url":"...", "elements":[...]}
  Errors return:  {"ok":false, "error":"...", "hint":"..."}

Edge cases:
  bp upload <ref> <filepath>                         # file input upload
  bp auth <user> <pass>                              # HTTP Basic Auth
  bp frame                                           # list iframes
  bp frame 1                                         # eval in iframe context
  bp frame 0                                         # back to top frame
  Dialogs (alert/confirm) are auto-handled by the daemon.

Eval (replaces scroll, back, forward, extract, etc.):
  bp eval "history.back()"                           # go back
  bp eval "history.forward()"                        # go forward
  bp eval "location.reload()"                        # reload
  bp eval "window.scrollBy(0, 500)"                  # scroll down
  bp eval "document.querySelector('h1').textContent"  # extract text
  bp eval "document.querySelector('div').innerHTML"   # extract HTML
  bp eval "JSON.stringify(localStorage)"              # read storage
  echo 'complex js here' | bp eval                   # stdin for complex JS
`);

// ── Output ──────────────────────────────────────────

function useJson(): boolean {
  if (program.opts().human) return false;
  return !process.stdout.isTTY;  // JSON by default for pipes/LLMs, human for TTY
}

function emit(data: Record<string, any>, human?: string): void {
  if (useJson()) console.log(JSON.stringify(data));
  else if (human) console.log(human);
}

function fail(error: string, hint?: string): never {
  if (useJson()) console.log(JSON.stringify({ ok: false, error, ...(hint ? { hint } : {}) }));
  else console.error(`\u2717 ${error}${hint ? `\n  hint: ${hint}` : ''}`);
  process.exit(1);
}

function emitSnapshot(result: SnapshotResult): void {
  if (useJson()) console.log(JSON.stringify({ ok: true, ...result.data }));
  else console.log(result.text);
}

// ── Helpers ─────────────────────────────────────────

function action(fn: (...args: any[]) => Promise<void>) {
  return (...args: any[]) => fn(...args).catch((err: unknown) => {
    const msg = err instanceof Error ? err.message : String(err);
    // Add hints for common errors
    if (msg.includes('not found') && msg.includes('Ref')) fail(msg, "Run 'bp snapshot' to refresh element refs.");
    if (msg.includes('Not connected')) fail(msg, "Run 'bp connect' first.");
    if (msg.includes('Page load timeout')) fail(msg, "Page may still be loading. Retry the command after a moment.");
    fail(msg);
  });
}

function normalizeUrl(url: string): string {
  if (/^[a-z][a-z0-9+.-]*:/i.test(url)) return url;
  return `https://${url}`;
}

function parseLimit(raw: string): number {
  const n = parseInt(raw, 10);
  if (isNaN(n) || n < 1) throw new Error('--limit must be a positive number');
  return n;
}

function readStdin(): Promise<string> {
  if (process.stdin.isTTY) return Promise.resolve('');
  return new Promise(resolve => {
    let d = '';
    process.stdin.on('data', c => { d += c; });
    process.stdin.on('end', () => resolve(d.trim()));
  });
}

async function snap(t: Transport, sid: string, tid: string, limit?: number): Promise<SnapshotResult> {
  // Brief pause for DOM to settle after click/press, then wait for load
  await new Promise(r => setTimeout(r, 300));
  await waitForLoad(t, sid, 10_000);
  return takeSnapshot(t, sid, tid, limit);
}

async function dispatchClick(t: Transport, sid: string, x: number, y: number): Promise<void> {
  await t.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y, button: 'none' }, sid);
  await t.send('Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button: 'left', clickCount: 1 }, sid);
  await t.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button: 'left', clickCount: 1 }, sid);
}

// ── Key dispatch ────────────────────────────────────

const KEY_DEFS: Record<string, { key: string; code: string; keyCode: number }> = {
  enter: { key: 'Enter', code: 'Enter', keyCode: 13 },
  tab: { key: 'Tab', code: 'Tab', keyCode: 9 },
  escape: { key: 'Escape', code: 'Escape', keyCode: 27 },
  esc: { key: 'Escape', code: 'Escape', keyCode: 27 },
  backspace: { key: 'Backspace', code: 'Backspace', keyCode: 8 },
  delete: { key: 'Delete', code: 'Delete', keyCode: 46 },
  space: { key: ' ', code: 'Space', keyCode: 32 },
  arrowup: { key: 'ArrowUp', code: 'ArrowUp', keyCode: 38 },
  arrowdown: { key: 'ArrowDown', code: 'ArrowDown', keyCode: 40 },
  arrowleft: { key: 'ArrowLeft', code: 'ArrowLeft', keyCode: 37 },
  arrowright: { key: 'ArrowRight', code: 'ArrowRight', keyCode: 39 },
  home: { key: 'Home', code: 'Home', keyCode: 36 },
  end: { key: 'End', code: 'End', keyCode: 35 },
  pageup: { key: 'PageUp', code: 'PageUp', keyCode: 33 },
  pagedown: { key: 'PageDown', code: 'PageDown', keyCode: 34 },
};

const MOD_DEFS: Record<string, { key: string; code: string; keyCode: number; mask: number }> = {
  control: { key: 'Control', code: 'ControlLeft', keyCode: 17, mask: 2 },
  ctrl: { key: 'Control', code: 'ControlLeft', keyCode: 17, mask: 2 },
  shift: { key: 'Shift', code: 'ShiftLeft', keyCode: 16, mask: 8 },
  alt: { key: 'Alt', code: 'AltLeft', keyCode: 18, mask: 1 },
  meta: { key: 'Meta', code: 'MetaLeft', keyCode: 91, mask: 4 },
  cmd: { key: 'Meta', code: 'MetaLeft', keyCode: 91, mask: 4 },
  command: { key: 'Meta', code: 'MetaLeft', keyCode: 91, mask: 4 },
};

async function dispatchKey(t: Transport, sid: string, combo: string): Promise<void> {
  const parts = combo.split('+');
  const mainKey = parts.pop()!;
  const mods = parts.map(p => {
    const m = MOD_DEFS[p.toLowerCase()];
    if (!m) throw new Error(`Unknown modifier: ${p}`);
    return m;
  });
  const modifierFlags = mods.reduce((n, m) => n | m.mask, 0);

  const kd = KEY_DEFS[mainKey.toLowerCase()];
  const key = kd?.key ?? mainKey;
  const code = kd?.code ?? (mainKey.length === 1 ? `Key${mainKey.toUpperCase()}` : mainKey);
  const keyCode = kd?.keyCode ?? mainKey.toUpperCase().charCodeAt(0);

  for (const m of mods) {
    await t.send('Input.dispatchKeyEvent', { type: 'keyDown', key: m.key, code: m.code, windowsVirtualKeyCode: m.keyCode, modifiers: modifierFlags }, sid);
  }
  const text = key === 'Enter' ? '\r' : (kd ? '' : mainKey);
  await t.send('Input.dispatchKeyEvent', { type: 'keyDown', key, code, windowsVirtualKeyCode: keyCode, text, modifiers: modifierFlags }, sid);
  await t.send('Input.dispatchKeyEvent', { type: 'keyUp', key, code, windowsVirtualKeyCode: keyCode, modifiers: modifierFlags }, sid);
  for (const m of mods.reverse()) {
    await t.send('Input.dispatchKeyEvent', { type: 'keyUp', key: m.key, code: m.code, windowsVirtualKeyCode: m.keyCode }, sid);
  }
}

// ═══════════════════════════════════════════════════════
//  COMMANDS
// ═══════════════════════════════════════════════════════

// ─── connect ────────────────────────────────────────

program.command('connect')
  .description('Connect to Chrome and create pilot window')
  .option('-b, --browser <name>', 'browser to connect to')
  .addHelpText('after', '\nExamples:\n  bp connect\n  bp connect --browser brave')
  .action(action(async (opts) => {
    if (!useJson()) {
      console.log('Connecting to Chrome...');
      console.log('If prompted, click "Allow" in Chrome\'s authorization dialog.\n');
    }
    const { state } = await connectFresh(opts.browser);
    emit(
      { ok: true, browser: state.browser },
      `\u2713 Connected to ${state.browser}\n\u2713 Pilot window created (daemon running in background)\n\nReady! Try: bp open https://example.com`,
    );
  }));

// ─── disconnect ─────────────────────────────────────

program.command('disconnect')
  .description('Close pilot window and stop daemon')
  .action(action(async () => {
    const existing = await resumeExisting();
    if (existing) {
      for (const id of existing.state.pilotTargetIds) {
        try { await existing.client.send('Target.closeTarget', { targetId: id }); } catch { /* ignore */ }
      }
    }
    await disconnect();
    emit({ ok: true }, '\u2713 Disconnected');
  }));

// ─── open ───────────────────────────────────────────

program.command('open <url>')
  .description('Navigate to URL and return page snapshot')
  .option('-n, --new', 'open in new tab')
  .option('-l, --limit <n>', 'max elements in snapshot', '50')
  .addHelpText('after', '\nExamples:\n  bp open https://github.com\n  bp open github.com --new\n  bp open https://example.com --limit 20')
  .action(action(async (url, opts) => {
    url = normalizeUrl(url);
    const limit = parseLimit(opts.limit);
    await withPilot(async ({ transport, state, sessionId }) => {
      let sid = sessionId;
      let tid = state.activeTargetId;

      if (opts.new) {
        const { targetId } = await transport.send('Target.createTarget', { url });
        const r = await transport.send('Target.attachToTarget', { targetId, flatten: true });
        await initSession(transport, r.sessionId);
        state.pilotTargetIds.push(targetId);
        state.activeTargetId = targetId;
        state.activeSessionId = r.sessionId;
        state.frameContextId = undefined;
        saveState(state);
        sid = r.sessionId;
        tid = targetId;
      } else {
        await transport.send('Page.navigate', { url }, sid);
        state.frameContextId = undefined;
        saveState(state);
      }

      await waitForLoad(transport, sid);
      emitSnapshot(await takeSnapshot(transport, sid, tid, limit));
    });
  }));

// ─── snapshot ───────────────────────────────────────

program.command('snapshot')
  .description('Get interactive elements on the page')
  .option('-l, --limit <n>', 'max elements to return', '50')
  .addHelpText('after', '\nExamples:\n  bp snapshot\n  bp snapshot --limit 100')
  .action(action(async (opts) => {
    const limit = parseLimit(opts.limit);
    await withPilot(async ({ transport, sessionId, state }) => {
      emitSnapshot(await takeSnapshot(transport, sessionId, state.activeTargetId, limit));
    });
  }));

// ─── click ──────────────────────────────────────────

program.command('click <ref>')
  .description('Click element by ref number and return page snapshot')
  .option('-l, --limit <n>', 'max elements in snapshot', '50')
  .addHelpText('after', '\nRef is a number from the snapshot output.\n\nExamples:\n  bp click 3\n  bp click 3 --limit 10')
  .action(action(async (ref, opts) => {
    const limit = parseLimit(opts.limit);
    await withPilot(async ({ transport, sessionId, state }) => {
      const objectId = await resolveTarget(transport, sessionId, ref, state.activeTargetId);
      try {
        const { result } = await transport.send('Runtime.callFunctionOn', {
          objectId, functionDeclaration: GET_CLICK_COORDS, returnByValue: true,
        }, sessionId);
        const { x, y } = JSON.parse(result.value);
        await dispatchClick(transport, sessionId, x, y);
      } finally {
        await transport.send('Runtime.releaseObject', { objectId }, sessionId).catch(() => {});
      }
      emitSnapshot(await snap(transport, sessionId, state.activeTargetId, limit));
    });
  }));

// ─── type ───────────────────────────────────────────

program.command('type <ref> <text>')
  .description('Type text into element and return page snapshot')
  .option('-c, --clear', 'clear field before typing')
  .option('-s, --submit', 'press Enter after typing')
  .option('-l, --limit <n>', 'max elements in snapshot', '50')
  .addHelpText('after', '\nExamples:\n  bp type 2 "hello world"\n  bp type 5 "query" --submit\n  bp type 3 "new value" --clear')
  .action(action(async (ref, text, opts) => {
    const limit = parseLimit(opts.limit);
    await withPilot(async ({ transport, sessionId, state }) => {
      const objectId = await resolveTarget(transport, sessionId, ref, state.activeTargetId);
      try {
        // Check if target is a contenteditable element (Draft.js, ProseMirror, etc.)
        const { result: ceResult } = await transport.send('Runtime.callFunctionOn', {
          objectId, functionDeclaration: IS_CONTENTEDITABLE, returnByValue: true,
        }, sessionId);

        if (ceResult.value) {
          // Contenteditable path: use Input.insertText (same approach as Playwright)
          if (opts.clear) {
            await transport.send('Runtime.callFunctionOn', {
              objectId, functionDeclaration: CONTENTEDITABLE_SELECT_ALL,
            }, sessionId);
            await transport.send('Input.dispatchKeyEvent', {
              type: 'rawKeyDown', key: 'Delete', code: 'Delete', windowsVirtualKeyCode: 46,
            }, sessionId);
            await transport.send('Input.dispatchKeyEvent', {
              type: 'keyUp', key: 'Delete', code: 'Delete', windowsVirtualKeyCode: 46,
            }, sessionId);
          } else {
            // Focus and move cursor to end
            await transport.send('Runtime.callFunctionOn', {
              objectId, functionDeclaration: `function() {
                this.focus();
                const sel = window.getSelection();
                sel.selectAllChildren(this);
                sel.collapseToEnd();
              }`,
            }, sessionId);
          }
          await transport.send('Input.insertText', { text }, sessionId);
        } else {
          // Standard input/textarea path
          await transport.send('Runtime.callFunctionOn', {
            objectId, functionDeclaration: SET_VALUE, arguments: [{ value: text }, { value: !!opts.clear }],
          }, sessionId);
        }
        if (opts.submit) await dispatchKey(transport, sessionId, 'Enter');
      } finally {
        await transport.send('Runtime.releaseObject', { objectId }, sessionId).catch(() => {});
      }
      emitSnapshot(await snap(transport, sessionId, state.activeTargetId, limit));
    });
  }));

// ─── press ──────────────────────────────────────────

program.command('press <key>')
  .description('Press key combo (e.g. Enter, Escape, Control+a) and return snapshot')
  .option('-l, --limit <n>', 'max elements in snapshot', '50')
  .addHelpText('after', '\nKeys: Enter, Escape, Tab, Space, Backspace, Delete,\n      ArrowUp, ArrowDown, ArrowLeft, ArrowRight,\n      Home, End, PageUp, PageDown\nModifiers: Control (Ctrl), Shift, Alt, Meta (Cmd)\n\nExamples:\n  bp press Enter\n  bp press Escape\n  bp press Control+a\n  bp press Meta+c')
  .action(action(async (key, opts) => {
    const limit = parseLimit(opts.limit);
    await withPilot(async ({ transport, sessionId, state }) => {
      await dispatchKey(transport, sessionId, key);
      emitSnapshot(await snap(transport, sessionId, state.activeTargetId, limit));
    });
  }));

// ─── eval ───────────────────────────────────────────

program.command('eval [expression]')
  .description('Execute JavaScript (pass via argument or stdin)')
  .addHelpText('after', '\nThis is the escape hatch — anything JS can do, eval can do.\n\nExamples:\n  bp eval "document.title"\n  bp eval "history.back()"\n  bp eval "window.scrollBy(0, 500)"\n  bp eval "document.querySelector(\'h1\').textContent"\n  echo \'complex js\' | bp eval')
  .action(action(async (expression) => {
    if (!expression) {
      expression = await readStdin();
      if (!expression) throw new Error('No expression. Pass as argument or pipe via stdin.');
    }
    await withPilot(async ({ transport, sessionId, state }) => {
      const evalParams: Record<string, any> = { expression, returnByValue: true, awaitPromise: true };
      if (state.frameContextId) evalParams.contextId = state.frameContextId;
      const { result, exceptionDetails } = await transport.send('Runtime.evaluate', evalParams, sessionId);
      if (exceptionDetails) {
        throw new Error(exceptionDetails.exception?.description || exceptionDetails.text || 'Evaluation error');
      }
      if (useJson()) {
        console.log(JSON.stringify({ ok: true, value: result.value }));
      } else if (result.value !== undefined) {
        console.log(typeof result.value === 'object' ? JSON.stringify(result.value, null, 2) : String(result.value));
      }
    });
  }));

// ─── upload ─────────────────────────────────────────

program.command('upload <filepath>')
  .description('Upload file (auto-finds <input type="file"> on the page)')
  .option('--nth <n>', 'which file input to use if multiple exist', '1')
  .addHelpText('after', '\nAuto-detects file inputs on the page. No ref needed.\n\nExamples:\n  bp upload ./photo.jpg\n  bp upload /tmp/resume.pdf\n  bp upload ./doc.pdf --nth 2    # if multiple file inputs')
  .action(action(async (filepath, opts) => {
    const absPath = resolvePath(filepath);
    if (!existsSync(absPath)) throw new Error(`File not found: ${absPath}`);
    await withPilot(async ({ transport, sessionId, state }) => {
      // Auto-find all <input type="file"> elements
      const { result } = await transport.send('Runtime.evaluate', {
        expression: `JSON.stringify(Array.from(document.querySelectorAll('input[type=file]')).map((el,i) => ({index:i+1, name:el.name||el.id||'unnamed', accept:el.accept||'*'})))`,
        returnByValue: true,
      }, sessionId);
      const inputs: Array<{ index: number; name: string; accept: string }> = JSON.parse(result.value);

      if (inputs.length === 0) throw new Error('No <input type="file"> found on this page.');

      const nth = parseInt(opts.nth, 10);
      if (nth < 1 || nth > inputs.length) {
        const list = inputs.map(i => `  ${i.index}. ${i.name} (${i.accept})`).join('\n');
        throw new Error(`${inputs.length} file input(s) found. Use --nth to choose:\n${list}`);
      }

      // Resolve the nth file input
      const { result: elResult } = await transport.send('Runtime.evaluate', {
        expression: `document.querySelectorAll('input[type=file]')[${nth - 1}]`,
      }, sessionId);
      try {
        const { node } = await transport.send('DOM.describeNode', { objectId: elResult.objectId }, sessionId);
        await transport.send('DOM.setFileInputFiles', {
          files: [absPath],
          backendNodeId: node.backendNodeId,
        }, sessionId);
      } finally {
        if (elResult.objectId) {
          await transport.send('Runtime.releaseObject', { objectId: elResult.objectId }, sessionId).catch(() => {});
        }
      }

      emitSnapshot(await snap(transport, sessionId, state.activeTargetId));
    });
  }));

// ─── screenshot ─────────────────────────────────────

program.command('screenshot [filename]')
  .description('Capture screenshot')
  .option('-f, --full', 'capture full page')
  .option('--selector <sel>', 'capture specific element')
  .addHelpText('after', '\nExamples:\n  bp screenshot\n  bp screenshot page.png\n  bp screenshot --full\n  bp screenshot --selector ".chart"')
  .action(action(async (filename, opts) => {
    await withPilot(async ({ transport, sessionId }) => {
      const params: Record<string, any> = { format: 'png' };
      if (opts.full) {
        const { result } = await transport.send('Runtime.evaluate', {
          expression: PAGE_DIMENSIONS, returnByValue: true,
        }, sessionId);
        const dims = JSON.parse(result.value);
        params.captureBeyondViewport = true;
        params.clip = { x: 0, y: 0, ...dims, scale: 1 };
      }
      if (opts.selector) {
        const { result } = await transport.send('Runtime.evaluate', {
          expression: elementRect(opts.selector), returnByValue: true,
        }, sessionId);
        const rect = result.value ? JSON.parse(result.value) : null;
        if (!rect) throw new Error(`Element not found: ${opts.selector}`);
        params.clip = { ...rect, scale: 1 };
      }
      const { data } = await transport.send('Page.captureScreenshot', params, sessionId);
      const file = filename ?? `screenshot-${new Date().toISOString().replace(/[:.]/g, '-').slice(0, -5)}.png`;
      writeFileSync(file, Buffer.from(data, 'base64'));
      emit({ ok: true, file }, `\u2713 Screenshot saved to ${file}`);
    });
  }));

// ─── pdf ────────────────────────────────────────────

program.command('pdf [filename]')
  .description('Save page as PDF')
  .option('--landscape', 'landscape orientation')
  .addHelpText('after', '\nExamples:\n  bp pdf\n  bp pdf report.pdf\n  bp pdf report.pdf --landscape')
  .action(action(async (filename, opts) => {
    await withPilot(async ({ transport, sessionId }) => {
      const params: Record<string, any> = {};
      if (opts.landscape) params.landscape = true;
      const { data } = await transport.send('Page.printToPDF', params, sessionId);
      const file = filename ?? `page-${new Date().toISOString().replace(/[:.]/g, '-').slice(0, -5)}.pdf`;
      writeFileSync(file, Buffer.from(data, 'base64'));
      emit({ ok: true, file }, `\u2713 PDF saved to ${file}`);
    });
  }));

// ─── cookies ────────────────────────────────────────

program.command('cookies [domain]')
  .description('View cookies (CDP-only, includes HttpOnly)')
  .addHelpText('after', '\nExamples:\n  bp cookies\n  bp cookies github.com')
  .action(action(async (domain) => {
    await withPilot(async ({ transport, sessionId }) => {
      const { result: info } = await transport.send('Runtime.evaluate', {
        expression: 'location.href', returnByValue: true,
      }, sessionId);
      const urls = domain ? [`https://${domain}`, `http://${domain}`] : [info.value];
      const { cookies } = await transport.send('Network.getCookies', { urls }, sessionId);
      if (useJson()) {
        console.log(JSON.stringify({ ok: true, cookies }));
      } else if (cookies.length === 0) {
        console.log('No cookies found.');
      } else {
        for (const c of cookies) {
          const exp = c.expires === -1 ? 'Session' : new Date(c.expires * 1000).toISOString().slice(0, 10);
          console.log(`${c.name.padEnd(30)} ${c.domain.padEnd(25)} ${exp}`);
        }
      }
    });
  }));

// ─── frame ──────────────────────────────────────────

program.command('frame [target]')
  .description('List frames, or switch to a frame by index (0=top)')
  .addHelpText('after', '\nExamples:\n  bp frame          # list all frames\n  bp frame 1        # switch eval context to frame 1\n  bp frame 0        # switch back to top frame')
  .action(action(async (target) => {
    await withPilot(async ({ transport, sessionId, state }) => {
      const { frameTree } = await transport.send('Page.getFrameTree', {}, sessionId);
      const frames: Array<{ id: string; url: string; name: string }> = [];
      function collect(node: any) {
        frames.push({ id: node.frame.id, url: node.frame.url, name: node.frame.name || '' });
        for (const child of node.childFrames || []) collect(child);
      }
      collect(frameTree);

      if (target === undefined) {
        // List frames
        const list = frames.map((f, i) => ({ index: i, ...f }));
        if (useJson()) {
          console.log(JSON.stringify({ ok: true, frames: list }));
        } else {
          for (const [i, f] of frames.entries()) {
            console.log(`${i === 0 ? '* ' : '  '}${i}  ${f.url}  ${f.name}`);
          }
        }
      } else {
        // Switch to frame by index (0 = top frame)
        const idx = parseInt(target, 10);
        if (isNaN(idx) || idx < 0 || idx >= frames.length) {
          throw new Error(`Frame index out of range (0-${frames.length - 1})`);
        }
        if (idx === 0) {
          state.frameContextId = undefined;
        } else {
          const { executionContextId } = await transport.send('Page.createIsolatedWorld', {
            frameId: frames[idx].id,
          }, sessionId);
          state.frameContextId = executionContextId;
        }
        saveState(state);
        emit(
          { ok: true, frame: idx, url: frames[idx].url },
          `\u2713 Switched to frame ${idx}: ${frames[idx].url}`,
        );
      }
    });
  }));

// ─── auth ───────────────────────────────────────────

program.command('auth [username] [password]')
  .description('Set or clear HTTP Basic Auth credentials')
  .option('--clear', 'clear stored credentials')
  .addHelpText('after', '\nSets credentials for HTTP 401 challenges.\nCall before navigating to the auth-protected URL.\n\nExamples:\n  bp auth admin secret123\n  bp open https://staging.example.com\n  bp auth --clear')
  .action(action(async (username, password, opts) => {
    const existing = await resumeExisting();
    if (!existing) throw new Error('Not connected');
    const { client, state } = existing;
    if (opts.clear || !username) {
      await client.clearAuth();
      emit({ ok: true }, '\u2713 Auth credentials cleared');
      return;
    }
    if (!password) throw new Error('Usage: bp auth <username> <password>');
    await client.setAuth(username, password);
    emit({ ok: true }, '\u2713 Auth credentials set (scoped to HTTP 401 challenges)');
  }));

// ─── tabs ───────────────────────────────────────────

program.command('tabs')
  .description('List pilot tabs (auto-adopts discovered popups)')
  .action(action(async () => {
    const existing = await resumeExisting();
    if (!existing) throw new Error('Not connected');
    const { client, state } = existing;
    const { targetInfos } = await client.send('Target.getTargets');

    // Auto-adopt discovered popups
    const discovered = await client.discoveredTargets();
    const knownIds = new Set(state.pilotTargetIds);
    const existingIds = new Set(targetInfos.map((t: any) => t.targetId));
    let adopted = 0;
    for (const d of discovered) {
      if (!knownIds.has(d.targetId) && existingIds.has(d.targetId)) {
        state.pilotTargetIds.push(d.targetId);
        knownIds.add(d.targetId);
        adopted++;
      }
    }
    if (adopted > 0) saveState(state);

    const tabs = state.pilotTargetIds.map((id, i) => {
      const t = targetInfos.find((t: any) => t.targetId === id);
      return t ? { index: i, url: t.url || 'about:blank', title: t.title || '', active: id === state.activeTargetId } : null;
    }).filter(Boolean) as { index: number; url: string; title: string; active: boolean }[];

    if (useJson()) {
      console.log(JSON.stringify({ ok: true, tabs }));
    } else if (tabs.length === 0) {
      console.log('No pilot tabs open.');
    } else {
      for (const t of tabs) console.log(`${t.active ? '*' : ' '} ${t.index}  ${t.url}  ${t.title}`);
    }
  }));

// ─── tab ────────────────────────────────────────────

program.command('tab <index>')
  .description('Switch to tab by index')
  .action(action(async (indexStr) => {
    const existing = await resumeExisting();
    if (!existing) throw new Error('Not connected');
    const { client, state } = existing;
    const index = parseInt(indexStr, 10);
    if (index < 0 || index >= state.pilotTargetIds.length) {
      throw new Error(`Tab index out of range (0-${state.pilotTargetIds.length - 1})`);
    }
    state.activeTargetId = state.pilotTargetIds[index];
    state.activeSessionId = undefined;
    state.frameContextId = undefined;
    saveState(state);
    await client.send('Target.activateTarget', { targetId: state.activeTargetId });
    emit({ ok: true, index }, `\u2713 Switched to tab ${index}`);
  }));

// ─── close ──────────────────────────────────────────

program.command('close')
  .description('Close current pilot tab')
  .option('-a, --all', 'close all tabs')
  .action(action(async (opts) => {
    const existing = await resumeExisting();
    if (!existing) throw new Error('Not connected');
    const { client, state } = existing;
    if (opts.all) {
      for (const id of [...state.pilotTargetIds]) {
        try { await client.send('Target.closeTarget', { targetId: id }); } catch { /* ignore */ }
      }
      clearState();
      emit({ ok: true }, '\u2713 All tabs closed');
    } else {
      await client.send('Target.closeTarget', { targetId: state.activeTargetId });
      state.pilotTargetIds = state.pilotTargetIds.filter(id => id !== state.activeTargetId);
      if (state.pilotTargetIds.length > 0) {
        state.activeTargetId = state.pilotTargetIds[0];
        state.activeSessionId = undefined;
        state.frameContextId = undefined;
        saveState(state);
        emit({ ok: true, remaining: state.pilotTargetIds.length }, '\u2713 Tab closed');
      } else {
        clearState();
        emit({ ok: true }, '\u2713 Last tab closed');
      }
    }
  }));

// ─── net (network monitoring & interception) ────────

// Fix 5: shared helper — all net commands ensure network is enabled
async function ensureNet() {
  const existing = await resumeExisting();
  if (!existing) throw new Error('Not connected');
  const { client, state } = existing;
  if (state.activeSessionId) await client.enableNetwork(state.activeSessionId);
  return { client, state };
}

const netCmd = program.command('net')
  .description('Network monitoring and interception')
  .option('-l, --limit <n>', 'max requests to show', '20')
  .option('--url <pattern>', 'filter by URL wildcard')
  .option('--method <method>', 'filter by HTTP method')
  .option('--status <code>', 'filter by status (200, 4xx, 5xx)')
  .option('--type <types>', 'filter by resource type (xhr,fetch,document)')
  .option('--after <id>', 'show requests after this ID')
  .addHelpText('after', '\nExamples:\n  bp net                              # list recent requests\n  bp net --url "*api*" --method POST  # filter\n  bp net show 3                       # full details + body\n  bp net block "*tracking*"           # block URLs\n  bp net mock "*api/data*" --body \'{"ok":true}\'\n  bp net rules                        # list active rules\n  bp net remove --all                 # clear rules')
  .action(action(async (opts) => {
    const { client } = await ensureNet();

    const { requests, total } = await client.netRequests({
      limit: opts.limit ? parseInt(opts.limit, 10) : undefined,
      url: opts.url, method: opts.method, status: opts.status, type: opts.type,
      after: opts.after ? parseInt(opts.after, 10) : undefined,
    });

    if (useJson()) {
      console.log(JSON.stringify({ ok: true, requests, total }));
    } else if (requests.length === 0) {
      console.log('No requests captured.');
    } else {
      console.log(` ${'#'.padStart(4)}  ${'METHOD'.padEnd(7)} ${'STATUS'.padEnd(7)} ${'TYPE'.padEnd(8)} ${'TIME'.padEnd(8)} URL`);
      for (const r of requests) {
        const time = r.time ? `${r.time}ms` : r.error ? 'FAIL' : '...';
        const status = r.status ? String(r.status) : r.error ? 'ERR' : '...';
        console.log(` ${String(r.id).padStart(4)}  ${r.method.padEnd(7)} ${status.padEnd(7)} ${(r.type || '').padEnd(8)} ${time.padEnd(8)} ${r.url}`);
      }
    }
  }));

netCmd.command('show <id>')
  .description('Show full request/response details')
  .option('--save <file>', 'save response body to file')
  .action(action(async (idStr, opts) => {
    const { client } = await ensureNet();
    const id = parseInt(idStr, 10);

    if (opts.save) {
      const { body } = await client.netBody(id);
      writeFileSync(opts.save, body);
      emit({ ok: true, file: opts.save }, `Saved to ${opts.save}`);
      return;
    }

    const detail = await client.netRequestDetail(id);
    let responseBody: string | undefined;
    try { responseBody = (await client.netBody(id)).body; } catch { /* not available */ }

    if (useJson()) {
      console.log(JSON.stringify({ ok: true, ...detail, responseBody }));
    } else {
      console.log(`#${detail.id} ${detail.method} ${detail.url}`);
      console.log(`Status: ${detail.status ?? 'pending'} ${detail.statusText ?? ''}`);
      if (detail.postData) console.log(`\nRequest Body:\n${detail.postData}`);
      if (responseBody) {
        console.log(`\nResponse (${detail.mimeType}):`);
        console.log(responseBody.length > 2000 ? responseBody.slice(0, 2000) + '\n... (truncated)' : responseBody);
      }
    }
  }));

netCmd.command('block <pattern>')
  .description('Block requests matching URL pattern')
  .action(action(async (pattern) => {
    const { client } = await ensureNet();
    const { rule } = await client.netAddRule({ type: 'block', pattern });
    emit({ ok: true, rule }, `Rule #${rule.id}: blocking "${pattern}"`);
  }));

netCmd.command('mock <pattern>')
  .description('Mock responses for matching URLs')
  .option('--body <json>', 'response body')
  .option('--file <path>', 'read body from file')
  .option('--status <code>', 'HTTP status', '200')
  .action(action(async (pattern, opts) => {
    const { client } = await ensureNet();
    let body = opts.body || '';
    if (opts.file) {
      const filePath = resolvePath(opts.file);
      if (!existsSync(filePath)) throw new Error(`File not found: ${filePath}`);
      body = readFileSync(filePath, 'utf-8');
    }
    const { rule } = await client.netAddRule({
      type: 'mock', pattern, status: parseInt(opts.status, 10), body,
    });
    emit({ ok: true, rule }, `Rule #${rule.id}: mocking "${pattern}" -> ${opts.status}`);
  }));

netCmd.command('headers <pattern> <header...>')
  .description('Add/override request headers for matching URLs')
  .action(action(async (pattern, headerStrs) => {
    const { client } = await ensureNet();
    const headers = headerStrs.map((h: string) => {
      const [name, ...rest] = h.split(':');
      return { name: name.trim(), value: rest.join(':').trim() };
    });
    const { rule } = await client.netAddRule({ type: 'headers', pattern, headers });
    emit({ ok: true, rule }, `Rule #${rule.id}: headers for "${pattern}"`);
  }));

netCmd.command('rules')
  .description('List active interception rules')
  .action(action(async () => {
    const { client } = await ensureNet();
    const { rules } = await client.netRules();
    if (useJson()) { console.log(JSON.stringify({ ok: true, rules })); }
    else if (rules.length === 0) { console.log('No active rules.'); }
    else { for (const r of rules) console.log(`  #${r.id}  ${r.type.toUpperCase()} "${r.pattern}"`); }
  }));

netCmd.command('remove [ruleId]')
  .description('Remove interception rule(s)')
  .option('-a, --all', 'remove all rules')
  .action(action(async (ruleId, opts) => {
    const { client } = await ensureNet();
    if (opts.all) { await client.netRemoveRule(); emit({ ok: true }, 'All rules removed'); }
    else if (ruleId) { await client.netRemoveRule(parseInt(ruleId, 10)); emit({ ok: true }, `Rule #${ruleId} removed`); }
    else throw new Error('Specify a rule ID or use --all');
  }));

netCmd.command('clear')
  .description('Clear captured request log')
  .action(action(async () => {
    const { client } = await ensureNet();
    await client.netClear();
    emit({ ok: true }, 'Request log cleared');
  }));

program.parse();
