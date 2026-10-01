import { spawn } from 'child_process';
import type { ChildProcessWithoutNullStreams } from 'child_process';
import { asRecord, isString } from '../shared/type-utils';

type WindowsProcessDetails = {
  executable: string;
  birthIdentity: string;
  listenerSid: string;
  hostSid: string;
};

// Keep a process handle open across all reads. Unlike CIM, these native calls
// neither load WMI providers nor confuse a reused PID with the original process.
const INSPECTION_SCRIPT = String.raw`
$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = New-Object System.Text.UTF8Encoding($false)
Add-Type -TypeDefinition @'
using System;
using System.ComponentModel;
using System.Runtime.InteropServices;
using System.Security.Principal;
using System.Text;

public class VarroProcessDetails {
  public string executable;
  public string birthIdentity;
  public string listenerSid;
  public string hostSid;
}
public static class VarroProcessInspection {
  [DllImport("kernel32.dll", SetLastError=true)]
  static extern IntPtr OpenProcess(uint access, bool inherit, int pid);
  [DllImport("kernel32.dll", SetLastError=true, CharSet=CharSet.Unicode)]
  static extern bool QueryFullProcessImageName(IntPtr process, uint flags, StringBuilder name, ref uint size);
  [DllImport("kernel32.dll", SetLastError=true)]
  static extern bool GetProcessTimes(IntPtr process, out long created, out long exited, out long kernel, out long user);
  [DllImport("kernel32.dll", SetLastError=true)]
  static extern bool GetExitCodeProcess(IntPtr process, out uint code);
  [DllImport("advapi32.dll", SetLastError=true)]
  static extern bool OpenProcessToken(IntPtr process, uint access, out IntPtr token);
  [DllImport("kernel32.dll")]
  static extern bool CloseHandle(IntPtr handle);

  static string Owner(IntPtr process) {
    IntPtr token;
    if (!OpenProcessToken(process, 8, out token)) return "";
    try {
      using (var identity = new WindowsIdentity(token)) {
        return identity.User == null ? "" : identity.User.Value;
      }
    } finally { CloseHandle(token); }
  }
  public static VarroProcessDetails Read(int pid, int hostPid) {
    IntPtr process = OpenProcess(0x1000, false, pid);
    if (process == IntPtr.Zero) throw new Win32Exception(Marshal.GetLastWin32Error());
    try {
      long created, exited, kernel, user;
      if (!GetProcessTimes(process, out created, out exited, out kernel, out user))
        throw new Win32Exception(Marshal.GetLastWin32Error());
      var name = new StringBuilder(32768);
      uint size = (uint)name.Capacity;
      if (!QueryFullProcessImageName(process, 0, name, ref size))
        throw new Win32Exception(Marshal.GetLastWin32Error());
      string listenerSid = Owner(process);
      string hostSid = "";
      IntPtr host = OpenProcess(0x1000, false, hostPid);
      if (host != IntPtr.Zero) {
        try { hostSid = Owner(host); } finally { CloseHandle(host); }
      }
      uint code;
      long verifiedCreated;
      if (!GetProcessTimes(process, out verifiedCreated, out exited, out kernel, out user) ||
          verifiedCreated != created || exited != 0 ||
          !GetExitCodeProcess(process, out code) || code != 259)
        throw new InvalidOperationException("Process exited during inspection");
      // Existing leases use CIM's microsecond precision. Preserve their identity.
      long ticks = DateTime.FromFileTimeUtc(created).Ticks;
      return new VarroProcessDetails {
        executable = name.ToString(),
        birthIdentity = "win32:" + (ticks - ticks % 10).ToString(),
        listenerSid = listenerSid,
        hostSid = hostSid
      };
    } finally { CloseHandle(process); }
  }
}
'@
while ($null -ne ($line = [Console]::In.ReadLine())) {
  $fields = $line.Split(' ')
  $id = 0
  $processId = 0
  $hostId = 0
  if ($fields.Length -ne 3 -or
      -not [int]::TryParse($fields[0], [ref]$id) -or
      -not [int]::TryParse($fields[1], [ref]$processId) -or
      -not [int]::TryParse($fields[2], [ref]$hostId)) { exit 1 }
  try {
    $details = [VarroProcessInspection]::Read($processId, $hostId)
    $response = @{ id = $id; details = $details }
  } catch { $response = @{ id = $id; error = $_.Exception.Message } }
  [Console]::Out.WriteLine(($response | ConvertTo-Json -Compress -Depth 3))
  [Console]::Out.Flush()
}
`;

/** One read-only helper per extension host, with in-flight sharing but no identity cache. */
export class WindowsProcessInspector {
  private worker: ChildProcessWithoutNullStreams | undefined;
  private sequence = 0;
  private readonly operations = new Map<number, Promise<WindowsProcessDetails>>();
  private readonly pending = new Map<
    number,
    { resolve: (details: WindowsProcessDetails) => void; reject: (error: Error) => void }
  >();
  private idleTimer: ReturnType<typeof setTimeout> | undefined;

  read(pid: number): Promise<WindowsProcessDetails> {
    if (!Number.isSafeInteger(pid) || pid <= 0 || pid > 0x7fffffff)
      return Promise.reject(new Error('Invalid Windows process ID'));
    const existing = this.operations.get(pid);
    if (existing) return existing;
    const operation = this.inspect(pid).finally(() => {
      if (this.operations.get(pid) === operation) this.operations.delete(pid);
    });
    this.operations.set(pid, operation);
    return operation;
  }

  dispose(): void {
    this.stop(new Error('Windows process inspector stopped'));
  }

  private async inspect(pid: number): Promise<WindowsProcessDetails> {
    if (this.idleTimer) clearTimeout(this.idleTimer);
    this.idleTimer = undefined;
    const worker = this.worker ?? this.start();
    const id = ++this.sequence;
    let timeout: ReturnType<typeof setTimeout> | undefined;
    try {
      return await new Promise<WindowsProcessDetails>((resolve, reject) => {
        this.pending.set(id, { resolve, reject });
        timeout = setTimeout(() => {
          if (this.worker === worker)
            this.stop(new Error('Windows native process inspection timed out after 5000ms'));
        }, 5000);
        worker.stdin.write(`${id} ${pid} ${process.pid}\n`, (error) => {
          if (error && this.worker === worker) this.stop(error);
        });
      });
    } finally {
      if (timeout) clearTimeout(timeout);
      this.pending.delete(id);
      if (!this.pending.size && this.worker === worker) {
        // stdin EOF also makes the helper exit when its extension host disappears.
        if (this.idleTimer) clearTimeout(this.idleTimer);
        this.idleTimer = setTimeout(() => this.dispose(), 60_000);
        this.idleTimer.unref();
      }
    }
  }

  private start(): ChildProcessWithoutNullStreams {
    const worker = spawn(
      'powershell.exe',
      [
        '-NoLogo',
        '-NoProfile',
        '-NonInteractive',
        '-EncodedCommand',
        Buffer.from(INSPECTION_SCRIPT, 'utf16le').toString('base64'),
      ],
      { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true }
    );
    this.worker = worker;
    let buffer = '';
    const fail = (error: Error) => {
      if (this.worker === worker) this.stop(error);
    };
    worker.on('error', fail);
    worker.on('close', () => fail(new Error('Windows process inspection helper exited')));
    worker.stdin.on('error', fail);
    worker.stderr.on('data', () => {
      // Drain startup diagnostics; never treat stderr/partial stdout as identity.
    });
    worker.stdout.setEncoding('utf8');
    worker.stdout.on('data', (chunk: string) => {
      if (this.worker !== worker) return;
      buffer += chunk;
      if (buffer.length > 64 * 1024) {
        fail(new Error('Windows process inspection response exceeded its limit'));
        return;
      }
      for (;;) {
        const end = buffer.indexOf('\n');
        if (end < 0) break;
        const line = buffer.slice(0, end);
        buffer = buffer.slice(end + 1);
        try {
          const response = asRecord(JSON.parse(line));
          const pending = this.pending.get(Number(response?.id));
          if (!pending) throw new Error('Unexpected Windows process inspection response');
          if (isString(response?.error)) {
            this.pending.delete(Number(response.id));
            pending.reject(new Error(response.error));
            continue;
          }
          const details = asRecord(response?.details);
          if (
            !isString(details?.executable) ||
            !details.executable ||
            !isString(details.birthIdentity) ||
            !/^win32:\d+$/.test(details.birthIdentity) ||
            !isString(details.listenerSid) ||
            !isString(details.hostSid)
          )
            throw new Error('Incomplete Windows process inspection response');
          this.pending.delete(Number(response?.id));
          pending.resolve({
            executable: details.executable,
            birthIdentity: details.birthIdentity,
            listenerSid: details.listenerSid,
            hostSid: details.hostSid,
          });
        } catch (error) {
          fail(
            error instanceof Error
              ? error
              : new Error('Invalid Windows process inspection response')
          );
          return;
        }
      }
    });
    return worker;
  }

  private stop(error: Error): void {
    if (this.idleTimer) clearTimeout(this.idleTimer);
    this.idleTimer = undefined;
    const worker = this.worker;
    this.worker = undefined;
    for (const pending of this.pending.values()) pending.reject(error);
    this.pending.clear();
    worker?.stdin.destroy();
    worker?.kill();
  }
}
