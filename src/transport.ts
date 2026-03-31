export interface Transport {
  send(method: string, params?: Record<string, any>, sessionId?: string): Promise<any>;
  close(): void;
}
