import { spawn, execFileSync } from 'node:child_process';
import { once } from 'node:events';
import { randomUUID } from 'node:crypto';
import { access, copyFile, chmod, mkdir, mkdtemp, open, writeFile } from 'node:fs/promises';
import os from 'node:os';
import net from 'node:net';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import { copyProviderCredentials, copyProviderSettings } from './ai-test-host-settings.mjs';
import { requireIsolatedTestServer } from './ai-test-isolation.mjs';
import { createWindowsProcessInspector } from './ai-streaming-selection.mjs';
import {
  isTestServerProcessAlive,
  stopTestServerChild,
  WindowsTestServerOwner,
} from './ai-test-server-lifecycle.mjs';
import { reserveLoopbackPort } from './vscode-launch-process.mjs';

const testRoot = fileURLToPath(new URL('../artifacts/ai-test-data', import.meta.url));

async function exists(filename) {
  try {
    await access(filename);
    return true;
  } catch (error) {
    if (error.code === 'ENOENT') return false;
    throw error;
  }
}

export async function startAiTestServer(workspace) {
  let binary = process.env.VARRO_OPENCODE_TEST_BINARY;
  if (!binary) {
    for (const candidate of ['opencode2', 'opencode']) {
      try {
        execFileSync(candidate, ['--version'], { stdio: 'ignore' });
        binary = candidate;
        break;
      } catch {}
    }
  }
  if (!binary) throw new Error('Set VARRO_OPENCODE_TEST_BINARY to the host OpenCode executable');
  const version = execFileSync(binary, ['--version'], { encoding: 'utf8' }).trim();
  const major = Number(version.replace(/^opencode v/, '').split('.')[0]);
  if (major !== 1 && major !== 2) throw new Error(`Unsupported OpenCode version: ${version}`);
  const sourceData = path.join(
    process.env.XDG_DATA_HOME || path.join(os.homedir(), '.local/share'),
    'opencode'
  );
  const sourceConfig = path.join(
    process.env.XDG_CONFIG_HOME || path.join(os.homedir(), '.config'),
    'opencode'
  );
  const sourceDatabase = process.env.OPENCODE_DB || path.join(sourceData, 'opencode.db');
  await mkdir(testRoot, { recursive: true });
  const root = await mkdtemp(path.join(testRoot, 'host-settings-'));
  await chmod(root, 0o700);
  // V2 generates server credentials when none are supplied. Keep the controller and editor in sync.
  process.env.OPENCODE_SERVER_PASSWORD ||= randomUUID();
  await writeFile(
    path.join(root, 'controller-env.json'),
    JSON.stringify({
      OPENCODE_SERVER_PASSWORD: process.env.OPENCODE_SERVER_PASSWORD,
      OPENCODE_SERVER_USERNAME: process.env.OPENCODE_SERVER_USERNAME || 'opencode',
    }),
    { mode: 0o600 }
  );
  for (const directory of ['data/opencode', 'config/opencode', 'state', 'cache']) {
    await mkdir(path.join(root, directory), { recursive: true });
  }
  await copyProviderSettings(sourceConfig, path.join(root, 'config/opencode'));
  const data = path.join(root, 'data/opencode');
  const database = path.join(data, 'opencode.db');
  if (major === 1 && (await exists(path.join(sourceData, 'auth.json')))) {
    await copyFile(path.join(sourceData, 'auth.json'), path.join(data, 'auth.json'));
    await chmod(path.join(data, 'auth.json'), 0o600);
  }
  const environment = {
    ...process.env,
    XDG_DATA_HOME: path.join(root, 'data'),
    XDG_CONFIG_HOME: path.join(root, 'config'),
    XDG_STATE_HOME: path.join(root, 'state'),
    XDG_CACHE_HOME: path.join(root, 'cache'),
    OPENCODE_DB: database,
    OPENCODE_PID: '',
    OPENCODE_DISABLE_AUTOUPDATE: 'true',
  };
  // Config overrides can redirect startup to host-owned files. Use the copied config.
  delete environment.OPENCODE_CONFIG;
  delete environment.OPENCODE_CONFIG_DIR;
  delete environment.OPENCODE_CONFIG_CONTENT;
  const port = await reserveLoopbackPort();
  const url = `http://127.0.0.1:${port}`;
  let child;
  const inspector =
    process.platform === 'win32' ? await createWindowsProcessInspector() : undefined;
  let owner;
  const verifiedLaunches = [];
  let listenerPid;
  let stopping;
  const stop = () =>
    (stopping ??= (async () => {
      if (owner) return owner.stop();
      if (!child?.pid) return;
      await stopTestServerChild(child);
      if (listenerPid && listenerPid !== child.pid && isTestServerProcessAlive(listenerPid))
        throw new Error(`Test server listener PID ${listenerPid} survived launch exit`);
      // A launcher exit alone does not prove that its endpoint closed.
      const probe = net.createServer();
      probe.listen(port, '127.0.0.1');
      await once(probe, 'listening');
      await new Promise((resolve, reject) =>
        probe.close((error) => (error ? reject(error) : resolve()))
      );
    })());
  const start = async (previous) => {
    child = undefined;
    owner = undefined;
    listenerPid = undefined;
    stopping = undefined;
    await inspector?.prepare();
    const log = await open(path.join(root, 'server.log'), 'a', 0o600);
    try {
      child = spawn(binary, ['serve', '--hostname', '127.0.0.1', '--port', String(port)], {
        cwd: workspace,
        env: environment,
        detached: true,
        stdio: ['ignore', log.fd, log.fd],
      });
      await once(child, 'spawn');
      if (inspector) owner = new WindowsTestServerOwner(inspector, port, child);
    } finally {
      await log.close();
    }
    const deadline = Date.now() + 30_000;
    while (true) {
      const ready = !owner || (await owner.capture());
      let isolation;
      try {
        if (!ready) throw new Error('Waiting for native test server listener');
        isolation = await requireIsolatedTestServer(url, workspace, testRoot, data);
      } catch (error) {
        if (Date.now() >= deadline || child.exitCode !== null || child.signalCode !== null) {
          throw new Error(`AI test server startup failed; see ${path.join(root, 'server.log')}`, {
            cause: error,
          });
        }
        await delay(200);
        continue;
      }
      listenerPid = isolation.serverPid;
      if (owner) await owner.verify(isolation.serverPid, previous);
      else if (previous?.pid === isolation.serverPid)
        throw new Error('Test server restart did not establish a fresh listener PID');
      verifiedLaunches.push({
        launchPid: child.pid,
        serverPid: listenerPid,
        birthIdentity: owner?.identity.birthIdentity,
      });
      inspector?.dispose();
      return isolation;
    }
  };
  try {
    let isolation = await start();
    if (major === 2 && (await exists(sourceDatabase))) {
      // Let this binary create its schema, then seed credentials while it is stopped.
      const previous = owner?.identity ?? { pid: isolation.serverPid };
      await stop();
      copyProviderCredentials(sourceDatabase, database);
      await chmod(database, 0o600);
      isolation = await start(previous);
    }
    child.unref();
    return {
      url,
      isolation,
      stop,
      root,
      configHome: environment.XDG_CONFIG_HOME,
      verifiedLaunches,
    };
  } catch (error) {
    try {
      if (!stopping) await stop();
    } catch (cleanupError) {
      throw new AggregateError(
        [error, cleanupError],
        `AI test server startup and cleanup failed: ${error.message}; ${cleanupError.message}`, { cause: cleanupError }
      );
    } finally {
      inspector?.dispose();
    }
    throw error;
  }
}
