import { Command, CommanderError } from 'commander';
import { BROWSER_PILOT_VERSION as PKG_VERSION } from './version.js';
import { BrowserPilotError } from './protocol/errors.js';
import { createCliCommandContext } from './cli/context.js';
import { createCliOutput } from './cli/output.js';
import { register as registerBrowserState } from './cli/commands/browser-state.js';
import { register as registerConnection } from './cli/commands/connection.js';
import { register as registerFiles } from './cli/commands/files.js';
import { register as registerInteraction } from './cli/commands/interaction.js';
import { register as registerNavigation } from './cli/commands/navigation.js';
import { register as registerNetwork } from './cli/commands/network.js';
import { register as registerTabs } from './cli/commands/tabs.js';

const program = new Command();
program.exitOverride();
program
  .name('bp')
  .description('Control your browser from the command line')
  .version(PKG_VERSION)
  .option('--human', 'force human-readable output (default when TTY)')
  .option('--client-key <key>', 'stable namespace for Agent browser state')
  .option('--request-id <id>', 'stable host request ID for safe retry recovery')
  .option('--timeout <ms>', 'browser command deadline in milliseconds', '60000')
  .addHelpText('after', `
Workflow:
  bp status                           # inspect connection state without requesting authorization
  bp browsers                         # inspect browser setup without requesting authorization
  bp connect --browser <id>           # connect once after setup (click Allow in Chrome if prompted)
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
  Errors return:  {"ok":false, "error":"...", "code":"...", "retryable":false}

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

const cliAbortController = new AbortController();
let receivedSignal: NodeJS.Signals | undefined;
for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.once(signal, () => {
    receivedSignal = signal;
    cliAbortController.abort();
    const fallback = setTimeout(() => process.exit(signal === 'SIGINT' ? 130 : 143), 2_000);
    fallback.unref();
  });
}

const output = createCliOutput(program, () => receivedSignal);
const context = createCliCommandContext({
  program,
  version: PKG_VERSION,
  signal: cliAbortController.signal,
  output,
});

registerConnection(program, context);
registerNavigation(program, context);
registerInteraction(program, context);
registerFiles(program, context);
registerBrowserState(program, context);
registerTabs(program, context);
registerNetwork(program, context);

async function main(): Promise<void> {
  try {
    await program.parseAsync();
  } catch (error) {
    if (error instanceof CommanderError) {
      if (error.exitCode === 0) {
        process.exitCode = 0;
      } else if (output.useJson()) {
        const message = error.message.replace(/^error:\s*/i, '');
        const stable = new BrowserPilotError('invalid_argument', message, {
          context: { parserCode: error.code },
        });
        output.fail(message, undefined, stable);
      } else {
        process.exitCode = error.exitCode;
      }
    } else {
      const message = error instanceof Error ? error.message : String(error);
      output.fail(
        message,
        undefined,
        error instanceof BrowserPilotError ? error : undefined,
      );
    }
  }
}

void main();
