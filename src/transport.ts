export type TransportConnectionState = 'connecting' | 'connected' | 'disconnected' | 'closed';

export interface TransportConnectionEvent {
  state: TransportConnectionState;
  previousState: TransportConnectionState;
  error?: Error;
}

export interface Transport {
  readonly connectionState?: TransportConnectionState;
  send(method: string, params?: Record<string, any>, sessionId?: string): Promise<any>;
  on?(method: string, handler: (params: any, sessionId?: string) => void): void;
  onConnectionState?(handler: (event: TransportConnectionEvent) => void): () => void;
  close(): void;
}
