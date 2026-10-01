import type { LocalServerAccount } from './process-inspection';

/** Coordinates consent; process management remains governed by the ownership lease. */
export class ServerConnectionAdmission {
  private generation = 0;
  private admitted: { url: string; account: LocalServerAccount } | null = null;
  private operation: Promise<void> | null = null;
  private checkedAt = 0;
  private external = false;
  private streamOpened = false;

  constructor(
    private readonly getUrl: () => string,
    private readonly inspect: () => Promise<LocalServerAccount>,
    private readonly confirm: (account: LocalServerAccount, url: string) => Promise<boolean>
  ) {}

  get isExternal(): boolean {
    return this.external;
  }

  get verificationExpiresAt(): number {
    return this.admitted ? this.checkedAt + 1000 : 0;
  }

  reset() {
    this.generation += 1;
    this.admitted = null;
    this.checkedAt = 0;
    this.external = false;
    this.streamOpened = false;
    this.operation = null;
  }

  async admit() {
    if (this.operation) return this.operation;
    const generation = this.generation;
    const url = this.getUrl();
    const operation = (async () => {
      // A supplied Authorization header does not prove the server enforces it.
      const account = await this.inspect();
      const sameInstance =
        this.admitted?.url === url &&
        account.identity !== undefined &&
        account.identity === this.admitted.account.identity;
      if (account.kind !== 'same-user' && !sameInstance) {
        if (!(await this.confirm(account, url)))
          throw new Error('OpenCode connection cancelled; the existing server was left untouched');
        const verified = await this.inspect();
        if (verified.kind !== account.kind || verified.identity !== account.identity)
          throw new Error(
            'OpenCode listener changed while confirmation was open; reconnect to verify it'
          );
      }
      if (generation !== this.generation || url !== this.getUrl())
        throw new Error('OpenCode connection changed during verification');
      this.admitted = { url, account };
      this.external = account.kind !== 'same-user';
      this.checkedAt = Date.now();
    })();
    this.operation = operation;
    try {
      await operation;
    } catch (error) {
      if (generation === this.generation) this.admitted = null;
      throw error;
    } finally {
      if (this.operation === operation) this.operation = null;
    }
  }

  async verify(reconnect = false) {
    if (this.operation) await this.operation;
    if (!this.admitted || this.admitted.url !== this.getUrl())
      throw new Error('OpenCode connection has not been approved');
    if (reconnect && !this.streamOpened) {
      this.streamOpened = true;
      return;
    }
    if (reconnect || Date.now() - this.checkedAt >= 1000) {
      // An unverifiable listener's approval lasts only for the current connection.
      if (reconnect && this.admitted.account.kind === 'unknown') this.admitted = null;
      await this.admit();
    }
  }
}
