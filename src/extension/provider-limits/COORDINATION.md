# Same-machine quota coordination

Adapters opt in through the optional `coordinate` callback. Each adapter resolves its
request inputs once, then passes an identity tuple and a poll closure using those same
inputs. The service does not maintain a second credential resolver. The coordinator
hashes the provider ID and JSON-encoded tuple; tuple boundaries are unambiguous.

Supported identities:

- OpenRouter: fixed auth-key endpoint and exact resolved OAuth/API/configured key.
- OpenAI subscriptions through Codex: both fixed usage/reset-credit endpoint pairs,
  exact access token and account ID used in both account headers. Resolution retains
  auth-store OAuth, then Codex auth.json, then CODEX_TOKEN precedence. API-key OpenAI
  probes remain local. JWT claims are not used as an account-sharing shortcut.
- Anthropic OAuth: fixed usage endpoint and exact resolved access token, from the
  OpenCode auth store or Claude credentials file. Statusline and local proxy results
  are read outside coordination, never published under an OAuth credential identity.
  Their merge/early-return behavior remains local and preserves source timestamps.
  File-backed OAuth refresh runs while holding coordination ownership. Credentials
   are re-read after acquisition. Rotation aborts that lookup without publication or
   observation; the next demand resolves the new identity outside the old lock.
   The identity-change signal also bypasses process-local fallback caching. Refresh
   initiated by the lock holder still runs normally under its captured identity.
- Claude Code IPC: validated literal-loopback descriptor URL and exact bearer token.
  Requests still reject redirects. Different bridge ports, paths or tokens do not
  share, even if the bridges happen to use the same subscription. The descriptor
  identifies a bridge, not its underlying account. A bridge that switches accounts
  without rotating its descriptor can retain the previous quota for the normal TTL.

Models using identical resolved request identities share polling. Explicit metadata
and auth-store reads for these provider IDs happen before each new shared lookup.
External credential reads happen in the adapters. In-flight requests keep their
captured identity; subsequent requests observe rotation. No successful shared result
is retained behind a process-local TTL. Non-opted-in adapters remain process-local.

Windows uses local fetching and local cache/backoff, without shared files, because
POSIX modes cannot validate Windows ACLs. Unsafe or unavailable POSIX storage falls
back to process-local single-flight polling and cooldowns without modifying unsafe
files. Remote extension hosts coordinate on their own
machine, not the VS Code UI machine. The authorized workspace directory scopes
metadata, console fallback and auth updates; the default call uses the server default.

`~/.varro-provider-quota-v2` and credential-digest subdirectories require owner-only
0700 permissions. Snapshots are bounded, validated regular 0600 files, published by
exclusive temporary files and atomic rename.

Persisted data contains only numeric quotas, timestamps, fixed outcomes, backoff,
reviewed window IDs/labels/units and allowlisted plan names. Reset-credit counts and
up to 32 expiration timestamps survive sharing; titles become the fixed "Full reset".
Raw notes, arbitrary plan names/labels, responses, credentials, account IDs, endpoint
URLs, model names and workspace paths are not written. Unknown window IDs return
live results without publishing a snapshot, so new provider schemas do not stop
limits but also do not gain shared caching until reviewed. This is not a security
boundary against processes running as the same OS user. The home and filesystem
must be local and trusted. Network filesystems and containers sharing a home but not
a PID namespace are unsupported.

Lock acquisition builds a private candidate directory containing a PID/UUID owner,
then atomically renames it to `lock`. POSIX rename cannot replace a nonempty lock.
An empty lock left during release/recovery is safe to replace because holders always
publish a populated directory. Only confirmed ESRCH allows eviction of an owner,
never age alone. Removing that exact owner grants the right to rmdir its directory;
a successor's nonempty directory cannot be removed by a competing recoverer.

Live or reused PIDs and malformed nonempty locks are not evicted. These can still
require manual cleanup after all relevant extension hosts stop. Crashes before
acquisition can leave orphan candidate directories; crashes during publication can
leave temporary snapshots. These are inert, not automatically garbage-collected.
There is no heartbeat lease or protection against an untrusted same-user writer.
Contenders wait at most 32 seconds. A poll owner retains its lock until the adapter
settles, including credential writes; a timeout race would not cancel those writes.
Individual HTTP requests have abort deadlines. The service allows 45 seconds for
preparation, lock waiting and result delivery. A genuinely hung adapter retains its
lock until it settles or the process exits rather than allowing overlapping refreshes.

Successful snapshots expire after 30 seconds. Errors share a 15-second retry delay;
429 responses share exponential 60-second through one-hour backoff. Unsupported
responses retry after 60 seconds. Non-429 responses reset backoff. Retry-After is not
exposed by adapters and is not honored. Last-good data keeps its original checkedAt
and is served for at most 15 minutes following errors. Old files may remain on disk
but expired quota data is not served. Clearing one host's cache does not erase shared
cooldowns. Readers always check the shared file.

Provider requests remain demand-driven. Webviews poll every 30 seconds while any
known session uses the selected provider, including while the sidebar is hidden,
or every 120 seconds while visible and idle. A completion refresh follows after
31 seconds to allow the successful cache TTL to expire.

One host timer reconciles recently requested shared snapshots every two seconds
without fetching providers. A bounded set of observations expires after five idle
minutes and is cleared on invalidation/disposal. Narrow `provider-limit/updated`
messages update matching workspaces after credential and generation checks. This
lets idle windows receive another host's active-provider updates between polls.
Codex and Anthropic supply cheap asynchronous identity validators that re-resolve
external credentials at delivery, including Codex account headers, without network
requests. Each new demand clears the previous observation for its scope. Anthropic
disables raw API observation when a local status is merged or a local proxy is
configured, so intermediate shared data cannot replace the final local result.
The UI rejects older snapshots and displays source age and stale fallback notes.
