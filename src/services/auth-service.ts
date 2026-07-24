import { invalidArgument } from '../protocol/errors.js';

export interface AuthController {
  setAuth(username: string, password: string): Promise<void>;
  clearAuth(): Promise<void>;
}

export class AuthService {
  constructor(private readonly controller: AuthController) {}

  async set(username: string, password: string): Promise<void> {
    if (!username) throw invalidArgument('HTTP auth username must not be empty', 'username');
    if (password === undefined) throw invalidArgument('HTTP auth password is required', 'password');
    await this.controller.setAuth(username, password);
  }

  async clear(): Promise<void> {
    await this.controller.clearAuth();
  }
}
