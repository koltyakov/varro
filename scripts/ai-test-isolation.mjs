import { realpath, stat } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { readActiveSessions } from './ai-streaming-selection.mjs';

const testDataRoot = fileURLToPath(new URL('../artifacts/ai-test-data', import.meta.url));

export function testServerOrigin(server) {
  if (!server) throw new Error('An explicit isolated AI test server is required; production port 4096 is not a default');
  const url = new URL(server);
  if (url.protocol !== 'http:' || url.hostname !== '127.0.0.1' || !url.port ||
      url.username || url.password || url.pathname !== '/' || url.search || url.hash) {
    throw new Error('AI test server must be an explicit 127.0.0.1 HTTP origin with a port');
  }
  return url.origin;
}

export async function requireIsolatedTestServer(
  server,
  directory,
  root = testDataRoot,
  dataDirectory = process.env.VARRO_AI_DATA_DIR
) {
  const serverUrl = testServerOrigin(server);
  const response = await fetch(new URL(`/path?directory=${encodeURIComponent(directory)}`, serverUrl), {
    redirect: 'error',
    signal: AbortSignal.timeout(5_000),
  });
  if (!response.ok) throw new Error(`Cannot verify AI test data directory: HTTP ${response.status}`);
  const paths = await response.json();
  const reportedData = paths.data ?? dataDirectory;
  if (!reportedData) {
    throw new Error('OpenCode /path does not report its data directory; set VARRO_AI_DATA_DIR to the isolated directory containing opencode.db');
  }
  const data = await realpath(reportedData);
  if (dataDirectory && await realpath(dataDirectory) !== data) {
    throw new Error('OpenCode data directory does not match VARRO_AI_DATA_DIR');
  }
  const expectedRoot = path.resolve(root);
  const relative = path.relative(expectedRoot, data);
  if (await realpath(expectedRoot) !== expectedRoot || !relative || relative.startsWith('..') || path.isAbsolute(relative)) {
    throw new Error(`AI tests require a separate OpenCode database under ${expectedRoot}; refusing ${data}`);
  }
  const database = path.join(data, 'opencode.db');
  if (await realpath(database) !== database || (await stat(database)).nlink !== 1) {
    throw new Error('AI test database must not be a symlink or hard link');
  }
  // A claimed /path alone is insufficient: verify the listener actually holds this database.
  const evidence = await readActiveSessions({ serverUrl, sourceDatabase: database, directory });
  return { ...evidence, data, xdgDataHome: path.dirname(data) };
}
