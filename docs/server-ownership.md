# OpenCode server ownership

Varro identifies a managed server independently of the VS Code window that started
it. Connecting to a server, including a registered OpenCode v2 service, does not
by itself grant ownership or permission to stop it.

## Shared records

New server leases and ownership markers use a per-user directory shared by VS Code
windows and builds using this implementation:

- macOS: `~/Library/Application Support/Varro/servers/`
- Linux: `$XDG_STATE_HOME/varro/servers/`, defaulting to `~/.local/state/varro/servers/`
- Windows: `%LOCALAPPDATA%\Varro\servers\`, defaulting to `~/AppData/Local/Varro/servers/`

Each configured port has a `varro-opencode-server-<port>.json` lease, a `.managed`
server marker, and a short-lived `.claim` coordination file. The lease records
the actual listening port, including fallback ports. These files do not depend
on a workspace, VS Code profile, or extension ID.

An existing valid lease in the older temporary-directory location remains the
coordination point for that process. It is not moved while older windows may
still use it. Once that lease is retired, newly constructed managers select the
per-user directory.

## Process identity and recovery

A lease records the listening PID, executable, process start identity, a server
nonce, and the extension host's identity. PID alone is insufficient because the
OS can reuse it.

- Windows uses process creation ticks and case-insensitive executable paths.
- macOS uses the process start date and executable path.
- Linux uses process start ticks and the boot ID when available. Legacy tick-only
  records can match within the current boot. An executable's ` (deleted)` suffix
  after a binary replacement does not invalidate the running process.

A live host's lease is observed by other windows. After disconnect or host exit,
one contender can claim the server after validating its process identity.
Explicit restarts coordinate ownership transfer with the same claim file.
Startup confirmation and disconnect handoff also participate in that coordination.

Maintenance rechecks the persisted lease instead of trusting cached ownership.
A former host's retained `ChildProcess` reference does not authorize stopping a
server or removing its files after another window takes ownership.

Leases and markers are written through unique temporary files and atomic rename.
Transient Windows replacement failures are retried without truncating the live
record. A failed parse does not authorize a reader to delete the file. Failed
process inspection preserves ownership evidence for a later retry.

## Verification

`src/extension/open-code-process.test.ts` covers competing windows, host crashes,
disconnect/recovery, transferred process references, per-platform identities,
Linux PID reuse across boots, inspection failure, and concurrent writes. These
tests use isolated filesystem fixtures and mocked OS commands. Native Windows
and Linux execution remains a separate verification step.
