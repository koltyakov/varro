# Docker and remote OpenCode servers

For Docker Sandboxes with Varro running inside a VS Code Remote SSH workspace, use the [Docker Sandboxes guide](docker-sandboxes.md). That setup lets Varro manage OpenCode inside the sandbox; this page covers attaching to a separately managed server.

> [!IMPORTANT]
> This is an advanced, reduced-functionality setup. We do not recommend Docker or a separately managed remote OpenCode server for general Varro use. Use this mode only if you have a specific requirement and understand how to manage the server's networking, authentication, workspace paths, tools, storage, and updates yourself. Read the unsupported and limited features below before following the setup instructions.

## Recommended setup: install OpenCode on the machine

Docker is usually unnecessary for Varro. For most users, installing OpenCode directly on the machine where the VS Code extension host runs gives you more flexibility and access to Varro's local integrations. Follow the [usage guide](usage.md) and leave `varro.server.autoStart` enabled so Varro can manage the server.

A direct installation can use your existing project tools, dependencies, credentials, and workspace files without port forwarding or matching container mounts. It also supports local CLI session export and terminal access, file-based configuration editing, and server restart and update management. A separate Docker server uses attach-only mode, which limits these integrations as described in [Feature availability in attach-only mode](#feature-availability-in-attach-only-mode).

Consider Docker only when a containerized toolchain, isolation, or an existing container-hosted OpenCode service is a requirement. If you do not have such a requirement, use the direct installation.

With WSL, Remote SSH, or Dev Containers, the recommended setup is still to install OpenCode alongside Varro's extension host and let Varro manage it. A remote VS Code workspace does not itself require attach-only mode. The restrictions below apply when you disable Varro's server management and connect to a separately managed server.

## Feature availability in attach-only mode

These limits apply to both OpenCode v1 and v2 when `varro.server.autoStart` is `false` and Varro does not own a running process. Varro cannot distinguish a local manual server from a Docker port or SSH tunnel, so it treats all of them the same way.

Chat, tools, session history, and embedded provider connection use the connected server's API. Workspace paths, tools, dependencies, and provider credentials must be valid on that server. Session permission rules, pending approvals, and server-memory approvals remain available through the API.

The following functionality is unsupported or limited in this mode:

| Feature | Limitation and required action |
| --- | --- |
| Server startup, restart, and automatic CLI updates | Varro does not start, restart, or update the external server. Manage its lifecycle yourself. Retrying a connection reconnects to the existing server. |
| Terminal provider login/logout and local installation commands | Unavailable through Varro's local CLI integration. Run the commands on the server host or inside the container. |
| Open session in Terminal and CLI session export | Unsupported. Use OpenCode on the server host or inside the container. Varro will not launch an unrelated local CLI. |
| Edit global AGENTS.md and import local v1 history | Unsupported through Varro in this mode. Perform these operations on the server host. Project AGENTS.md remains available through the shared workspace. |
| File-based model routing and provider disabling | Varro can read model routing from the API, but cannot edit the server's configuration files. Edit those files on the server host. |
| Project permission configuration and `Allow always > For this project` | Unsupported because these operations write configuration files. Edit the server's project configuration directly, or use Allow once, session-scoped approval, or approval until server restart. An unsupported project approval leaves the request pending and displays an explanation. |
| Provider quota checks | Unavailable because Varro cannot read server-side provider credentials. Session token and cost information reported by OpenCode remains available. |
| Usage report | Uses the server API instead of a local database. Reports support up to 250 sessions; larger reports show an explanatory error. |
| Global configuration and credential-file watching | Local changes are not watched or applied to the external server. Refresh providers after server-side changes and restart the server externally when needed. |
| Varro auto-compaction and injected Ask agent settings | Varro cannot inject startup configuration into an external process. Configure these settings on the OpenCode server. |
| Custom server hostname, URL, or HTTPS endpoint | No direct setting is available. Forward the server to `http://127.0.0.1:<port>` as seen by the VS Code extension host. |
| Workspace path translation and file synchronization | Unsupported. Both environments need the same files at identical absolute paths. A port forward does not synchronize files, and native Windows paths do not map to Linux container paths. |
| Provider authentication that needs a server-side browser callback | May require additional forwarding or login inside the container. Host provider credentials are not automatically shared. |

File opening, diffs, and project context still use the VS Code workspace. Files created only on the server outside shared mounts are not available in the editor. You are responsible for keeping the editor and server workspaces consistent and for supplying the server's build tools and dependencies.

## Docker setup overview

Varro can attach to a separately managed OpenCode server through `http://127.0.0.1:<port>`. Setting `varro.server.autoStart` to `false` disables launching a server; it still allows Varro to connect to one that is already running.

This guide includes OpenCode v1 and v2 samples, with VS Code running on a macOS or Linux host and Docker publishing the server port on that host. For WSL, run the commands and open the workspace from the WSL environment where Varro runs.

## Connection requirements

- Varro supports a configurable port, but no custom server hostname, URL, or HTTPS setting. The default address is `http://127.0.0.1:4096`.
- The address is relative to the **VS Code extension host**. With Remote SSH, WSL, or Dev Containers, this can be a different machine or container from the desktop running VS Code.
- OpenCode must listen on `0.0.0.0` inside the container for Docker port forwarding to reach it.
- The workspace must be available at the same absolute path in VS Code and the OpenCode container. Varro sends the workspace path to the API and has no host-to-container path mapping setting.
- Provider credentials, project tools, and dependencies used by OpenCode must be available inside the container.

For example, a workspace opened as `/Users/alex/projects/app` must also be mounted at `/Users/alex/projects/app` inside the container. Mounting it only at `/workspace` will not match the directory Varro sends.

## Build a server image

Choose one API family. Complete samples are included in the repository:

| Family | Package and example version | Dockerfile | Compose sample | Health endpoint |
| --- | --- | --- | --- | --- |
| v1 | `opencode-ai@1.18.32` | [Dockerfile.v1](../examples/docker/Dockerfile.v1) | [compose.v1.yaml](../examples/docker/compose.v1.yaml) | `/global/health` |
| v2 | `@opencode/cli@2.0.14` | [Dockerfile.v2](../examples/docker/Dockerfile.v2) | [compose.v2.yaml](../examples/docker/compose.v2.yaml) | `/api/info` |

From the Varro repository root, build the selected image:

```sh
# v1
docker build -f examples/docker/Dockerfile.v1 -t varro-opencode:v1 examples/docker
```

```sh
# v2
docker build -f examples/docker/Dockerfile.v2 -t varro-opencode:v2 examples/docker
```

Both Dockerfiles use the same base image and tools. The v2 sample is:

```dockerfile
FROM node:24-bookworm-slim

RUN apt-get update \
    && apt-get install -y --no-install-recommends ca-certificates git ripgrep \
    && rm -rf /var/lib/apt/lists/*

ARG OPENCODE_VERSION=2.0.14
RUN npm install --global "@opencode/cli@${OPENCODE_VERSION}"

EXPOSE 4096
CMD ["opencode", "serve", "--hostname", "0.0.0.0", "--port", "4096"]
```

The v1 sample replaces the package installation with:

```dockerfile
ARG OPENCODE_VERSION=1.18.32
RUN npm install --global "opencode-ai@${OPENCODE_VERSION}"
```

The examples pin versions tested with Varro. See the [supported versions](usage.md#choose-and-update-opencode) before selecting another version with `--build-arg OPENCODE_VERSION=...`. Keep the version in the selected package's API family. Add any tools your project needs to the image.

## Start the container

In a terminal, change to the workspace directory you will open in VS Code. Generate a password and keep this terminal open for the later steps:

```sh
export OPENCODE_SERVER_USERNAME=opencode
export OPENCODE_SERVER_PASSWORD="$(openssl rand -hex 24)"
export VARRO_WORKSPACE="$(pwd -P)"
export VARRO_OPENCODE_FAMILY=v2

docker run -d \
  --name varro-opencode \
  --publish 127.0.0.1:4096:4096 \
  --env OPENCODE_SERVER_USERNAME \
  --env OPENCODE_SERVER_PASSWORD \
  --mount "type=bind,source=$VARRO_WORKSPACE,target=$VARRO_WORKSPACE" \
  --mount "type=volume,source=varro-opencode-$VARRO_OPENCODE_FAMILY-config,target=/root/.config/opencode" \
  --mount "type=volume,source=varro-opencode-$VARRO_OPENCODE_FAMILY-data,target=/root/.local/share/opencode" \
  --workdir "$VARRO_WORKSPACE" \
  "varro-opencode:$VARRO_OPENCODE_FAMILY"
```

Use `VARRO_OPENCODE_FAMILY=v1` for the v1 image. Run only one sample at a time with the default container name and port. Each family uses separate named volumes so trying v2 does not reuse the v1 database.

The bind mount lets OpenCode work on the same files as VS Code. The named volumes retain configuration, provider authentication, and session data when you replace the container. For a multi-root workspace, mount every folder at its matching absolute path.

The image runs as root by default. On Linux, files it creates in the workspace may be root-owned. If your workflow requires matching host ownership, configure a container user and writable configuration/data volumes for that user.

Configure a provider inside the container:

```sh
docker exec -it varro-opencode opencode auth login
```

Alternatively, connect a provider from Varro after completing the connection setup. The container does not automatically inherit provider credentials from the host. OpenCode v1 may need an external restart and provider refresh after credentials change; Varro displays this guidance after embedded authentication in attach-only mode.

### Docker Compose alternative

Instead of `docker run`, export the same workspace and credential variables, then select the sample with an absolute path:

```sh
export COMPOSE_FILE=/absolute/path/to/varro/examples/docker/compose.v2.yaml
docker compose up --build -d
docker compose exec opencode opencode auth login
```

For v1, select `compose.v1.yaml`. Set `VARRO_SERVER_PORT` before starting Compose to publish a different host port. Both samples name the container `varro-opencode`, so the checks below also work with Compose. Compose uses its own family-specific volumes; switching between `docker run` and Compose does not reuse data automatically.

## Configure VS Code

Add these settings to VS Code:

```json
{
  "varro.server.autoStart": false,
  "varro.server.port": 4096
}
```

VS Code marks `varro.server.autoStart` as deprecated and debug-only, but the setting remains available for manual server management. With auto-start disabled and no Varro-managed process, Varro uses attach-only mode and does not assume the server shares its CLI, database, or global configuration. Changing the port requires a window reload. `varro.server.command` selects a local executable; it does not set an API address or Docker command.

Varro reads server authentication from `OPENCODE_SERVER_PASSWORD` and optional `OPENCODE_SERVER_USERNAME` in the extension host's environment. These must match the container. They are separate from model-provider API keys.

For local VS Code, fully quit existing VS Code processes, then launch it from the terminal where you exported the credentials:

```sh
code "$VARRO_WORKSPACE"
```

Opening another window in an already-running VS Code process may reuse its old environment. Setting variables only in VS Code's integrated terminal does not update the running extension host. For remote workspaces, supply the variables to the remote extension host through that environment's startup configuration.

Open Varro to attach to the running server.

### Use a different port

If host port `4096` is occupied, publish another host port when creating the container:

```sh
--publish 127.0.0.1:4097:4096
```

Set `varro.server.port` to `4097` and reload VS Code. OpenCode still listens on port `4096` inside the container. Use the host port in connection checks.

## Verify the connection

From the same environment where the extension host runs, check the published endpoint:

```sh
curl --fail --show-error \
  --user "$OPENCODE_SERVER_USERNAME:$OPENCODE_SERVER_PASSWORD" \
  http://127.0.0.1:4096/api/info
```

For v1, use its health endpoint instead:

```sh
curl --fail --show-error \
  --user "$OPENCODE_SERVER_USERNAME:$OPENCODE_SERVER_PASSWORD" \
  http://127.0.0.1:4096/global/health
```

Both responses should contain the server version; v1 also returns `healthy: true`. These commands check the Docker endpoint directly. In v2, `opencode api` can discover or start a different local service, so it is not a substitute for this check.

Check the container and workspace mount:

```sh
docker logs varro-opencode
docker exec varro-opencode pwd
docker exec varro-opencode ls -ld "$VARRO_WORKSPACE"
```

After connecting, create a session in Varro and ask it to read a known file in the workspace. A successful API probe alone does not verify the workspace mount or provider setup.

## Remote hosts and Dev Containers

For Remote SSH, publish the Docker port on the SSH host where Varro runs, and use that host's workspace path for the bind mount.

If VS Code runs locally but OpenCode runs on another machine, forward its port to the extension host:

```sh
ssh -N -L 127.0.0.1:4096:127.0.0.1:4096 user@server-host
```

Use attach-only mode and the remote server's credentials. A tunnel forwards HTTP only; it does not synchronize files. The remote workspace must contain the same files at the same absolute path. A Remote SSH workspace usually avoids this mismatch.

For Dev Containers, `127.0.0.1` refers to the development container. Publishing OpenCode's port on the Docker host or running it in a sibling container does not make it available at the development container's loopback address. Run OpenCode in the development container, or arrange forwarding so the configured port is reachable at `127.0.0.1` from that container.

Native Windows workspace paths do not map directly to Linux container paths. Use a VS Code WSL or Dev Container workspace with matching Linux paths for this setup.

## Troubleshooting

| Symptom | What to check |
| --- | --- |
| `No server at http://127.0.0.1:...` | Confirm the container is running, OpenCode listens on `0.0.0.0`, and the published host port matches `varro.server.port`. Run the API check from the extension host's environment. |
| Authentication failed or HTTP 401/403 | Check that the extension host inherited the same server credentials as Docker. Fully restart local VS Code after changing its environment. |
| API check succeeds, but sessions fail to open or files are missing | Check that the exact workspace path exists inside the container and contains the expected files. |
| Provider is missing or requests fail | Configure the provider inside the container or through Varro. Host-side provider credentials are not automatically shared. |
| Varro connects to an unexpected server | Check for an existing local OpenCode process on the configured port. Use a free published port and reload VS Code after updating the setting. |
| Server version is unsupported | Compare `docker exec varro-opencode opencode --version` with Varro's [supported versions](usage.md#choose-and-update-opencode). |

If the connection still fails, include your Varro and OpenCode versions, Docker command or Compose configuration, extension-host location, and relevant **Output > Varro** logs in an issue. Remove credentials before sharing them.

## Manage the server

Docker owns this server's lifecycle. Use `docker stop varro-opencode`, `docker start varro-opencode`, or `docker restart varro-opencode` to manage it. Varro's restart command only restarts a server it manages.

To update OpenCode, rebuild the image with a supported version and recreate the container with the same mounts and credentials. Varro does not update the OpenCode installation inside this container. Varro settings that require injecting configuration into a managed server, such as its auto-compaction settings, must instead be configured in OpenCode for this setup.
