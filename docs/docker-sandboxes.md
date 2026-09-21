# Use Varro with Docker Sandboxes

Run Varro and OpenCode inside a Docker Sandbox while using VS Code on your desktop. VS Code connects through Remote SSH, and Varro starts the OpenCode server inside the sandbox automatically. The main walkthrough uses the template's bundled OpenCode, currently V1. See [Use V2 instead](#use-v2-instead) for the optional V2 setup.

This is a suggested setup based on Docker's documented SSH support and Varro's remote-workspace support. It has not yet been verified end to end with Docker Sandboxes.

## Before you start

You need:

- VS Code with the **Remote - SSH** extension from Microsoft.
- Docker Sandboxes and a Docker account.
- A local project folder.
- A model-provider account or API key for OpenCode.

Docker Desktop is not required. Docker currently supports Apple silicon Macs running macOS 14 or later, Windows 11 with Windows Hypervisor Platform, and Ubuntu 24.04 or later with KVM. See [Docker's installation requirements](https://docs.docker.com/ai/sandboxes/install/).

The examples below use macOS paths. Replace `/Users/alex/projects/my-app` with your project's absolute path.

## 1. Install Docker Sandboxes

On macOS, run these commands in your host terminal:

```sh
brew trust docker/tap
brew install docker/tap/sbx
```

On Windows, use PowerShell:

```powershell
winget install -h Docker.sbx
```

For Ubuntu, follow [Docker's installation instructions](https://docs.docker.com/ai/sandboxes/install/).

Sign in and configure SSH access from your host terminal:

```sh
sbx login
sbx setup ssh
```

Complete the Docker sign-in in your browser. SSH setup is normally needed only once.

## 2. Create a sandbox for your project

Run on the host:

```sh
sbx create --name my-app-dev opencode /Users/john/projects/my-app
```

This creates a named sandbox using Docker's OpenCode template and shares your project folder with it. Use a different name for each project environment.

The default direct workspace mode shares edits with your host checkout immediately. Files in the shared project are writable by the agent.

Check that the sandbox exists:

```sh
sbx ls
```

It may show as stopped after creation. Connecting through SSH starts a stopped sandbox automatically.

## 3. Open the sandbox in VS Code

1. Open the Command Palette.
2. Run **Remote-SSH: Connect to Host...**.
3. Enter `my-app-dev.sbx` manually.
4. If asked for the remote platform, choose **Linux**.
5. Wait for VS Code to install its remote server.
6. Use **File > Open Folder...** to open your mounted project.

For the macOS example, select:

```text
/Users/john/projects/my-app
```

Docker documents that mounted workspaces appear at their original absolute paths inside the sandbox. On Windows, use the Linux-side project path shown by the remote folder picker rather than typing a Windows drive path into it.

Confirm that VS Code's remote indicator shows `my-app-dev.sbx` and the Explorer contains your project. The initial remote folder may be `/home/agent`; select the project explicitly.

## 4. Install Varro in the remote window

In that VS Code window:

1. Open Extensions.
2. Find **Varro: OpenCode Workbench**.
3. Install it in **SSH: my-app-dev.sbx**. If it is already installed locally, use the remote installation action.

Varro must run in the sandbox's extension host. Installing it only in the local VS Code environment is not enough.

## 5. Check OpenCode inside the sandbox

Open a new integrated terminal in the remote VS Code window and run:

```sh
pwd
opencode --version
```

The directory should be your project. The template currently bundles V1, but its version can change. Check that it meets Varro's [supported version requirements](usage.md#choose-and-update-opencode). No separate OpenCode installation is needed when the bundled version is supported.

Install your project's build tools and dependencies inside the sandbox too. The sandbox runs Linux, so host-installed native dependencies may not work there.

## 6. Let Varro start the server

Keep Varro's normal server settings. If you previously changed them, run **Preferences: Open Remote Settings (JSON)** in the Command Palette and merge these settings into the existing file. Remove conflicting workspace overrides.

```json
{
  "varro.server.autoStart": true,
  "varro.server.command": "",
  "varro.server.port": 4096
}
```

Open Varro. When it first needs OpenCode, Varro should find the bundled CLI and start the server inside the sandbox. Confirm the connected version in Varro's status bar.

You do not need to run `opencode serve`, publish a Docker port, or create an SSH port forward for this setup. Varro and OpenCode share the sandbox's localhost network.

If automatic CLI discovery fails or selects another installation, run `command -v opencode` in the remote terminal and put the resulting absolute path in `varro.server.command`. Finish active work and run **Varro: Restart Server** after changing the executable.

## 7. Connect a provider and send a first message

Use Varro's provider connection flow to sign in or supply an API key, then choose an available model. Host OpenCode credentials and user-level configuration are not automatically available inside the sandbox.

If you prefer Docker's provider-secret integration, configure it using the [Docker OpenCode guide](https://docs.docker.com/ai/sandboxes/agents/opencode/). For a first setup, choose one authentication method and complete it before testing chat.

Create a session in the project folder and send:

```text
Tell me the current working directory and summarize the top-level project files.
Do not modify any files.
```

Check that the response refers to the project you opened and that Varro shows a connected server. This confirms folder context and a working provider request.

## Daily use

- Reconnect with **Remote-SSH: Connect to Host... > my-app-dev.sbx** and reopen your project.
- Keep using the same named sandbox to retain its installed tools, configuration, and OpenCode history.
- Finish active work and close the remote VS Code window before stopping it from a host terminal:

  ```sh
  sbx stop my-app-dev
  ```

- Reconnecting through SSH starts it again.

Stopping preserves sandbox data. Removing the sandbox with `sbx rm my-app-dev` deletes its internal files, including session history and configuration stored there. Export anything you want to retain first. Files in the directly mounted host project remain on the host.

## Multiple project folders

Supply the folders when creating the sandbox:

```sh
sbx create --name workspace-dev opencode \
  /Users/alex/projects/my-app \
  /Users/alex/projects/shared-library
```

Connect to `workspace-dev.sbx`, open the first folder, and use **File > Add Folder to Workspace...** for the second. Select the intended folder in Varro when creating a session. Varro sends that folder as OpenCode's session context.

## Use V2 instead

To use OpenCode V2, complete the sandbox and Remote SSH setup above, then install V2 separately from the template's bundled CLI. Run these commands in the **remote VS Code terminal**:

```sh
node --version
npm --version
npm install -g --prefix "$HOME/.local/opencode-v2" @opencode/cli
"$HOME/.local/opencode-v2/bin/opencode" --version
printf '%s\n' "$HOME/.local/opencode-v2/bin/opencode"
```

If Node.js or npm is unavailable, install a supported Node.js release inside the sandbox first. See the [OpenCode installation guide](usage.md#choose-and-update-opencode).

The OpenCode version must start with `2.`. Run **Preferences: Open Remote Settings (JSON)** and set `varro.server.command` to the absolute path printed by the last command, normally:

```json
{
  "varro.server.autoStart": true,
  "varro.server.command": "/home/agent/.local/opencode-v2/bin/opencode",
  "varro.server.port": 4096
}
```

Bare `opencode` and `sbx run` may still select the bundled V1. The explicit executable path makes Varro use V2.

Finish active work, run **Varro: Restart Server**, and confirm that the status bar shows OpenCode `2.x`. Installing V2 does not replace a running V1 server. If V1 remains connected, follow the [restart recovery steps](usage.md#if-restart-does-not-switch-to-v2). Selecting a different executable does not migrate session history; see [version differences and history](usage.md#version-differences-and-history).

## Troubleshooting

| Problem | What to check |
| --- | --- |
| Sandbox is missing from the SSH picker | Enter `my-app-dev.sbx` manually. The wildcard SSH configuration does not list individual sandboxes. |
| SSH cannot connect | Run `sbx ls`, then try `ssh my-app-dev.sbx` from the host terminal. Confirm Docker sign-in and rerun `sbx setup ssh` if needed. |
| VS Code repeatedly reconnects on macOS | Set `"remote.SSH.useLocalServer": false` in local VS Code user settings, as recommended by Docker. |
| Varro cannot find OpenCode | Check `opencode --version` and `command -v opencode` in the remote terminal and set the absolute executable path if needed. |
| Varro shows V1 after installing V2 | Follow [Use V2 instead](#use-v2-instead) to set the explicit V2 executable path and restart the server. |
| Varro opens the wrong project | Check the remote Explorer and selected session folder. Open the mounted project rather than `/home/agent`. |
| Provider or model is unavailable | Configure authentication inside the sandbox. Check sandbox network rules if provider requests fail. |
| A build fails despite working on the host | Install the required Linux toolchain and dependencies inside the sandbox. |

## Why this setup fits Varro

VS Code runs the Varro extension inside the sandbox, alongside OpenCode. Varro can manage the server process, read its configuration, and pass the selected remote folder to its API. Your desktop displays the UI through VS Code's SSH connection.

Keeping Varro on the host and forwarding only the OpenCode server is a separate, reduced-functionality setup. See [Docker and remote servers](docker-server.md) if you specifically need attach-only mode.

## References

- [Docker Sandboxes installation](https://docs.docker.com/ai/sandboxes/install/)
- [Docker's VS Code connection guide](https://docs.docker.com/ai/sandboxes/integrations/vscode/)
- [Docker workspace and lifecycle commands](https://docs.docker.com/ai/sandboxes/usage/)
- [OpenCode in Docker Sandboxes](https://docs.docker.com/ai/sandboxes/agents/opencode/)
- [Varro usage guide](usage.md)
