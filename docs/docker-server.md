# Connect Varro to OpenCode in Docker

Varro can attach to a separately managed OpenCode server through `http://127.0.0.1:<port>`. Setting `varro.server.autoStart` to `false` disables launching a server; it still allows Varro to connect to one that is already running.

This guide uses OpenCode v2 with VS Code running on a macOS or Linux host and Docker publishing the server port on that host. For WSL, run the commands and open the workspace from the WSL environment where Varro runs.

## Connection requirements

- Varro supports a configurable port, but no custom server hostname, URL, or HTTPS setting. The default address is `http://127.0.0.1:4096`.
- The address is relative to the **VS Code extension host**. With Remote SSH, WSL, or Dev Containers, this can be a different machine or container from the desktop running VS Code.
- OpenCode must listen on `0.0.0.0` inside the container for Docker port forwarding to reach it.
- The workspace must be available at the same absolute path in VS Code and the OpenCode container. Varro sends the workspace path to the API and has no host-to-container path mapping setting.
- Provider credentials, project tools, and dependencies used by OpenCode must be available inside the container.

For example, a workspace opened as `/Users/alex/projects/app` must also be mounted at `/Users/alex/projects/app` inside the container. Mounting it only at `/workspace` will not match the directory Varro sends.

## Build a server image

Save this as `Dockerfile.opencode` in a directory of your choice:

```dockerfile
FROM node:24-bookworm-slim

RUN apt-get update \
    && apt-get install -y --no-install-recommends ca-certificates git ripgrep \
    && rm -rf /var/lib/apt/lists/*

ARG OPENCODE_VERSION=2.0.10
RUN npm install --global "@opencode/cli@${OPENCODE_VERSION}"

EXPOSE 4096
CMD ["opencode", "serve", "--hostname", "0.0.0.0", "--port", "4096"]
```

Build it from that directory:

```sh
docker build -f Dockerfile.opencode -t varro-opencode .
```

The example pins a version tested with Varro. See the [supported versions](usage.md#choose-and-update-opencode) before selecting another version with `--build-arg OPENCODE_VERSION=...`. Add any tools your project needs to the image.

## Start the container

In a terminal, change to the workspace directory you will open in VS Code. Generate a password and keep this terminal open for the later steps:

```sh
export OPENCODE_SERVER_USERNAME=opencode
export OPENCODE_SERVER_PASSWORD="$(openssl rand -hex 24)"
export VARRO_WORKSPACE="$(pwd -P)"

docker run -d \
  --name varro-opencode \
  --publish 127.0.0.1:4096:4096 \
  --env OPENCODE_SERVER_USERNAME \
  --env OPENCODE_SERVER_PASSWORD \
  --mount "type=bind,source=$VARRO_WORKSPACE,target=$VARRO_WORKSPACE" \
  --mount type=volume,source=varro-opencode-config,target=/root/.config/opencode \
  --mount type=volume,source=varro-opencode-data,target=/root/.local/share/opencode \
  --workdir "$VARRO_WORKSPACE" \
  varro-opencode
```

The bind mount lets OpenCode work on the same files as VS Code. The named volumes retain configuration, provider authentication, and session data when you replace the container. For a multi-root workspace, mount every folder at its matching absolute path.

The image runs as root by default. On Linux, files it creates in the workspace may be root-owned. If your workflow requires matching host ownership, configure a container user and writable configuration/data volumes for that user.

Configure a provider inside the container:

```sh
docker exec -it varro-opencode opencode auth login
```

Alternatively, connect a provider from Varro after completing the connection setup. The container does not automatically inherit provider credentials from the host.

## Configure VS Code

Add these settings to VS Code:

```json
{
  "varro.server.autoStart": false,
  "varro.server.port": 4096
}
```

VS Code marks `varro.server.autoStart` as deprecated and debug-only, but the setting remains available for manual server management. Changing the port requires a window reload. `varro.server.command` selects a local executable; it does not set an API address or Docker command.

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

For the v2 version in this example, the response should contain the server version. This checks the Docker endpoint directly. `opencode api` can discover or start a different local service, so it is not a substitute for this check.

Check the container and workspace mount:

```sh
docker logs varro-opencode
docker exec varro-opencode pwd
docker exec varro-opencode ls -ld "$VARRO_WORKSPACE"
```

After connecting, create a session in Varro and ask it to read a known file in the workspace. A successful API probe alone does not verify the workspace mount or provider setup.

## Remote hosts and Dev Containers

For Remote SSH, publish the Docker port on the SSH host where Varro runs, and use that host's workspace path for the bind mount.

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
