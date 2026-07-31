import type { Command } from 'commander';
import { BrowserPilotError, invalidArgument } from '../../protocol/errors.js';
import type { ControlledTargetId } from '../../protocol/model.js';
import { serializeStructuralText } from '../../structural-text.js';
import type { CliCommandContext } from '../context.js';

export function register(program: Command, ctx: CliCommandContext): void {
  const { action, requireCompatibility } = ctx;
  const { emit, useJson } = ctx.output;

program.command('tabs')
  .description('List all controllable browser tabs')
  .action(action(async () => {
    const targets = await (await requireCompatibility()).listTabs('all');
    const tabs = targets.map(({ targetId: _targetId, managedTabSetId: _managedTabSetId, controlState, active, selected, ...tab }, index) => ({
      index: index + 1,
      ...tab,
      selected: selected ?? active === true,
      controlState,
    }));

    if (useJson()) {
      emit({ ok: true, tabs });
    } else if (tabs.length === 0) {
      console.log('No controllable tabs open.');
    } else {
      for (const t of tabs) {
        console.log(`${t.selected ? '*' : ' '} ${t.index}  ${serializeStructuralText(t.url, 2_048)}  ${serializeStructuralText(t.title)}`);
      }
    }
  }));

// ─── tab ────────────────────────────────────────────

program.command('tab <index>')
  .description('Select a tab by one-based index')
  .action(action(async (indexStr) => {
    const client = await requireCompatibility();
    const index = Number(indexStr);
    const targets = await client.listTabs('all');
    if (!Number.isSafeInteger(index) || index < 1 || index > targets.length) {
      throw invalidArgument(`Tab index out of range (1-${targets.length})`, 'index');
    }
    await client.callTool('browser.tabs.switch', { targetId: targets[index - 1].targetId });
    emit({ ok: true, index }, `\u2713 Selected tab ${index}`);
  }));

// ─── close ──────────────────────────────────────────

program.command('close')
  .description('Close current browser tab')
  .option('-a, --all', 'close all managed tabs in this Agent Workspace')
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
      emit(
        { ok: true, closed, remaining: remainingTabs.length },
        `\u2713 Closed ${closed} Pilot tab(s)`,
      );
    } else {
      const target = await client.ensureTarget();
      await client.callTool('browser.tabs.close', {}, target.targetId);
      const remainingTabs = await client.listTabs('all');
      if (remainingTabs.length > 0) {
        if (!remainingTabs.some(tab => tab.selected ?? tab.active === true)) {
          const fallback = remainingTabs.find(tab => tab.origin !== 'user_tab');
          if (fallback) await client.callTool('browser.tabs.switch', { targetId: fallback.targetId });
        }
        emit({ ok: true, remaining: remainingTabs.length }, '\u2713 Tab closed');
      } else {
        emit({ ok: true, remaining: 0 }, '\u2713 Last tab closed');
      }
    }
  }));
}
