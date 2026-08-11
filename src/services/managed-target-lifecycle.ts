import type { Transport } from '../transport.js';

export interface ManagedTargetCreateParams {
  url: string;
  newWindow: true;
  browserContextId?: string;
}

export interface ManagedTargetLifecycle {
  createTarget(params: ManagedTargetCreateParams): Promise<{ targetId: string }>;
  adoptTarget(targetId: string): Promise<void>;
}

export class ManagedTargetCreationRejectedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ManagedTargetCreationRejectedError';
  }
}

export class TransportManagedTargetLifecycle implements ManagedTargetLifecycle {
  constructor(private readonly transport: Transport) {}

  async createTarget(params: ManagedTargetCreateParams): Promise<{ targetId: string }> {
    return this.transport.send('Target.createTarget', params);
  }

  async adoptTarget(targetId: string): Promise<void> {
    const result = await this.transport.send('Target.getTargetInfo', { targetId });
    if (result?.targetInfo?.targetId !== targetId) {
      throw new Error('Chrome returned invalid managed target metadata');
    }
  }
}
