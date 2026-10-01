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

After OpenCode shared-service discovery, Varro rechecks ownership records before
classifying the endpoint as external. A matching lease or marker under another
configured-port key is verified against the listening PID, executable, and process
start identity. Varro keeps using that record's original lease/marker/claim path;
it does not copy a live registration into the automatic key. A live owning editor
remains the owner, while other editors report the server as managed by Varro.
Conflicting matching registrations block recovery rather than creating another
ownership authority. About/diagnostics wait for the pending ownership preparation
so they do not show a transient unmanaged result.

## Editor distributions and test isolation

VS Code, VS Code Nightly/Insiders, VSCodium, and Varro OpenJet coordinate through
the same production paths for the same OS user and state directory. Editor names
and Varro patch versions must not create separate ownership authorities for one
server. Compatible builds retain the version-1 lease and existing legacy paths.

AI and sandbox launchers instead supply an absolute `VARRO_TEST_STATE_ROOT` inside
their disposable profile. Server records live in its `servers/` directory; v2
annotations and session locks live in `opencode-v2/`. Test discovery never falls
back to production or legacy temp records, even for the same port or session ID.
A test endpoint without an isolated state root fails before default state access.
This complements, rather than replaces, database isolation and endpoint checks.

Launchers also isolate `HOME`, `USERPROFILE`, `LOCALAPPDATA`, `XDG_STATE_HOME`,
`TMPDIR`, `TMP`, and `TEMP` so older builds see fixture-only paths. Independent
AI profiles use independent roots.

Compatible v2 annotation writers share the `<sessionID>.json.lock` directory.
The owner marker contains a PID and random UUID, not an editor or version label.
Cross-process locking was introduced in revision `06a9a611`, with package version
`0.30.11`. Earlier writers ignored these locks. Update those builds before editing
the same session's annotations concurrently; a newer client cannot stop an old
binary from ignoring a lock. Do not delete live locks or split production state
by editor to hide this limitation.

## Process identity and recovery

A lease records the listening PID, executable, process start identity, a server
nonce, and the extension host's identity. PID alone is insufficient because the
OS can reuse it.

- Windows uses process creation ticks and case-insensitive executable paths.
- macOS uses the process start date and executable path. If replacing the binary
  leaves `lsof` reporting a nonexistent path, Varro resolves the launch path from
  `ps` before comparing executable identities. The listening PID and process start
  date must still match.
- Linux uses process start ticks and the boot ID when available. Legacy tick-only
  records can match within the current boot. An executable's ` (deleted)` suffix
  after a binary replacement does not invalidate the running process.

A live host's lease is observed by other windows. After disconnect or host exit,
one contender can claim the server after validating its process identity.
Explicit restarts coordinate ownership transfer with the same claim file.
Startup confirmation and disconnect handoff also participate in that coordination.

## Automatic ports and upgrade compatibility

`varro.server.port` defaults to `"auto"`. New managed launches choose a random
loopback port in 49152-65535 and retry collisions a bounded number of times.
The actual port is persisted in the existing lease. An explicit integer setting
never selects another port or redirects to a differently registered v2 service.

Automatic mode retains the default `varro-opencode-server-4096.json` coordination
key. The number in that filename is a compatibility key, not the listening port.
Do not replace it with an independent automatic-mode lock while a process lives.
Older clients and rollback builds already recover its recorded actual port.
New leases remain version 1 and add optional `portMode` and `username` fields.

On upgrade, validated existing leases and surviving managed markers are reused
in place, including legacy temp paths and inherited fallback ports. Existing
integer settings retain fixed-port intent, even when explicitly set to 4096.
An old fallback is grandfathered for its live process; subsequent explicit
launches cannot fall back. A new automatic-mode lease at a different port is not
silently adopted by a newly configured fixed-port client.

Fresh installations do not probe 4096. Existing installations identified by the
previous first-activation marker retain their old default-endpoint discovery,
so same-user manually launched servers can continue. This decision is persisted
before the new first-activation marker is written. Very old or reset editor
profiles without that marker can still recover leases, but manual connections
without any registration need an explicit port setting.

Initial launches acquire the same claim before spawning and re-read registration
after acquiring it. The claim stays held through listener confirmation and lease
publication. Cancellation and failed startup release it. A live but unhealthy or
unverifiable registered process blocks replacement. Corrupt or unreadable leases
are retained and reported, not interpreted as absent. Process identity mismatch
does not authorize signalling the replacement PID.

Retirement also clears matching in-memory ownership, not just the startup lease
candidate. Otherwise a previously observed server can reject requests to a newly
discovered service at another port. Missing files do not prove retirement: cached
identity is revalidated first. This check does not delete records or stop a process.

After a registered process exits, automatic mode chooses a new random port rather
than inheriting its old fixed port. Each new launch rechecks the installed CLI and
prefers a verified v2 executable when no command is configured. Discovery checks
later candidates when an earlier `opencode2` command actually runs v1. A connected
server's version is not evidence of the installed executable's version and does
not select launch flags.

Reused servers are excluded from background CLI
maintenance for that connection, avoiding a migration-triggered restart or family
switch. Their configuration and credentials are unchanged. Explicit restart remains
subject to the existing active-session and pending-attention preflight. Reload
disconnects rather than stopping the process. A surviving registered server is
recoverable, not a stale process to kill based on age.

New launches use an existing nonempty environment password or generate a
cryptographically random password before spawning. Credentials never enter the
command arguments or webview. Managed credentials are also copied to VS Code
secret storage with their launch owner token. Reads validate that token against
the verified registration. The private lease credential remains necessary for
older builds and editor profiles/installations that do not share secret storage.
Missing secret storage is not permission to retry without authentication.

## Connection admission

Before ordinary REST requests, event subscriptions, cleanup, or incompatible-server
remediation, attachment checks the listener's OS account in the workspace
extension host. Verified same-user attachment is quiet. Different-user and unknown
ownership use distinct native modal warnings. Dismissal leaves the server untouched.
A migrated automatic-mode user can instead choose to start their own server on
another port, but cannot abandon a registered live process through this action.

Consent binds to the observed PID, birth identity, account, and endpoint. Ownership
is rechecked on stream reconnect and ordinary requests using a one-second inspection
cache. Unknown-owner consent covers only the current connection and requires a new
decision on reconnect. Concurrent callers share the decision; disposal invalidates
late answers. Refusal blocks subsequent requests rather than starting retry prompts.

Manual servers and consented foreign or unverifiable connections remain attach-only even
with auto-start enabled. They cannot be adopted or restarted and do not run automatic
local recycle-bin cleanup. Existing permission and question recovery remains unchanged.

These checks prevent accidental attachment, not hostile-server impersonation. A
supplied Authorization header does not prove that authentication is enforced.
Account inspection proves the visible listener's account, not the backend account
behind Docker, SSH forwarding, or another proxy. Ambiguous listeners and denied
inspection are unknown. Native cross-user checks and Windows ACL inheritance still
require platform validation. Private POSIX records are checked for owner, permissions,
and symlinks; new records use private directories, exclusive temporary files, and
atomic replacement.

Maintenance rechecks the persisted lease instead of trusting cached ownership.
A former host's retained `ChildProcess` reference does not authorize stopping a
server or removing its files after another window takes ownership.

Leases and markers are written through unique temporary files and atomic rename.
Transient Windows replacement failures are retried without truncating the live
record. A failed parse does not authorize a reader to delete the file. Failed
process inspection preserves ownership evidence for a later retry.

A surviving legacy temporary-directory marker remains a recovery source when its
lease is missing. Recovery validates the marker's process identity before claiming
the server.

Restart preflight checks v2's process-global active sessions before inspecting
location-scoped questions and permissions. It skips deleted historical directories
that would fail location initialization. Running sessions and observed pending
attention still block restart even when their directory has been deleted. Other
inspection errors continue to block restart.

## Verification

`src/extension/open-code-process.test.ts` covers competing windows, host crashes,
disconnect/recovery, transferred process references, per-platform identities,
Linux PID reuse across boots, inspection failure, and concurrent writes. These
tests use isolated filesystem fixtures and mocked OS commands. Native Windows
and Linux execution remains a separate verification step.

Connection-admission tests cover concurrent consent, dismissal, listener replacement,
uncertain ownership, reconnect, and cancellation during ordinary requests. The
startup integration test checks authentication enforcement, second-window attachment,
disconnect/automatic-mode rediscovery, and explicit restart using isolated databases.
It passes on macOS against released OpenCode 1.16.0, 1.18.33, 2.0.5, and 2.0.20.
See `artifacts/opencode-adapters/verified.json` for the retained run logs. This is
not native Windows/Linux, cross-user, rollback-editor, or live-session UI verification.

State-isolation tests cover identical session IDs with a held normal-editor lock,
four independent annotation writers, per-platform claim paths, and legacy Node
home/temp resolution. A macOS source-level contention check also ran two writers
from revision `06a9a611` alongside two current writers and preserved all 100 fields.
Evidence is in `artifacts/ai-test-data/mixed-version-locks-brIMTg/result.json`.
These checks do not establish native editor-distribution or Windows/Linux coverage.
