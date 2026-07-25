import type { Transport } from '../transport.js';

export interface ManagedTargetCreateParams {
  url: string;
  newWindow?: boolean;
  windowId?: number;
}

export interface ManagedTargetLifecycle {
  createTarget(params: ManagedTargetCreateParams): Promise<{ targetId: string }>;
}

export class TransportManagedTargetLifecycle implements ManagedTargetLifecycle {
  constructor(private readonly transport: Transport) {}

  async createTarget(params: ManagedTargetCreateParams): Promise<{ targetId: string }> {
    return this.transport.send('Target.createTarget', params);
  }
}
