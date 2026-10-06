import type { LocalServerAccount } from './process-inspection';
import { ProcessInspectionTimeoutError } from './process-inspection-error';

/** Coordinates consent; process management remains governed by the ownership lease. */
export class ServerConnectionAdmission {
  private generation = 0;
  private admitted: { url: string; account: LocalServerAccount; managed: boolean } | null = null;
  private operation: Promise<void> | null = null;
  private checkedAt = 0;
  private external = false;
  private streamOpened = false;
  private requiresUncertaintyConsent = false;

  constructor(
    private readonly getUrl: () => string,
    private readonly inspect: () => Promise<LocalServerAccount>,
    private readonly confirm: (account: LocalServerAccount, url: string) => Promise<boolean>,
    private readonly verifyManagedConnection: () => Promise<boolean> = async () => false
  ) {}

  get isExternal(): boolean {
    return this.external;
  }

  get confirmedAccount(): LocalServerAccount | undefined {
    return this.admitted?.url === this.getUrl() ? this.admitted.account : undefined;
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
    this.requiresUncertaintyConsent = false;
    this.operation = null;
  }

  async admit() {
    if (this.operation) return this.operation;
    const generation = this.generation;
    const url = this.getUrl();
    const assertCurrent = () => {
      if (generation !== this.generation || url !== this.getUrl())
        throw new Error('OpenCode connection changed during verification');
    };
    const operation = (async () => {
      // A supplied Authorization header does not prove the server enforces it.
      let account = await this.inspect();
      assertCurrent();
      const previous = this.admitted?.url === url ? this.admitted : undefined;
      // Managed provenance is not uncertainty consent. Revalidate it on every
      // strict admission instead of transferring approval to an unregistered listener.
      const previousAccount = previous?.managed ? undefined : previous?.account;
      const approvedAccount =
        this.requiresUncertaintyConsent && previousAccount?.kind === 'unknown'
          ? undefined
          : previousAccount;
      if (
        account.kind === 'unknown' &&
        !(approvedAccount?.kind === 'unknown' && approvedAccount.identity === account.identity)
      ) {
        // Retry fresh evidence once before turning a transient inspection failure
        // into a modal. Never substitute the last successful observation.
        account = await this.inspect();
        assertCurrent();
      }
      const managed = account.kind === 'unknown' && (await this.verifyManagedConnection());
      assertCurrent();
      const consentApplies =
        account.kind === approvedAccount?.kind &&
        (account.identity !== undefined || account.kind === 'unknown') &&
        account.identity === approvedAccount.identity;
      // Explicit uncertainty consent covers this connection only. verify(true)
      // requires a new decision on reconnect; fresh observations detect known changes.
      if (account.kind !== 'same-user' && !managed && !consentApplies) {
        const confirmed = await this.confirm(account, url);
        assertCurrent();
        if (!confirmed)
          throw new Error('OpenCode connection cancelled; the existing server was left untouched');
        const verified = await this.inspect();
        assertCurrent();
        const recoveredSameUser =
          account.kind === 'unknown' &&
          verified.kind === 'same-user' &&
          verified.identity !== undefined &&
          (account.identity === undefined || account.identity === verified.identity);
        if (
          !recoveredSameUser &&
          (verified.kind !== account.kind || verified.identity !== account.identity)
        )
          throw new Error(
            'OpenCode listener changed while confirmation was open; reconnect to verify it'
          );
        account = verified;
      }
      assertCurrent();
      this.admitted = { url, account, managed };
      // Missing SID evidence remains unknown. A verified Varro registration
      // admits its own process without downgrading it to an external server.
      this.external = account.kind !== 'same-user' && !managed;
      this.checkedAt = Date.now();
      this.requiresUncertaintyConsent = false;
    })();
    this.operation = operation;
    try {
      await operation;
    } catch (error) {
      // Retain the prior decision, not its expired verification window. No
      // request can use it until a new inspection succeeds. Refusal and real
      // uncertainty still revoke admission as before.
      if (generation === this.generation) {
        this.checkedAt = 0;
        if (!(error instanceof ProcessInspectionTimeoutError)) this.admitted = null;
      }
      throw error;
    } finally {
      if (this.operation === operation) this.operation = null;
    }
  }

  async verify(reconnect = false, force = false) {
    if (this.operation) await this.operation;
    if (!this.admitted || this.admitted.url !== this.getUrl())
      throw new Error('OpenCode connection has not been approved');
    if (reconnect && !this.streamOpened) {
      this.streamOpened = true;
      if (!force) return;
    }
    if (reconnect || force || Date.now() - this.checkedAt >= 1000) {
      // An unverifiable listener's approval lasts only for the current connection.
      if (reconnect && this.admitted.account.kind === 'unknown')
        this.requiresUncertaintyConsent = true;
      await this.admit();
    }
  }
}
