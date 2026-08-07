import type { Command } from 'commander';
import { BrowserPilotError } from '../protocol/errors.js';
import type { JsonValue } from '../protocol/model.js';
import { serializeStructuralText } from '../structural-text.js';

interface CliObservationElement {
  ref: number;
  role: string;
  name: string;
  value?: string;
  checked?: boolean;
}

interface CliSiteEntry {
  status: 'full' | 'seen' | 'invalid';
  name?: string;
  summary?: string;
  path?: string;
  reason?: string;
  body?: string;
}

/**
 * Human mode summarises site knowledge; the full body is only worth printing
 * for the JSON consumer that acts on it.
 */
function renderSiteEntry(entry: CliSiteEntry): string {
  if (entry.status === 'invalid') {
    return `[site] unusable ${serializeStructuralText(entry.path ?? '', 512)} - ${serializeStructuralText(entry.reason ?? '')}`;
  }
  const name = serializeStructuralText(entry.name ?? '', 128);
  const summary = serializeStructuralText(entry.summary ?? '');
  const detail = entry.status === 'full'
    ? `${entry.body ? `${Buffer.byteLength(entry.body, 'utf8')} bytes` : 'empty'} inlined`
    : serializeStructuralText(entry.path ?? '', 512);
  return `[site] ${name} "${summary}" (${entry.status}: ${detail})`;
}

export interface CliOutput {
  useJson(): boolean;
  emit(data: Record<string, any>, human?: string): void;
  fail(error: string, hint?: string, details?: BrowserPilotError): never;
  emitObservation(result: Record<string, JsonValue>): void;
}

export function createCliOutput(
  program: Command,
  receivedSignal: () => NodeJS.Signals | undefined,
): CliOutput {
  const useJson = (): boolean => {
    if (program.opts().human) return false;
    return !process.stdout.isTTY;
  };

  const emit = (data: Record<string, any>, human?: string): void => {
    if (useJson()) console.log(JSON.stringify(data));
    else if (human) console.log(human);
  };

  const fail = (error: string, hint?: string, details?: BrowserPilotError): never => {
    const stable = details ?? new BrowserPilotError('internal_error', error);
    if (useJson()) emit({
      ok: false,
      error,
      code: stable.code,
      retryable: stable.retryable,
      ...(hint ? { hint } : {}),
      ...(stable.context ? { context: stable.context } : {}),
      ...(stable.remediation ? { remediation: stable.remediation } : {}),
    });
    else {
      const guidance = hint ?? stable.remediation?.message;
      console.error(`\u2717 ${error}${guidance ? `\n  action: ${guidance}` : ''}`);
    }
    const signal = receivedSignal();
    process.exit(signal === 'SIGINT' ? 130 : signal === 'SIGTERM' ? 143 : 1);
  };

  const emitObservation = (result: Record<string, JsonValue>): void => {
    const title = String(result.title ?? '');
    const url = String(result.url ?? '');
    const elements = Array.isArray(result.elements)
      ? result.elements as unknown as CliObservationElement[]
      : [];
    const truncated = result.truncated === true;
    const truncationReasons = Array.isArray(result.truncationReasons)
      ? result.truncationReasons
      : [];
    if (useJson()) {
      emit({
        ok: true,
        title,
        url,
        ...(result.page && typeof result.page === 'object' ? { page: result.page } : {}),
        elements,
        truncated,
        truncationReasons,
        ...(Array.isArray(result.hints) ? { hints: result.hints } : {}),
        ...(Array.isArray(result.site) ? { site: result.site } : {}),
        ...(result.evidence && typeof result.evidence === 'object' ? { evidence: result.evidence } : {}),
        ...(typeof result.profileContextId === 'string'
          ? { profileContextId: result.profileContextId }
          : {}),
      });
      return;
    }

    const lines = [
      `[page] ${serializeStructuralText(title)} | ${serializeStructuralText(url, 2_048)}`,
      '',
    ];
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
        let line = `[${element.ref}] ${serializeStructuralText(element.role, 128)} "${serializeStructuralText(element.name)}"`;
        if (element.value !== undefined && element.value !== '') {
          line += ` value="${serializeStructuralText(element.value)}"`;
        }
        if (element.checked) line += ' checked';
        lines.push(line);
      }
    }
    const site = Array.isArray(result.site) ? result.site as unknown as CliSiteEntry[] : [];
    if (site.length > 0) {
      lines.push('');
      for (const entry of site) lines.push(renderSiteEntry(entry));
    }
    const suffix = truncated
      ? `\n\n[truncated: ${truncationReasons.join(', ')}]`
      : '';
    console.log(`${lines.join('\n')}${suffix}`);
  };

  program.configureOutput({
    writeErr: value => {
      if (!useJson()) process.stderr.write(value);
    },
  });

  return { useJson, emit, fail, emitObservation };
}
