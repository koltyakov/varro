# macOS notification helper

This first-party Objective-C app uses Apple's UserNotifications framework. It supplies the Varro name, `assets/icon.png`, and bundle identifier `com.koltyakov.varro.notifications`. It sends notifications and checks editor visibility. Banners are silent; the extension plays its configured sound separately.

## Build and packaging

On macOS with Apple Command Line Tools installed:

```sh
npm run build:notifications:macos
npm run test:notifications:macos
npm run build:extension
npm run package:vsix
```

The first command compiles a universal arm64/x86_64 app for macOS 11+, generates its icon, ad-hoc signs it, verifies the signature and identity, and writes `assets/notifications/varro-notifier.zip` and its JSON manifest. Commit both with changes to the helper, build script, or logo. Extension builds on every platform verify the source hash and archive checksum before copying the asset. End users need no compiler or downloaded helper.

This build uses an ad-hoc signature, not an Apple Developer ID or notarization. Distribution through Gatekeeper and permission persistence across rebuilt binaries still need verification before release. Do not strip quarantine or reset notification permissions to work around a denial.

## Runtime

The extension verifies the archive checksum and installs the app under its global storage directory, `notifications/<archive-sha256>/Varro.app`. Extraction uses a temporary directory and atomic rename so editor windows can share the installation. It verifies the code signature and registers the app with Launch Services before launching it directly. Registration has a 30-second timeout and does not force an update because checksum-versioned apps never change in place. Installation is lazy; sound-only users do not need the helper.

Notifications use the originating VS Code window's focus, not process-wide editor visibility. An unfocused window can notify while another VS Code window is active, even in side-by-side use. The extension rechecks focus, event validity, and notification settings before each alert burst. Banners and sounds remain independently opt-in and off by default. The helper's `--windows PID` command remains available for geometry diagnostics but does not gate notification delivery.

The first `--notify` requests alert authorization. A denial produces an actionable error; Varro never changes OS permission settings. The helper exits after the OS accepts the request. Acceptance alone does not prove a banner appeared. Focus modes and banner settings still apply.

The title is the project name, the subtitle is the chat title, and the body describes the event. Project notifications store a built-in VS Code project URI in their `userInfo`, using the saved `.code-workspace` file for multi-root workspaces or the workspace folder otherwise. Folderless scratch windows instead use Varro's `/notification` callback resolved through `vscode.env.asExternalUri`, which routes to the originating window and opens the notification's chat there. Never use an open-folder URI for the internal scratch directory: VS Code may replace the active window with it. Callback resolution failures are reported without falling back to that unsafe route.

Clicking a notification relaunches the helper, whose notification-response delegate opens the URI through Launch Services before acknowledging the response. Acknowledging first can end the activation before the handoff runs. Project links include `windowId=_blank`: VS Code matches an existing project window without invoking Varro's URI handler or switching chats, but reopens a closed project in a new window instead of replacing another workspace. The helper adds this parameter to older project notifications too. Scratch callbacks keep their originating-window routing unchanged. Dismissal opens nothing. The helper runs no shell commands from notification content.

The native response tests exercise the production delegate while replacing only the OS URL opener. They check handoff-before-acknowledgement ordering, encoded URLs, dismissal, missing URLs, and opener failures without opening any windows. The helper records launch, response-validation, and handoff status in macOS unified logs; chat titles and callback URLs are not logged.

For diagnostics, run the installed app's `Contents/MacOS/varro-notifier` executable:

```sh
varro-notifier --diagnose
varro-notifier --windows EDITOR_MAIN_PID
varro-notifier --notify 'Project: My project' 'Chat title' 'Response ready' varro-test
varro-notifier --delivered varro-test
```

An optional URI follows the ID in `--notify PROJECT CHAT DETAILS [ID [URL]]`, for example `vscode://file/Users/name/project?windowId=_blank`. Use the editor's URI scheme and an encoded absolute folder or workspace-file path. Project URLs accept only the optional `windowId=_blank` query. `--diagnose` reads authorization and presentation settings without requesting permission. `--delivered` reports only the matching notification, including its three text fields, project URI, and whether it carried a sound. Sending is bounded to 45 seconds for the initial authorization prompt; the extension's process timeout is 50 seconds. Disposing the extension cancels its running commands.
