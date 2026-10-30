import { dirname, join, parse } from 'node:path';
import { resolveOpenCodeDataDirectory } from '../shared/opencode-data-directory';

export function usageDatabasePaths() {
  const dataDirectory = resolveOpenCodeDataDirectory();
  const databasePath = process.env.OPENCODE_DB ?? join(dataDirectory, 'opencode.db');
  return {
    databasePath,
    archivePath: join(dirname(databasePath), `${parse(databasePath).name}-stats.db`),
    dataDirectory,
  };
}
