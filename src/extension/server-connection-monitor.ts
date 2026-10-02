import type { LocalServerAccount } from './process-inspection';
import type { ManagedServerOwnershipLease } from '../shared/server-ownership';
import { ManagedServerConnectionChangedError } from './process-inspection-error';

type ManagedConnectionIdentity = Pick<
  ManagedServerOwnershipLease,
  'port' | 'pid' | 'birthIdentity' | 'executable'
>;

function hasProcessIdentity(
  account: LocalServerAccount | undefined
): account is LocalServerAccount & { identity: string; pid: number; birthIdentity: string } {
  return (
    !!account?.identity &&
    Number.isSafeInteger(account.pid) &&
    account.pid !== undefined &&
    account.pid > 0 &&
    !!account.birthIdentity &&
    account.identity.startsWith(`${account.pid}:${account.birthIdentity}:`)
  );
}

type ConfirmedConnection = {
  url: string;
  account: LocalServerAccount & { kind: 'same-user'; pid: number; birthIdentity: string };
  managedIdentity: string | undefined;
};

interface ConnectionMonitorOptions {
  getUrl(): string;
  getManagedIdentity(): ManagedConnectionIdentity | undefined;
  getAccount(): LocalServerAccount | undefined;
  isProcessAlive(pid: number): boolean;
  inspectAccount(): Promise<LocalServerAccount>;
  verifyManagedConnection(): Promise<void>;
  reportDiagnostic(message: string): void;
}

/** Established attachment is separate from the authority to stop or adopt a server. */
export class ServerConnectionMonitor {
  private static readonly CHECK_INTERVAL_MS = 30_000;
  private confirmation: ConfirmedConnection | undefined;
  private timer: ReturnType<typeof setTimeout> | undefined;
  private currentGeneration = 0;
  private needsVerification = false;
  private diagnosticReported = false;

  constructor(private readonly options: ConnectionMonitorOptions) {}

  get generation(): number {
    return this.currentGeneration;
  }

  get requiresVerification(): boolean {
    return this.needsVerification;
  }

  canReuse(): boolean {
    const confirmation = this.confirmation;
    if (!confirmation) return false;
    const account = this.options.getAccount();
    if (
      confirmation.url !== this.options.getUrl() ||
      confirmation.managedIdentity !== this.managedIdentityKey() ||
      account?.kind !== 'same-user' ||
      confirmation.account.identity !== account.identity ||
      !this.options.isProcessAlive(confirmation.account.pid)
    ) {
      this.invalidate();
      return false;
    }
    return true;
  }

  confirm(account: LocalServerAccount | undefined, generation: number): void {
    const managed = this.options.getManagedIdentity();
    if (
      generation !== this.currentGeneration ||
      account?.kind !== 'same-user' ||
      !hasProcessIdentity(account) ||
      (managed && (managed.pid !== account.pid || managed.birthIdentity !== account.birthIdentity))
    )
      return;
    this.clearTimer();
    this.confirmation = {
      url: this.options.getUrl(),
      account: {
        ...account,
        kind: 'same-user',
        pid: account.pid,
        birthIdentity: account.birthIdentity,
      },
      managedIdentity: this.managedIdentityKey(),
    };
    this.needsVerification = false;
    this.diagnosticReported = false;
    this.scheduleCheck();
  }

  invalidate(): void {
    this.reset();
    this.needsVerification = true;
  }

  reset(): void {
    this.currentGeneration++;
    this.clearTimer();
    this.confirmation = undefined;
    this.needsVerification = false;
    this.diagnosticReported = false;
  }

  private clearTimer(): void {
    clearTimeout(this.timer);
    this.timer = undefined;
  }

  private managedIdentityKey(): string | undefined {
    const identity = this.options.getManagedIdentity();
    return identity
      ? JSON.stringify([identity.port, identity.pid, identity.birthIdentity, identity.executable])
      : undefined;
  }

  private scheduleCheck(): void {
    const generation = this.currentGeneration;
    this.timer = setTimeout(() => {
      this.timer = undefined;
      void this.check(generation);
    }, ServerConnectionMonitor.CHECK_INTERVAL_MS);
    this.timer.unref?.();
  }

  private async check(generation: number): Promise<void> {
    const confirmation = this.confirmation;
    if (!confirmation || generation !== this.currentGeneration || !this.canReuse()) return;
    // Background reads never call admission's consent flow and never hold up a
    // request. Wait for both observations so one failed read cannot hide a change.
    const [managed, account] = await Promise.allSettled([
      this.options.verifyManagedConnection(),
      this.options.inspectAccount(),
    ]);
    if (
      generation !== this.currentGeneration ||
      this.confirmation !== confirmation ||
      !this.canReuse()
    )
      return;
    const observed = account.status === 'fulfilled' ? account.value : undefined;
    if (
      (managed.status === 'rejected' &&
        managed.reason instanceof ManagedServerConnectionChangedError) ||
      (hasProcessIdentity(observed) &&
        observed.kind !== 'unknown' &&
        (observed.kind !== 'same-user' || observed.identity !== confirmation.account.identity))
    ) {
      this.options.reportDiagnostic(
        'OpenCode process identity changed; fresh connection verification is required'
      );
      this.invalidate();
      return;
    }
    if (
      managed.status === 'rejected' ||
      !hasProcessIdentity(observed) ||
      observed.kind === 'unknown'
    ) {
      if (!this.diagnosticReported) {
        const reason: unknown =
          managed.status === 'rejected'
            ? managed.reason
            : account.status === 'rejected'
              ? account.reason
              : 'local account inspection was inconclusive';
        this.options.reportDiagnostic(
          `Background OpenCode ownership inspection was inconclusive; retaining the confirmed connection: ${reason instanceof Error ? reason.message : String(reason)}`
        );
        this.diagnosticReported = true;
      }
    } else {
      this.diagnosticReported = false;
    }
    this.scheduleCheck();
  }
}
