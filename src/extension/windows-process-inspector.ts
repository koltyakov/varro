import { spawn } from 'child_process';
import type { ChildProcessWithoutNullStreams } from 'child_process';
import { asRecord, isString } from '../shared/type-utils';

type WindowsProcessDetails = {
  executable: string;
  birthIdentity: string;
  listenerSid: string;
  hostSid: string;
  hostBirthIdentity?: string;
  ancestorPid?: number;
};

// Keep a process handle open across all reads. Unlike CIM, these native calls
// neither load WMI providers nor confuse a reused PID with the original process.
const INSPECTION_SCRIPT = String.raw`
$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = New-Object System.Text.UTF8Encoding($false)
Add-Type -TypeDefinition @'
using System;
using System.Collections.Generic;
using System.ComponentModel;
using System.Runtime.InteropServices;
using System.Security.Principal;
using System.Text;

public class VarroProcessDetails {
  public string executable;
  public string birthIdentity;
  public string listenerSid;
  public string hostSid;
  public string hostBirthIdentity;
  public int ancestorPid;
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
  [StructLayout(LayoutKind.Sequential)]
  struct ProcessBasicInformation {
    public IntPtr reserved1, peb, reserved2a, reserved2b, pid, parentPid;
  }
  [DllImport("ntdll.dll")]
  static extern int NtQueryInformationProcess(IntPtr process, int informationClass,
    ref ProcessBasicInformation information, int length, out int returned);

  static long Created(IntPtr process) {
    long created, exited, kernel, user;
    if (!GetProcessTimes(process, out created, out exited, out kernel, out user))
      throw new Win32Exception(Marshal.GetLastWin32Error());
    return created;
  }
  static void VerifyAlive(IntPtr process, long created) {
    long verifiedCreated, exited, kernel, user;
    uint code;
    if (!GetProcessTimes(process, out verifiedCreated, out exited, out kernel, out user) ||
        verifiedCreated != created || exited != 0 ||
        !GetExitCodeProcess(process, out code) || code != 259)
      throw new InvalidOperationException("Process exited during inspection");
  }
  static string Birth(long created) {
    long ticks = DateTime.FromFileTimeUtc(created).Ticks;
    return "win32:" + (ticks - ticks % 10).ToString();
  }

  static string Owner(IntPtr process) {
    IntPtr token;
    if (!OpenProcessToken(process, 8, out token)) return "";
    try {
      using (var identity = new WindowsIdentity(token)) {
        return identity.User == null ? "" : identity.User.Value;
      }
    } finally { CloseHandle(token); }
  }
  public static VarroProcessDetails Read(int pid, int hostPid, int ancestorPid) {
    IntPtr process = OpenProcess(ancestorPid == 0 ? 0x1000u : 0x1400u, false, pid);
    if (process == IntPtr.Zero) throw new Win32Exception(Marshal.GetLastWin32Error());
    var ancestors = new List<IntPtr>();
    var births = new List<long>();
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
      string hostBirthIdentity = "";
      IntPtr host = OpenProcess(0x1000, false, hostPid);
      if (host != IntPtr.Zero) {
        try {
          long hostCreated = Created(host);
          hostSid = Owner(host);
          VerifyAlive(host, hostCreated);
          hostBirthIdentity = Birth(hostCreated);
        } finally { CloseHandle(host); }
      }
      if (ancestorPid != 0) {
        int currentPid = pid;
        IntPtr current = process;
        long childCreated = created;
        var visited = new HashSet<int>();
        for (int depth = 0; currentPid != ancestorPid && depth < 32; depth++) {
          if (!visited.Add(currentPid)) throw new InvalidOperationException("Cyclic process ancestry");
          var information = new ProcessBasicInformation();
          int returned;
          if (NtQueryInformationProcess(current, 0, ref information,
              Marshal.SizeOf(typeof(ProcessBasicInformation)), out returned) != 0)
            throw new InvalidOperationException("Process ancestry unavailable");
          long parentPid = information.parentPid.ToInt64();
          if (parentPid <= 0 || parentPid > Int32.MaxValue)
            throw new InvalidOperationException("Process does not descend from launch");
          currentPid = (int)parentPid;
          current = OpenProcess(0x1400, false, currentPid);
          if (current == IntPtr.Zero) throw new Win32Exception(Marshal.GetLastWin32Error());
          ancestors.Add(current);
          long parentCreated = Created(current);
          births.Add(parentCreated);
          // A reused parent PID cannot be ancestry proof for an older child.
          if (parentCreated > childCreated)
            throw new InvalidOperationException("Parent process identity changed");
          childCreated = parentCreated;
        }
        if (currentPid != ancestorPid)
          throw new InvalidOperationException("Process does not descend from launch");
        for (int index = 0; index < ancestors.Count; index++)
          VerifyAlive(ancestors[index], births[index]);
      }
      VerifyAlive(process, created);
      // Existing leases use CIM's microsecond precision. Preserve their identity.
      return new VarroProcessDetails {
        executable = name.ToString(),
        birthIdentity = Birth(created),
        listenerSid = listenerSid,
        hostSid = hostSid,
        hostBirthIdentity = hostBirthIdentity,
        ancestorPid = ancestorPid
      };
    } finally {
      foreach (IntPtr ancestor in ancestors) CloseHandle(ancestor);
      CloseHandle(process);
    }
  }
}
'@
while ($null -ne ($line = [Console]::In.ReadLine())) {
  $fields = $line.Split(' ')
  $id = 0
  $processId = 0
  $hostId = 0
  $ancestorId = 0
  if ($fields.Length -ne 4 -or
      -not [int]::TryParse($fields[0], [ref]$id) -or
      -not [int]::TryParse($fields[1], [ref]$processId) -or
      -not [int]::TryParse($fields[2], [ref]$hostId) -or
      -not [int]::TryParse($fields[3], [ref]$ancestorId)) { exit 1 }
  try {
    $details = [VarroProcessInspection]::Read($processId, $hostId, $ancestorId)
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
  private readonly operations = new Map<string, Promise<WindowsProcessDetails>>();
  private readonly pending = new Map<
    number,
    {
      resolve: (details: WindowsProcessDetails) => void;
      reject: (error: Error) => void;
      ancestorPid: number;
    }
  >();
  private idleTimer: ReturnType<typeof setTimeout> | undefined;

  read(pid: number, ancestorPid = 0): Promise<WindowsProcessDetails> {
    if (!Number.isSafeInteger(pid) || pid <= 0 || pid > 0x7fffffff)
      return Promise.reject(new Error('Invalid Windows process ID'));
    if (!Number.isSafeInteger(ancestorPid) || ancestorPid < 0 || ancestorPid > 0x7fffffff)
      return Promise.reject(new Error('Invalid Windows ancestor process ID'));
    const key = `${pid}:${ancestorPid}`;
    const existing = this.operations.get(key);
    if (existing) return existing;
    const operation = this.inspect(pid, ancestorPid).finally(() => {
      if (this.operations.get(key) === operation) this.operations.delete(key);
    });
    this.operations.set(key, operation);
    return operation;
  }

  dispose(): void {
    this.stop(new Error('Windows process inspector stopped'));
  }

  private async inspect(pid: number, ancestorPid: number): Promise<WindowsProcessDetails> {
    if (this.idleTimer) clearTimeout(this.idleTimer);
    this.idleTimer = undefined;
    const worker = this.worker ?? this.start();
    const id = ++this.sequence;
    let timeout: ReturnType<typeof setTimeout> | undefined;
    try {
      return await new Promise<WindowsProcessDetails>((resolve, reject) => {
        this.pending.set(id, { resolve, reject, ancestorPid });
        timeout = setTimeout(() => {
          if (this.worker === worker)
            this.stop(new Error('Windows native process inspection timed out after 5000ms'));
        }, 5000);
        worker.stdin.write(`${id} ${pid} ${process.pid} ${ancestorPid}\n`, (error) => {
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
          if (
            pending.ancestorPid !== 0 &&
            (details.ancestorPid !== pending.ancestorPid ||
              !isString(details.hostBirthIdentity) ||
              !/^win32:\d+$/.test(details.hostBirthIdentity))
          )
            throw new Error('Incomplete Windows ancestry inspection response');
          this.pending.delete(Number(response?.id));
          pending.resolve({
            executable: details.executable,
            birthIdentity: details.birthIdentity,
            listenerSid: details.listenerSid,
            hostSid: details.hostSid,
            hostBirthIdentity: isString(details.hostBirthIdentity)
              ? details.hostBirthIdentity
              : undefined,
            ancestorPid: pending.ancestorPid,
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
