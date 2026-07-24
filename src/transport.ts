export interface Transport {
  send(method: string, params?: Record<string, any>, sessionId?: string): Promise<any>;
  on?(method: string, handler: (params: any, sessionId?: string) => void): void;
  close(): void;
}
