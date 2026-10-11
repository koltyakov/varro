import { execFile, spawn } from 'child_process';
import { once } from 'events';
import { promisify } from 'util';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { WindowsProcessInspector } from './windows-process-inspector';

describe.skipIf(process.platform !== 'win32')('native Windows process inspection', () => {
  const inspector = new WindowsProcessInspector();

  beforeAll(async () => {
    // Wait for compilation once, without restarting it at the inspection deadline.
    // Readiness is not identity evidence; all reads retain the production deadline.
    await inspector.prepare();
    await inspector.read(process.pid);
  }, 25_000);

  afterAll(() => inspector.dispose());

  it('verifies a live child ancestry and rejects an unrelated ancestor', async () => {
    const child = spawn(
      process.execPath,
      ['-e', 'console.log("ready"); setInterval(() => {}, 1000)'],
      { windowsHide: true }
    );
    try {
      if (!child.stdout) throw new Error('Fixture stdout is unavailable');
      await once(child.stdout, 'data');
      if (!child.pid) throw new Error('Fixture child did not start');
      const details = await inspector.read(child.pid, process.pid);
      expect(details.ancestorPid).toBe(process.pid);
      expect(details.hostBirthIdentity).toMatch(/^win32:\d+$/);
      expect(details.listenerSid).toBe(details.hostSid);
      await expect(inspector.read(child.pid, 0x7fffffff)).rejects.toThrow();
      await expect(inspector.read(child.pid, process.pid)).resolves.toMatchObject({
        ancestorPid: process.pid,
      });
    } finally {
      const exited = once(child, 'exit');
      child.kill();
      await exited;
    }
  }, 20_000);

  it('matches existing CIM leases and reads fresh snapshots from one helper', async () => {
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
  }, 20_000);
});
