import type { Command } from 'commander';
import type {
  CompatibilityBrokerClient,
  CompatibilityTarget,
} from '../../compatibility-broker-client.js';
import { BrowserPilotError, invalidArgument } from '../../protocol/errors.js';
import type { JsonValue } from '../../protocol/model.js';
import { serializeStructuralText } from '../../structural-text.js';
import type { CliCommandContext } from '../context.js';
import { parseCoordinates, parseLimit, parseNonNegativeInteger, parseRef } from '../parse.js';

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
  if (!raw.trim()) throw invalidArgument('Element target must not be empty', 'target');
  return { selector: raw };
}

export function register(program: Command, ctx: CliCommandContext): void {
  const {
    action,
    readStdin,
    withTarget: withCliTarget,
  } = ctx;
  const { emit, emitObservation, fail, useJson } = ctx.output;

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
    if (opts.double && opts.right) {
      throw invalidArgument('--double and --right are mutually exclusive', 'button');
    }
    if (!ref && !opts.xy) throw invalidArgument('Provide a ref number or --xy coordinates', 'target');
    if (ref && opts.xy) throw invalidArgument('Provide either a ref number or --xy, not both', 'target');
    const limit = parseLimit(opts.limit);
    const coordinates = opts.xy ? parseCoordinates(opts.xy) : undefined;
    const parsedRef = ref ? parseRef(ref) : undefined;
    await withCliTarget(async (client, controlledTarget) => {
      let target: Record<string, JsonValue>;
      if (coordinates) {
        target = coordinates;
      } else {
        target = {
          observationId: await client.latestObservation(controlledTarget.targetId),
          ref: parsedRef!,
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
        emit({
          ok: true,
          x: coords.x,
          y: coords.y,
          top: coords.top,
          left: coords.left,
          width: coords.width,
          height: coords.height,
        });
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
    const parsedRef = parseRef(ref);
    await withCliTarget(async (client, target) => {
      const result = await client.callTool('browser.type', {
        observationId: await client.latestObservation(target.targetId),
        ref: parsedRef,
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
    const delay = opts.delay
      ? parseNonNegativeInteger(opts.delay, '--delay must be a non-negative integer', 'delay')
      : 0;
    await withCliTarget(async (client, target) => {
      const result = await client.callTool('browser.keyboard', {
        text,
        ...(opts.clear ? { clear: true } : {}),
        ...(opts.submit ? { submit: true } : {}),
        delayMs: delay,
        ...(opts.click ? { focusSelector: opts.click } : {}),
        observationLimit: limit,
      }, target.targetId);
      emitObservation(result);
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
  .addHelpText('after', '\nThis is the escape hatch — anything JS can do, eval can do. It runs in the page\'s main JavaScript world, where page scripts may modify globals.\n\nExamples:\n  bp eval "document.title"\n  bp eval "history.back()"\n  bp eval "window.scrollBy(0, 500)"\n  bp eval "document.querySelector(\'h1\').textContent"\n  echo \'complex js\' | bp eval')
  .action(action(async (expression) => {
    if (!expression) {
      expression = await readStdin();
      if (!expression) {
        throw invalidArgument('No expression. Pass as argument or pipe via stdin.', 'expression');
      }
    }
    await withCliTarget(async (client, target) => {
      const result = await client.callTool('browser.eval', {
        expression,
        awaitPromise: true,
      }, target.targetId);
      const value = result.value;
      if (useJson()) {
        emit({ ok: true, value, truncated: result.truncated === true });
      } else if (value !== undefined) {
        emit({}, typeof value === 'object' ? JSON.stringify(value, null, 2) : String(value));
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
    const limit = parseLimit(opts.limit);
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
        emit({ ok: true, title: data.title, url: data.url, text: data.text, length: data.length, truncated: data.truncated });
      } else {
        console.log(`${serializeStructuralText(data.title)}\n${serializeStructuralText(data.url, 2_048)}\n${'─'.repeat(60)}\n${data.text}${data.truncated === true ? '\n... [truncated]' : ''}`);
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
        emit({ ok: true, ...result });
        return;
      }
      const matches = Array.isArray(result.matches) ? result.matches : [];
      console.log(`${serializeStructuralText(result.title)}\n${serializeStructuralText(result.url, 2_048)}\n${'─'.repeat(60)}`);
      if (matches.length === 0) console.log('(no matches)');
      for (const match of matches) {
        if (!match || typeof match !== 'object' || Array.isArray(match)) continue;
        console.log(`[${match.index}] ${serializeStructuralText(match.context)}`);
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
        emit({ ok: true, ...result });
        return;
      }
      const elements = Array.isArray(result.elements) ? result.elements : [];
      if (elements.length === 0) console.log('(no matching elements)');
      for (const element of elements) {
        if (!element || typeof element !== 'object' || Array.isArray(element)) continue;
        const state = `${element.visible === true ? 'visible' : 'hidden'}, ${element.enabled === true ? 'enabled' : 'disabled'}`;
        console.log(`[${element.index}] <${serializeStructuralText(element.tagName, 128)}> ${serializeStructuralText(element.role || '', 128)} "${serializeStructuralText(element.name || '')}" (${state})`);
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
    if (opts.selector && opts.ref) {
      throw invalidArgument('--selector and --ref are mutually exclusive', 'target');
    }
    const modes = [direction !== undefined, opts.to !== undefined, opts.toText !== undefined].filter(Boolean).length;
    if (modes > 1) throw invalidArgument('Use only one of direction, --to, or --to-text', 'mode');
    const validDirections = new Set(['up', 'down', 'left', 'right']);
    if (direction !== undefined && !validDirections.has(direction)) {
      throw invalidArgument('direction must be up, down, left, or right', 'direction');
    }
    if (opts.to !== undefined && !['start', 'end'].includes(opts.to)) {
      throw invalidArgument('--to must be start or end', 'to');
    }
    if (!['pixels', 'viewport'].includes(opts.unit)) {
      throw invalidArgument('--unit must be pixels or viewport', 'unit');
    }
    const amount = opts.amount === undefined ? undefined : Number(opts.amount);
    if (amount !== undefined && (!Number.isFinite(amount) || amount <= 0)) {
      throw invalidArgument('--amount must be a positive number', 'amount');
    }
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
        emit({ ok: true, ...result });
        return;
      }
      const options = Array.isArray(result.options) ? result.options : [];
      console.log(`[${result.kind}]${result.requiresOpen === true ? ' open required' : ''}`);
      if (options.length === 0) console.log('(no exposed options)');
      for (const option of options) {
        if (!option || typeof option !== 'object' || Array.isArray(option)) continue;
        console.log(`${option.selected === true ? '*' : ' '} ${option.index}  ${serializeStructuralText(option.label)}  value="${serializeStructuralText(option.value)}"`);
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
    if (!['label', 'value', 'index'].includes(opts.by)) {
      throw invalidArgument('--by must be label, value, or index', 'by');
    }
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

}
