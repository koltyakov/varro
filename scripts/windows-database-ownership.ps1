param([Parameter(Mandatory = $true)][string]$Database)

$ErrorActionPreference = 'Stop'
Add-Type -TypeDefinition @'
using System;
using System.ComponentModel;
using System.Runtime.InteropServices;
using System.Text;

public static class VarroDatabaseOwners {
  [StructLayout(LayoutKind.Sequential)]
  public struct UniqueProcess {
    public uint ProcessId;
    public System.Runtime.InteropServices.ComTypes.FILETIME StartTime;
  }
  [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
  public struct ProcessInfo {
    public UniqueProcess Process;
    [MarshalAs(UnmanagedType.ByValTStr, SizeConst = 256)] public string AppName;
    [MarshalAs(UnmanagedType.ByValTStr, SizeConst = 64)] public string ServiceName;
    public uint ApplicationType;
    public uint AppStatus;
    public uint SessionId;
    [MarshalAs(UnmanagedType.Bool)] public bool Restartable;
  }
  [DllImport("rstrtmgr.dll", CharSet = CharSet.Unicode)]
  static extern int RmStartSession(out uint session, uint flags, StringBuilder key);
  [DllImport("rstrtmgr.dll", CharSet = CharSet.Unicode)]
  static extern int RmRegisterResources(uint session, uint fileCount, string[] files,
    uint appCount, UniqueProcess[] apps, uint serviceCount, string[] services);
  [DllImport("rstrtmgr.dll")]
  static extern int RmGetList(uint session, out uint needed, ref uint count,
    [In, Out] ProcessInfo[] processes, ref uint reasons);
  [DllImport("rstrtmgr.dll")]
  static extern int RmEndSession(uint session);

  public static uint[] Read(string file) {
    uint session;
    int error = RmStartSession(out session, 0, new StringBuilder(33));
    if (error != 0) throw new Win32Exception(error);
    try {
      error = RmRegisterResources(session, 1, new[] { file }, 0, null, 0, null);
      if (error != 0) throw new Win32Exception(error);
      uint needed, count = 0, reasons = 0;
      ProcessInfo[] processes = null;
      for (int attempt = 0; attempt < 4; attempt++) {
        error = RmGetList(session, out needed, ref count, processes, ref reasons);
        if (error == 0) {
          uint[] result = new uint[count];
          for (int i = 0; i < count; i++) result[i] = processes[i].Process.ProcessId;
          return result;
        }
        if (error != 234) throw new Win32Exception(error);
        count = needed;
        processes = new ProcessInfo[count];
      }
      throw new InvalidOperationException("Database owners kept changing during verification");
    } finally {
      RmEndSession(session);
    }
  }
}
'@

# Read-only ownership inspection. Never call Restart Manager shutdown/restart APIs.
$owners = @([VarroDatabaseOwners]::Read($Database))
$listeners = @(Get-NetTCPConnection -State Listen | ForEach-Object {
  @{ address = $_.LocalAddress; port = $_.LocalPort; pid = $_.OwningProcess }
})
@{ databaseOwners = $owners; listeners = $listeners } | ConvertTo-Json -Depth 3 -Compress
