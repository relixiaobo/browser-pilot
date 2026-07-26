import { Command } from 'commander';
import { writeFileSync, readFileSync, existsSync } from 'node:fs';
import { resolve as resolvePath } from 'node:path';
import { BROWSER_PILOT_VERSION as PKG_VERSION } from './version.js';
import { BrowserPilotError } from './protocol/errors.js';
import type {
  ArtifactDescriptor,
  ControlledTargetId,
  JsonValue,
} from './protocol/model.js';
import { DaemonBridgeBackend } from './bridge/daemon-bridge-backend.js';
import { runStdioBridge } from './bridge/stdio-bridge.js';
import { discoverBrowserCandidates } from './chrome.js';
import {
  connectCompatibility,
  resumeCompatibility,
  shutdownCompatibility,
  withCompatibilityTarget,
  type CompatibilityBrokerClient,
  type CompatibilityProfile,
  type CompatibilityTarget,
} from './compatibility-broker-client.js';

const program = new Command();
program
  .name('bp')
  .description('Control your browser from the command line')
  .version(PKG_VERSION)
  .option('--human', 'force human-readable output (default when TTY)')
  .addHelpText('after', `
Workflow:
  bp connect                          # one-time setup (click Allow in Chrome)
  bp profiles                         # list live Chrome Profile contexts
  bp profile <index>                  # route new managed tabs to one Profile
  bp open <url>                       # navigate — returns snapshot with [ref] numbers
  bp open <url> --new --profile <id>  # create managed work in one Profile
  bp click <ref>                      # interact — returns updated snapshot
  bp click --xy 400,300              # click at coordinates (canvas/maps)
  bp locate ".selector"              # get element coordinates for click --xy
  bp type <ref> <text>                # input text — returns updated snapshot
  bp keyboard <text>                  # type via keyboard events (Google Docs etc.)
  bp press <key>                      # press key — returns updated snapshot
  bp read [selector]                  # extract page text content (search results, articles)
  bp search <text>                    # find bounded visible text matches
  bp find <selector>                  # inspect bounded DOM metadata
  bp scroll down                      # scroll page/container and return fresh state
  bp dropdown <ref>                   # list native or ARIA dropdown options
  bp select <ref> <label>             # select and verify a dropdown option
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

Eval (escape hatch for operations without a dedicated command):
  bp eval "history.back()"                           # go back
  bp eval "history.forward()"                        # go forward
  bp eval "location.reload()"                        # reload
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

function fail(error: string, hint?: string, details?: BrowserPilotError): never {
  if (useJson()) console.log(JSON.stringify({
    ok: false,
    error,
    ...(hint ? { hint } : {}),
    ...(details ? details.toData() : {}),
  }));
  else console.error(`\u2717 ${error}${hint ? `\n  hint: ${hint}` : ''}`);
  process.exit(1);
}

interface CliObservationElement {
  ref: number;
  role: string;
  name: string;
  value?: string;
  checked?: boolean;
}

function observationElements(result: Record<string, JsonValue>): CliObservationElement[] {
  return Array.isArray(result.elements)
    ? result.elements as unknown as CliObservationElement[]
    : [];
}

function emitObservation(result: Record<string, JsonValue>): void {
  const title = String(result.title ?? '');
  const url = String(result.url ?? '');
  const elements = observationElements(result);
  const truncated = result.truncated === true;
  const truncationReasons = Array.isArray(result.truncationReasons)
    ? result.truncationReasons
    : [];
  if (useJson()) {
    console.log(JSON.stringify({
      ok: true,
      title,
      url,
      ...(result.page && typeof result.page === 'object' ? { page: result.page } : {}),
      elements,
      truncated,
      truncationReasons,
      ...(Array.isArray(result.hints) ? { hints: result.hints } : {}),
      ...(result.evidence && typeof result.evidence === 'object' ? { evidence: result.evidence } : {}),
      ...(typeof result.profileContextId === 'string'
        ? { profileContextId: result.profileContextId }
        : {}),
    }));
  } else {
    const lines = [`[page] ${title} | ${url}`, ''];
    const page = result.page && typeof result.page === 'object' && !Array.isArray(result.page)
      ? result.page as Record<string, JsonValue>
      : undefined;
    if (page) {
      lines.push(`[viewport] ${page.viewportWidth}x${page.viewportHeight} at ${page.scrollX},${page.scrollY} | ${page.pixelsBelow}px below`);
      lines.push('');
    }
    if (elements.length === 0) {
      lines.push('(no interactive elements)');
    } else {
      for (const element of elements) {
        let line = `[${element.ref}] ${element.role} "${element.name}"`;
        if (element.value !== undefined && element.value !== '') line += ` value="${element.value}"`;
        if (element.checked) line += ' checked';
        lines.push(line);
      }
    }
    const suffix = truncated
      ? `\n\n[truncated: ${truncationReasons.join(', ')}]`
      : '';
    console.log(`${lines.join('\n')}${suffix}`);
  }
}

// ── Helpers ─────────────────────────────────────────

function action(fn: (...args: any[]) => Promise<void>) {
  return (...args: any[]) => fn(...args).catch((err: unknown) => {
    const msg = err instanceof Error ? err.message : String(err);
    // Add hints for common errors
    if (err instanceof BrowserPilotError && err.code === 'stale_ref') {
      fail(msg, "Run 'bp snapshot' to refresh element refs.", err);
    }
    if (msg.includes('not found') && msg.includes('Ref')) fail(msg, "Run 'bp snapshot' to refresh element refs.", err instanceof BrowserPilotError ? err : undefined);
    if (msg.includes('Not connected')) fail(msg, "Run 'bp connect' first.", err instanceof BrowserPilotError ? err : undefined);
    if (msg.includes('Page load timeout')) fail(msg, "Page may still be loading. Retry the command after a moment.", err instanceof BrowserPilotError ? err : undefined);
    fail(msg, undefined, err instanceof BrowserPilotError ? err : undefined);
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

function parseRef(raw: string): number {
  const ref = Number(raw);
  if (!Number.isSafeInteger(ref) || ref < 1) {
    throw new Error('Ref must be a positive integer');
  }
  return ref;
}

function requireString(value: JsonValue | undefined, label: string): string {
  if (typeof value !== 'string') throw new BrowserPilotError('internal_error', `${label} is missing`);
  return value;
}

function artifactFrom(result: Record<string, JsonValue>): ArtifactDescriptor {
  if (!result.artifact || typeof result.artifact !== 'object' || Array.isArray(result.artifact)) {
    throw new BrowserPilotError('internal_error', 'Browser tool did not return an Artifact');
  }
  return result.artifact as unknown as ArtifactDescriptor;
}

async function cliElementAddress(
  client: CompatibilityBrokerClient,
  target: CompatibilityTarget,
  raw: string,
): Promise<Record<string, JsonValue>> {
  if (/^[1-9]\d*$/.test(raw)) {
    return {
      observationId: await client.latestObservation(target.targetId),
      ref: parseRef(raw),
    };
  }
  if (!raw.trim()) throw new Error('Element target must not be empty');
  return { selector: raw };
}

async function requireCompatibility(): Promise<CompatibilityBrokerClient> {
  const client = await resumeCompatibility(PKG_VERSION);
  if (!client) throw new Error('Not connected');
  return client;
}

async function resolveCliProfile(
  client: CompatibilityBrokerClient,
  selector: string,
): Promise<CompatibilityProfile> {
  const profiles = await client.listProfiles();
  const exactId = profiles.find(profile => profile.profileContextId === selector);
  if (exactId) return exactId;
  if (/^\d+$/.test(selector)) {
    const index = Number(selector);
    if (Number.isSafeInteger(index) && profiles[index]) return profiles[index];
    throw invalidCliProfile(`Profile index out of range (0-${Math.max(0, profiles.length - 1)})`, selector);
  }
  const normalized = selector.trim().toLocaleLowerCase();
  const matches = profiles.filter(profile => (
    profile.label.toLocaleLowerCase() === normalized ||
    profile.displayName?.toLocaleLowerCase() === normalized
  ));
  if (matches.length === 1) return matches[0];
  if (matches.length > 1) {
    throw invalidCliProfile('Profile selector is ambiguous; use its index or Profile context ID', selector);
  }
  throw invalidCliProfile('Profile selector does not match a live Chrome Profile', selector);
}

function invalidCliProfile(message: string, selector: string): BrowserPilotError {
  return new BrowserPilotError('invalid_argument', message, {
    context: { field: 'profile', selector },
  });
}

function cliProfile(profile: CompatibilityProfile, index: number): Record<string, JsonValue> {
  return {
    index,
    profileContextId: profile.profileContextId,
    label: profile.label,
    ...(profile.displayName ? { displayName: profile.displayName } : {}),
    tabCount: profile.tabCount,
    eligibleTabCount: profile.eligibleTabCount,
    selected: profile.selected,
    representativeTabs: profile.representativeTabs,
  };
}

function withCliTarget<T>(
  operation: (client: CompatibilityBrokerClient, target: CompatibilityTarget) => Promise<T>,
): Promise<T> {
  return withCompatibilityTarget(PKG_VERSION, operation);
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

program.command('browsers')
  .description('List supported local browsers and their setup state')
  .option('-b, --browser <name>', 'filter by browser ID, product, or channel')
  .action(action(async (opts) => {
    const filter = typeof opts.browser === 'string' ? opts.browser.toLowerCase() : undefined;
    const browsers = (await discoverBrowserCandidates())
      .map(discovered => discovered.candidate)
      .filter(candidate => !filter || [candidate.id, candidate.product, candidate.channel]
        .some(value => value?.toLowerCase().includes(filter)));
    if (useJson()) {
      console.log(JSON.stringify({ ok: true, browsers }));
      return;
    }
    if (browsers.length === 0) {
      console.log('No installed supported browsers found.');
      return;
    }
    console.log(browsers.map(candidate => {
      const label = `${candidate.product}${candidate.channel ? ` (${candidate.channel})` : ''}`;
      const details = [
        `${label}: ${candidate.state}`,
        `  id: ${candidate.id}`,
        `  process: ${candidate.processState}; remote debugging: ${candidate.remoteDebuggingState}; authorization: ${candidate.authorizationState}`,
      ];
      if (candidate.remediation) details.push(`  action: ${candidate.remediation.message}`);
      return details.join('\n');
    }).join('\n\n'));
  }));

program.command('connect')
  .description('Connect to Chrome and prepare unambiguous managed browsing')
  .option('-b, --browser <name>', 'browser to connect to')
  .addHelpText('after', '\nExamples:\n  bp connect\n  bp connect --browser brave')
  .action(action(async (opts) => {
    if (!useJson()) {
      console.log('Connecting to Chrome...');
      console.log('If prompted, click "Allow" in Chrome\'s authorization dialog.\n');
    }
    const client = await connectCompatibility(PKG_VERSION, opts.browser);
    await client.connectBrowser();
    const profiles = await client.listProfiles();
    if (profiles.length <= 1) await client.ensureManagedTarget();
    const browser = client.initialized.browsers.find(candidate => candidate.state === 'ready')?.product ?? 'browser';
    if (profiles.length > 1) {
      const listed = profiles.map(cliProfile);
      emit(
        { ok: true, browser, profileSelectionRequired: true, profiles: listed },
        `\u2713 Connected to ${browser}\nMultiple Chrome Profiles are open. Run 'bp profiles', then 'bp profile <index>'.`,
      );
      return;
    }
    emit(
      { ok: true, browser, profileSelectionRequired: false },
      `\u2713 Connected to ${browser}\n\u2713 Pilot window ready (daemon running in background)\n\nReady! Try: bp open https://example.com`,
    );
  }));

// ─── embedded stdio bridge ─────────────────────────

program.command('bridge')
  .description('Run the Agent-neutral JSON-RPC bridge')
  .option('--stdio', 'use newline-delimited JSON-RPC over stdin/stdout')
  .option('-b, --browser <name>', 'prefer a browser ID, product, or channel when starting the Broker')
  .action((opts) => {
    if (!opts.stdio) {
      process.stderr.write('bridge currently requires --stdio\n');
      process.exitCode = 2;
      return;
    }
    void runStdioBridge({
      input: process.stdin,
      output: process.stdout,
      backend: new DaemonBridgeBackend(opts.browser),
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
  .description('Release CLI browser state and stop an otherwise unused daemon')
  .action(action(async () => {
    await shutdownCompatibility(PKG_VERSION);
    emit({ ok: true }, '\u2713 Disconnected');
  }));

// ─── open ───────────────────────────────────────────

program.command('profiles')
  .description('List live Chrome Profile contexts')
  .action(action(async () => {
    const profiles = (await (await requireCompatibility()).listProfiles()).map(cliProfile);
    if (useJson()) {
      console.log(JSON.stringify({ ok: true, profiles }));
      return;
    }
    if (profiles.length === 0) {
      console.log('No live Chrome Profile contexts found.');
      return;
    }
    for (const profile of profiles) {
      const name = profile.displayName ? ` (${profile.displayName})` : '';
      console.log(`${profile.selected ? '*' : ' '} ${profile.index}  ${profile.label}${name}  ${profile.tabCount} tab(s)`);
    }
  }));

program.command('profile <selector>')
  .description('Select a Chrome Profile context for new managed tabs')
  .action(action(async (selector) => {
    const client = await requireCompatibility();
    const profile = await resolveCliProfile(client, String(selector));
    const selected = await client.selectProfile(profile.profileContextId);
    emit(
      {
        ok: true,
        profileContextId: selected.profileContextId,
        label: selected.label,
        ...(selected.displayName ? { displayName: selected.displayName } : {}),
      },
      `\u2713 Selected ${selected.displayName ?? selected.label}`,
    );
  }));

program.command('open <url>')
  .description('Navigate to URL and return page snapshot')
  .option('-n, --new', 'open in new tab')
  .option('--profile <selector>', 'Profile index, ID, label, or verified display name (requires --new)')
  .option('-l, --limit <n>', 'max elements in snapshot', '50')
  .addHelpText('after', '\nExamples:\n  bp open https://github.com\n  bp open github.com --new\n  bp open https://example.com --new --profile 1\n  bp open https://example.com --limit 20')
  .action(action(async (url, opts) => {
    url = normalizeUrl(url);
    const limit = parseLimit(opts.limit);
    if (opts.profile && !opts.new) throw new Error('--profile requires --new');
    if (opts.new) {
      const client = await requireCompatibility();
      const profile = opts.profile
        ? await resolveCliProfile(client, String(opts.profile))
        : undefined;
      emitObservation(await client.callTool('browser.open', {
        url,
        newTarget: true,
        ...(profile ? { profileContextId: profile.profileContextId } : {}),
        observationLimit: limit,
      }));
      return;
    }
    await withCliTarget(async (client, target) => {
      const result = await client.callTool('browser.open', {
        url,
        targetId: target.targetId,
        observationLimit: limit,
      });
      emitObservation(result);
    });
  }));

// ─── snapshot ───────────────────────────────────────

program.command('snapshot')
  .description('Get interactive elements on the page')
  .option('-l, --limit <n>', 'max elements to return', '50')
  .addHelpText('after', '\nExamples:\n  bp snapshot\n  bp snapshot --limit 100')
  .action(action(async (opts) => {
    const limit = parseLimit(opts.limit);
    await withCliTarget(async (client, target) => {
      emitObservation(await client.callTool('browser.observe', { limit }, target.targetId));
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
    await withCliTarget(async (client, controlledTarget) => {
      let target: Record<string, JsonValue>;
      if (opts.xy) {
        const [xStr, yStr] = opts.xy.split(',');
        const x = parseFloat(xStr), y = parseFloat(yStr);
        if (isNaN(x) || isNaN(y)) throw new Error('--xy must be x,y (e.g. --xy 400,300)');
        target = { x, y };
      } else {
        target = {
          observationId: await client.latestObservation(controlledTarget.targetId),
          ref: parseRef(ref),
        };
      }
      const result = await client.callTool('browser.click', {
        target,
        button: opts.right ? 'right' : 'left',
        clickCount: opts.double ? 2 : 1,
        observationLimit: limit,
      }, controlledTarget.targetId);
      emitObservation(result);
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
    await withCliTarget(async (client, target) => {
      const coords = await client.callTool('browser.locate', { selector }, target.targetId);
      if (useJson()) {
        console.log(JSON.stringify({
          ok: true,
          x: coords.x,
          y: coords.y,
          top: coords.top,
          left: coords.left,
          width: coords.width,
          height: coords.height,
        }));
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
    await withCliTarget(async (client, target) => {
      const result = await client.callTool('browser.type', {
        observationId: await client.latestObservation(target.targetId),
        ref: parseRef(ref),
        text,
        ...(opts.clear ? { clear: true } : {}),
        ...(opts.submit ? { submit: true } : {}),
        observationLimit: limit,
      }, target.targetId);
      emitObservation(result);
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
    await withCliTarget(async (client, target) => {
      const result = await client.callTool('browser.keyboard', {
        text,
        ...(opts.clear ? { clear: true } : {}),
        ...(opts.submit ? { submit: true } : {}),
        delayMs: delay,
        ...(opts.click ? { focusSelector: opts.click } : {}),
        observationLimit: limit,
      }, target.targetId);
      if (useJson()) {
        console.log(JSON.stringify({
          ok: true,
          typed: text,
          title: String(result.title ?? ''),
          url: String(result.url ?? ''),
          elements: observationElements(result),
          truncated: result.truncated === true,
          truncationReasons: Array.isArray(result.truncationReasons) ? result.truncationReasons : [],
        }));
      } else {
        emitObservation(result);
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
    await withCliTarget(async (client, target) => {
      const result = await client.callTool('browser.press', {
        key,
        observationLimit: limit,
      }, target.targetId);
      emitObservation(result);
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
    await withCliTarget(async (client, target) => {
      const result = await client.callTool('browser.eval', {
        expression,
        awaitPromise: true,
      }, target.targetId);
      const value = result.value;
      if (useJson()) {
        console.log(JSON.stringify({ ok: true, value, truncated: result.truncated === true }));
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
    await withCliTarget(async (client, target) => {
      let data: Record<string, JsonValue>;
      try {
        data = await client.callTool('browser.read', {
          ...(selector ? { selector } : {}),
          limit,
        }, target.targetId);
      } catch (error) {
        if (selector && error instanceof BrowserPilotError && error.context?.field === 'selector') {
          fail(error.message, `Selector "${selector}" did not match.`, error);
        }
        throw error;
      }
      if (useJson()) {
        console.log(JSON.stringify({ ok: true, title: data.title, url: data.url, text: data.text, length: data.length, truncated: data.truncated }));
      } else {
        console.log(`${data.title}\n${data.url}\n${'─'.repeat(60)}\n${data.text}${data.truncated === true ? '\n... [truncated]' : ''}`);
      }
    });
  }));

// ─── search / find ─────────────────────────────────

program.command('search <query>')
  .description('Find visible page text without returning the entire page')
  .option('--selector <selector>', 'limit search to a CSS-selected region')
  .option('--case-sensitive', 'use case-sensitive matching')
  .option('--whole-word', 'match complete words only')
  .option('-l, --limit <n>', 'maximum matches to return', '20')
  .addHelpText('after', '\nExamples:\n  bp search "invoice total"\n  bp search "error" --selector main --limit 50')
  .action(action(async (query, opts) => {
    const limit = parseLimit(opts.limit);
    await withCliTarget(async (client, target) => {
      const result = await client.callTool('browser.search', {
        query,
        ...(opts.selector ? { selector: opts.selector } : {}),
        ...(opts.caseSensitive ? { caseSensitive: true } : {}),
        ...(opts.wholeWord ? { wholeWord: true } : {}),
        limit,
      }, target.targetId);
      if (useJson()) {
        console.log(JSON.stringify({ ok: true, ...result }));
        return;
      }
      const matches = Array.isArray(result.matches) ? result.matches : [];
      console.log(`${result.title}\n${result.url}\n${'─'.repeat(60)}`);
      if (matches.length === 0) console.log('(no matches)');
      for (const match of matches) {
        if (!match || typeof match !== 'object' || Array.isArray(match)) continue;
        console.log(`[${match.index}] ${match.context}`);
      }
      if (result.truncated === true) console.log('... [truncated]');
    });
  }));

program.command('find <selector>')
  .description('Inspect bounded metadata for CSS-matched elements')
  .option('-l, --limit <n>', 'maximum elements to return', '20')
  .option('--attributes <names>', 'comma-separated attribute names')
  .option('--no-shadow', 'do not query open shadow roots')
  .addHelpText('after', '\nExamples:\n  bp find "[role=option]"\n  bp find "a.result" --attributes href,data-testid')
  .action(action(async (selector, opts) => {
    const limit = parseLimit(opts.limit);
    const attributeNames = typeof opts.attributes === 'string'
      ? opts.attributes.split(',').map((name: string) => name.trim()).filter(Boolean)
      : undefined;
    await withCliTarget(async (client, target) => {
      const result = await client.callTool('browser.elements.find', {
        selector,
        limit,
        ...(attributeNames ? { attributeNames } : {}),
        ...(opts.shadow === false ? { pierceShadow: false } : {}),
      }, target.targetId);
      if (useJson()) {
        console.log(JSON.stringify({ ok: true, ...result }));
        return;
      }
      const elements = Array.isArray(result.elements) ? result.elements : [];
      if (elements.length === 0) console.log('(no matching elements)');
      for (const element of elements) {
        if (!element || typeof element !== 'object' || Array.isArray(element)) continue;
        const state = `${element.visible === true ? 'visible' : 'hidden'}, ${element.enabled === true ? 'enabled' : 'disabled'}`;
        console.log(`[${element.index}] <${element.tagName}> ${element.role || ''} "${element.name || ''}" (${state})`);
      }
      if (result.truncated === true) console.log('... [truncated]');
    });
  }));

// ─── scroll ────────────────────────────────────────

program.command('scroll [direction]')
  .description('Scroll the page, an element, or matching text')
  .option('--amount <n>', 'distance in pixels or viewport units')
  .option('--unit <unit>', 'pixels or viewport', 'viewport')
  .option('--selector <selector>', 'scroll a CSS-selected container')
  .option('--ref <ref>', 'scroll an element from the latest snapshot')
  .option('--to <position>', 'scroll to start or end')
  .option('--to-text <text>', 'scroll the first visible text match into view')
  .option('--exact', 'require an exact text match with --to-text')
  .option('-l, --limit <n>', 'max elements in returned snapshot', '50')
  .addHelpText('after', `
Examples:
  bp scroll down
  bp scroll up --amount 400 --unit pixels
  bp scroll down --selector ".results"
  bp scroll --ref 8 --to end
  bp scroll --to-text "Payment details"`)
  .action(action(async (direction, opts) => {
    if (opts.selector && opts.ref) throw new Error('--selector and --ref are mutually exclusive');
    const modes = [direction !== undefined, opts.to !== undefined, opts.toText !== undefined].filter(Boolean).length;
    if (modes > 1) throw new Error('Use only one of direction, --to, or --to-text');
    const validDirections = new Set(['up', 'down', 'left', 'right']);
    if (direction !== undefined && !validDirections.has(direction)) throw new Error('direction must be up, down, left, or right');
    if (opts.to !== undefined && !['start', 'end'].includes(opts.to)) throw new Error('--to must be start or end');
    if (!['pixels', 'viewport'].includes(opts.unit)) throw new Error('--unit must be pixels or viewport');
    const amount = opts.amount === undefined ? undefined : Number(opts.amount);
    if (amount !== undefined && (!Number.isFinite(amount) || amount <= 0)) throw new Error('--amount must be a positive number');
    const limit = parseLimit(opts.limit);
    await withCliTarget(async (client, target) => {
      const rawTarget = opts.selector ?? opts.ref;
      const address = rawTarget ? await cliElementAddress(client, target, String(rawTarget)) : undefined;
      const result = await client.callTool('browser.scroll', {
        ...(address ? { target: address } : {}),
        ...(direction ? { direction } : {}),
        ...(amount !== undefined ? { amount } : {}),
        unit: opts.unit,
        ...(opts.to ? { position: opts.to } : {}),
        ...(opts.toText ? { text: opts.toText, exact: opts.exact === true } : {}),
        observationLimit: limit,
      }, target.targetId);
      emitObservation(result);
    });
  }));

// ─── dropdowns ─────────────────────────────────────

program.command('dropdown <target>')
  .description('List native or ARIA dropdown options by ref or CSS selector')
  .addHelpText('after', '\nExamples:\n  bp dropdown 4\n  bp dropdown "select[name=country]"')
  .action(action(async (rawTarget) => {
    await withCliTarget(async (client, target) => {
      const result = await client.callTool('browser.dropdown.options', {
        target: await cliElementAddress(client, target, rawTarget),
      }, target.targetId);
      if (useJson()) {
        console.log(JSON.stringify({ ok: true, ...result }));
        return;
      }
      const options = Array.isArray(result.options) ? result.options : [];
      console.log(`[${result.kind}]${result.requiresOpen === true ? ' open required' : ''}`);
      if (options.length === 0) console.log('(no exposed options)');
      for (const option of options) {
        if (!option || typeof option !== 'object' || Array.isArray(option)) continue;
        console.log(`${option.selected === true ? '*' : ' '} ${option.index}  ${option.label}  value=${JSON.stringify(option.value)}`);
      }
      if (result.truncated === true) console.log('... [truncated]');
    });
  }));

program.command('select <target> <option>')
  .description('Select and verify a dropdown option')
  .option('--by <mode>', 'match by label, value, or index', 'label')
  .option('--contains', 'use case-insensitive substring matching')
  .option('-l, --limit <n>', 'max elements in returned snapshot', '50')
  .addHelpText('after', '\nExamples:\n  bp select 4 "United States"\n  bp select 4 us --by value\n  bp select 4 3 --by index')
  .action(action(async (rawTarget, rawOption, opts) => {
    if (!['label', 'value', 'index'].includes(opts.by)) throw new Error('--by must be label, value, or index');
    const choice: Record<string, JsonValue> = opts.by === 'index'
      ? { by: 'index', index: parseRef(rawOption) }
      : { by: opts.by, [opts.by]: rawOption, exact: opts.contains !== true };
    const limit = parseLimit(opts.limit);
    await withCliTarget(async (client, target) => {
      const result = await client.callTool('browser.dropdown.select', {
        target: await cliElementAddress(client, target, rawTarget),
        choice,
        observationLimit: limit,
      }, target.targetId);
      emitObservation(result);
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
    await withCliTarget(async (client, target) => {
      const artifact = await client.importArtifact(absPath);
      try {
        const result = await client.callTool('browser.upload', {
          artifactId: artifact.id,
          inputIndex,
          observationLimit: 50,
        }, target.targetId);
        emitObservation(result);
      } finally {
        await client.releaseArtifact(artifact.id).catch(() => {});
      }
    });
  }));

// ─── screenshot ─────────────────────────────────────

program.command('screenshot [filename]')
  .description('Capture screenshot')
  .option('-f, --full', 'capture full page')
  .option('--selector <sel>', 'capture specific element')
  .option('--annotate [refs]', 'draw Observation ref boxes; optionally comma-separated refs')
  .addHelpText('after', '\nExamples:\n  bp screenshot\n  bp screenshot page.png\n  bp screenshot --full\n  bp screenshot --selector ".chart"\n  bp screenshot page.png --annotate\n  bp screenshot page.png --annotate 1,3,8')
  .action(action(async (filename, opts) => {
    if (opts.annotate !== undefined && (opts.full || opts.selector)) {
      throw new Error('--annotate cannot be combined with --full or --selector');
    }
    await withCliTarget(async (client, target) => {
      let annotations: Record<string, JsonValue> | undefined;
      if (opts.annotate !== undefined) {
        const refs = typeof opts.annotate === 'string'
          ? opts.annotate.split(',').map((value: string) => parseRef(value.trim()))
          : undefined;
        annotations = {
          observationId: await client.latestObservation(target.targetId),
          ...(refs ? { refs } : {}),
        };
      }
      const result = await client.callTool('browser.capture', {
        fullPage: opts.full,
        ...(opts.selector ? { selector: opts.selector } : {}),
        ...(annotations ? { annotations } : {}),
        includeOriginal: true,
      }, target.targetId);
      const artifact = artifactFrom(result);
      const file = filename ?? `screenshot-${new Date().toISOString().replace(/[:.]/g, '-').slice(0, -5)}.png`;
      const outputPath = resolvePath(file);
      try {
        await client.exportArtifact(artifact.id, outputPath);
      } finally {
        await client.releaseArtifact(artifact.id).catch(() => {});
        if (result.preview && typeof result.preview === 'object' && !Array.isArray(result.preview)) {
          const preview = result.preview as unknown as ArtifactDescriptor;
          await client.releaseArtifact(preview.id).catch(() => {});
        }
      }
      emit({
        ok: true,
        file: outputPath,
        ...(typeof result.annotationCount === 'number' ? { annotationCount: result.annotationCount } : {}),
      }, `\u2713 Screenshot saved to ${outputPath}`);
    });
  }));

// ─── pdf ────────────────────────────────────────────

program.command('pdf [filename]')
  .description('Save page as PDF')
  .option('--landscape', 'landscape orientation')
  .addHelpText('after', '\nExamples:\n  bp pdf\n  bp pdf report.pdf\n  bp pdf report.pdf --landscape')
  .action(action(async (filename, opts) => {
    await withCliTarget(async (client, target) => {
      const result = await client.callTool('browser.pdf', {
        ...(opts.landscape ? { landscape: true } : {}),
      }, target.targetId);
      const artifact = artifactFrom(result);
      const file = filename ?? `page-${new Date().toISOString().replace(/[:.]/g, '-').slice(0, -5)}.pdf`;
      const outputPath = resolvePath(file);
      try {
        await client.exportArtifact(artifact.id, outputPath);
      } finally {
        await client.releaseArtifact(artifact.id).catch(() => {});
      }
      emit({ ok: true, file: outputPath }, `\u2713 PDF saved to ${outputPath}`);
    });
  }));

// ─── cookies ────────────────────────────────────────

program.command('cookies [domain]')
  .description('View cookies (CDP-only, includes HttpOnly)')
  .addHelpText('after', '\nExamples:\n  bp cookies\n  bp cookies github.com')
  .action(action(async (domain) => {
    await withCliTarget(async (client, target) => {
      const result = await client.callTool('browser.cookies.list', {
        ...(domain ? { domain } : {}),
      }, target.targetId);
      const cookies = Array.isArray(result.cookies) ? result.cookies as Array<Record<string, JsonValue>> : [];
      if (useJson()) {
        console.log(JSON.stringify({ ok: true, cookies }));
      } else if (cookies.length === 0) {
        console.log('No cookies found.');
      } else {
        for (const c of cookies) {
          const expires = Number(c.expires);
          const exp = expires === -1 ? 'Session' : new Date(expires * 1000).toISOString().slice(0, 10);
          console.log(`${String(c.name ?? '').padEnd(30)} ${String(c.domain ?? '').padEnd(25)} ${exp}`);
        }
      }
    });
  }));

// ─── frame ──────────────────────────────────────────

program.command('frame [target]')
  .description('List frames, or switch to a frame by index (0=top)')
  .addHelpText('after', '\nExamples:\n  bp frame          # list all frames\n  bp frame 1        # switch eval context to frame 1\n  bp frame 0        # switch back to top frame')
  .action(action(async (target) => {
    await withCliTarget(async (client, controlledTarget) => {
      const result = await client.callTool('browser.frames.list', {}, controlledTarget.targetId);
      const frames = Array.isArray(result.frames)
        ? result.frames as Array<Record<string, JsonValue>>
        : [];
      if (target === undefined) {
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
        if (!Number.isSafeInteger(idx) || idx < 0 || idx >= frames.length) {
          throw new Error(`Frame index out of range (0-${Math.max(0, frames.length - 1)})`);
        }
        const frame = frames[idx];
        await client.callTool('browser.frames.switch', idx === 0
          ? { top: true }
          : { frameId: requireString(frame.frameId, 'frameId') }, controlledTarget.targetId);
        emit(
          { ok: true, frame: idx, url: frame.url },
          `\u2713 Switched to frame ${idx}: ${frame.url}`,
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
    const client = await requireCompatibility();
    if (opts.clear || !username) {
      await client.callTool('browser.auth.clear');
      emit({ ok: true }, '\u2713 Auth credentials cleared');
      return;
    }
    if (!password) throw new Error('Usage: bp auth <username> <password>');
    await client.callTool('browser.auth.set', { username, password });
    emit({ ok: true }, '\u2713 Auth credentials set (scoped to HTTP 401 challenges)');
  }));

// ─── dialogs ────────────────────────────────────────

program.command('dialogs')
  .description('List pending JavaScript dialogs')
  .action(action(async () => {
    const result = await (await requireCompatibility()).callTool('browser.dialogs.list');
    const dialogs = Array.isArray(result.dialogs)
      ? result.dialogs as Array<Record<string, JsonValue>>
      : [];
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
    const client = await requireCompatibility();
    const listed = await client.callTool('browser.dialogs.list');
    const dialog = (Array.isArray(listed.dialogs) ? listed.dialogs : [])
      .find(candidate => candidate && typeof candidate === 'object' && !Array.isArray(candidate) && candidate.dialogId === dialogId);
    if (!dialog || Array.isArray(dialog) || typeof dialog !== 'object') {
      throw new BrowserPilotError('invalid_argument', 'Dialog is not pending', {
        context: { field: 'dialogId', dialogId },
      });
    }
    const result = await client.callTool('browser.dialogs.respond', {
      dialogId,
      action: opts.accept ? 'accept' : 'dismiss',
      ...(opts.prompt !== undefined ? { promptText: opts.prompt } : {}),
    }, requireString(dialog.targetId, 'dialog targetId') as ControlledTargetId);
    emit(
      { ok: true, dialogId: result.dialogId, action: result.action },
      `\u2713 ${result.action === 'accept' ? 'Accepted' : 'Dismissed'} dialog ${result.dialogId}`,
    );
  }));

// ─── tabs ───────────────────────────────────────────

program.command('tabs')
  .description('List all controllable browser tabs')
  .action(action(async () => {
    const targets = await (await requireCompatibility()).listTabs('all');
    const tabs = targets.map(({ targetId: _targetId, managedTabSetId: _managedTabSetId, controlState, ...tab }, index) => ({
      index,
      ...tab,
      controlState,
    }));

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
    const client = await requireCompatibility();
    const index = parseInt(indexStr, 10);
    const targets = await client.listTabs('all');
    if (!Number.isSafeInteger(index) || index < 0 || index >= targets.length) {
      throw new Error(`Tab index out of range (0-${Math.max(0, targets.length - 1)})`);
    }
    await client.callTool('browser.tabs.switch', { targetId: targets[index].targetId });
    emit({ ok: true, index }, `\u2713 Switched to tab ${index}`);
  }));

// ─── close ──────────────────────────────────────────

program.command('close')
  .description('Close current browser tab')
  .option('-a, --all', 'close all tabs in the current Pilot window')
  .action(action(async (opts) => {
    const client = await requireCompatibility();
    if (opts.all) {
      const managed = await client.listTabs('managed_only');
      const failed: ControlledTargetId[] = [];
      let closed = 0;
      for (const target of managed) {
        try {
          await client.callTool('browser.tabs.close', {}, target.targetId);
          closed += 1;
        } catch {
          failed.push(target.targetId);
        }
      }
      const remainingTabs = await client.listTabs('all');
      if (failed.length > 0) {
        throw new BrowserPilotError('internal_error', `Failed to close ${failed.length} Pilot tab(s)`, {
          retryable: true,
          context: { failedTargetIds: failed },
        });
      }
      if (remainingTabs.length > 0 && !remainingTabs.some(tab => tab.active)) {
        await client.callTool('browser.tabs.switch', { targetId: remainingTabs[0].targetId });
      }
      emit(
        { ok: true, closed, remaining: remainingTabs.length },
        `\u2713 Closed ${closed} Pilot tab(s)`,
      );
    } else {
      const target = await client.ensureTarget();
      await client.callTool('browser.tabs.close', {}, target.targetId);
      const remainingTabs = await client.listTabs('all');
      if (remainingTabs.length > 0) {
        if (!remainingTabs.some(tab => tab.active)) {
          const fallback = remainingTabs.find(tab => tab.origin !== 'user_tab') ?? remainingTabs[0];
          await client.callTool('browser.tabs.switch', { targetId: fallback.targetId });
        }
        emit({ ok: true, remaining: remainingTabs.length }, '\u2713 Tab closed');
      } else {
        emit({ ok: true, remaining: 0 }, '\u2713 Last tab closed');
      }
    }
  }));

// ─── net (network monitoring & interception) ────────

function networkRequests(result: Record<string, JsonValue>): Array<Record<string, JsonValue>> {
  return Array.isArray(result.requests)
    ? result.requests as Array<Record<string, JsonValue>>
    : [];
}

function cliNetworkRequest(request: Record<string, JsonValue>): Record<string, JsonValue> {
  return {
    id: request.sequence,
    method: request.method,
    url: request.url,
    ...(request.status !== undefined ? { status: request.status } : {}),
    type: request.type,
    ...(request.size !== undefined ? { size: request.size } : {}),
    ...(request.durationMs !== undefined ? { time: request.durationMs } : {}),
    ...(request.error !== undefined ? { error: request.error } : {}),
  };
}

async function findNetworkRequest(
  client: CompatibilityBrokerClient,
  sequence: number,
): Promise<Record<string, JsonValue>> {
  if (!Number.isSafeInteger(sequence) || sequence < 1) {
    throw new Error('Request ID must be a positive integer');
  }
  const listed = await client.callTool('browser.network.requests', {
    after: sequence - 1,
    limit: 1,
  });
  const request = networkRequests(listed)[0];
  if (!request || request.sequence !== sequence) {
    throw new BrowserPilotError('invalid_argument', `Request #${sequence} not found`, {
      context: { field: 'id', sequence },
    });
  }
  return request;
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
    const client = await requireCompatibility();
    const limit = opts.limit ? parseInt(opts.limit, 10) : 20;
    const result = await client.callTool('browser.network.requests', {
      limit,
      ...(opts.url ? { url: opts.url } : {}),
      ...(opts.method ? { method: opts.method } : {}),
      ...(opts.status ? { status: opts.status } : {}),
      ...(opts.type ? { type: String(opts.type).split(',').map(value => value.trim()).filter(Boolean) } : {}),
      ...(opts.after ? { after: parseInt(opts.after, 10) } : {}),
    });
    const requests = networkRequests(result).map(cliNetworkRequest);

    if (useJson()) {
      console.log(JSON.stringify({
        ok: true,
        requests,
        total: requests.length,
        truncated: result.truncated === true,
        nextCursor: result.nextCursor,
      }));
    } else if (requests.length === 0) {
      console.log('No requests captured.');
    } else {
      console.log(` ${'#'.padStart(4)}  ${'METHOD'.padEnd(7)} ${'STATUS'.padEnd(7)} ${'TYPE'.padEnd(8)} ${'TIME'.padEnd(8)} URL`);
      for (const r of requests) {
        const time = r.time ? `${r.time}ms` : r.error ? 'FAIL' : '...';
        const status = r.status ? String(r.status) : r.error ? 'ERR' : '...';
        console.log(` ${String(r.id).padStart(4)}  ${String(r.method ?? '').padEnd(7)} ${status.padEnd(7)} ${String(r.type ?? '').padEnd(8)} ${time.padEnd(8)} ${r.url}`);
      }
    }
  }));

netCmd.command('show <id>')
  .description('Show full request/response details')
  .option('--save <file>', 'save response body to file')
  .action(action(async (idStr, opts) => {
    const client = await requireCompatibility();
    const id = parseInt(idStr, 10);
    const summary = await findNetworkRequest(client, id);
    const result = await client.callTool('browser.network.request', {
      requestId: requireString(summary.requestId, 'requestId'),
      includeBody: true,
    });
    const request = result.request && typeof result.request === 'object' && !Array.isArray(result.request)
      ? result.request as Record<string, JsonValue>
      : {};
    const responseBody = typeof result.body === 'string' ? result.body : undefined;

    if (opts.save) {
      if (responseBody === undefined) throw new Error(`Response body for request #${id} is unavailable`);
      const outputPath = resolvePath(opts.save);
      const bytes = result.bodyEncoding === 'base64'
        ? Buffer.from(responseBody, 'base64')
        : Buffer.from(responseBody, 'utf8');
      writeFileSync(outputPath, bytes);
      emit({ ok: true, file: outputPath }, `Saved to ${outputPath}`);
      return;
    }

    const detail: Record<string, any> = { id: request.sequence, ...request, responseBody };

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
    const client = await requireCompatibility();
    const result = await client.callTool('browser.network.rules.add', { type: 'block', pattern });
    const rule = { id: result.ruleId, type: 'block', pattern };
    emit({ ok: true, rule }, `Rule #${rule.id}: blocking "${pattern}"`);
  }));

netCmd.command('mock <pattern>')
  .description('Mock responses for matching URLs')
  .option('--body <json>', 'response body')
  .option('--file <path>', 'read body from file')
  .option('--status <code>', 'HTTP status', '200')
  .action(action(async (pattern, opts) => {
    const client = await requireCompatibility();
    let body = opts.body || '';
    if (opts.file) {
      const filePath = resolvePath(opts.file);
      if (!existsSync(filePath)) throw new Error(`File not found: ${filePath}`);
      body = readFileSync(filePath, 'utf-8');
    }
    const status = parseInt(opts.status, 10);
    const result = await client.callTool('browser.network.rules.add', {
      type: 'mock',
      pattern,
      status,
      body,
    });
    const rule = { id: result.ruleId, type: 'mock', pattern, status };
    emit({ ok: true, rule }, `Rule #${rule.id}: mocking "${pattern}" -> ${opts.status}`);
  }));

netCmd.command('headers <pattern> <header...>')
  .description('Add/override request headers for matching URLs')
  .action(action(async (pattern, headerStrs) => {
    const client = await requireCompatibility();
    const headers = headerStrs.map((h: string) => {
      const [name, ...rest] = h.split(':');
      return { name: name.trim(), value: rest.join(':').trim() };
    });
    const result = await client.callTool('browser.network.rules.add', {
      type: 'headers',
      pattern,
      headers,
    });
    const rule = { id: result.ruleId, type: 'headers', pattern, headers };
    emit({ ok: true, rule }, `Rule #${rule.id}: headers for "${pattern}"`);
  }));

netCmd.command('rules')
  .description('List active interception rules')
  .action(action(async () => {
    const result = await (await requireCompatibility()).callTool('browser.network.rules.list');
    const rules: Array<Record<string, JsonValue>> = (Array.isArray(result.rules) ? result.rules : []).map(value => {
      const rule = value as Record<string, JsonValue>;
      const { ruleId, ...rest } = rule;
      return { id: ruleId, ...rest };
    });
    if (useJson()) { console.log(JSON.stringify({ ok: true, rules })); }
    else if (rules.length === 0) { console.log('No active rules.'); }
    else { for (const r of rules) console.log(`  #${r.id}  ${String(r.type).toUpperCase()} "${r.pattern}"`); }
  }));

netCmd.command('remove [ruleId]')
  .description('Remove interception rule(s)')
  .option('-a, --all', 'remove all rules')
  .action(action(async (ruleId, opts) => {
    const client = await requireCompatibility();
    if (opts.all) {
      await client.callTool('browser.network.rules.remove', { all: true });
      emit({ ok: true }, 'All rules removed');
    }
    else if (ruleId) {
      await client.callTool('browser.network.rules.remove', { ruleId });
      emit({ ok: true }, `Rule #${ruleId} removed`);
    }
    else throw new Error('Specify a rule ID or use --all');
  }));

netCmd.command('clear')
  .description('Clear captured request log')
  .action(action(async () => {
    await (await requireCompatibility()).callTool('browser.network.clear');
    emit({ ok: true }, 'Request log cleared');
  }));

program.parse();
