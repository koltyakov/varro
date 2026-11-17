import { execFile, spawn } from 'child_process';
import { once } from 'events';
import { createConnection, createServer } from 'net';
import type { Socket } from 'net';
import { promisify } from 'util';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { WindowsProcessInspector } from './windows-process-inspector';
import { isString } from '../shared/type-utils';

describe.skipIf(process.platform !== 'win32')('native Windows process inspection', () => {
  const inspector = new WindowsProcessInspector();

  beforeAll(async () => {
    // Wait for compilation once, without restarting it at the inspection deadline.
    // Readiness is not identity evidence; all reads retain the production deadline.
    await inspector.prepare();
    await inspector.read(process.pid);
  }, 40_000);

  afterAll(() => inspector.dispose());

  it.each(['127.0.0.1', '::1'])('identifies only live listeners on %s', async (host) => {
    const server = createServer();
    await new Promise<void>((resolve) => server.listen(0, host, resolve));
    const address = server.address();
    if (!address || isString(address)) throw new Error('Fixture port is unavailable');
    const client = createConnection({ host, port: address.port });
    const accepted = await new Promise<Socket>((resolve) => server.once('connection', resolve));
    try {
      await expect(inspector.readListeners(address.port)).resolves.toEqual([process.pid]);
      if (!client.localPort) throw new Error('Fixture client port is unavailable');
      await expect(inspector.readListeners(client.localPort)).resolves.toEqual([]);
      await expect(inspector.readListeners(address.port)).resolves.toEqual([process.pid]);
    } finally {
      client.destroy();
      accepted.destroy();
      await new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve()))
      );
    }
    await expect(inspector.readListeners(address.port)).resolves.toEqual([]);
  });

  it('does not classify a bound socket as a listener', async () => {
    const child = spawn(
      'powershell.exe',
      [
        '-NoProfile',
        '-NonInteractive',
        '-Command',
        '$socket = New-Object System.Net.Sockets.Socket([System.Net.Sockets.AddressFamily]::InterNetwork, [System.Net.Sockets.SocketType]::Stream, [System.Net.Sockets.ProtocolType]::Tcp); try { $socket.Bind([System.Net.IPEndPoint]::new([System.Net.IPAddress]::Loopback, 0)); [Console]::Out.WriteLine($socket.LocalEndPoint.Port); [Console]::Out.Flush(); [Console]::In.ReadLine() | Out-Null } finally { $socket.Dispose() }',
      ],
      { windowsHide: true }
    );
    try {
      if (!child.stdout) throw new Error('Fixture stdout unavailable');
      const [data] = await once(child.stdout, 'data');
      const port = Number(String(data).trim());
      expect(port).toBeGreaterThan(0);
      await expect(inspector.readListeners(port)).resolves.toEqual([]);
    } finally {
      const exited = once(child, 'exit');
      child.stdin?.end('\n');
      await exited;
    }
  }, 20_000);

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
