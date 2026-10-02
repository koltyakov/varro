import { execFile } from 'child_process';
import { promisify } from 'util';
import { describe, expect, it } from 'vitest';
import { WindowsProcessInspector } from './windows-process-inspector';

describe.skipIf(process.platform !== 'win32')('native Windows process inspection', () => {
  it('matches existing CIM leases and reads fresh snapshots from one helper', async () => {
    const inspector = new WindowsProcessInspector();
    try {
      const first = await inspector.read(process.pid);
      expect(first.executable.toLowerCase()).toBe(process.execPath.toLowerCase());
      expect(first.listenerSid).toMatch(/^S-\d+(?:-\d+)+$/);
      expect(first.hostSid).toBe(first.listenerSid);
      const { stdout } = await promisify(execFile)(
        'powershell.exe',
        [
          '-NoProfile',
          '-NonInteractive',
          '-Command',
          `(Get-CimInstance Win32_Process -Filter "ProcessId = ${process.pid}").CreationDate.ToUniversalTime().Ticks`,
        ],
        { timeout: 10_000, windowsHide: true }
      );
      expect(first.birthIdentity).toBe(`win32:${stdout.trim()}`);
      const [identity, account] = await Promise.all([
        inspector.read(process.pid),
        inspector.read(process.pid),
      ]);
      expect(identity).toEqual(first);
      expect(account).toBe(identity);
      await expect(inspector.read(0x7fffffff)).rejects.toThrow();
      await expect(inspector.read(process.pid)).resolves.toEqual(first);
    } finally {
      inspector.dispose();
    }
  }, 20_000);
});
