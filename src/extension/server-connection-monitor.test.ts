import { afterEach, describe, expect, it, vi } from 'vitest';
import type { LocalServerAccount } from './process-inspection';
import {
  ManagedServerConnectionChangedError,
  ProcessInspectionTimeoutError,
} from './process-inspection-error';
import { ServerConnectionMonitor } from './server-connection-monitor';

function knownAccount(pid = 123, birthIdentity = 'birth-1'): LocalServerAccount {
  return { kind: 'same-user', pid, birthIdentity, identity: `${pid}:${birthIdentity}:1000` };
}

function setup() {
  vi.useFakeTimers();
  let url = 'http://127.0.0.1:4096';
  let account: LocalServerAccount | undefined = knownAccount();
  let managedIdentity:
    | { port: number; pid: number; birthIdentity: string; executable: string }
    | undefined;
  const inspect = vi.fn(async () => knownAccount());
  const verifyManaged = vi.fn(async () => {});
  const alive = vi.fn(() => true);
  const diagnostic = vi.fn();
  const monitor = new ServerConnectionMonitor({
    getUrl: () => url,
    getManagedIdentity: () => managedIdentity,
    getAccount: () => account,
    isProcessAlive: alive,
    inspectAccount: inspect,
    verifyManagedConnection: verifyManaged,
    reportDiagnostic: diagnostic,
  });
  monitor.confirm(account, monitor.generation);
  return {
    monitor,
    inspect,
    verifyManaged,
    alive,
    diagnostic,
    setUrl: (value: string) => {
      url = value;
    },
    setAccount: (value: LocalServerAccount | undefined) => {
      account = value;
    },
    setManagedIdentity: (value: typeof managedIdentity) => {
      managedIdentity = value;
    },
  };
}

afterEach(() => vi.useRealTimers());

describe('confirmed server connection monitoring', () => {
  it('keeps routine requests inspection-free and checks in the background every thirty seconds', async () => {
    const { monitor, inspect, verifyManaged } = setup();
    for (let index = 0; index < 100; index++) expect(monitor.canReuse()).toBe(true);
    await vi.advanceTimersByTimeAsync(29_999);
    expect(inspect).not.toHaveBeenCalled();
    expect(verifyManaged).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(inspect).toHaveBeenCalledOnce();
    expect(verifyManaged).toHaveBeenCalledOnce();
    expect(monitor.canReuse()).toBe(true);
    await vi.advanceTimersByTimeAsync(30_000);
    expect(inspect).toHaveBeenCalledTimes(2);
    monitor.reset();
  });

  it('does not block requests or launch overlapping checks while inspection is slow', async () => {
    const { monitor, inspect, verifyManaged } = setup();
    let resolve!: (value: LocalServerAccount) => void;
    inspect.mockImplementationOnce(
      () =>
        new Promise((done) => {
          resolve = done;
        })
    );
    await vi.advanceTimersByTimeAsync(30_000);
    for (let index = 0; index < 100; index++) expect(monitor.canReuse()).toBe(true);
    await vi.advanceTimersByTimeAsync(90_000);
    expect(inspect).toHaveBeenCalledOnce();
    expect(verifyManaged).toHaveBeenCalledOnce();
    resolve(knownAccount());
    await vi.advanceTimersByTimeAsync(0);
    expect(monitor.canReuse()).toBe(true);
    monitor.reset();
  });

  it.each(['timeout', 'unknown', 'managed-inspection'] as const)(
    'retains confirmed attachment after inconclusive %s evidence without repeated diagnostics',
    async (failure) => {
      const { monitor, inspect, verifyManaged, diagnostic } = setup();
      if (failure === 'timeout')
        inspect.mockRejectedValue(new ProcessInspectionTimeoutError('lsof timed out'));
      if (failure === 'unknown') inspect.mockResolvedValue({ kind: 'unknown' });
      if (failure === 'managed-inspection')
        verifyManaged.mockRejectedValue(new Error('Cannot read process birth identity'));
      await vi.advanceTimersByTimeAsync(90_000);
      expect(inspect).toHaveBeenCalledTimes(3);
      expect(monitor.canReuse()).toBe(true);
      expect(monitor.requiresVerification).toBe(false);
      expect(diagnostic).toHaveBeenCalledOnce();
      expect(diagnostic).toHaveBeenCalledWith(expect.stringContaining('inconclusive'));
      monitor.reset();
    }
  );

  it.each(['new-pid', 'pid-reuse', 'foreign-account', 'managed-replacement'] as const)(
    'requires fresh admission after conclusive %s evidence',
    async (change) => {
      const { monitor, inspect, verifyManaged } = setup();
      if (change === 'new-pid') inspect.mockResolvedValue(knownAccount(456));
      if (change === 'pid-reuse') inspect.mockResolvedValue(knownAccount(123, 'birth-2'));
      if (change === 'foreign-account')
        inspect.mockResolvedValue({ ...knownAccount(), kind: 'different-user' });
      if (change === 'managed-replacement')
        verifyManaged.mockRejectedValue(
          new ManagedServerConnectionChangedError('listener changed')
        );
      await vi.advanceTimersByTimeAsync(30_000);
      expect(monitor.canReuse()).toBe(false);
      expect(monitor.requiresVerification).toBe(true);
      await vi.advanceTimersByTimeAsync(60_000);
      expect(inspect).toHaveBeenCalledOnce();
    }
  );

  it('does not let an inconclusive managed read hide a new listener', async () => {
    const { monitor, inspect, verifyManaged } = setup();
    verifyManaged.mockRejectedValue(new ProcessInspectionTimeoutError('lsof timed out'));
    inspect.mockResolvedValue(knownAccount(456));
    await vi.advanceTimersByTimeAsync(30_000);
    expect(monitor.canReuse()).toBe(false);
    expect(monitor.requiresVerification).toBe(true);
  });

  it.each(['exit', 'endpoint', 'registration', 'admission-reset'] as const)(
    'invalidates attachment immediately after %s without an OS inspection',
    (change) => {
      const { monitor, inspect, alive, setUrl, setManagedIdentity, setAccount } = setup();
      if (change === 'exit') alive.mockReturnValue(false);
      if (change === 'endpoint') setUrl('http://127.0.0.1:5096');
      if (change === 'registration')
        setManagedIdentity({
          port: 4096,
          pid: 456,
          birthIdentity: 'birth-2',
          executable: '/opencode',
        });
      if (change === 'admission-reset') setAccount(undefined);
      expect(monitor.canReuse()).toBe(false);
      expect(monitor.requiresVerification).toBe(true);
      expect(inspect).not.toHaveBeenCalled();
    }
  );

  it('does not enable reuse for mismatched managed and account identities', () => {
    const { monitor, setManagedIdentity } = setup();
    monitor.reset();
    setManagedIdentity({ port: 4096, pid: 456, birthIdentity: 'birth-2', executable: '/opencode' });
    monitor.confirm(knownAccount(), monitor.generation);
    expect(monitor.canReuse()).toBe(false);
  });

  it.each([
    { kind: 'unknown' },
    { ...knownAccount(), kind: 'different-user' },
    { kind: 'same-user', identity: 'incomplete' },
    { ...knownAccount(), identity: 'mismatched-pid' },
  ] satisfies LocalServerAccount[])(
    'never grants background reuse to unverified or foreign account %j',
    async (account) => {
      const { monitor, setAccount, inspect } = setup();
      monitor.reset();
      setAccount(account);
      monitor.confirm(account, monitor.generation);
      expect(monitor.canReuse()).toBe(false);
      await vi.advanceTimersByTimeAsync(60_000);
      expect(inspect).not.toHaveBeenCalled();
    }
  );

  it('discards late observations after reset without reviving the monitor', async () => {
    const { monitor, inspect, diagnostic } = setup();
    let resolve!: (value: LocalServerAccount) => void;
    inspect.mockImplementationOnce(
      () =>
        new Promise((done) => {
          resolve = done;
        })
    );
    const generation = monitor.generation;
    await vi.advanceTimersByTimeAsync(30_000);
    monitor.reset();
    resolve(knownAccount(456));
    await vi.advanceTimersByTimeAsync(0);
    monitor.confirm(knownAccount(), generation);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(monitor.canReuse()).toBe(false);
    expect(monitor.requiresVerification).toBe(false);
    expect(inspect).toHaveBeenCalledOnce();
    expect(diagnostic).not.toHaveBeenCalled();
  });

  it('does not let an old pending observation invalidate a freshly confirmed connection', async () => {
    const { monitor, inspect, setAccount, diagnostic } = setup();
    let resolve!: (value: LocalServerAccount) => void;
    inspect.mockImplementationOnce(
      () =>
        new Promise((done) => {
          resolve = done;
        })
    );
    await vi.advanceTimersByTimeAsync(30_000);
    monitor.invalidate();
    const replacement = knownAccount(456, 'birth-2');
    setAccount(replacement);
    monitor.confirm(replacement, monitor.generation);
    resolve({ ...knownAccount(), kind: 'different-user' });
    await vi.advanceTimersByTimeAsync(0);
    expect(monitor.canReuse()).toBe(true);
    expect(diagnostic).not.toHaveBeenCalled();
    monitor.reset();
  });
});
