/** Scalar provenance only. Never a usage snapshot or a replayable conversation. */
export type OriginalUsageTiming = {
  session_id: string;
  message_id: string;
  source_session_id: string;
  source_message_id: string;
  time_created: number;
  provider_id: string;
  model_id: string;
  time_completed: number;
  provenance: 'v1-message';
};

/** Shared by the isolated usage worker's readers and its explicit preservation task. */
export const ORIGINAL_USAGE_TIMING_WORKER = String.raw`
const USAGE_ARCHIVE_SCHEMA =
  'CREATE TABLE IF NOT EXISTS usage_session (id TEXT PRIMARY KEY, identity TEXT NOT NULL UNIQUE, time_updated INTEGER NOT NULL, version INTEGER NOT NULL); ' +
  'CREATE TABLE IF NOT EXISTS usage_message (id TEXT NOT NULL, session_id TEXT NOT NULL REFERENCES usage_session(id) ON DELETE CASCADE, data TEXT NOT NULL, PRIMARY KEY (session_id, id)); ' +
  'CREATE INDEX IF NOT EXISTS usage_message_session_idx ON usage_message(session_id); ' +
  'CREATE TABLE IF NOT EXISTS usage_cleanup (id TEXT PRIMARY KEY, directory TEXT NOT NULL, time_updated INTEGER NOT NULL); ' +
  'CREATE TABLE IF NOT EXISTS usage_cleanup_directory (session_id TEXT NOT NULL, directory TEXT NOT NULL, PRIMARY KEY(session_id,directory)); ' +
  'CREATE TABLE IF NOT EXISTS usage_artifact (session_id TEXT NOT NULL, path TEXT NOT NULL, PRIMARY KEY (session_id, path));';
const TIMING_COLUMNS = 'session_id,message_id,source_session_id,source_message_id,time_created,provider_id,model_id,time_completed,provenance';
const validateUsageArchiveFile = () => {
  const { lstatSync, statSync } = require('node:fs');
  let target;
  try { target = lstatSync(workerData.archivePath); }
  catch (error) { if (error.code === 'ENOENT') return; throw error; }
  if (!target.isFile() || target.isSymbolicLink() || target.nlink !== 1) throw new Error('Usage archive must be a regular file without links.');
  const source = statSync(workerData.databasePath);
  if (target.ino !== 0 && target.ino === source.ino && target.dev === source.dev) throw new Error('Usage archive must not refer to the live database.');
};
const checkTimingSchema = (database) => {
  const version = database.prepare('PRAGMA user_version').get().user_version;
  if (version !== 0 && version !== 1) throw new Error('Unsupported usage archive schema version: ' + version);
  const hasTiming = !!database.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='usage_original_timing'").get();
  if (hasTiming !== (version === 1)) throw new Error('Incomplete original usage timing schema. Restore the statistics archive before cleanup.');
  if (hasTiming) {
    const columns = database.prepare('PRAGMA table_info(usage_original_timing)').all();
    if (columns.length !== 9 || TIMING_COLUMNS.split(',').some((name,index) => columns[index]?.name !== name || columns[index].pk !== (index < 2 ? index + 1 : 0)) ||
      database.prepare('PRAGMA foreign_key_list(usage_original_timing)').all().length)
      throw new Error('Unsupported original usage timing table layout.');
  }
  return hasTiming;
};
const initializeUsageArchive = (database) => {
  checkTimingSchema(database);
  database.exec(USAGE_ARCHIVE_SCHEMA);
  database.exec('CREATE TABLE IF NOT EXISTS usage_original_timing (' +
    'session_id TEXT NOT NULL, message_id TEXT NOT NULL, source_session_id TEXT NOT NULL, source_message_id TEXT NOT NULL, ' +
    'time_created INTEGER NOT NULL, provider_id TEXT NOT NULL, model_id TEXT NOT NULL, time_completed INTEGER NOT NULL, ' +
    "provenance TEXT NOT NULL CHECK(provenance = 'v1-message'), PRIMARY KEY(session_id,message_id)); PRAGMA user_version=1;");
};
const validTiming = (row) => row && row.provenance === 'v1-message' &&
  row.source_message_id === row.message_id &&
  ['session_id','message_id','source_session_id','source_message_id','provider_id','model_id'].every(key => typeof row[key] === 'string' && row[key].length > 0 && row[key].length <= 512) &&
  Number.isSafeInteger(row.time_created) && row.time_created >= 0 && Number.isSafeInteger(row.time_completed) && row.time_completed >= row.time_created;
class OriginalUsageTimingStore {
  constructor(path) {
    this.rows = new Map();
    if (!existsSync(path)) return;
    this.database = new DatabaseSync(path, { readOnly: true });
    try {
      this.database.exec('PRAGMA query_only=ON; PRAGMA busy_timeout=1000; BEGIN;');
      if (checkTimingSchema(this.database)) {
        this.get = this.database.prepare('SELECT ' + TIMING_COLUMNS + ' FROM usage_original_timing WHERE session_id=? AND message_id=?');
        this.list = this.database.prepare('SELECT ' + TIMING_COLUMNS + ' FROM usage_original_timing WHERE session_id=? ORDER BY message_id');
      }
    } catch (error) { this.close(); throw error; }
  }
  readSessions(ids) {
    const rows = [];
    let bytes = 0;
    for (const id of new Set(ids)) {
      if (!this.list) continue;
      for (const row of this.list.iterate(id)) {
        if (!validTiming(row)) throw new Error('Invalid preserved original usage timing.');
        bytes += Buffer.byteLength(JSON.stringify(row));
        if (bytes > 64 * 1024 * 1024) throw new Error('Original usage timing exceeds the 64 MB read limit.');
        if (rows.length >= 100000) throw new Error('Original usage timing exceeds the 100,000-record read limit.');
        rows.push(row);
      }
    }
    return rows;
  }
  // Release the archive read transaction before its separate writer commits.
  freeze(ids) {
    for (const row of this.readSessions(ids)) this.rows.set(JSON.stringify([row.session_id,row.message_id]),row);
    this.close();
  }
  completed(row) {
    if (!this.get && !this.rows.size) return null;
    const saved = this.get?.get(row.sessionID,row.messageID) ?? this.rows.get(JSON.stringify([row.sessionID,row.messageID]));
    if (!saved) return null;
    if (!validTiming(saved)) throw new Error('Invalid preserved original usage timing.');
    return saved.source_session_id === row.identity && saved.time_created === row.timeCreated &&
      saved.provider_id === (row.providerID ?? row.nestedProviderID) && saved.model_id === (row.modelID ?? row.nestedModelID)
      ? saved.time_completed : null;
  }
  close() {
    this.get = undefined;
    this.list = undefined;
    this.database?.close();
    this.database = undefined;
  }
}
const preserveUsageTimings = (sessions, allowEmpty = false) => {
  if (!sessions.length || sessions.length > 1000 || new Set(sessions.map(s => s.id)).size !== sessions.length) throw new Error('Preserve between 1 and 1,000 distinct V2 sessions.');
  const database = new DatabaseSync(workerData.databasePath, { readOnly: true });
  let archive;
  try {
    database.exec('PRAGMA query_only=ON; PRAGMA busy_timeout=1000; BEGIN;');
    const header = database.prepare("SELECT id,time_updated,coalesce(json_extract(metadata,'$.varroLegacyImport.sourceSessionID'),id) AS identity FROM session_v2 WHERE id=?");
    const messages = database.prepare("SELECT id,json_extract(data,'$.time.created','$.providerID','$.model.providerID','$.modelID','$.model.id','$.model.modelID') AS fields FROM session_message WHERE session_id=? AND type='assistant' ORDER BY seq");
    const original = database.prepare("SELECT session_id,CASE WHEN json_valid(data) THEN json_extract(data,'$.role','$.time.created','$.providerID','$.modelID','$.time.completed') END AS fields FROM message WHERE id=?");
    const rows = [];
    let bytes = 0;
    for (const expected of sessions) {
      const session = header.get(expected.id);
      if (!session || session.time_updated !== expected.updated) throw new Error('Sessions changed or are missing while preserving original usage timing.');
      const start = rows.length;
      let scanned = 0;
      for (const message of messages.iterate(session.id)) {
        if (++scanned > 100000) throw new Error('Original usage timing exceeds the 100,000-message session limit.');
        const fields = JSON.parse(message.fields);
        const source = original.get(message.id);
        const timing = source?.fields ? JSON.parse(source.fields) : null;
        if (!timing || source.session_id !== session.identity || timing[0] !== 'assistant' ||
          typeof fields[0] !== 'number' || timing[1] !== fields[0] || timing[2] !== (fields[1] ?? fields[2]) ||
          timing[3] !== (fields[3] ?? fields[4] ?? fields[5]) || typeof timing[4] !== 'number' || timing[4] < fields[0]) continue;
        const row = { session_id: session.id, message_id: message.id, source_session_id: session.identity, source_message_id: message.id,
          time_created: fields[0], provider_id: timing[2], model_id: timing[3], time_completed: timing[4], provenance: 'v1-message' };
        if (!validTiming(row)) throw new Error('Cannot preserve invalid original usage timing.');
        bytes += Buffer.byteLength(JSON.stringify(row));
        if (bytes > 64 * 1024 * 1024) throw new Error('Original usage timing exceeds the 64 MB preservation limit.');
        if (rows.length >= 100000) throw new Error('Original usage timing exceeds the 100,000-record preservation limit.');
        rows.push(row);
      }
      if (rows.length === start && !allowEmpty) throw new Error('No matching original usage timing for ' + session.id);
    }
    progress('Committing original usage timing');
    // Do not hold a read connection to this archive while its writer commits.
    validateUsageArchiveFile();
    if (!existsSync(workerData.archivePath)) {
      const { openSync, closeSync } = require('node:fs');
      closeSync(openSync(workerData.archivePath, 'wx', 0o600));
    }
    archive = new DatabaseSync(workerData.archivePath);
    archive.exec('PRAGMA busy_timeout=5000; PRAGMA synchronous=FULL; BEGIN IMMEDIATE;');
    initializeUsageArchive(archive);
    const existing = archive.prepare('SELECT ' + TIMING_COLUMNS + ' FROM usage_original_timing WHERE session_id=? AND message_id=?');
    const insert = archive.prepare('INSERT INTO usage_original_timing (' + TIMING_COLUMNS + ') VALUES (?,?,?,?,?,?,?,?,?)');
    for (const row of rows) {
      const previous = existing.get(row.session_id,row.message_id);
      if (previous) {
        if (TIMING_COLUMNS.split(',').some(key => previous[key] !== row[key])) throw new Error('Conflicting original usage timing for ' + row.message_id);
      } else insert.run(...TIMING_COLUMNS.split(',').map(key => row[key]));
    }
    archive.exec('COMMIT');
    archive.close();
    archive = undefined;
    archive = new DatabaseSync(workerData.archivePath, { readOnly: true });
    const verify = archive.prepare('SELECT ' + TIMING_COLUMNS + ' FROM usage_original_timing WHERE session_id=? AND message_id=?');
    for (const row of rows) {
      const stored = verify.get(row.session_id,row.message_id);
      if (!stored || TIMING_COLUMNS.split(',').some(key => stored[key] !== row[key])) throw new Error('Could not verify committed original usage timing.');
    }
    return { sessions: sessions.length, messages: rows.length };
  } finally { archive?.close(); database.close(); }
};
`;
