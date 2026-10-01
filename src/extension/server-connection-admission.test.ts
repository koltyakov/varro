import { afterEach, describe, expect, it, vi } from 'vitest';
import type { LocalServerAccount } from './process-inspection';
import { ServerConnectionAdmission } from './server-connection-admission';

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

  it('always checks ownership rather than relying on supplied credentials', async () => {
    const { admission, inspect, confirm } = setup({ kind: 'unknown' });
    await admission.admit();
    expect(inspect).toHaveBeenCalledTimes(2);
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
    await Promise.resolve();
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
