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
a fake OpenCode CLI/server and does not modify or stop the user's installed OpenCode CLI.

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
- Leaving an update terminal open on Windows, where the OpenCode executable can remain reserved.
- OpenCode versions newer than Varro's tested ceiling and malformed version output.
- No providers, provider API failure, provider login cancellation, and invalid provider credentials.
- Embedded API-key and OAuth connection, code-based and automatic OAuth completion, provider disconnection, terminal fallbacks, and provider-catalog load failure.
- Expired or revoked provider credentials, targeted reauthentication from both a failed response and the Models view, and authentication-only refresh while another agent is running.
- Corrupt `opencode.json`, invalid injected config, and an unsupported or non-OpenCode process on the configured port.
