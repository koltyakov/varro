// @ts-check
import { realpath, stat } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { readActiveSessions } from './ai-streaming-selection.mjs';
import { AiOpenCodeClient } from './ai-opencode-client.mjs';

const testDataRoot = fileURLToPath(new URL('../artifacts/ai-test-data', import.meta.url));

export function testServerOrigin(server) {
  if (!server)
    throw new Error(
      'An explicit isolated AI test server is required; production port 4096 is not a default'
    );
  const url = new URL(server);
  if (
    url.protocol !== 'http:' ||
    url.hostname !== '127.0.0.1' ||
    !url.port ||
    url.username ||
    url.password ||
    url.pathname !== '/' ||
    url.search ||
    url.hash
  ) {
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
  const client = new AiOpenCodeClient(serverUrl, directory);
  const backend = await client.detect();
  const paths = await client.request('GET', '/path');
  const reportedData = paths.data ?? dataDirectory;
  if (!reportedData) {
    throw new Error(
      'OpenCode /path does not report its data directory; set VARRO_AI_DATA_DIR to the isolated directory containing opencode.db'
    );
  }
  const data = await realpath(reportedData);
  if (dataDirectory && (await realpath(dataDirectory)) !== data) {
    throw new Error('OpenCode data directory does not match VARRO_AI_DATA_DIR');
  }
  const expectedRoot = path.resolve(root);
  const relative = path.relative(expectedRoot, data);
  if (
    (await realpath(expectedRoot)) !== expectedRoot ||
    !relative ||
    relative.startsWith('..') ||
    path.isAbsolute(relative)
  ) {
    throw new Error(
      `AI tests require a separate OpenCode database under ${expectedRoot}; refusing ${data}`
    );
  }
  const database = path.join(data, 'opencode.db');
  if ((await realpath(database)) !== database || (await stat(database)).nlink !== 1) {
    throw new Error('AI test database must not be a symlink or hard link');
  }
  // A claimed /path alone is insufficient: verify native listener and database ownership.
  const evidence = await readActiveSessions({
    serverUrl,
    sourceDatabase: database,
    directory,
    client,
  });
  return { ...evidence, backend, data, xdgDataHome: path.dirname(data) };
}
