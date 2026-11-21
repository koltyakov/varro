import { execFile } from 'node:child_process';
import { setTimeout as delay } from 'node:timers/promises';
import { promisify } from 'node:util';

export function isTestServerProcessAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    if (error.code === 'ESRCH') return false;
    throw error;
  }
}

async function terminateWindowsOwner({ pid, birthIdentity, executable }) {
  // Keep the Process handle open from identity comparison through Kill and WaitForExit.
  // A fresh PID lookup after the comparison could target a replacement.
  await promisify(execFile)(
    'powershell.exe',
    [
      '-NoProfile',
      '-NonInteractive',
      '-Command',
      `$ErrorActionPreference = 'Stop'
       $p = [Diagnostics.Process]::GetProcessById([int]$env:VARRO_STOP_PID)
       try {
         $null = $p.Handle
         $ticks = $p.StartTime.ToUniversalTime().Ticks
         $birth = 'win32:' + ($ticks - ($ticks % 10)).ToString()
         if ($birth -cne $env:VARRO_STOP_BIRTH -or $p.MainModule.FileName -ine $env:VARRO_STOP_EXE) {
           throw 'Native test server identity changed before termination'
         }
         $p.Kill()
         if (!$p.WaitForExit(3000)) { throw 'Native test server did not exit' }
       } finally { $p.Dispose() }`,
    ],
    {
      env: {
        ...process.env,
        VARRO_STOP_PID: String(pid),
        VARRO_STOP_BIRTH: birthIdentity,
        VARRO_STOP_EXE: executable,
      },
      timeout: 10_000,
      windowsHide: true,
    }
  );
}

export class WindowsTestServerOwner {
  constructor(
    inspector,
    port,
    child,
    { isAlive = isTestServerProcessAlive, terminate = terminateWindowsOwner } = {}
  ) {
    this.inspector = inspector;
    this.port = port;
    this.child = child;
    this.isAlive = isAlive;
    this.terminate = terminate;
  }

  async capture() {
    const listeners = await this.inspector.readListeners(this.port);
    if (!listeners.length && !this.identity) return false;
    if (listeners.length !== 1 || (this.identity && listeners[0] !== this.identity.pid)) {
      throw new Error(`Unexpected native test server listener on port ${this.port}`);
    }
    const pid = listeners[0];
    // The launch handle belongs to this generation. Check ancestry before retaining
    // cleanup authority, even if the subsequent HTTP/database readiness check fails.
    if (this.child.exitCode !== null || this.child.signalCode !== null)
      throw new Error('Test server launch exited before native ancestry verification');
    const { executable, birthIdentity } = await this.inspector.read(pid, this.child.pid);
    if (this.child.exitCode !== null || this.child.signalCode !== null)
      throw new Error('Test server launch exited during native ancestry verification');
    if (
      this.identity &&
      (this.identity.birthIdentity !== birthIdentity || this.identity.executable !== executable)
    )
      throw new Error('Native test server identity changed');
    this.identity ??= { pid, executable, birthIdentity };
    return true;
  }

  async verify(serverPid, previous) {
    await this.capture();
    if (!this.identity || this.identity.pid !== serverPid)
      throw new Error('Native test server differs from verified database owner');
    if (previous?.pid === serverPid && previous.birthIdentity === this.identity.birthIdentity)
      throw new Error('Test server restart reused the previous native process');
  }

  async stop() {
    const errors = [];
    try {
      await this.inspector.prepare();
      // Startup may have failed before its first successful capture.
      if (!this.identity) await this.capture();
      const listeners = await this.inspector.readListeners(this.port);
      const owner = this.identity;
      if (listeners.length && (listeners.length !== 1 || listeners[0] !== owner?.pid))
        throw new Error(`Unexpected native test server listener on port ${this.port}`);
      if (owner && this.isAlive(owner.pid)) {
        const current = await this.inspector.read(owner.pid);
        if (
          owner.birthIdentity !== current.birthIdentity ||
          owner.executable !== current.executable
        )
          throw new Error('Native test server identity changed before stop');
        await this.terminate(owner);
        if (this.isAlive(owner.pid))
          throw new Error(`Native test server PID ${owner.pid} still exists`);
      }
    } catch (error) {
      errors.push(error);
    }
    try {
      if (!errors.length || this.child.pid !== this.identity?.pid)
        await stopTestServerChild(this.child);
    } catch (error) {
      errors.push(error);
    }
    try {
      if ((await this.inspector.readListeners(this.port)).length)
        throw new Error(`Test server port ${this.port} is still listening after cleanup`);
    } catch (error) {
      errors.push(error);
    } finally {
      this.inspector.dispose();
    }
    if (errors.length)
      throw new AggregateError(errors, errors.map((error) => error.message).join('; '));
  }
}

export async function stopTestServerChild(child) {
  if (!child?.pid) return;
  for (const signal of ['SIGTERM', 'SIGKILL']) {
    if (child.exitCode !== null || child.signalCode !== null) return;
    child.kill(signal);
    const deadline = Date.now() + 3_000;
    while (child.exitCode === null && child.signalCode === null && Date.now() < deadline)
      await delay(50);
  }
  if (child.exitCode === null && child.signalCode === null)
    throw new Error(`Test server launch PID ${child.pid} did not exit`);
}
