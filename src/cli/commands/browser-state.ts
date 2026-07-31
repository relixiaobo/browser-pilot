import type { Command } from 'commander';
import { BrowserPilotError, invalidArgument } from '../../protocol/errors.js';
import type { ControlledTargetId, JsonValue } from '../../protocol/model.js';
import { serializeStructuralText } from '../../structural-text.js';
import type { CliCommandContext } from '../context.js';

function requireString(value: JsonValue | undefined, label: string): string {
  if (typeof value !== 'string') throw new BrowserPilotError('internal_error', `${label} is missing`);
  return value;
}

export function register(program: Command, ctx: CliCommandContext): void {
  const {
    action,
    requireCompatibility,
    withTarget: withCliTarget,
  } = ctx;
  const { emit, useJson } = ctx.output;

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
        emit({ ok: true, cookies });
      } else if (cookies.length === 0) {
        console.log('No cookies found.');
      } else {
        for (const c of cookies) {
          const expires = Number(c.expires);
          const exp = expires === -1 ? 'Session' : new Date(expires * 1000).toISOString().slice(0, 10);
          console.log(`${serializeStructuralText(c.name).padEnd(30)} ${serializeStructuralText(c.domain).padEnd(25)} ${exp}`);
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
          emit({ ok: true, frames: list });
        } else {
          for (const [i, f] of frames.entries()) {
            console.log(`${i === 0 ? '* ' : '  '}${i}  ${serializeStructuralText(f.url, 2_048)}  ${serializeStructuralText(f.name)}`);
          }
        }
      } else {
        const idx = Number(target);
        if (!Number.isSafeInteger(idx) || idx < 0 || idx >= frames.length) {
          throw invalidArgument(
            `Frame index out of range (0-${Math.max(0, frames.length - 1)})`,
            'target',
          );
        }
        const frame = frames[idx];
        await client.callTool('browser.frames.switch', idx === 0
          ? { top: true }
          : { frameId: requireString(frame.frameId, 'frameId') }, controlledTarget.targetId);
        emit(
          { ok: true, frame: idx, url: frame.url },
          `\u2713 Switched to frame ${idx}: ${serializeStructuralText(frame.url, 2_048)}`,
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
    if (!password) throw invalidArgument('Usage: bp auth <username> <password>', 'password');
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
      emit({ ok: true, dialogs });
    } else if (dialogs.length === 0) {
      console.log('No pending dialogs.');
    } else {
      for (const dialog of dialogs) {
        console.log(`${dialog.dialogId}  ${dialog.type}  ${serializeStructuralText(dialog.message)}`);
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
      throw invalidArgument('Choose exactly one of --accept or --dismiss', 'action');
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

}
