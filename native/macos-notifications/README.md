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

The extension verifies the archive checksum and installs the app under its global storage directory, `notifications/<archive-sha256>/Varro.app`. Extraction uses a temporary directory and atomic rename so editor windows can share the installation. It verifies the code signature and registers the app with Launch Services before launching it directly. Installation is lazy; sound-only users also use the helper to check window visibility.

Before each background alert burst, `--windows PID` reads active display bounds and front-to-back on-screen windows for the originating editor process. The extension subtracts opaque covering rectangles from the editor windows, including coverage by several windows and multiple monitors. Any uncovered editor area suppresses both the banner and sound. macOS omits minimized and hidden windows from this list. Dock's transparent full-display overlay is excluded from coverage. The check reads geometry and opacity, without window titles, screen pixels, Screen Recording access, or Accessibility access. It approximates coverage using window rectangles; per-pixel transparent regions are not inspected. If visibility cannot be determined, the burst is dropped and the error is reported. Focus and event validity are checked again after the asynchronous read.

The first `--notify` requests alert authorization. A denial produces an actionable error; Varro never changes OS permission settings. The helper exits after the OS accepts the request. Acceptance alone does not prove a banner appeared. Focus modes and banner settings still apply.

The title is the project name, the subtitle is the chat title, and the body describes the event. Each notification stores a built-in VS Code project URI in its `userInfo`, using the saved `.code-workspace` file for multi-root workspaces or the workspace folder otherwise. Clicking it relaunches the helper, whose notification-response delegate opens that URI through Launch Services before acknowledging the response. Acknowledging first can end the activation before the handoff runs. VS Code matches the project to its existing window. This does not invoke Varro's extension URI handler or switch chats. If the project has been closed, VS Code can reopen it. Dismissal opens nothing. Older notifications retain their legacy chat links. The helper runs no shell commands from notification content.

The native response tests exercise the production delegate while replacing only the OS URL opener. They check handoff-before-acknowledgement ordering, encoded URLs, dismissal, missing URLs, and opener failures without opening any windows. The helper records launch, response-validation, and handoff status in macOS unified logs; chat titles and callback URLs are not logged.

For diagnostics, run the installed app's `Contents/MacOS/varro-notifier` executable:

```sh
varro-notifier --diagnose
varro-notifier --windows EDITOR_MAIN_PID
varro-notifier --notify 'Project: My project' 'Chat title' 'Response ready' varro-test
varro-notifier --delivered varro-test
```

An optional URI follows the ID in `--notify PROJECT CHAT DETAILS [ID [URL]]`, for example `vscode://file/Users/name/project`. Use the editor's URI scheme and an encoded absolute folder or workspace-file path. `--diagnose` reads authorization and presentation settings without requesting permission. `--delivered` reports only the matching notification, including its three text fields, project URI, and whether it carried a sound. Sending is bounded to 45 seconds for the initial authorization prompt; the extension's process timeout is 50 seconds. Disposing the extension cancels its running commands.
