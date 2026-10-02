import { afterEach, describe, expect, it, vi } from 'vitest';
import type { LocalServerAccount } from './process-inspection';
import { ServerConnectionAdmission } from './server-connection-admission';
import { ProcessInspectionTimeoutError } from './process-inspection-error';

function setup(account: LocalServerAccount = { kind: 'same-user', identity: 'first-process' }) {
  let url = 'http://127.0.0.1:4096';
  const inspect = vi.fn(async (): Promise<LocalServerAccount> => account);
  const confirm = vi.fn(async () => true);
  const admission = new ServerConnectionAdmission(() => url, inspect, confirm);
  return {
    admission,
    inspect,
    confirm,
    setUrl: (value: string) => {
      url = value;
    },
  };
}

afterEach(() => vi.useRealTimers());

describe('server connection admission', () => {
  it('blocks ordinary use before admission', async () => {
    const { admission, inspect } = setup();
    await expect(admission.verify()).rejects.toThrow('not been approved');
    expect(inspect).not.toHaveBeenCalled();
  });

  it('keeps verified same-user connections quiet', async () => {
    const { admission, confirm } = setup();
    await admission.admit();
    await admission.verify();
    expect(confirm).not.toHaveBeenCalled();
    expect(admission.isExternal).toBe(false);
  });

  it('forces fresh evidence after an observed process change even inside the cache window', async () => {
    const { admission, inspect } = setup();
    await admission.admit();
    await admission.verify(false, true);
    expect(inspect).toHaveBeenCalledTimes(2);
  });

  it('does not let the initial subscription shortcut bypass forced verification', async () => {
    const { admission, inspect } = setup();
    await admission.admit();
    await admission.verify(true, true);
    expect(inspect).toHaveBeenCalledTimes(2);
  });

  it('always checks ownership rather than relying on supplied credentials', async () => {
    const { admission, inspect, confirm } = setup({ kind: 'unknown' });
    await admission.admit();
    expect(inspect).toHaveBeenCalledTimes(3);
    expect(confirm).toHaveBeenCalledOnce();
    expect(admission.isExternal).toBe(true);
  });

  it('shares one pending confirmation and blocks use until it completes', async () => {
    const { admission, inspect, confirm } = setup({
      kind: 'different-user',
      identity: 'foreign-process',
    });
    let answer!: (value: boolean) => void;
    confirm.mockImplementation(
      () =>
        new Promise<boolean>((resolve) => {
          answer = resolve;
        })
    );
    const first = admission.admit();
    const second = admission.admit();
    await Promise.resolve();
    let used = false;
    const use = admission.verify().then(() => {
      used = true;
    });
    await Promise.resolve();
    expect(used).toBe(false);
    expect(confirm).toHaveBeenCalledOnce();
    answer(true);
    await Promise.all([first, second, use]);
    expect(inspect).toHaveBeenCalledTimes(2);
    expect(admission.isExternal).toBe(true);
  });

  it('retries transient uncertainty with fresh evidence before prompting', async () => {
    const { admission, inspect, confirm } = setup();
    inspect.mockResolvedValueOnce({ kind: 'unknown' });
    await admission.admit();
    expect(inspect).toHaveBeenCalledTimes(2);
    expect(confirm).not.toHaveBeenCalled();
    expect(admission.isExternal).toBe(false);
  });

  it('reuses uncertainty consent for ordinary requests, while still inspecting every second', async () => {
    vi.useFakeTimers();
    const { admission, inspect, confirm } = setup({ kind: 'unknown' });
    await admission.admit();
    for (let index = 0; index < 3; index += 1) {
      vi.advanceTimersByTime(1001);
      await admission.verify();
    }
    expect(inspect).toHaveBeenCalledTimes(6);
    expect(confirm).toHaveBeenCalledOnce();
    expect(admission.isExternal).toBe(true);
    await admission.verify(true);
    await admission.verify(true);
    expect(confirm).toHaveBeenCalledTimes(2);
  });

  it('accepts fresh same-user evidence recovered after uncertainty confirmation', async () => {
    const { admission, inspect, confirm } = setup({ kind: 'unknown' });
    confirm.mockImplementation(async () => {
      inspect.mockResolvedValue({ kind: 'same-user', identity: 'recovered-process' });
      return true;
    });
    await admission.admit();
    expect(confirm).toHaveBeenCalledOnce();
    expect(admission.isExternal).toBe(false);
    await admission.verify(true);
    await admission.verify(true);
    expect(confirm).toHaveBeenCalledOnce();
  });

  it('does not accept foreign-account recovery after uncertainty confirmation', async () => {
    const { admission, inspect, confirm } = setup({ kind: 'unknown' });
    confirm.mockImplementation(async () => {
      inspect.mockResolvedValue({ kind: 'different-user', identity: 'foreign-process' });
      return true;
    });
    await expect(admission.admit()).rejects.toThrow('listener changed');
    await expect(admission.verify()).rejects.toThrow('not been approved');
  });

  it('does not accept a known identity replacement even when its account is now same-user', async () => {
    const { admission, inspect, confirm } = setup({ kind: 'unknown', identity: 'old' });
    confirm.mockImplementation(async () => {
      inspect.mockResolvedValue({ kind: 'same-user', identity: 'replacement' });
      return true;
    });
    await expect(admission.admit()).rejects.toThrow('listener changed');
  });

  it('requires consent when a previously verified account becomes persistently unknown', async () => {
    vi.useFakeTimers();
    const { admission, inspect, confirm } = setup();
    await admission.admit();
    inspect.mockResolvedValue({ kind: 'unknown' });
    vi.advanceTimersByTime(1001);
    await admission.verify();
    expect(confirm).toHaveBeenCalledOnce();
    expect(admission.isExternal).toBe(true);
  });

  it('does not transfer uncertainty consent to a newly identified foreign listener', async () => {
    vi.useFakeTimers();
    const { admission, inspect, confirm } = setup({ kind: 'unknown' });
    await admission.admit();
    inspect.mockResolvedValue({ kind: 'different-user', identity: 'foreign-process' });
    vi.advanceTimersByTime(1001);
    await admission.verify();
    expect(confirm).toHaveBeenCalledTimes(2);
  });

  it('blocks timed-out rechecks without prompting or extending the previous verification', async () => {
    vi.useFakeTimers();
    const { admission, inspect, confirm } = setup();
    await admission.admit();
    const expiry = admission.verificationExpiresAt;
    vi.advanceTimersByTime(1001);
    inspect.mockRejectedValue(new ProcessInspectionTimeoutError('lsof timed out'));
    await expect(admission.verify()).rejects.toThrow('lsof timed out');
    await expect(admission.verify()).rejects.toThrow('lsof timed out');
    expect(admission.verificationExpiresAt).toBeLessThanOrEqual(expiry);
    expect(confirm).not.toHaveBeenCalled();
    inspect.mockResolvedValue({ kind: 'same-user', identity: 'first-process' });
    await admission.verify();
    expect(admission.verificationExpiresAt).toBeGreaterThan(expiry);
    expect(confirm).not.toHaveBeenCalled();
  });

  it('requires foreign-account consent after recovering from an inspection timeout', async () => {
    vi.useFakeTimers();
    const { admission, inspect, confirm } = setup();
    await admission.admit();
    vi.advanceTimersByTime(1001);
    inspect.mockRejectedValueOnce(new ProcessInspectionTimeoutError('lsof timed out'));
    await expect(admission.verify()).rejects.toThrow('lsof timed out');
    inspect.mockResolvedValue({ kind: 'different-user', identity: 'replacement' });
    confirm.mockResolvedValue(false);
    await expect(admission.verify()).rejects.toThrow('left untouched');
    await expect(admission.verify()).rejects.toThrow('not been approved');
    expect(confirm).toHaveBeenCalledOnce();
  });

  it.each([false, true])(
    'does not bypass fresh uncertainty consent after a timed-out reconnect, reconnect=%s',
    async (reconnect) => {
      const { admission, inspect, confirm } = setup({ kind: 'unknown' });
      await admission.admit();
      await admission.verify(true);
      inspect.mockRejectedValueOnce(new ProcessInspectionTimeoutError('lsof timed out'));
      await expect(admission.verify(true)).rejects.toThrow('lsof timed out');
      expect(confirm).toHaveBeenCalledOnce();
      await admission.verify(reconnect);
      expect(confirm).toHaveBeenCalledTimes(2);
    }
  );

  it('does not grant initial approval after an inspection timeout', async () => {
    const { admission, inspect, confirm } = setup();
    inspect.mockRejectedValue(new ProcessInspectionTimeoutError('lsof timed out'));
    await expect(admission.admit()).rejects.toThrow('lsof timed out');
    await expect(admission.verify()).rejects.toThrow('not been approved');
    expect(confirm).not.toHaveBeenCalled();
  });

  it('does not prompt after reset while inspection is pending', async () => {
    const { admission, inspect, confirm } = setup({ kind: 'unknown' });
    let resolve!: (account: LocalServerAccount) => void;
    inspect.mockImplementationOnce(
      () =>
        new Promise((done) => {
          resolve = done;
        })
    );
    const pending = admission.admit();
    const rejected = expect(pending).rejects.toThrow('connection changed');
    admission.reset();
    resolve({ kind: 'unknown' });
    await rejected;
    expect(confirm).not.toHaveBeenCalled();
    expect(inspect).toHaveBeenCalledOnce();
  });

  it('does not prompt if the endpoint changes during the uncertainty retry', async () => {
    const { admission, inspect, confirm, setUrl } = setup({ kind: 'unknown' });
    inspect.mockImplementationOnce(async () => ({ kind: 'unknown' }));
    inspect.mockImplementationOnce(async () => {
      setUrl('http://127.0.0.1:50000');
      return { kind: 'unknown' };
    });
    await expect(admission.admit()).rejects.toThrow('connection changed');
    expect(confirm).not.toHaveBeenCalled();
  });

  it.each(['different-user', 'unknown'] as const)(
    'leaves %s connections blocked after dismissal',
    async (kind) => {
      const { admission, confirm } = setup({ kind });
      confirm.mockResolvedValue(false);
      await expect(admission.admit()).rejects.toThrow('left untouched');
      await expect(admission.verify()).rejects.toThrow('not been approved');
      expect(confirm).toHaveBeenCalledOnce();
    }
  );

  it('does not transfer approval to a replacement listener during the dialog', async () => {
    const { admission, inspect } = setup({ kind: 'different-user', identity: 'old' });
    inspect
      .mockResolvedValueOnce({ kind: 'different-user', identity: 'old' })
      .mockResolvedValueOnce({ kind: 'different-user', identity: 'replacement' });
    await expect(admission.admit()).rejects.toThrow('listener changed');
    await expect(admission.verify()).rejects.toThrow('not been approved');
  });

  it('reuses approval only for the same verified listener on reconnection', async () => {
    const { admission, confirm, inspect } = setup({ kind: 'different-user', identity: 'old' });
    await admission.admit();
    await admission.verify(true);
    await admission.verify(true);
    expect(confirm).toHaveBeenCalledOnce();
    inspect.mockResolvedValue({ kind: 'different-user', identity: 'new' });
    await admission.verify(true);
    expect(confirm).toHaveBeenCalledTimes(2);
  });

  it('requires fresh uncertainty consent on reconnection, but not the initial subscription', async () => {
    const { admission, confirm } = setup({ kind: 'unknown' });
    await admission.admit();
    await admission.verify(true);
    expect(confirm).toHaveBeenCalledOnce();
    await admission.verify(true);
    expect(confirm).toHaveBeenCalledTimes(2);
  });

  it('rechecks ownership before ordinary requests after the bounded cache expires', async () => {
    vi.useFakeTimers();
    const { admission, inspect, confirm } = setup();
    await admission.admit();
    inspect.mockResolvedValue({ kind: 'different-user', identity: 'replacement' });
    vi.advanceTimersByTime(1001);
    await admission.verify();
    expect(confirm).toHaveBeenCalledOnce();
    expect(admission.isExternal).toBe(true);
  });

  it('invalidates an outstanding answer when disposed', async () => {
    const { admission, confirm } = setup({ kind: 'unknown' });
    let answer!: (value: boolean) => void;
    confirm.mockImplementation(
      () =>
        new Promise<boolean>((resolve) => {
          answer = resolve;
        })
    );
    const pending = admission.admit();
    const rejected = expect(pending).rejects.toThrow('connection changed');
    await vi.waitFor(() => expect(confirm).toHaveBeenCalledOnce());
    admission.reset();
    answer(true);
    await rejected;
    await expect(admission.verify()).rejects.toThrow('not been approved');
  });

  it('never transfers admission across endpoint changes', async () => {
    const { admission, setUrl } = setup();
    await admission.admit();
    setUrl('http://127.0.0.1:50000');
    await expect(admission.verify()).rejects.toThrow('not been approved');
  });
});
