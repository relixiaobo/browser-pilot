import { randomUUID } from 'node:crypto';
import { invalidArgument } from '../protocol/errors.js';
import type { Transport } from '../transport.js';

export type CompatibilityDialogType = 'alert' | 'confirm' | 'prompt' | 'beforeunload';

export interface CompatibilityDialogDescriptor {
  dialogId: string;
  type: CompatibilityDialogType;
  message: string;
  defaultPrompt: string;
  url: string;
  openedAt: number;
}

interface PendingCompatibilityDialog extends CompatibilityDialogDescriptor {
  sessionId: string;
}

const DIALOG_TYPES = new Set<CompatibilityDialogType>([
  'alert',
  'confirm',
  'prompt',
  'beforeunload',
]);

/** Keeps the one-shot CLI dialog flow separate from Broker-owned sessions. */
export class CompatibilityDialogService {
  private readonly pending = new Map<string, PendingCompatibilityDialog>();
  private readonly pendingBySession = new Map<string, string>();

  constructor(
    private readonly transport: Transport,
    private readonly isBrokerSession: (sessionId: string) => boolean,
  ) {
    transport.on?.('Page.javascriptDialogOpening', (params: any, sessionId?: string) => {
      if (!sessionId || this.isBrokerSession(sessionId)) return;
      const type = params?.type as CompatibilityDialogType | undefined;
      if (!type || !DIALOG_TYPES.has(type)) return;

      this.removeBySession(sessionId);
      const dialog: PendingCompatibilityDialog = {
        dialogId: `dialog:${randomUUID()}`,
        sessionId,
        type,
        message: typeof params.message === 'string' ? params.message : '',
        defaultPrompt: typeof params.defaultPrompt === 'string' ? params.defaultPrompt : '',
        url: typeof params.url === 'string' ? params.url : '',
        openedAt: Date.now(),
      };
      this.pending.set(dialog.dialogId, dialog);
      this.pendingBySession.set(sessionId, dialog.dialogId);
    });

    transport.on?.('Page.javascriptDialogClosed', (_params: any, sessionId?: string) => {
      if (sessionId) this.removeBySession(sessionId);
    });
    transport.on?.('Target.detachedFromTarget', (params: any) => {
      if (typeof params?.sessionId === 'string') this.removeBySession(params.sessionId);
    });
  }

  list(): CompatibilityDialogDescriptor[] {
    return [...this.pending.values()]
      .sort((left, right) => left.openedAt - right.openedAt)
      .map(({ sessionId: _sessionId, ...dialog }) => dialog);
  }

  clear(): void {
    this.pending.clear();
    this.pendingBySession.clear();
  }

  async respond(
    dialogId: string,
    action: 'accept' | 'dismiss',
    promptText?: string,
  ): Promise<CompatibilityDialogDescriptor & { action: 'accept' | 'dismiss' }> {
    const dialog = this.pending.get(dialogId);
    if (!dialog) throw invalidArgument('Dialog is not pending', 'dialogId');
    if (promptText !== undefined && dialog.type !== 'prompt') {
      throw invalidArgument('prompt is valid only for prompt dialogs', 'prompt');
    }

    await this.transport.send('Page.handleJavaScriptDialog', {
      accept: action === 'accept',
      ...(promptText !== undefined ? { promptText } : {}),
    }, dialog.sessionId);
    this.remove(dialog);
    const { sessionId: _sessionId, ...descriptor } = dialog;
    return { ...descriptor, action };
  }

  private removeBySession(sessionId: string): void {
    const dialogId = this.pendingBySession.get(sessionId);
    const dialog = dialogId ? this.pending.get(dialogId) : undefined;
    if (dialog) this.remove(dialog);
  }

  private remove(dialog: PendingCompatibilityDialog): void {
    this.pending.delete(dialog.dialogId);
    if (this.pendingBySession.get(dialog.sessionId) === dialog.dialogId) {
      this.pendingBySession.delete(dialog.sessionId);
    }
  }
}
