# Onboarding Verification

This guide covers first-run and recovery testing across the real VS Code Extension Host, the
browser webview harness, unit tests, and Windows CI.

## VS Code Sandbox

Run the complete disposable Extension Host matrix:

```sh
npm run test:vscode-sandbox
```

The runner builds Varro, launches each scenario in a separate VS Code window with isolated user
data, extensions, workspace settings, and global state, and removes the sandbox afterward. It uses
a fake OpenCode CLI/server and does not modify or stop the user's installed OpenCode CLI. On macOS,
the disposable instances launch hidden in the background so they do not steal keyboard focus.

Run one or more scenarios by name:

```sh
npm run test:vscode-sandbox -- clean-install-missing-cli
npm run test:vscode-sandbox -- startup-process-exit port-conflict-fallback
node scripts/vscode-sandbox/run.mjs --list
```

Set `VARRO_VSCODE_EXECUTABLE` to select another VS Code-compatible application binary. This must
be the GUI test executable (`Code`, `Code.exe`, or the Linux `code` binary), not the `code` command
management shim on macOS. Set `VARRO_KEEP_VSCODE_SANDBOX=1` to retain generated profiles for
inspection.

The Extension Host matrix covers:

| Scenario | Simulated condition | Expected outcome |
| --- | --- | --- |
| `clean-install-missing-cli` | Empty profile, isolated home/PATH, and deterministic missing-CLI simulation | First reveal starts onboarding and reports install guidance |
| `invalid-cli-path` | `varro.server.command` points to a missing file | Reports the configured path instead of generic install guidance |
| `auto-start-disabled` | No server and automatic startup disabled | Reports the manual `opencode serve` recovery path |
| `version-command-failure` | `opencode --version` exits with an error | Continues startup and reports the diagnostic in About |
| `malformed-cli-version` | `opencode --version` returns no parseable version | Uses the healthy server while reporting that the CLI version is unavailable |
| `startup-process-exit` | CLI version succeeds but `serve` exits | Retries and reports startup diagnostics |
| `runtime-crash-recovery` | A healthy managed server exits unexpectedly | Restarts the server and returns to a healthy event stream |
| `event-stream-failure` | Health remains available but the global event endpoint fails | Keeps the server usable while reporting a degraded event stream |
| `port-conflict-fallback` | Configured port is occupied by another HTTP process | Moves to a nearby port and reaches healthy state |
| `required-update-disabled` | CLI is below the supported floor and updates are disabled | Blocks startup with the update setting guidance |
| `required-update-failure` | Required CLI update encounters a network failure | Reports install-aware update recovery |
| `required-update-no-change` | Updater exits successfully but leaves the old CLI in place | Rejects the false success and explains that an older CLI may be shadowing the update |
| `healthy-first-run` | Compatible CLI and server | Starts, passes health, and connects the event stream |

The assertions use the `Varro: About` diagnostics from the real extension host. Webview DOM and
action assertions remain in Playwright because VS Code's stable extension API does not expose a
webview's DOM to Extension Host tests.

## Webview Recovery States

Run the browser-level recovery suite:

```sh
npm run test:e2e -- e2e/tests/error-states.spec.ts e2e/tests/server-status.spec.ts e2e/tests/transport.spec.ts
```

This verifies missing CLI, invalid path, generic startup failure, update failure and blocking,
provider setup, startup races, and degraded event-stream UI and actions.

## Host Policy Tests

Run the cross-platform process and lifecycle policy tests:

```sh
npm run test -- src/extension/extension.test.ts src/extension/server.test.ts src/extension/open-code-process.test.ts src/extension/open-code-transport.test.ts src/extension/util/server-path.test.ts src/extension/util/server-launch.test.ts src/extension/vscode-install.test.ts src/shared/opencode-install.test.ts src/webview/components/ServerStatus.test.ts
```

The same process suite runs on `windows-latest` in CI. Windows-specific coverage includes `Path`
casing, npm/pnpm/Yarn/Volta/Bun locations, `.cmd` and `.bat` quoting, missing shims, process-tree
termination, file-lock update recovery, and VSIX installation through `code.cmd`.

Windows CI runs unit and host-policy tests, builds, and packages the VSIX on Node `24.18.1`. A
manually dispatched CI run also launches the real VS Code application on
`windows-latest` for `clean-install-missing-cli`, `invalid-cli-path`, and `healthy-first-run`. Failed
sandbox runs upload their isolated profiles as a `windows-vscode-sandbox-*` artifact.

## Windows Host Placement

Verify native Windows and VS Code WSL separately. They are different extension hosts and must not
share an assumed CLI installation.

1. Open a normal local folder in VS Code on Windows. Install OpenCode from a Windows terminal, open
   Varro, and run `Varro: About`. Confirm `Platform` is `win32`, the resolved binary is a Windows path,
   and OpenCode data appears under `%USERPROFILE%\.local\share\opencode`.
2. Open a folder in a VS Code WSL window. Install OpenCode inside that distribution, open Varro,
   and run `Varro: About`. Confirm `Platform` is `linux`, the resolved binary is a Linux path, and data
   appears under `~/.local/share/opencode` in the distribution.
3. Confirm a Windows-only CLI does not satisfy the WSL host and a WSL-only CLI does not satisfy the
   native host. `varro.server.command` must also name a path that exists on the active extension host.

OpenCode recommends [WSL for the best Windows experience](https://opencode.ai/docs/windows-wsl), but
the native flow remains supported.

## Native Windows Checks

- Leave `varro.server.autoUpdate` enabled with an older compatible CLI. Confirm Varro prompts instead
  of replacing the CLI in the background.
- Exercise the terminal update fallback with a Varro-managed server. Confirm Varro waits for active
  work, stops the managed server, then opens the update terminal. Keep that terminal open and confirm
  Varro does not restart the managed server until the terminal closes, so `opencode.exe` stays
  unlocked.
- Connect to a server that Varro does not own and try to update. Confirm Varro asks you to stop that
  server instead of attempting to replace its locked executable.
- With an empty Git index, generate a commit message from a tracked unstaged change plus an untracked
  file. Confirm the tracked diff is present in the helper evidence while the untracked path is marked
  `content unavailable` and its contents are absent.
- Run the focused Antigravity discovery tests. They cover PowerShell CIM process output,
  `Get-NetTCPConnection` port output, malformed data, and command failures:

```sh
npm run test -- src/extension/provider-limits/adapters/antigravity.discovery.test.ts
```

## Manual Checks

Use the `Varro: Extension Development Host` launch configuration for exploratory testing. For a
true first install, prefer the sandbox runner because reinstalling into a normal VS Code profile
preserves extension global state.

Before release, manually inspect situations that are not deterministic on every development host:

- Workspace Trust denial and enabling trust afterward.
- Remote SSH, Dev Container, and WSL hosts, where the workspace-side CLI and PATH differ locally.
- Proxy, TLS interception, DNS failure, offline mode, and authentication expiry.
- Read-only home/config directories, executable permission errors, and full disks.
- Sleep/wake, network changes, server crashes, and multiple VS Code windows sharing a configured port.
- Closing a native Windows update terminal, which allows Varro to use the CLI again after the file lock is released.
- OpenCode versions newer than Varro's tested ceiling and malformed version output.
- No providers, provider API failure, provider login cancellation, and invalid provider credentials.
- Embedded API-key and OAuth connection, code-based and automatic OAuth completion, provider disconnection, terminal fallbacks, and provider-catalog load failure.
- Expired or revoked provider credentials, targeted reauthentication from both a failed response and the Models view, and authentication-only refresh while another agent is running.
- Corrupt `opencode.json`, invalid injected config, and an unsupported or non-OpenCode process on the configured port.
