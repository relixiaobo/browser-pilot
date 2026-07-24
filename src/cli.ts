import { Command } from 'commander';
import { writeFileSync, readFileSync, existsSync } from 'node:fs';
import { resolve as resolvePath } from 'node:path';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const PKG_VERSION: string = require('../package.json').version;
import { connectFresh, resume, resumeExisting, withPilot, disconnect, waitForLoad, saveState, clearState, initSession } from './session.js';
import { type SnapshotResult } from './snapshot.js';
import { CaptureService } from './services/capture-service.js';
import { ActionService, type ClickTarget } from './services/action-service.js';
import { ObservationService } from './services/observation-service.js';
import { UploadService } from './services/upload-service.js';
import { PageContentService } from './services/page-content-service.js';
import { TargetService } from './services/target-service.js';
import { FrameService } from './services/frame-service.js';
import { CookieService } from './services/cookie-service.js';
import { AuthService } from './services/auth-service.js';
import { NetworkService } from './services/network-service.js';
import { BrowserPilotError } from './protocol/errors.js';
import { DaemonBridgeBackend } from './bridge/daemon-bridge-backend.js';
import { runStdioBridge } from './bridge/stdio-bridge.js';

const program = new Command();
program
  .name('bp')
  .description('Control your browser from the command line')
  .version(PKG_VERSION)
  .option('--human', 'force human-readable output (default when TTY)')
  .addHelpText('after', `
Workflow:
  bp connect                          # one-time setup (click Allow in Chrome)
  bp open <url>                       # navigate — returns snapshot with [ref] numbers
  bp click <ref>                      # interact — returns updated snapshot
  bp click --xy 400,300              # click at coordinates (canvas/maps)
  bp locate ".selector"              # get element coordinates for click --xy
  bp type <ref> <text>                # input text — returns updated snapshot
  bp keyboard <text>                  # type via keyboard events (Google Docs etc.)
  bp press <key>                      # press key — returns updated snapshot
  bp read [selector]                  # extract page text content (search results, articles)
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

Canvas editors (Google Docs, Sheets, Figma):
  bp keyboard "text" --click ".editor"               # click to focus, then type
  bp keyboard "text" --clear                          # select all + delete, then type
  bp press Meta+b                                     # toggle bold (works in Docs)

Edge cases:
  bp upload <filepath>                                # file input upload (auto-detect)
  bp auth <user> <pass>                               # HTTP Basic Auth
  bp frame                                            # list iframes
  bp frame 1                                          # eval in iframe context
  bp frame 0                                          # back to top frame
  bp dialogs                                           # list pending JavaScript dialogs
  bp dialog <id> --accept                              # explicitly accept a dialog

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

// ─── embedded stdio bridge ─────────────────────────

program.command('bridge')
  .description('Run the Agent-neutral JSON-RPC bridge')
  .option('--stdio', 'use newline-delimited JSON-RPC over stdin/stdout')
  .action((opts) => {
    if (!opts.stdio) {
      process.stderr.write('bridge currently requires --stdio\n');
      process.exitCode = 2;
      return;
    }
    void runStdioBridge({
      input: process.stdin,
      output: process.stdout,
      backend: new DaemonBridgeBackend(),
    }).then(result => {
      process.exitCode = result.exitCode;
    }).catch(error => {
      const message = error instanceof Error ? error.message : String(error);
      process.stderr.write(`Bridge error: ${message}\n`);
      process.exitCode = 1;
    });
  });

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
      emitSnapshot(await new ObservationService(transport, sid, tid).observe(limit));
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
      emitSnapshot(await new ObservationService(
        transport,
        sessionId,
        state.activeTargetId,
      ).observe(limit));
    });
  }));

// ─── click ──────────────────────────────────────────

program.command('click [ref]')
  .description('Click element by ref number or at x,y coordinates')
  .option('--xy <coords>', 'click at x,y viewport coordinates (e.g. --xy 400,300)')
  .option('--double', 'double-click')
  .option('--right', 'right-click (context menu)')
  .option('-l, --limit <n>', 'max elements in snapshot', '50')
  .addHelpText('after', `
Examples:
  bp click 3                  # click element [3] from snapshot
  bp click --xy 400,300       # click at viewport coordinates
  bp click --xy 400,300 --double   # double-click at coordinates
  bp click --xy 400,300 --right    # right-click (context menu)
  bp click 3 --right          # right-click element [3]`)
  .action(action(async (ref, opts) => {
    if (opts.double && opts.right) throw new Error('--double and --right are mutually exclusive');
    if (!ref && !opts.xy) throw new Error('Provide a ref number or --xy coordinates');
    const limit = parseLimit(opts.limit);
    await withPilot(async ({ transport, sessionId, state }) => {
      let target: ClickTarget;
      if (opts.xy) {
        const [xStr, yStr] = opts.xy.split(',');
        const x = parseFloat(xStr), y = parseFloat(yStr);
        if (isNaN(x) || isNaN(y)) throw new Error('--xy must be x,y (e.g. --xy 400,300)');
        target = { kind: 'coordinates', x, y };
      } else {
        target = { kind: 'ref', ref };
      }
      const service = new ActionService(transport, sessionId, state.activeTargetId);
      emitSnapshot(await service.click(target, {
        button: opts.right ? 'right' : 'left',
        clickCount: opts.double ? 2 : 1,
        observationLimit: limit,
      }));
    });
  }));

// ─── locate ────────────────────────────────────────

program.command('locate <selector>')
  .description('Get element coordinates by CSS selector (for use with click --xy)')
  .addHelpText('after', `
Returns center coordinates and bounding box of an element.
Use with click --xy for canvas apps, charts, or elements not in snapshot.

Examples:
  bp locate ".kix-appview-editor"    # Google Docs editor area
  bp locate "canvas"                 # canvas element
  bp locate "#map"                   # map container`)
  .action(action(async (selector) => {
    await withPilot(async ({ transport, sessionId, state }) => {
      const coords = await new ObservationService(
        transport,
        sessionId,
        state.activeTargetId,
      ).locate(selector);
      if (useJson()) {
        console.log(JSON.stringify({ ok: true, ...coords }));
      } else {
        console.log(`center: ${coords.x},${coords.y}  size: ${coords.width}x${coords.height}  (top:${coords.top} left:${coords.left})`);
      }
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
      const result = await new ActionService(
        transport,
        sessionId,
        state.activeTargetId,
      ).type(ref, text, {
        clear: opts.clear,
        submit: opts.submit,
        observationLimit: limit,
      });
      emitSnapshot(result.observation);
    });
  }));

// ─── keyboard ──────────────────────────────────────

program.command('keyboard <text>')
  .description('Type text via keyboard events (for canvas editors like Google Docs)')
  .option('-c, --clear', 'select all + delete before typing')
  .option('-s, --submit', 'press Enter after typing')
  .option('-d, --delay <ms>', 'delay between keystrokes in ms')
  .option('--click <selector>', 'click element by CSS selector first to focus it')
  .option('-l, --limit <n>', 'max elements in snapshot', '50')
  .addHelpText('after', `
Unlike 'type', this does not target a specific element. It sends real
keyboard events to whatever is currently focused — works with canvas-based
editors (Google Docs, Google Sheets, Figma) that don't expose DOM inputs.

Use --click to focus an element before typing (sends a real CDP mouse click).

Examples:
  bp keyboard "hello world"
  bp keyboard "new content" --clear
  bp keyboard "search query" --submit
  bp keyboard "Hello Docs!" --click ".kix-appview-editor"
  bp keyboard "slow typing" --delay 50`)
  .action(action(async (text, opts) => {
    const limit = parseLimit(opts.limit);
    let delay = 0;
    if (opts.delay) {
      delay = parseInt(opts.delay, 10);
      if (isNaN(delay) || delay < 0) throw new Error('--delay must be a non-negative number');
    }
    await withPilot(async ({ transport, sessionId, state }) => {
      const result = await new ActionService(
        transport,
        sessionId,
        state.activeTargetId,
      ).keyboard(text, {
        clear: opts.clear,
        submit: opts.submit,
        delayMs: delay,
        focusSelector: opts.click,
        observationLimit: limit,
      });
      if (useJson()) {
        console.log(JSON.stringify({ ok: true, typed: text, ...result.observation.data }));
      } else {
        console.log(result.observation.text);
      }
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
      emitSnapshot(await new ActionService(
        transport,
        sessionId,
        state.activeTargetId,
      ).press(key, limit));
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
      const value = await new PageContentService(transport, sessionId).evaluate(expression, {
        executionContextId: state.frameContextId,
      });
      if (useJson()) {
        console.log(JSON.stringify({ ok: true, value }));
      } else if (value !== undefined) {
        console.log(typeof value === 'object' ? JSON.stringify(value, null, 2) : String(value));
      }
    });
  }));

// ─── read ───────────────────────────────────────────

program.command('read [selector]')
  .description('Extract cleaned readable text from the page (or a CSS selector)')
  .option('--limit <n>', 'max characters of text to return', '3000')
  .addHelpText('after', `
Returns title + url + cleaned text content. Use this when you need to "see"
the actual content of a page (search results, articles, lists) — things the
snapshot/accessibility tree does not capture.

Strips: scripts, styles, nav, footer, aside, svg, iframe, ARIA-hidden elements.

Examples:
  bp read                              # main content of current page
  bp read "main"                       # specific selector
  bp read ".search-results"            # search results region only
  bp read --limit 10000                # allow longer output

When to use which command:
  bp snapshot   → list interactive elements (buttons, links, inputs)
  bp read       → page text content (search results, articles)
  bp eval       → custom extraction (structured data, attributes)`)
  .action(action(async (selector, opts) => {
    const limit = parseInt(opts.limit, 10);
    if (isNaN(limit) || limit < 1) throw new Error('--limit must be a positive integer');
    await withPilot(async ({ transport, sessionId, state }) => {
      let data;
      try {
        data = await new PageContentService(transport, sessionId).read(selector, limit, {
          executionContextId: state.frameContextId,
        });
      } catch (error) {
        if (selector && error instanceof BrowserPilotError && error.context?.field === 'selector') {
          fail(error.message, `Selector "${selector}" did not match.`);
        }
        throw error;
      }
      if (useJson()) {
        console.log(JSON.stringify({ ok: true, title: data.title, url: data.url, text: data.text, length: data.length, truncated: data.truncated }));
      } else {
        console.log(`${data.title}\n${data.url}\n${'─'.repeat(60)}\n${data.text}${data.truncated ? '\n... [truncated]' : ''}`);
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
    const inputIndex = parseInt(opts.nth, 10);
    if (isNaN(inputIndex) || inputIndex < 1) throw new Error('--nth must be a positive integer');
    await withPilot(async ({ transport, sessionId, state }) => {
      const observations = new ObservationService(transport, sessionId, state.activeTargetId);
      emitSnapshot(await new UploadService(transport, sessionId, observations).upload(absPath, {
        inputIndex,
      }));
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
      const media = await new CaptureService(transport, sessionId).screenshot({
        fullPage: opts.full,
        selector: opts.selector,
      });
      const file = filename ?? `screenshot-${new Date().toISOString().replace(/[:.]/g, '-').slice(0, -5)}.png`;
      writeFileSync(file, media.bytes);
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
      const media = await new CaptureService(transport, sessionId).pdf({ landscape: opts.landscape });
      const file = filename ?? `page-${new Date().toISOString().replace(/[:.]/g, '-').slice(0, -5)}.pdf`;
      writeFileSync(file, media.bytes);
      emit({ ok: true, file }, `\u2713 PDF saved to ${file}`);
    });
  }));

// ─── cookies ────────────────────────────────────────

program.command('cookies [domain]')
  .description('View cookies (CDP-only, includes HttpOnly)')
  .addHelpText('after', '\nExamples:\n  bp cookies\n  bp cookies github.com')
  .action(action(async (domain) => {
    await withPilot(async ({ transport, sessionId }) => {
      const cookies = await new CookieService(transport, sessionId).list(domain);
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
      const service = new FrameService(transport, sessionId);

      if (target === undefined) {
        const frames = await service.list();
        const list = frames.map((f, i) => ({ index: i, ...f }));
        if (useJson()) {
          console.log(JSON.stringify({ ok: true, frames: list }));
        } else {
          for (const [i, f] of frames.entries()) {
            console.log(`${i === 0 ? '* ' : '  '}${i}  ${f.url}  ${f.name}`);
          }
        }
      } else {
        const idx = parseInt(target, 10);
        const selection = await service.select(idx);
        state.frameContextId = selection.executionContextId;
        saveState(state);
        emit(
          { ok: true, frame: idx, url: selection.frame.url },
          `\u2713 Switched to frame ${idx}: ${selection.frame.url}`,
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
    const service = new AuthService(existing.client);
    if (opts.clear || !username) {
      await service.clear();
      emit({ ok: true }, '\u2713 Auth credentials cleared');
      return;
    }
    if (!password) throw new Error('Usage: bp auth <username> <password>');
    await service.set(username, password);
    emit({ ok: true }, '\u2713 Auth credentials set (scoped to HTTP 401 challenges)');
  }));

// ─── dialogs ────────────────────────────────────────

program.command('dialogs')
  .description('List pending JavaScript dialogs')
  .action(action(async () => {
    const existing = await resumeExisting();
    if (!existing) throw new Error('Not connected');
    const dialogs = await existing.client.dialogs();
    if (useJson()) {
      console.log(JSON.stringify({ ok: true, dialogs }));
    } else if (dialogs.length === 0) {
      console.log('No pending dialogs.');
    } else {
      for (const dialog of dialogs) {
        console.log(`${dialog.dialogId}  ${dialog.type}  ${dialog.message}`);
      }
    }
  }));

program.command('dialog <dialogId>')
  .description('Accept or dismiss a pending JavaScript dialog')
  .option('--accept', 'accept the dialog')
  .option('--dismiss', 'dismiss the dialog')
  .option('--prompt <text>', 'text to submit to a prompt dialog')
  .action(action(async (dialogId, opts) => {
    if (Boolean(opts.accept) === Boolean(opts.dismiss)) {
      throw new Error('Choose exactly one of --accept or --dismiss');
    }
    const existing = await resumeExisting();
    if (!existing) throw new Error('Not connected');
    const result = await existing.client.respondToDialog(
      dialogId,
      opts.accept ? 'accept' : 'dismiss',
      opts.prompt,
    );
    emit(
      { ok: true, dialogId: result.dialogId, action: result.action },
      `\u2713 ${result.action === 'accept' ? 'Accepted' : 'Dismissed'} dialog ${result.dialogId}`,
    );
  }));

// ─── tabs ───────────────────────────────────────────

program.command('tabs')
  .description('List all controllable browser tabs')
  .action(action(async () => {
    const existing = await resumeExisting();
    if (!existing) throw new Error('Not connected');
    const { client, state } = existing;
    const result = await new TargetService(client, client).list(
      state.pilotTargetIds,
      state.activeTargetId,
    );
    if (
      result.managedTargetIds.length !== state.pilotTargetIds.length ||
      result.managedTargetIds.some((targetId, index) => targetId !== state.pilotTargetIds[index])
    ) {
      state.pilotTargetIds = result.managedTargetIds;
      saveState(state);
    }
    const tabs = result.tabs.map(({ targetId: _targetId, ...tab }) => tab);

    if (useJson()) {
      console.log(JSON.stringify({ ok: true, tabs }));
    } else if (tabs.length === 0) {
      console.log('No controllable tabs open.');
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
    const service = new TargetService(client, client);
    const inventory = await service.list(state.pilotTargetIds, state.activeTargetId);
    state.pilotTargetIds = inventory.managedTargetIds;
    state.activeTargetId = await service.activateByIndex(
      inventory.tabs.map(tab => tab.targetId),
      index,
    );
    state.activeSessionId = undefined;
    state.frameContextId = undefined;
    saveState(state);
    emit({ ok: true, index }, `\u2713 Switched to tab ${index}`);
  }));

// ─── close ──────────────────────────────────────────

program.command('close')
  .description('Close current browser tab')
  .option('-a, --all', 'close all tabs in the current Pilot window')
  .action(action(async (opts) => {
    const existing = await resumeExisting();
    if (!existing) throw new Error('Not connected');
    const { client, state } = existing;
    const service = new TargetService(client, client);
    if (opts.all) {
      const inventory = await service.list(state.pilotTargetIds, state.activeTargetId);
      const result = await service.closeManaged(inventory.managedTargetIds);
      const remainingTabs = inventory.tabs.filter(tab => !result.closed.includes(tab.targetId));
      if (result.failed.length > 0) {
        state.pilotTargetIds = result.failed;
        if (!remainingTabs.some(tab => tab.targetId === state.activeTargetId)) {
          state.activeTargetId = remainingTabs[0].targetId;
        }
        state.activeSessionId = undefined;
        state.frameContextId = undefined;
        saveState(state);
        throw new BrowserPilotError('internal_error', `Failed to close ${result.failed.length} Pilot tab(s)`, {
          retryable: true,
          context: { failedTargetIds: result.failed },
        });
      }
      state.pilotTargetIds = [];
      if (remainingTabs.length > 0) {
        if (!remainingTabs.some(tab => tab.targetId === state.activeTargetId)) {
          state.activeTargetId = remainingTabs[0].targetId;
        }
        state.activeSessionId = undefined;
        state.frameContextId = undefined;
        saveState(state);
      } else {
        clearState();
      }
      emit(
        { ok: true, closed: result.closed.length, remaining: remainingTabs.length },
        `\u2713 Closed ${result.closed.length} Pilot tab(s)`,
      );
    } else {
      const inventory = await service.list(state.pilotTargetIds, state.activeTargetId);
      await service.close(inventory.tabs.map(tab => tab.targetId), state.activeTargetId);
      const remainingTabs = inventory.tabs.filter(tab => tab.targetId !== state.activeTargetId);
      state.pilotTargetIds = inventory.managedTargetIds.filter(id => id !== state.activeTargetId);
      if (remainingTabs.length > 0) {
        state.activeTargetId = state.pilotTargetIds[0] ?? remainingTabs[0].targetId;
        state.activeSessionId = undefined;
        state.frameContextId = undefined;
        saveState(state);
        emit({ ok: true, remaining: remainingTabs.length }, '\u2713 Tab closed');
      } else {
        clearState();
        emit({ ok: true, remaining: 0 }, '\u2713 Last tab closed');
      }
    }
  }));

// ─── net (network monitoring & interception) ────────

// Fix 5: shared helper — all net commands ensure network is enabled
async function ensureNet() {
  const existing = await resumeExisting();
  if (!existing) throw new Error('Not connected');
  const { client, state } = existing;
  const service = new NetworkService(client, state.activeSessionId);
  await service.enable();
  return service;
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
    const service = await ensureNet();

    const { requests, total } = await service.requests({
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
    const service = await ensureNet();
    const id = parseInt(idStr, 10);

    if (opts.save) {
      const { body } = await service.body(id);
      writeFileSync(opts.save, body);
      emit({ ok: true, file: opts.save }, `Saved to ${opts.save}`);
      return;
    }

    const detail = await service.request(id);
    const responseBody = detail.responseBody;

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
    const service = await ensureNet();
    const { rule } = await service.addBlock(pattern);
    emit({ ok: true, rule }, `Rule #${rule.id}: blocking "${pattern}"`);
  }));

netCmd.command('mock <pattern>')
  .description('Mock responses for matching URLs')
  .option('--body <json>', 'response body')
  .option('--file <path>', 'read body from file')
  .option('--status <code>', 'HTTP status', '200')
  .action(action(async (pattern, opts) => {
    const service = await ensureNet();
    let body = opts.body || '';
    if (opts.file) {
      const filePath = resolvePath(opts.file);
      if (!existsSync(filePath)) throw new Error(`File not found: ${filePath}`);
      body = readFileSync(filePath, 'utf-8');
    }
    const { rule } = await service.addMock(pattern, parseInt(opts.status, 10), body);
    emit({ ok: true, rule }, `Rule #${rule.id}: mocking "${pattern}" -> ${opts.status}`);
  }));

netCmd.command('headers <pattern> <header...>')
  .description('Add/override request headers for matching URLs')
  .action(action(async (pattern, headerStrs) => {
    const service = await ensureNet();
    const headers = headerStrs.map((h: string) => {
      const [name, ...rest] = h.split(':');
      return { name: name.trim(), value: rest.join(':').trim() };
    });
    const { rule } = await service.addHeaders(pattern, headers);
    emit({ ok: true, rule }, `Rule #${rule.id}: headers for "${pattern}"`);
  }));

netCmd.command('rules')
  .description('List active interception rules')
  .action(action(async () => {
    const rules = await (await ensureNet()).rules();
    if (useJson()) { console.log(JSON.stringify({ ok: true, rules })); }
    else if (rules.length === 0) { console.log('No active rules.'); }
    else { for (const r of rules) console.log(`  #${r.id}  ${r.type.toUpperCase()} "${r.pattern}"`); }
  }));

netCmd.command('remove [ruleId]')
  .description('Remove interception rule(s)')
  .option('-a, --all', 'remove all rules')
  .action(action(async (ruleId, opts) => {
    const service = await ensureNet();
    if (opts.all) { await service.remove(); emit({ ok: true }, 'All rules removed'); }
    else if (ruleId) { await service.remove(parseInt(ruleId, 10)); emit({ ok: true }, `Rule #${ruleId} removed`); }
    else throw new Error('Specify a rule ID or use --all');
  }));

netCmd.command('clear')
  .description('Clear captured request log')
  .action(action(async () => {
    await (await ensureNet()).clear();
    emit({ ok: true }, 'Request log cleared');
  }));

program.parse();
