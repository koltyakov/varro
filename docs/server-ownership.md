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

A private `.credentials` companion records connection credentials separately from
process ownership. It contains the actual port, username, password, launch token,
and creation time, but no PID or executable identity. Confirmed launches retain
this companion as a recovery source when a lease is missing. If a healthy launch
cannot be confirmed through OS inspection, enforced credentials can instead
establish attach-only connection and persist this record without inventing process
ownership. Both health-poll and early-launch-exit recovery use this connection
confirmation, rather than requiring lifecycle ownership before attachment.

For older installations with a surviving private marker but no credential-bearing
lease, startup can copy the matching owner-token-bound SecretStorage payload into
the companion under the original claim path. It rechecks the record's owner and
port before copying and still verifies enforced authentication before attachment.
A vault payload for another launch is rejected. A private lease or companion
already carrying credentials skips this vault lookup entirely.

The parent directory is Varro's shared state root. Session annotations use its
`opencode-v2/` subdirectory and provider quota coordination uses
`provider-quota-v2/`. See [local state files](usage.md#local-state-files) for native
paths, legacy compatibility links, and read-only usage reporting. Existing session
and quota directories are not copied while old writers may still be using them.

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

An OpenCode v2 CLI upgrade can replace a Varro-launched shared service and retain
its password while changing the PID and random port. Automatic discovery recovers
this replacement without adoption consent only when a private Varro lease carries
the exact discovered credentials, its original process is conclusively retired,
and the replacement has the same executable identity. Account inspection must not
identify another OS user. Unavailable account evidence does not erase the proven
Varro provenance or trigger connection consent; it is not recorded as same-user.
An anonymous `/api/info` request must be rejected and a request using the Varro
lease credentials must return the verified listening PID. Account and process
identity are checked again before publication under the original claim path.
Random ports or OpenCode's own service registration alone do not grant ownership.

When several retired Varro leases share those credentials, recovery selects the
newest lease with a deterministic path tie-break. A matching live or uncertain
original process blocks replacement recovery. The new process receives a new
ownership token so late cleanup from its former host cannot remove its records.
Retired injected configuration is not attributed to the replacement. Other live
services, credentials, and sessions are left unchanged.

A recovered replacement without runtime configuration is checked for Varro's Ask
agent. If no user definition exists and the owned server is globally idle, startup
relaunches it with a fresh temporary config before publishing routing catalogs.
Recovery checks work again under verified restart ownership. If sessions, questions,
or approvals block startup repair, catalog/send preflight and maintenance retry it;
an idle event bypasses the ordinary maintenance throttle while repair is pending.
This does not edit global/project configuration, invent a client-only agent, or
grant restart rights over another host's or an unmanaged server.

## Editor distributions and test isolation

VS Code, VS Code Nightly/Insiders, VSCodium, and Varro OpenJet coordinate through
the same production paths for the same OS user and state directory. Editor names
and Varro patch versions must not create separate ownership authorities for one
server. Compatible builds retain the version-1 lease and existing legacy paths.

AI and sandbox launchers instead supply an absolute `VARRO_TEST_STATE_ROOT` inside
their disposable profile. Server records live in its `servers/` directory; v2
annotations and session locks live in `opencode-v2/`; quota coordination uses
`provider-quota-v2/`. Test discovery never falls
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

Windows can temporarily return `EPERM` when scanning a lock directory during
release. Annotation writers retry that contention within the existing ten-second
acquisition deadline and honor cancellation. An unreadable lock is never treated
as empty or as evidence that its owner is dead; persistent errors remain the
timeout's cause.

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

When a live marker or lease blocks startup, the error includes the expected PID
and port, observed listener PIDs, or the mismatching executable/start identity.
It does not include lease credentials or ownership tokens. An explicit restart
failure is reported through the error hub even if startup already left the server
in an error state, with a Show Output action. This feedback does not relax process
verification or authorize stopping an unverified server.

Ownership refresh and editor disconnect retain the lease, credentials, marker,
and temporary configuration when listener or executable verification fails but
the original process is still alive or its retirement is uncertain. A failed
inspection is not proof of retirement. Cleanup requires process exit or a changed
birth identity; subsequent attachment still needs fresh complete verification.

Reload recovery also retains its in-memory lease candidate until ownership is
recovered or another live editor's ownership is verified. An inconclusive read
does not delete the lease or prevent a subsequent fresh recovery attempt. Before
showing an authentication prompt, startup rechecks registration once so a lease
published during editor handoff can supply verified credentials and prevent an
incorrect external-server classification. Restart waits for pending ownership
preparation before rejecting an attach-only connection.

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

Reused servers never run implicit server-family migration. Only the window holding
verified ownership of a reused server runs the same-family background CLI update, so
windows sharing one server do not race installers and a reload does not disable
automatic updates. Maintenance can then restart a reused Varro-owned server when the
installed CLI is newer within the same API family, after fresh lease/process
verification and the existing global active-session and pending-attention preflight.
Unmanaged servers, another live host's ownership, unknown or cross-family versions,
and failed safety reads skip installation and leave the server running. Explicit
restart retains its existing safety checks. Reload disconnects rather than stopping
the process. A surviving registered server is recoverable, not a stale process to
kill based on age.

The About view mirrors this: a managed server with automatic updates enabled reports
that Varro installs the update itself, with the manual command as an optional
shortcut. A newer installed CLI on a managed server is reported as a pending idle
restart. Unmanaged servers and disabled automatic updates show the manual command.

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
ownership use distinct native modal warnings for unregistered servers. A Varro-started
server reconnects quietly when fresh verification of its private lease identifies
the exact sole listener, executable, and process birth identity, even if account
inspection is unavailable. This does not invent same-user evidence or grant new
lifecycle rights. Positive different-user evidence still requires consent. Dismissal
leaves the server untouched.
Admission rechecks discovery registration before consent when no lease was loaded,
including records published during editor handoff or stored under another port key.
A surviving private Varro marker with the same complete listener identity also
admits quietly before background ownership preparation recreates its missing lease.
Each strict admission and reconnect revalidates that marker and the sole listener;
this attachment check does not write records or claim lifecycle ownership.
Recreating a missing lease preserves discovered credentials only for that verified
endpoint. Background editor ownership handoff does not invalidate attachment when
the launch token, listener PID, executable, and birth identity remain unchanged.
A migrated automatic-mode user can instead choose to start their own server on
another port, but cannot abandon a registered live process through this action.

After a reboot or process replacement, the saved PID or birth identity can differ.
Varro reconnects quietly on the exact saved port when the private lease credentials
still work and the server rejects both anonymous requests and an incorrect password.
The authenticated response must identify a supported OpenCode API family, and the
lease's port and credentials must remain unchanged through verification. These
read-only probes have a three-second total deadline and honor startup cancellation.
Unavailable process inspection can use the same fallback. Positive different-user
account evidence still requires consent.

Credential-only reconnection is attach-only. It never updates the old lease or
marker, claims the replacement process, repairs runtime configuration, or grants
stop, restart, upgrade, or cleanup rights. Ordinary requests retain strict bounded
verification rather than reusing PID-based connection confirmation; SSE reconnects
recheck enforced credentials. Endpoint or saved-credential changes revoke attachment.

Automatic discovery can also recover a changed service port when its exact
username and password match a private Varro lease or credential companion. The
discovered endpoint must be loopback and must enforce those credentials. Failed
Windows process inspection, changed process ancestry, or a still-live old listener
does not block this read-only fallback. It grants no authority over either process
and leaves the old lease and marker unchanged. An explicitly configured integer
port never follows a different service port. A valid old registration must not
replace the endpoint already selected by discovery.

Consent binds to the observed PID, birth identity, account, and endpoint. Initial
attachment and stream reconnect inspect fresh evidence. Foreign, unknown, and
incomplete identities retain the strict one-second request-admission cache.
For unregistered servers, unknown-owner consent covers only the current connection
and requires a new decision on reconnect. Concurrent callers share the decision; disposal invalidates late
answers. Refusal blocks subsequent requests rather than starting retry prompts.

Once the running connection has a complete same-user PID/birth/account identity,
routine REST traffic reuses that confirmed connection. A managed lease must identify
the same PID and birth identity. The request path checks the endpoint, registration,
admission identity, and process liveness without starting OS inspection commands.
Full listener/account and managed-identity checks run independently in the background
every thirty seconds, with no overlapping scans. Slow, failed, or inconclusive
background reads are diagnostics, not proof of replacement or server failure. They
do not hold up sends, prompt for consent, stop SSE, or hide the chat.

Confirmed process exit, changed registration/endpoint, fresh PID/birth/account change,
disconnect, and SSE reconnect invalidate reuse. The next request then needs fresh
admission even if an old one-second cache has not expired. Background results and
outstanding confirmations are generation-bound and cannot restore a reset connection.
Adapter tickets remain endpoint-bound and expire after at most one second. This is
connection-lifetime attachment monitoring, not a permanent PID-only ownership cache.
It does not grant adoption, restart, upgrade, or cleanup authority; those operations
still verify the current private registration and process identity independently.

A port with no visible listener whose loopback connection is refused has no account
to consent to. Account inspection reports it as not listening instead of unknown, so
a stopped or restarting server never produces the unknown-owner warning. A port that
accepts connections while process inspection shows no listener, such as another
user's process hidden from `lsof`, remains unknown and keeps the consent rules below.

Every window attached to a Varro-registered server follows that registration across
restarts. When the registered listener closes or is replaced, or the event stream
degrades after the registered PID exits (a signal-0 probe, no OS inspection command),
a non-owning window uses the same bounded restart path as the owner. It resets
admission, which also cancels any consent prompt an in-flight check could reach,
reports `stopped`, and reruns startup. Startup rereads the registration and waits on
the launch claim, so the window reattaches to the owner's replacement under the same
quiet same-user admission. Non-owning windows wait one extra second before their
first attempt so the owning window normally relaunches. If no live owner relaunches,
one contender launches under the claim and the rest reuse its registration. A
reattached connection restores its crash-retry budget after the usual stability
window. External endpoints and consented foreign or unknown connections are never
relaunched implicitly; a closed external endpoint reports a connection error.

Before requesting new uncertainty consent, admission retries one fresh account
inspection. Strict request rechecks inspect at least every second, but persistent
uncertainty does not repeat an already approved warning within that connection.
Registered unknown-account connections instead revalidate their private Varro lease
and complete listener identity on every strict admission and reconnect. They never
transfer that provenance into uncertainty consent if the registration disappears.
Newly identified foreign listeners still require consent. If inspection recovers
to verified same-user evidence after the dialog, admission uses that fresh evidence
instead of treating recovered visibility as listener replacement. A changed known
identity still blocks confirmation. Generation and endpoint changes invalidate
each inspection and dialog result before further use.

On macOS, a timed-out `lsof` listener scan retries one fresh scan with a five-second
deadline after the ordinary two-second deadline. Failed command output is never
accepted as a complete listener set. Concurrent ownership/account scans share only
their in-flight observation. A persistent timeout during initial/fresh admission
blocks that request without granting unknown-account consent or stopping the server.
An established confirmed same-user connection continues while background inspection
recovers. SSE admission retries with its normal reconnect backoff.
Actual unknown or foreign account evidence still follows the consent rules above.

On Windows, ordinary listener checks use `netstat` first, with PowerShell networking
discovery only when `netstat` fails. A shared read-only helper obtains executable,
creation identity, and token SIDs using Windows APIs, holding the process handle
through its final liveness check. Concurrent reads share only their in-flight
observation; no PID-only identity cache is introduced. Creation ticks match existing
CIM leases. Strict admission keeps its one-second cache and fresh reconnect checks;
complete same-user running connections use the background monitoring described above.
If native inspection is unavailable, fresh PID-reuse-checked CIM snapshots remain
the bounded fallback, with one retry for failed or incomplete executable/account
reads. Persistent failures still block fresh admission and retain records, but do not
revoke an established connection without evidence of replacement. Strict admission
tickets expire at the earlier original verification expiry; confirmed-connection
tickets last at most one second. Neither transfers approval to another endpoint.

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
questions, permissions, and shells in the server's loaded locations. Historical
session directories are used only to label blockers, not for filesystem probes or
location initialization, so deleted paths and unavailable UNC shares do not prevent
an idle restart. Loaded locations are checked even when absent from session history
or no longer accessible on disk. Running sessions and observed pending attention
still block restart. Invalid location lists and failed loaded-location reads block
restart rather than treating missing evidence as idle. V1 retains historical
directory probing because its session status is location-scoped.

## Verification

`src/extension/open-code-process.test.ts` covers competing windows, host crashes,
disconnect/recovery, transferred process references, per-platform identities,
Linux PID reuse across boots, inspection failure, and concurrent writes. These
tests use isolated filesystem fixtures and mocked OS commands. Native Windows
and Linux execution remains a separate verification step.

Native Linux reconnect coverage also runs `opencode-startup.integration.test.ts`
against released OpenCode 2.0.24 in an isolated Linux ARM64 container. The editor-
reload and missing-lease marker-recovery cases each reconnect three times, both
with normal inspection tools and with only procfs available. They check zero
consent prompts, unchanged listener PID and credentials, retained session catalog,
and a healthy event stream. Evidence is retained under
`artifacts/ai-test-data/linux-reconnect-native/fixed/`. This verifies host startup
and transport behavior, not the native VS Code UI or native Windows execution.

The same Linux fixture also exercises `reboot-reconnect`: it stops only its isolated
server, retains the prior lease, and starts a new process with the same port,
credentials, and database. Three reconnects verify the changed PID, retained session
catalog, healthy SSE, zero prompts, and attach-only lifecycle behavior. OpenCode
2.0.24 passes both procfs-only and normal-tool runs; evidence is under
`artifacts/ai-test-data/linux-reconnect-native/same-port-v2-probes/`, including
redacted HTTP probe observations. The fixture disconnects its old editor, disables
that editor's exit-cleanup callback to model host loss, and kills only its verified
isolated launch and listener. This simulates the persisted process replacement,
not an actual machine reboot.

OpenCode 1.18.34 also passes editor reload and same-port process replacement with
both procfs-only and normal-tool inspection, for twelve reconnects without prompts.
Evidence is under `artifacts/ai-test-data/linux-reconnect-native/same-port-v1-verified/`.
V1 uses its original coordination path because it has no v2 shared-service discovery.
Graceful V1 disposal encountered a separate listener-inspection failure in earlier
runs; the abrupt-loss fixture does not establish a graceful-shutdown fix. See the
run ledger at `artifacts/ai-test-data/linux-reconnect-native/same-port-verification.md`.

Additional real-server checks inject failed lifecycle ownership confirmation during
fresh startup, then reload three times using the independent credential companion.
V2 also replaces that unowned fixture on another port and reattaches twice without
consent or restart rights. These scenarios pass with procfs-only and normal Linux
tools for OpenCode 2.0.24; V1 startup/reload cases pass on 1.18.34. The OS-inspection
failure is injected, so this is not native PowerShell or Windows UI verification.
Evidence and the reported Windows failure analysis are in
`artifacts/ai-test-data/linux-reconnect-native/windows-attachment-verification.md`.

Connection-admission tests cover concurrent consent, dismissal, listener replacement,
uncertain ownership, reconnect, and cancellation during ordinary requests. Follow
recovery tests cover a refused port, a replaced registered listener, an exited
registered PID on stream degradation, a live PID, and a closed external endpoint,
each without a consent prompt. The
startup integration test checks authentication enforcement, second-window attachment,
disconnect/automatic-mode rediscovery, and explicit restart using isolated databases.
Its latest macOS run passes against released OpenCode 1.16.0 and 1.18.34.
OpenCode 2.0.22 passes configured startup and shadowed discovery, but replacement
recovery hits a 30-second health timeout. A focused rerun against 2.0.21 also
reproduces that timeout, despite the previous matrix passing on that release.
OpenCode 2.0.5 passes configured startup and shadowed discovery, but replacement
recovery attaches as unmanaged because that path still probes `/api/info` instead
of the older `/api/status` endpoint.
See `artifacts/opencode-adapters/verified.json` for the retained run logs. This is
not native Windows/Linux, cross-user, rollback-editor, or live-session UI verification.

State-isolation tests cover identical session IDs with a held normal-editor lock,
four independent annotation writers, per-platform claim paths, and legacy Node
home/temp resolution. A macOS source-level contention check also ran two writers
from revision `06a9a611` alongside two current writers and preserved all 100 fields.
Evidence is in `artifacts/ai-test-data/mixed-version-locks-brIMTg/result.json`.
These checks do not establish native editor-distribution or Windows/Linux coverage.
