/* oxlint-disable anti-slop/no-module-mocking, anti-slop/no-runtime-typeof, anti-slop/no-unknown-parameters -- Mock VS Code and inspect worker options/replies while counting real SQLite work against isolated fixtures. */
import { mkdir, mkdtemp, rm, readFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ProgressOptions } from 'vscode';
import type { WorkerOptions } from 'node:worker_threads';
import type * as workerThreads from 'node:worker_threads';
import { asRecord } from '../shared/type-utils';
import {
  archiveSessionUsage,
  readAllTimeUsageCsv,
  UsageReportService,
} from './usage-report-service';
import { usageDatabasePaths } from './usage-database-paths';
import { OpenCodeV2SessionState } from './opencode-v2-session-state';

const mocks = vi.hoisted(() => ({ content: '' }));
const archiveWork = vi.hoisted(() => ({ metadataReads: 0, originalRoleReads: 0, jsonCalls: 0 }));
const reportWork = vi.hoisted(() => ({
  promptSetEntries: -1,
  promptRows: -1,
  promptInserts: -1,
  tempStore: -1,
  tempCache: -1,
}));
vi.mock('node:worker_threads', async (importOriginal) => {
  const original = await importOriginal<typeof workerThreads>();
  return {
    ...original,
    Worker: class extends original.Worker {
      constructor(filename: string | URL, options?: WorkerOptions) {
        let source = filename;
        if (
          typeof source === 'string' &&
          options?.eval &&
          Array.isArray(asRecord(options.workerData)?.windows)
        ) {
          source = source
            .replace(
              '\n      timing = new OriginalUsageTimingStore(workerData.archivePath);',
              String.raw`
            const probe = { metadataReads: 0, originalRoleReads: 0, jsonCalls: 0 };
            const builtins = new DatabaseSync(':memory:');
            const extracts = new Map();
            database.function('json_extract', { deterministic: true, varargs: true }, function(...args) {
              probe.jsonCalls++;
              if (args[1] === '$.varroLegacyImport.sourceSessionID') probe.metadataReads++;
              if (args[1] === '$.role') probe.originalRoleReads++;
              let extract = extracts.get(args.length);
              if (!extract) { extract = builtins.prepare('SELECT json_extract(' + args.map(() => '?').join(',') + ') AS value'); extracts.set(args.length, extract); }
              return extract.get(...args).value;
            });
            timing = new OriginalUsageTimingStore(workerData.archivePath);
          `
            )
            .replace(
              'parentPort.postMessage({ archived: archiveSessions.length });',
              'parentPort.postMessage({ archived: archiveSessions.length, probe });'
            )
            .replace('rowCount: csvGroups.size });', 'rowCount: csvGroups.size, probe });')
            .replace(
              'insertReportPrompt.run(index, promptID, route);',
              'probe.promptInserts = (probe.promptInserts ?? 0) + 1; insertReportPrompt.run(index, promptID, route);'
            )
            .replace(
              'sessionCount: Number(sessionCount),',
              String.raw`probe: { ...probe,
                promptSetEntries: aggregates.reduce((count, window) => count + window.promptIDs.size + [...window.groups.values()].reduce((sum, group) => sum + group.promptIDs.size, 0), 0),
                promptRows: workerData.allTimeReport ? database.prepare('SELECT count(*) AS count FROM usage_report_prompt').get().count : 0,
                promptInserts: probe.promptInserts ?? 0,
                tempStore: database.prepare('PRAGMA temp_store').get().temp_store,
                tempCache: database.prepare('PRAGMA temp.cache_size').get().cache_size,
              }, sessionCount: Number(sessionCount),`
            );
        }
        super(source, options);
        this.on('message', (value: unknown) => {
          const probe = asRecord(asRecord(value)?.probe);
          if (
            typeof probe?.metadataReads === 'number' &&
            typeof probe.originalRoleReads === 'number'
          ) {
            archiveWork.metadataReads = probe.metadataReads;
            archiveWork.originalRoleReads = probe.originalRoleReads;
            if (typeof probe.jsonCalls === 'number') archiveWork.jsonCalls = probe.jsonCalls;
            for (const key of [
              'promptSetEntries',
              'promptRows',
              'promptInserts',
              'tempStore',
              'tempCache',
            ] as const) {
              if (typeof probe[key] === 'number') reportWork[key] = probe[key];
            }
          }
        });
      }
    },
  };
});
vi.mock('vscode', () => ({
  ProgressLocation: { Notification: 15 },
  commands: { executeCommand: vi.fn() },
  workspace: {
    openTextDocument: async (options: { content: string }) => {
      mocks.content = options.content;
      return { uri: 'untitled:usage' };
    },
  },
  window: {
    withProgress: async (_options: ProgressOptions, task: () => Promise<string>) => task(),
    showTextDocument: vi.fn(),
    showErrorMessage: vi.fn(),
  },
}));

const directories: string[] = [];
afterEach(async () => {
  vi.unstubAllEnvs();
  await Promise.all(
    directories.splice(0).map((path) => rm(path, { recursive: true, force: true }))
  );
});

async function fixture(versions: number[]) {
  const parent = resolve('artifacts/ai-test-data');
  await mkdir(parent, { recursive: true });
  const directory = await mkdtemp(join(parent, 'usage-'));
  directories.push(directory);
  const path = join(directory, 'opencode.db');
  vi.stubEnv('OPENCODE_DB', path);
  vi.stubEnv('XDG_STATE_HOME', directory);
  vi.stubEnv('VARRO_TEST_STATE_ROOT', join(directory, 'varro-state'));
  const database = new DatabaseSync(path);
  if (versions.includes(1)) {
    database.exec(`CREATE TABLE session (id TEXT PRIMARY KEY, time_updated INTEGER);
      CREATE TABLE message (id TEXT PRIMARY KEY, session_id TEXT, data TEXT);
      CREATE INDEX message_session_idx ON message(session_id);`);
  }
  if (versions.includes(2)) {
    database.exec(`CREATE TABLE session_v2 (id TEXT PRIMARY KEY, time_updated INTEGER, metadata TEXT);
      CREATE TABLE session_message (id TEXT PRIMARY KEY, session_id TEXT, type TEXT, seq INTEGER, data TEXT);
      CREATE UNIQUE INDEX session_message_session_seq_idx ON session_message(session_id, seq);`);
  }
  const now = Date.now();
  function add(version: number, id: string, updated: number, model: string, sourceID?: string) {
    const data = {
      role: version === 1 ? 'assistant' : undefined,
      parentID: version === 1 ? `${id}-prompt` : undefined,
      providerID: version === 1 ? 'provider' : undefined,
      modelID: version === 1 ? model : undefined,
      model: version === 2 ? { providerID: 'provider', id: model } : undefined,
      time: { created: now - 2_000, completed: now },
      tokens: { input: 10, output: 5, reasoning: 2, cache: { read: 3, write: 1 } },
    };
    if (version === 1) {
      database.prepare('INSERT INTO session VALUES (?, ?)').run(id, updated);
      database
        .prepare('INSERT INTO message VALUES (?, ?, ?)')
        .run(`${id}-reply`, id, JSON.stringify(data));
    } else {
      database
        .prepare('INSERT INTO session_v2 VALUES (?, ?, ?)')
        .run(
          id,
          updated,
          sourceID ? JSON.stringify({ varroLegacyImport: { sourceSessionID: sourceID } }) : null
        );
      const insert = database.prepare('INSERT INTO session_message VALUES (?, ?, ?, ?, ?)');
      insert.run(`${id}-prompt`, id, 'user', 1, '{}');
      insert.run(`${id}-reply`, id, 'assistant', 2, JSON.stringify(data));
      insert.run(`${id}-reply-2`, id, 'assistant', 3, JSON.stringify(data));
    }
  }
  async function report(allTime = false) {
    const before = database.prepare('SELECT name, sql FROM sqlite_master ORDER BY name').all();
    database.close();
    const request = vi.fn();
    const start = vi.fn();
    await new UsageReportService({ request }, start).openReport(allTime);
    expect(request).not.toHaveBeenCalled();
    expect(start).not.toHaveBeenCalled();
    const check = new DatabaseSync(path, { readOnly: true });
    expect(check.prepare('SELECT name, sql FROM sqlite_master ORDER BY name').all()).toEqual(
      before
    );
    check.close();
    return mocks.content;
  }
  return { add, report, now, database };
}

describe('local usage database versions', () => {
  it('reports over one million assistant messages without the recent-report aggregation or scan caps', async () => {
    const { database, report, now } = await fixture([2]);
    const count = 1_000_001;
    database.prepare("INSERT INTO session_v2 VALUES ('all-history',?,NULL)").run(now);
    database.exec("INSERT INTO session_message VALUES ('prompt','all-history','user',0,'{}');");
    const body = JSON.stringify({
      model: { providerID: 'provider', id: 'model' },
      time: { created: now, completed: now },
      tokens: { input: 10, output: 5 },
    });
    database
      .prepare(
        "WITH RECURSIVE n(value) AS (VALUES(1) UNION ALL SELECT value+1 FROM n WHERE value < ?) INSERT INTO session_message SELECT 'reply-'||value,'all-history','assistant',value,? FROM n"
      )
      .run(count, body);
    await expect(
      new UsageReportService({ request: vi.fn() }, vi.fn()).openReport()
    ).rejects.toThrow('250,000-message local aggregation limit');
    const content = await report(true);
    for (const title of ['Today', 'Last 7 rolling days', 'Last 30 rolling days', 'All time']) {
      expect(content.split(`## ${title}\n`)[1]?.split('\n## ')[0]).toContain(
        '| provider | model | 1 | 15,000,015 | <1s | 10,000,010 | 5,000,005 |'
      );
    }
    expect(reportWork).toEqual({
      promptSetEntries: 0,
      promptRows: 4,
      promptInserts: 4,
      tempStore: 1,
      tempCache: -8192,
    });
  }, 60_000);

  it('deduplicates all-time prompts across models, nonconsecutive replies, sessions, and windows', async () => {
    const { database, report, now } = await fixture([2]);
    database.exec("INSERT INTO session_v2 VALUES ('first',1,NULL),('second',1,NULL);");
    const insert = database.prepare('INSERT INTO session_message VALUES (?, ?, ?, ?, ?)');
    for (const sessionID of ['first', 'second']) {
      for (let index = 0; index < 12; index++) {
        insert.run(
          `${sessionID}-${index}`,
          sessionID,
          'assistant',
          index,
          JSON.stringify({
            parentID: `prompt-${index % 3}`,
            model: { providerID: 'provider', id: `model-${index % 2}` },
            time: { created: now - 2000, completed: now - 1000 },
            tokens: { input: 1, output: 1 },
          })
        );
      }
    }
    const older = now - 40 * 24 * 60 * 60 * 1000;
    insert.run(
      'older',
      'first',
      'assistant',
      12,
      JSON.stringify({
        parentID: 'old-prompt',
        model: { providerID: 'provider', id: 'model-0' },
        time: { created: older, completed: older + 1000 },
        tokens: { input: 1, output: 1 },
      })
    );
    const content = await report(true);
    for (const title of ['Today', 'Last 7 rolling days', 'Last 30 rolling days']) {
      const section = content.split(`## ${title}\n`)[1]?.split('\n## ')[0];
      expect(section).toContain('| provider | model-0 | 6 | 24 | 12s |');
      expect(section).toContain('| provider | model-1 | 6 | 24 | 12s |');
      expect(section).toContain('| **Total** |  | 6 | 48 | 24s |');
    }
    const allTime = content.split('## All time\n')[1];
    expect(allTime).toContain('| provider | model-0 | 7 | 26 | 13s |');
    expect(allTime).toContain('| provider | model-1 | 6 | 24 | 12s |');
    expect(allTime).toContain('| **Total** |  | 7 | 50 | 25s |');
    expect(reportWork.promptSetEntries).toBe(0);
    expect(reportWork.promptRows).toBe(49);
  });

  it('retains the provider/model route bound for all-time reports', async () => {
    const { database, report, now } = await fixture([2]);
    database.exec("INSERT INTO session_v2 VALUES ('many-models',1,NULL);");
    const body = JSON.stringify({
      model: { providerID: 'provider', id: 'model' },
      time: { created: now, completed: now },
      tokens: { input: 1, output: 1 },
    });
    database
      .prepare(
        "WITH RECURSIVE n(value) AS (VALUES(1) UNION ALL SELECT value+1 FROM n WHERE value < 4097) INSERT INTO session_message SELECT 'reply-'||value,'many-models','assistant',value,json_set(?,'$.model.id','model-'||value) FROM n"
      )
      .run(body);
    await expect(report(true)).rejects.toThrow('4,096-route local aggregation limit');
  });

  it('bounds JSON extraction for an all-time report with long assistant runs', async () => {
    const { database, report, now } = await fixture([2]);
    const count = 2_001;
    database.exec(
      "INSERT INTO session_v2 VALUES ('long-history',1,NULL); INSERT INTO session_message VALUES ('prompt','long-history','user',0,'{}');"
    );
    const body = JSON.stringify({
      model: { providerID: 'provider', id: 'model' },
      time: { created: now - 1000, completed: now },
      tokens: { input: 10, output: 5 },
      content: 'x'.repeat(8 * 1024),
    });
    database
      .prepare(
        "WITH RECURSIVE n(value) AS (VALUES(1) UNION ALL SELECT value+1 FROM n WHERE value < ?) INSERT INTO session_message SELECT 'reply-'||value,'long-history','assistant',value,? FROM n"
      )
      .run(count, body);
    archiveWork.jsonCalls = 0;
    const content = await report(true);
    expect(content).toContain('| provider | model | 1 | 30,015 | 33m 21s |');
    expect(archiveWork.jsonCalls).toBeLessThanOrEqual(2 * count + 10);
  }, 30_000);

  it('cancels a real CSV scan without changing the source history', async () => {
    const { database } = await fixture([2]);
    database.exec("INSERT INTO session_v2 VALUES ('cancel-history',1,NULL);");
    const body = JSON.stringify({
      model: { providerID: 'provider', id: 'model' },
      time: { created: 1, completed: 2 },
      tokens: { input: 1, output: 1 },
    });
    database
      .prepare(
        "WITH RECURSIVE n(value) AS (VALUES(1) UNION ALL SELECT value+1 FROM n WHERE value < 20000) INSERT INTO session_message SELECT 'reply-'||value,'cancel-history','assistant',value,? FROM n"
      )
      .run(body);
    const controller = new AbortController();
    await expect(
      readAllTimeUsageCsv((message) => {
        if (message.startsWith('Read ')) controller.abort();
      }, controller.signal)
    ).rejects.toThrow('cancelled');
    expect(database.prepare('SELECT count(*) AS count FROM session_message').get()?.count).toBe(
      20_000
    );
    database.close();
  });

  it('exports over 190,000 assistant records with one compact JSON projection per record', async () => {
    const { database } = await fixture([2]);
    const count = 200_001;
    database.exec(
      "INSERT INTO session_v2 VALUES ('large-history',1,NULL); INSERT INTO session_message VALUES ('prompt','large-history','user',0,'{}');"
    );
    const body = JSON.stringify({
      model: { providerID: 'provider', id: 'model', variant: 'high' },
      time: { created: Date.UTC(2025, 0, 1), completed: Date.UTC(2025, 0, 1) + 1000 },
      tokens: { input: 10, output: 5, reasoning: 2, cache: { read: 3, write: 1 } },
    });
    database
      .prepare(
        "WITH RECURSIVE n(value) AS (VALUES(1) UNION ALL SELECT value+1 FROM n WHERE value < ?) INSERT INTO session_message SELECT 'reply-'||value,'large-history','assistant',value,? FROM n"
      )
      .run(count, body);
    const progress: string[] = [];
    archiveWork.jsonCalls = 0;
    const result = await readAllTimeUsageCsv((message) => progress.push(message));
    expect(result.rowCount).toBe(1);
    expect(result.csv).toContain(
      '2025-01-01,provider,model,high,200001,2000010,1000005,400002,600003,200001,4200021,,0\r\n'
    );
    expect(archiveWork.jsonCalls).toBeLessThanOrEqual(count + 5);
    expect(progress).toContain(`Read ${(200_000).toLocaleString()} assistant messages`);
    expect(progress.at(-1)).toBe('Formatting daily CSV');
    database.close();
  }, 30_000);

  it('exports all-time UTC day/model/reasoning rows with separate token and cost columns', async () => {
    const { add, database, now } = await fixture([1, 2]);
    add(1, 'legacy', 1, 'legacy-model');
    add(2, 'native', 2, 'native-model');
    const beforeMidnight = Date.UTC(2025, 0, 1, 23, 59, 59);
    database
      .prepare(
        "UPDATE message SET data = json_set(data, '$.time.created', ?, '$.time.completed', ?)"
      )
      .run(beforeMidnight - 1000, beforeMidnight);
    database
      .prepare(
        "UPDATE session_message SET data = json_set(data, '$.time.created', ?, '$.time.completed', ?, '$.model.variant', 'high', '$.cost', 0.125) WHERE type = 'assistant'"
      )
      .run(beforeMidnight - 1000, beforeMidnight);
    database
      .prepare(
        "UPDATE session_message SET data = json_set(data, '$.time.created', ?, '$.time.completed', ?, '$.model.variant', 'low') WHERE id = 'native-reply-2'"
      )
      .run(beforeMidnight, beforeMidnight + 1000);
    const before = database.prepare('SELECT name, sql FROM sqlite_master ORDER BY name').all();
    const result = await readAllTimeUsageCsv();
    expect(result.rowCount).toBe(3);
    expect(result.csv).toBe(
      '\uFEFFday_utc,provider,model,reasoning_setting,messages,input_tokens,output_tokens,reasoning_tokens,cache_read_tokens,cache_write_tokens,total_tokens,reported_cost_usd,costed_messages\r\n' +
        '2025-01-01,provider,legacy-model,unknown,1,10,5,2,3,1,21,,0\r\n' +
        '2025-01-01,provider,native-model,high,1,10,5,2,3,1,21,0.125,1\r\n' +
        '2025-01-02,provider,native-model,low,1,10,5,2,3,1,21,0.125,1\r\n'
    );
    expect(database.prepare('SELECT name, sql FROM sqlite_master ORDER BY name').all()).toEqual(
      before
    );
    expect(now).toBeGreaterThan(beforeMidnight);
    database.close();
  });

  it('deduplicates migrated/live/archive copies and preserves CSV reasoning settings after deletion', async () => {
    const { add, database, now } = await fixture([1, 2]);
    add(1, 'original', now - 1, 'discard-legacy');
    add(2, 'copy', now, 'current', 'original');
    database
      .prepare(
        "UPDATE session_message SET data = json_set(data, '$.model.variant', 'high') WHERE type = 'assistant'"
      )
      .run();
    await archiveSessionUsage([{ id: 'copy', directory: '/project', updated: now }]);
    const live = await readAllTimeUsageCsv();
    expect(live.rowCount).toBe(1);
    expect(live.csv).toContain(',current,high,2,20,10,4,6,2,42,,0\r\n');
    expect(live.csv).not.toContain('discard-legacy');
    database.exec(
      'DELETE FROM session_message; DELETE FROM session_v2; DELETE FROM message; DELETE FROM session;'
    );
    database.close();
    await rm(usageDatabasePaths().databasePath);
    expect(await readAllTimeUsageCsv()).toEqual(live);
  });

  it('quotes CSV delimiters and neutralizes spreadsheet formulas in identifiers', async () => {
    const { add, database, now } = await fixture([2]);
    add(2, 'csv', now, 'model,"quoted"\nnext line');
    database
      .prepare(
        "UPDATE session_message SET data = json_set(data, '$.model.providerID', '=1+1', '$.model.variant', '@SUM(A1)') WHERE type = 'assistant'"
      )
      .run();
    const result = await readAllTimeUsageCsv();
    expect(result.csv).toContain(`,'=1+1,"model,""quoted""\nnext line",'@SUM(A1),2,`);
    database.close();
  });

  it('exports large assistant envelopes without the interactive report body-size filter', async () => {
    const { add, database, now } = await fixture([2]);
    add(2, 'large-csv', now, 'large-model');
    database
      .prepare(
        "UPDATE session_message SET data = json_set(data, '$.content', ?) WHERE type = 'assistant'"
      )
      .run('PRIVATE_PAYLOAD'.repeat(100_000));
    const result = await readAllTimeUsageCsv();
    expect(result.csv).toContain(',large-model,unknown,2,20,10,4,6,2,42,,0\r\n');
    expect(result.csv).not.toContain('PRIVATE_PAYLOAD');
    database.close();
  });

  it('marks old archive reasoning settings unknown without changing archived records', async () => {
    const { add, database, now } = await fixture([2]);
    add(2, 'archived-csv', now, 'old-model');
    await archiveSessionUsage([{ id: 'archived-csv', directory: '/project', updated: now }]);
    database.exec('DELETE FROM session_message; DELETE FROM session_v2;');
    database.close();
    const archive = new DatabaseSync(usageDatabasePaths().archivePath);
    archive.exec("UPDATE usage_message SET data = json_remove(data, '$.variant')");
    const before = archive.prepare('SELECT * FROM usage_message ORDER BY id').all();
    const result = await readAllTimeUsageCsv();
    expect(result.csv).toContain(',old-model,unknown,2,20,10,4,6,2,42,,0\r\n');
    expect(archive.prepare('SELECT * FROM usage_message ORDER BY id').all()).toEqual(before);
    archive.close();
  });

  it('keeps providers and V1 reasoning variants separate and distinguishes unknown cost from reported zero', async () => {
    const { add, database, now } = await fixture([1]);
    add(1, 'first', now, 'same-model');
    add(1, 'second', now, 'same-model');
    database
      .prepare(
        "UPDATE message SET data = json_set(data, '$.variant', 'high', '$.cost', 0) WHERE session_id = 'first'"
      )
      .run();
    database
      .prepare(
        "UPDATE message SET data = json_set(data, '$.providerID', 'other-provider', '$.variant', 'low') WHERE session_id = 'second'"
      )
      .run();
    const result = await readAllTimeUsageCsv();
    expect(result.rowCount).toBe(2);
    expect(result.csv).toContain(',provider,same-model,high,1,10,5,2,3,1,21,0,1\r\n');
    expect(result.csv).toContain(',other-provider,same-model,low,1,10,5,2,3,1,21,,0\r\n');
    database.close();
  });

  it('returns a header-only CSV for empty supported history', async () => {
    const { database } = await fixture([2]);
    const result = await readAllTimeUsageCsv();
    expect(result.rowCount).toBe(0);
    expect(result.csv.split('\r\n')).toHaveLength(2);
    database.close();
  });

  it('uses explicit token totals and exposes partial reported-cost coverage', async () => {
    const { add, database, now } = await fixture([2]);
    add(2, 'total-csv', now, 'model');
    database
      .prepare(
        "UPDATE session_message SET data = json_set(data, '$.tokens.total', 99) WHERE type = 'assistant'"
      )
      .run();
    database
      .prepare(
        "UPDATE session_message SET data = json_set(data, '$.cost', 0.25) WHERE id = 'total-csv-reply'"
      )
      .run();
    const result = await readAllTimeUsageCsv();
    expect(result.csv).toContain(',model,unknown,2,20,10,4,6,2,198,0.25,1\r\n');
    database.close();
  });

  it('assigns UTC days using original migration timing and pause boundaries, not import dates', async () => {
    const { add, database, now } = await fixture([1, 2]);
    add(1, 'original', now - 1, 'model');
    add(2, 'copy', now, 'model', 'original');
    const created = Date.UTC(2025, 0, 1, 12);
    database
      .prepare(
        "UPDATE message SET id = 'copy-reply', data = json_set(data, '$.time.created', ?, '$.time.completed', ?) WHERE session_id = 'original'"
      )
      .run(created, created + 1000);
    database
      .prepare(
        "UPDATE session_message SET data = json_set(data, '$.time.created', ?, '$.time.completed', ?) WHERE type = 'assistant'"
      )
      .run(created, now);
    await new OpenCodeV2SessionState().update('copy', {
      metadata: {
        varro: { pauses: [{ messageId: 'copy-reply-2', pausedAt: created + 86_400_000 }] },
      },
    });
    const result = await readAllTimeUsageCsv();
    expect(result.rowCount).toBe(2);
    expect(result.csv).toContain('2025-01-01,provider,model,unknown,1,10,5,2,3,1,21,,0\r\n');
    expect(result.csv).toContain('2025-01-02,provider,model,unknown,1,10,5,2,3,1,21,,0\r\n');
    database.close();
  });

  it.each(['model', 'created', 'session', 'role', 'completion', 'missing created'])(
    'keeps native CSV dates when original timing has a mismatched %s',
    async (mismatch) => {
      const { add, database, now } = await fixture([1, 2]);
      add(1, 'original', now - 1, 'model');
      add(2, 'copy', now, 'model', 'original');
      const created = Date.UTC(2025, 0, 1);
      const completed = Date.UTC(2025, 1, 1);
      database
        .prepare(
          "UPDATE message SET id = 'copy-reply', data = json_set(data, '$.time.created', ?, '$.time.completed', ?) WHERE session_id = 'original'"
        )
        .run(created, created + 1000);
      database
        .prepare(
          "UPDATE session_message SET data = json_set(data, '$.time.created', ?, '$.time.completed', ?) WHERE type = 'assistant'"
        )
        .run(created, completed);
      if (mismatch === 'missing created') {
        database.exec(
          "UPDATE message SET data = json_remove(data, '$.time.created'); UPDATE session_message SET data = json_remove(data, '$.time.created') WHERE type = 'assistant';"
        );
      } else if (mismatch === 'session')
        database.prepare("UPDATE message SET session_id = 'other'").run();
      else {
        const field =
          mismatch === 'model'
            ? '$.modelID'
            : mismatch === 'created'
              ? '$.time.created'
              : mismatch === 'role'
                ? '$.role'
                : '$.time.completed';
        database
          .prepare('UPDATE message SET data = json_set(data, ?, ?)')
          .run(field, mismatch === 'created' ? 0 : mismatch === 'role' ? 'user' : 'different');
      }
      const result = await readAllTimeUsageCsv();
      expect(result.rowCount).toBe(1);
      expect(result.csv).toContain('2025-02-01,provider,model,unknown,2,');
      expect(result.csv).not.toContain('2025-01-01');
      database.close();
    }
  );

  it('fails rather than silently dropping usage with an invalid date', async () => {
    const { add, database, now } = await fixture([2]);
    add(2, 'bad-csv', now, 'model');
    database
      .prepare(
        "UPDATE session_message SET data = json_set(data, '$.time.created', 1e30, '$.time.completed', 1e30) WHERE type = 'assistant'"
      )
      .run();
    await expect(readAllTimeUsageCsv()).rejects.toThrow('invalid message timestamp');
    database.close();
  });

  it('resolves candidate identities once and reads original timing once per archived assistant', async () => {
    const { add, database, now } = await fixture([1, 2]);
    add(1, 'original', now - 1, 'model');
    add(2, 'candidate', now, 'model', 'original');
    database
      .prepare("UPDATE message SET id = 'candidate-reply' WHERE session_id = 'original'")
      .run();
    database.exec(
      "INSERT INTO message SELECT 'candidate-reply-2',session_id,data FROM message WHERE id = 'candidate-reply'"
    );
    const insert = database.prepare('INSERT INTO session_v2 VALUES (?, ?, ?)');
    for (let index = 0; index < 100; index++)
      insert.run(`unrelated-${index}`, now, JSON.stringify({ notes: 'x'.repeat(4096) }));
    archiveWork.metadataReads = 0;
    archiveWork.originalRoleReads = 0;
    const progress: string[] = [];
    await archiveSessionUsage(
      [{ id: 'candidate', directory: '/project', updated: now }],
      (message) => progress.push(message)
    );
    database.close();
    expect(archiveWork.metadataReads).toBeLessThanOrEqual(105);
    expect(archiveWork.originalRoleReads).toBe(2);
    expect(progress).toContain('Resolving usage identities');
    expect(progress).toContain('Archiving assistant usage records');
    expect(progress.at(-1)).toBe('Committing usage archive');
  });

  it('archives the newest identity when deleting a superseded imported copy and never downgrades an archive', async () => {
    const { add, report, now, database } = await fixture([1, 2]);
    add(1, 'source', now - 2, 'legacy');
    add(2, 'older-copy', now - 1, 'discard-older', 'source');
    add(2, 'newest-copy', now, 'newest', 'source');
    await archiveSessionUsage([{ id: 'older-copy', directory: '/project', updated: now - 1 }]);
    database.prepare("DELETE FROM session_message WHERE session_id = 'newest-copy'").run();
    database.prepare("DELETE FROM session_v2 WHERE id = 'newest-copy'").run();
    // The newest copy can already be gone after a prior completed deletion unit.
    await archiveSessionUsage([{ id: 'older-copy', directory: '/project', updated: now - 1 }]);
    database.exec(
      'DELETE FROM session_message; DELETE FROM session_v2; DELETE FROM message; DELETE FROM session;'
    );
    const content = await report(true);
    expect(content).toContain('from 1 sessions scanned');
    expect(content).toContain('| provider | newest | 1 | 42 |');
    expect(content).not.toContain('discard-older');
    expect(content).not.toContain('| provider | legacy |');
  });

  it('archives usage from large image/tool messages without copying their payloads', async () => {
    const { add, report, now, database } = await fixture([2]);
    add(2, 'large', now, 'large-model');
    database
      .prepare(
        "UPDATE session_message SET data = json_set(data, '$.content', ?) WHERE type = 'assistant'"
      )
      .run('x'.repeat(2 * 1024 * 1024));
    database
      .prepare(
        "UPDATE session_message SET data = json_set(data, '$.files', json(?)) WHERE type = 'user'"
      )
      .run(JSON.stringify([{ url: `data:image/png;base64,${'A'.repeat(2 * 1024 * 1024)}` }]));
    await archiveSessionUsage([{ id: 'large', directory: '/project', updated: now }]);
    database.exec('DELETE FROM session_message; DELETE FROM session_v2;');
    const content = await report(true);
    expect(content).toContain('| provider | large-model | 1 | 42 | 4s |');
    expect((await readFile(usageDatabasePaths().archivePath)).byteLength).toBeLessThan(100_000);
  });

  it.each([1, 2])(
    'does not double count an unchanged live V%i session beside its archive',
    async (version) => {
      const { add, report, now } = await fixture([version]);
      add(version, 'interrupted', now, 'unchanged');
      await archiveSessionUsage([{ id: 'interrupted', directory: '/project', updated: now }]);
      const content = await report(true);
      expect(content).toContain('from 1 sessions scanned');
      expect(content).toContain(
        `| provider | unchanged | 1 | ${version === 1 ? '21 | 2s' : '42 | 4s'} |`
      );
    }
  );

  it.each([1, 2])(
    'preserves V%i usage after deletion without retaining conversation content',
    async (version) => {
      const { add, report, now, database } = await fixture([version]);
      add(version, 'deleted', now, 'archived-model');
      const table = version === 1 ? 'message' : 'session_message';
      database
        .prepare(
          `UPDATE ${table} SET data = json_set(data, '$.text', 'private conversation', '$.cost', 0.25)`
        )
        .run();
      await archiveSessionUsage([{ id: 'deleted', directory: '/project', updated: now }]);
      database.prepare(`DELETE FROM ${table}`).run();
      database.prepare(`DELETE FROM ${version === 1 ? 'session' : 'session_v2'}`).run();
      const content = await report(true);
      expect(content).toContain('from 1 sessions scanned');
      expect(content).toContain(
        `| provider | archived-model | 1 | ${version === 1 ? '21 | 2s' : '42 | 4s'} |`
      );
      const archive = new DatabaseSync(usageDatabasePaths().archivePath, { readOnly: true });
      try {
        expect(archive.prepare('SELECT data FROM usage_message LIMIT 1').get()?.data).toContain(
          '"cost":0.25'
        );
      } finally {
        archive.close();
      }
      expect(
        (await readFile(usageDatabasePaths().archivePath)).includes(
          Buffer.from('private conversation')
        )
      ).toBe(false);
    }
  );

  it('does not double count a committed archive before server deletion and prefers newer live usage', async () => {
    const { add, report, now, database } = await fixture([1, 2]);
    add(1, 'source', now - 1, 'legacy');
    add(2, 'imported', now, 'original', 'source');
    await archiveSessionUsage([{ id: 'imported', directory: '/project', updated: now }]);
    // A restart can repeat an already committed archive without duplicating usage.
    await archiveSessionUsage([{ id: 'imported', directory: '/project', updated: now }]);
    database
      .prepare(
        "UPDATE session_message SET data = json_set(data, '$.model.id', 'new-live') WHERE type = 'assistant'"
      )
      .run();
    database.prepare('UPDATE session_v2 SET time_updated = ?').run(now + 1);
    const content = await report(true);
    expect(content).toContain('from 1 sessions scanned');
    expect(content).toContain('| provider | new-live | 1 | 42 |');
    expect(content).not.toContain('| provider | original |');
    expect(content).not.toContain('| provider | legacy |');
  });

  it('keeps migration timing and pauses when the original databases and annotations are removed', async () => {
    const { add, now, database } = await fixture([1, 2]);
    add(1, 'source', now - 1, 'model');
    add(2, 'imported', now, 'model', 'source');
    database
      .prepare(
        "UPDATE message SET id = 'imported-reply', data = json_set(data, '$.time.created', ?, '$.time.completed', ?)"
      )
      .run(now - 10_000, now - 2_000);
    database
      .prepare(
        "UPDATE session_message SET data = json_set(data, '$.time.created', ?) WHERE type = 'assistant'"
      )
      .run(now - 10_000);
    database.prepare("DELETE FROM session_message WHERE id = 'imported-reply-2'").run();
    await new OpenCodeV2SessionState().update('imported', {
      metadata: { varro: { pauses: [{ messageId: 'imported-reply', pausedAt: now - 4_000 }] } },
    });
    await archiveSessionUsage([{ id: 'imported', directory: '/project', updated: now }]);
    database.close();
    await rm(usageDatabasePaths().databasePath);
    await new OpenCodeV2SessionState().remove('imported');
    const request = vi.fn();
    await new UsageReportService({ request }, vi.fn()).openReport(true);
    expect(request).not.toHaveBeenCalled();
    expect(mocks.content).toContain('| provider | model | 1 | 21 | 6s |');
  });

  it('refuses changed sessions and rolls back malformed artifact history before deletion', async () => {
    const { add, now, database } = await fixture([2]);
    add(2, 'old', now, 'model');
    await expect(
      archiveSessionUsage([{ id: 'old', directory: '/project', updated: now - 1 }])
    ).rejects.toThrow('Sessions changed');
    database.exec('CREATE TABLE session_part (session_id TEXT, data TEXT);');
    database.prepare('INSERT INTO session_part VALUES (?, ?)').run('old', 'malformed');
    await expect(
      archiveSessionUsage([{ id: 'old', directory: '/project', updated: now }])
    ).rejects.toThrow('malformed JSON');
    const archive = new DatabaseSync(usageDatabasePaths().archivePath, { readOnly: true });
    expect(
      archive.prepare("SELECT name FROM sqlite_master WHERE name = 'usage_session'").get()
    ).toBeUndefined();
    expect(archive.prepare('PRAGMA user_version').get()?.user_version).toBe(0);
    archive.close();
    database.close();
  });

  it('caps an interrupted response at its pause marker and excludes the gap before a new prompt', async () => {
    const { add, report, now, database } = await fixture([2]);
    add(2, 'paused-session', now, 'luna');
    database.prepare("DELETE FROM session_message WHERE id = 'paused-session-reply-2'").run();
    database
      .prepare(
        "UPDATE session_message SET data = json_set(data, '$.time.created', ?, '$.time.completed', ?) WHERE id = 'paused-session-reply'"
      )
      .run(now - 3_610_000, now);
    await new OpenCodeV2SessionState().update('paused-session', {
      metadata: {
        varro: { pauses: [{ messageId: 'paused-session-reply', pausedAt: now - 3_600_000 }] },
      },
    });
    const insert = database.prepare('INSERT INTO session_message VALUES (?, ?, ?, ?, ?)');
    insert.run('resume-prompt', 'paused-session', 'user', 3, '{}');
    insert.run(
      'resumed-answer',
      'paused-session',
      'assistant',
      4,
      JSON.stringify({
        model: { providerID: 'provider', id: 'luna' },
        time: { created: now - 5_000, completed: now },
        tokens: { input: 10, output: 5 },
      })
    );
    const content = await report();
    expect(content).toContain('| provider | luna | 2 | 36 | 15s |');
  });

  it('recovers migrated completion timing without reverting token usage', async () => {
    const { add, report, now, database } = await fixture([1, 2]);
    add(1, 'migrated', now - 1, 'luna');
    add(2, 'migrated', now, 'luna');
    database.prepare("DELETE FROM session_message WHERE id = 'migrated-reply-2'").run();
    const created = now - 5 * 24 * 60 * 60 * 1_000;
    database
      .prepare(
        "UPDATE message SET data = json_set(data, '$.time.created', ?, '$.time.completed', ?)"
      )
      .run(created, created + 4_700);
    database
      .prepare(
        "UPDATE session_message SET data = json_set(data, '$.time.created', ?, '$.tokens.output', 15) WHERE type = 'assistant'"
      )
      .run(created);

    const content = await report();
    expect(content.split('## Last 7 rolling days')[0]).toContain('_No token usage._');
    expect(content).toContain('| provider | luna | 1 | 31 | 5s | 10 | 15 | 2 | 3 | 1 |');
    expect(content).not.toContain('120h');
  });

  it.each(['created', 'model', 'session', 'invalid completion'])(
    'keeps native timing when the legacy message has mismatched %s',
    async (mismatch) => {
      const { add, report, now, database } = await fixture([1, 2]);
      add(1, 'migrated', now - 1, 'luna');
      add(2, 'migrated', now, 'luna');
      if (mismatch === 'session') {
        database.prepare("UPDATE message SET session_id = 'other'").run();
      } else {
        const path =
          mismatch === 'created'
            ? '$.time.created'
            : mismatch === 'model'
              ? '$.modelID'
              : '$.time.completed';
        database
          .prepare('UPDATE message SET data = json_set(data, ?, ?)')
          .run(path, mismatch === 'model' ? 'other' : 0);
      }
      const content = await report();
      expect(content).toContain('| provider | luna | 1 | 42 | 4s |');
    }
  );

  it.each([1, 2])('reads a V%i-only database', async (version) => {
    const { add, report, now } = await fixture([version]);
    add(version, 'only', now, 'only-model');
    const content = await report();
    expect(content).toContain('from 1 sessions scanned');
    expect(content).toContain(
      version === 1
        ? '| provider | only-model | 1 | 21 | 2s | 10 | 5 | 2 | 3 | 1 |'
        : '| provider | only-model | 1 | 42 | 4s | 20 | 10 | 4 | 6 | 2 |'
    );
  });

  it.each([false, true])(
    'merges versions and selects the newest complete session, allTime=%s',
    async (allTime) => {
      const { add, report, now } = await fixture([1, 2]);
      add(1, 'legacy-only', now, 'legacy');
      add(2, 'native-only', now, 'native');
      add(1, 'v2-newer', now - 1, 'discard-v1');
      add(2, 'v2-newer', now, 'newer-v2');
      add(1, 'v1-newer', now, 'newer-v1');
      add(2, 'v1-newer', now - 1, 'discard-v2');
      add(1, 'tie', now, 'discard-tie');
      add(2, 'tie', now, 'tie-v2');
      add(1, 'import-source', now - 1, 'discard-source');
      add(2, 'import-copy', now, 'imported', 'import-source');
      add(2, 'older-copy', now - 1, 'discard-copy', 'import-source');
      add(1, 'source-newer', now, 'updated-source');
      add(2, 'copy-older', now - 1, 'discard-import', 'source-newer');
      const content = await report(allTime);
      expect(content).toContain('from 7 sessions scanned');
      expect(content).not.toContain('discard');
      for (const model of [
        'legacy',
        'native',
        'newer-v2',
        'newer-v1',
        'tie-v2',
        'imported',
        'updated-source',
      ]) {
        expect(content).toContain(`| provider | ${model} | 1 |`);
      }
      expect(content).toContain('| **Total** |  | 7 | 231 | 22s | 110 | 55 | 22 | 33 | 11 |');
    }
  );

  it('filters old sessions after resolving migrated identities', async () => {
    const { add, report, now } = await fixture([1, 2]);
    const old = now - 40 * 24 * 60 * 60 * 1_000;
    add(1, 'old', old, 'discard-old');
    add(2, 'old', old + 1, 'discard-old-v2');
    add(1, 'active', old, 'discard-legacy');
    add(2, 'active', now, 'active-v2');
    const content = await report();
    expect(content).toContain('from 1 sessions scanned');
    expect(content).not.toContain('discard');
    expect(content).toContain('| provider | active-v2 | 1 | 42 |');
  });

  it('does not decode message bodies from old or superseded sessions', async () => {
    const { add, report, now, database } = await fixture([1, 2]);
    add(1, 'old', 0, 'old-model');
    add(1, 'migrated', now - 1, 'legacy-model');
    add(2, 'migrated', now, 'current-model');
    // Invalid bodies make an accidental full-history JSON scan fail deterministically.
    database.prepare('UPDATE message SET data = ?').run('unreadable excluded message');
    const content = await report();
    expect(content).toContain('from 1 sessions scanned');
    expect(content).toContain('| provider | current-model | 1 | 42 |');
  });
});
