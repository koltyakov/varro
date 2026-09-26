import { access, mkdir, readFile, writeFile } from 'node:fs/promises';
import { DatabaseSync } from 'node:sqlite';
import path from 'node:path';
import { parse } from 'jsonc-parser';

export async function copyHostModelPreferences(sourceUserData, destinationUserData) {
  const filename = path.join(sourceUserData, 'User/globalStorage/state.vscdb');
  try {
    await access(filename);
  } catch (error) {
    if (error.code === 'ENOENT') return;
    throw error;
  }
  const source = new DatabaseSync(filename, { readOnly: true });
  let preferences;
  try {
    const row = source.prepare('SELECT value FROM ItemTable WHERE key = ?').get('koltyakov.varro');
    if (!row) return;
    const state = JSON.parse(Buffer.from(row.value).toString('utf8'));
    preferences = Object.fromEntries(
      Object.entries(state).filter(
        ([key]) =>
          key === 'varro.modelPreferences' || key.startsWith('varro.modelPreferences.hostMigration')
      )
    );
  } finally {
    source.close();
  }
  if (!Object.keys(preferences).length) return;
  const directory = path.join(destinationUserData, 'User/globalStorage');
  await mkdir(directory, { recursive: true });
  const destination = new DatabaseSync(path.join(directory, 'state.vscdb'));
  try {
    destination.exec(
      'CREATE TABLE IF NOT EXISTS ItemTable (key TEXT UNIQUE ON CONFLICT REPLACE, value BLOB)'
    );
    destination
      .prepare('INSERT INTO ItemTable (key, value) VALUES (?, ?)')
      .run('koltyakov.varro', JSON.stringify(preferences));
  } finally {
    destination.close();
  }
}

// Read credentials only. Never copy a production database or its session tables.
export function copyProviderCredentials(sourcePath, destinationPath) {
  const source = new DatabaseSync(sourcePath, { readOnly: true });
  const destination = new DatabaseSync(destinationPath);
  try {
    if (!source.prepare("SELECT name FROM sqlite_master WHERE name = 'credential'").get()) return 0;
    const columns = destination
      .prepare('PRAGMA table_info(credential)')
      .all()
      .map((row) => row.name);
    if (!columns.length)
      throw new Error('Initialize the isolated v2 database before copying credentials');
    const quoted = columns.map((name) => `"${name.replaceAll('"', '""')}"`).join(', ');
    const rows = source
      .prepare(`SELECT ${quoted} FROM credential WHERE integration_id IS NOT NULL`)
      .all();
    const insert = destination.prepare(
      `INSERT INTO credential (${quoted}) VALUES (${columns.map(() => '?').join(', ')})`
    );
    destination.exec('BEGIN');
    try {
      for (const row of rows) insert.run(...columns.map((name) => row[name]));
      destination.exec('COMMIT');
    } catch (error) {
      destination.exec('ROLLBACK');
      throw error;
    }
    return rows.length;
  } finally {
    source.close();
    destination.close();
  }
}

export async function copyProviderSettings(sourceDirectory, destinationDirectory) {
  const copied = [];
  for (const name of ['opencode.json', 'opencode.jsonc']) {
    let text;
    try {
      text = await readFile(path.join(sourceDirectory, name), 'utf8');
    } catch (error) {
      if (error.code === 'ENOENT') continue;
      throw error;
    }
    const errors = [];
    const config = parse(text, errors, { allowTrailingComma: true });
    // oxlint-disable-next-line anti-slop/no-runtime-typeof -- Validate the host JSONC object at the file boundary.
    if (errors.length || !config || typeof config !== 'object' || Array.isArray(config)) {
      throw new Error(`Invalid host OpenCode configuration: ${name}`);
    }
    const settings = {};
    for (const key of [
      'model',
      'small_model',
      'providers',
      'provider',
      'enabled_providers',
      'disabled_providers',
    ]) {
      if (Object.hasOwn(config, key)) settings[key] = config[key];
    }
    // Resolve parsed strings so serialization escapes Windows paths and other JSON characters.
    const serialized = JSON.stringify(settings, (_key, value) =>
      // oxlint-disable-next-line anti-slop/no-runtime-typeof -- JSON values need a string guard before resolving file references.
      typeof value === 'string'
        ? value.replace(
            /\{file:([^}]+)\}/g,
            (_, filename) =>
              `{file:${filename.startsWith('~') ? filename : path.resolve(sourceDirectory, filename)}}`
          )
        : value
    );
    await writeFile(path.join(destinationDirectory, name), serialized, {
      mode: 0o600,
      flag: 'wx',
    });
    copied.push(name);
  }
  return copied;
}
