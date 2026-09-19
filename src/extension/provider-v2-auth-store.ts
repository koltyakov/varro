import { join } from 'node:path';
import { Worker } from 'node:worker_threads';
import { resolveOpenCodeDataDirectory } from '../shared/opencode-data-directory';
import { parseProviderAuthStore, type ProviderAuthRecord } from './util/provider-limit';

/** V2 keeps credentials in SQLite; auth.json is only the legacy V1 store. */
export async function readOpenCodeV2AuthStore(
  databasePath = process.env.OPENCODE_DB ?? join(resolveOpenCodeDataDirectory(), 'opencode.db')
): Promise<Record<string, ProviderAuthRecord>> {
  return new Promise((resolve, reject) => {
    const worker = new Worker(READ_CREDENTIALS_WORKER, { eval: true, workerData: databasePath });
    const timeout = setTimeout(() => {
      reject(new Error('Timed out reading OpenCode V2 credentials'));
      void worker.terminate();
    }, 2_000);
    worker.once('message', (raw: string) => {
      clearTimeout(timeout);
      resolve(parseProviderAuthStore(raw));
    });
    worker.once('error', (error) => {
      clearTimeout(timeout);
      reject(error);
    });
    worker.once('exit', (code) => {
      clearTimeout(timeout);
      if (code !== 0) reject(new Error('Failed to read OpenCode V2 credentials'));
    });
  });
}

const READ_CREDENTIALS_WORKER = String.raw`
const { DatabaseSync } = require('node:sqlite');
const { parentPort, workerData } = require('node:worker_threads');
const database = new DatabaseSync(workerData, { readOnly: true });
try {
  const auth = Object.create(null);
  // Match V2 Credential.list selection: active first, then newest creation and ID.
  const rows = database.prepare(
    'SELECT integration_id, value FROM credential WHERE integration_id IS NOT NULL ' +
    'ORDER BY active DESC, time_created DESC, id DESC'
  ).all();
  const selected = new Set();
  for (const row of rows) {
    if (selected.has(row.integration_id)) continue;
    selected.add(row.integration_id);
    const value = JSON.parse(row.value);
    if (value?.type === 'key') auth[row.integration_id] = { type: 'api', key: value.key };
    else if (value?.type === 'oauth') {
      auth[row.integration_id] = { ...value, accountId: value.metadata?.accountId };
    }
  }
  parentPort.postMessage(JSON.stringify(auth));
} finally {
  database.close();
}
`;
