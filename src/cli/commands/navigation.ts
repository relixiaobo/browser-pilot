import type { Command } from 'commander';
import { invalidArgument } from '../../protocol/errors.js';
import type { CliCommandContext } from '../context.js';
import { normalizeUrl, parseLimit } from '../parse.js';

export function register(program: Command, ctx: CliCommandContext): void {
  const {
    action,
    requireCompatibility,
    resolveProfile: resolveCliProfile,
    withTarget: withCliTarget,
  } = ctx;
  const { emitObservation } = ctx.output;

program.command('open <url>')
  .description('Navigate to URL and return page snapshot')
  .option('-n, --new', 'open in new tab')
  .option('--profile <selector>', 'Profile index, ID, label, verified name, or email (requires --new)')
  .option('-l, --limit <n>', 'max elements in snapshot', '50')
  .addHelpText('after', '\nExamples:\n  bp open https://github.com\n  bp open github.com --new\n  bp open https://example.com --new --profile 1\n  bp open https://example.com --limit 20')
  .action(action(async (url, opts) => {
    url = normalizeUrl(url);
    const limit = parseLimit(opts.limit);
    if (opts.profile && !opts.new) throw invalidArgument('--profile requires --new', 'profile');
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

}

