import { resolve as resolvePath } from 'node:path';
import { Worker } from 'node:worker_threads';
import { resolveOpenCodeDataDirectory } from '../shared/opencode-data-directory';

/** Inspect only the saved selection, without creating or migrating OpenCode's database. */
export async function hasStoredWebSearchPreference(): Promise<boolean> {
  if (process.env.OPENCODE_DB === ':memory:') return false;
  const databasePath = resolvePath(
    resolveOpenCodeDataDirectory(),
    process.env.OPENCODE_DB ?? 'opencode.db'
  );
  return new Promise((resolve, reject) => {
    const worker = new Worker(READ_PREFERENCE_WORKER, { eval: true, workerData: databasePath });
    const timeout = setTimeout(() => {
      reject(new Error('Timed out inspecting the saved OpenCode web search preference'));
      void worker.terminate();
    }, 2_000);
    worker.once('message', (present: boolean) => {
      clearTimeout(timeout);
      resolve(present);
    });
    worker.once('error', (error) => {
      clearTimeout(timeout);
      reject(error);
    });
    worker.once('exit', () => {
      clearTimeout(timeout);
      reject(new Error('OpenCode web search preference reader exited without a result'));
    });
  });
}

const READ_PREFERENCE_WORKER = String.raw`
const { statSync } = require('node:fs');
const { DatabaseSync } = require('node:sqlite');
const { parentPort, workerData } = require('node:worker_threads');
let present = true;
try {
  statSync(workerData);
} catch (error) {
  if (error.code !== 'ENOENT') throw error;
  present = false;
}
if (!present) {
  parentPort.postMessage(false);
} else {
  const database = new DatabaseSync(workerData, { readOnly: true });
  try {
    const table = database.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'kv'").get();
    // Older databases may not have the preference table. Never migrate them here.
    const present = table && database.prepare('SELECT 1 FROM kv WHERE key = ?').get('websearch:provider');
    parentPort.postMessage(Boolean(present));
  } finally {
    database.close();
  }
}
`;
