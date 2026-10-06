# Varro menu-bar app

An optional experimental macOS companion for local Varro VS Code windows. It shows running sessions, approvals, questions, failures, plans ready for review, and unread completions. Clicking a row opens its project window without selecting another chat. Closed projects can reopen.

## Build and install

Requires macOS 13 or newer and Apple's Command Line Tools (`xcode-select --install`). No npm dependencies or Developer ID are needed. Builds use the current Mac's architecture and an ad-hoc signature.

```sh
cd native/macos-tray
make build
make test
make install
open ~/Applications/Varro.app
```

`make build` writes `build/Varro.app`. `make install` installs to `~/Applications/Varro.app`; override with `make install INSTALL_DIR=/Applications`. Quit the running app before replacing it. `make run` opens the build directly, `make clean` removes build output, and `make uninstall` removes the installed app and its data directory. Disable Launch at login and quit before uninstalling. Installation refuses to overwrite a different app named Varro.

Enable **Launch at login** in the gear menu after installation. macOS may request approval in Login Items. This local build is not notarized or intended as a public release artifact.

After the first launch, reload VS Code windows that were already open. Editors check for the app's data directory once at startup; without it they stay inert until the next reload.

Build/install the Varro extension separately using the repository's normal workflow. The companion app is not built by npm, included in the VSIX, or launched by the extension. When the app is absent or closed, Varro and its existing notifications work as usual. The app itself does not send banners or duplicate notification sounds.

## Behavior

- One icon aggregates connected local editor windows. Use the project dropdown to filter the list.
- The popover fits its visible content up to 520 points tall. Longer lists scroll; shorter lists, wrapped titles, project filters, and errors resize it automatically.
- Each editor registers every open workspace folder, including idle projects and projects whose backend is not ready. Folder changes refresh the catalog. Multi-root folders have separate filters even when clicks target the same saved workspace window.
- Attention takes precedence over running state. Child-session requests appear under their root chat.
- A full-size counter beside the icon counts sessions with unread completed replies, unread plans, waiting permissions/questions, or unseen errors. Running sessions are not counted. A small lower-right dot starts with the newest unread event's color: green for completed, yellow for plan-ready, blue for permissions/questions, and red for errors. When multiple colors are unread, it rotates through them every three seconds. Both are hidden when none need attention.
- Running rows also use ready webviews' working indicators, so a restored chat stays visible if its initial busy event was missed. Backend reconnects do not hide the state still reported by an editor.
- The tray is an unread-attention list. VS Code window focus alone does not acknowledge another chat or resolve a pending request. Reading the response clears its unread state; pending permissions and questions remain until resolved. System notification banners keep their separate focus rules.
- Clicking a row opens its project window. The tray waits for VS Code to report the chat read or the request resolved before removing it; window navigation does not create a separate local read marker.
- Completed replies and plans disappear when marked read in VS Code. Their read state comes from connected editors; completed history is not restored from disk. Existing completion archives are discarded on upgrade.
- The extension checks saved VS Code read timestamps before publishing completions and errors, so chats read before connecting or reloading the tray stay out of the list. A later reply or error in the same chat can still need attention.
- If a connected editor reports a chat unread or needing attention, the tray includes it. Duplicate reports are grouped into one row and badge entry.
- Up to 100 other session summaries persist across restarts as disconnected activity. Clear disconnected sessions removes only that offline history; it cannot hide live unread replies or pending requests.
- The app stays open after VS Code closes. Disconnected activity is labeled, not counted as live. It does not monitor OpenCode directly while the extension is disconnected.
- Quiet connections from the current extension have no heartbeat checks. A three-second display timer runs only while multiple unread event colors need rotation. With no extension connected, the app waits for socket events without periodic checks. Disconnects schedule a one-shot reconnect-grace cleanup, then no cleanup timer remains, including when disconnected history is present. Older extensions retain their one-shot heartbeat expiry.
- Remote extension hosts and isolated test editors do not connect. VS Code, Insiders, VSCodium, and Code OSS project URLs are accepted. Untitled workspaces fall back to the session's folder.

## Local protocol

The app owns `~/Library/Application Support/Varro/tray/tray.sock` in a dedicated user-owned mode-700 directory, separate from Varro's shared state. The socket is mode 600, accepts only same-user peers, and uses a lock to prevent competing app instances. Stale sockets are replaced only after acquiring that lock.

The directory is the extension's install marker. An editor that starts without it makes no connection attempts, watches nothing, schedules no timers, and does no work on state changes. When it exists, the extension watches only that directory and connects, with a two-second deadline, when the socket appears or is replaced. State changes do no work while disconnected. A reset of an established connection gets one immediate recovery attempt; otherwise the extension waits for the app to replace its socket, without polling. It sends a full newline-delimited JSON snapshot on connect and after coalesced state or workspace changes, suppressing identical snapshots. Each frame has `version: 1`, `eventDriven: true`, a per-extension-instance UUID `instanceID`, an `available` flag for the backend connection, up to 256 `projects`, and up to 256 `sessions`. Projects contain a folder `id`, display `name`, and project-window `url`. Each session contains `id`, `title`, `project`, `projectID`, `projectUrl`, `status`, and epoch-millisecond `updatedAt`. Session IDs hash server/workspace/root-session identity; snapshots contain no credentials, transcripts, or tool arguments. Older publishers without a project catalog still work, with project choices derived from their sessions. Frames are capped at 1 MiB. The app sends no commands back to the extension.

Socket disconnects retain the last report for a 15-second reconnect grace period. Event-driven publishers remain registered while their socket is open, even without updates; silence is not proof that a chat was read or a request resolved. A 60-second heartbeat expiry remains for legacy publishers without `eventDriven: true`. Earlier builds used `~/Library/Application Support/Varro/tray.sock`; rebuild both the app and extension together, then delete the old `tray.lock` and `tray-history.json` from that folder. Reconnection replaces that editor's entire snapshot. Offline running/request summaries are stored in `tray-history.json` beside the socket. Old local dismissal markers are ignored so they cannot override VS Code's unread state. Delete that file while the app is closed to erase local history.

`make test` checks protocol validation, attention counts, multi-editor deduplication, disconnect/reconnect, history persistence, navigation without read-state overrides, and the real Unix socket using a temporary fixture. It also runs offscreen SwiftUI layout checks for compact content, wrapped titles, section spacing, the height cap, errors, and shrinking after updates; run those alone with `make test-layout`. `make test-indicator` checks the menu-bar counter and event dot offscreen. Extension tests live in `src/extension/macos-tray.test.ts`.
