import { describe, expect, it } from 'vitest';
import { cloneDatabaseContext, databaseContextDetail, isDatabaseContext } from './database-context';
import { isEditorContext } from './extension-message';
import type { DatabaseContext } from './protocol';

const context: DatabaseContext = {
  name: 'public.orders',
  dataSource: 'local',
  dialect: 'PostgreSQL',
  filter: '',
  columns: [
    { name: 'id', type: 'bigint' },
    { name: 'id', type: 'text' },
  ],
  rows: [['9007199254740993', null]],
  selectedRowCount: 1,
  scope: 'selected-rows',
  pendingChanges: true,
  cellEditing: false,
  pageStart: 0,
  truncated: false,
};

describe('database context', () => {
  it('accepts DDL editors and rejects missing or oversized definitions', () => {
    const ddl = 'create table users (id INT primary key);';
    const definition: DatabaseContext = {
      ...context,
      scope: 'ddl',
      rows: [],
      selectedRowCount: 0,
      ddl,
      pendingChanges: false,
    };
    expect(isDatabaseContext(definition)).toBe(true);
    expect(databaseContextDetail(definition)).toBe('DDL');
    expect(isDatabaseContext({ ...definition, ddl: undefined })).toBe(false);
    expect(isDatabaseContext({ ...definition, ddl: 'x'.repeat(40001) })).toBe(false);
    expect(isDatabaseContext({ ...definition, selectedRowCount: 1 })).toBe(false);
    expect(databaseContextDetail({ ...context, ddl })).toBe('1 row; unsubmitted edits');
    expect(cloneDatabaseContext(definition)?.ddl).toBe(ddl);
  });
  it('validates optional context in full editor snapshots', () => {
    expect(isDatabaseContext(context)).toBe(true);
    expect(
      isEditorContext({
        workspacePath: null,
        activeFile: null,
        selection: null,
        diagnostics: [],
        databaseContext: context,
      })
    ).toBe(true);
    expect(
      isEditorContext({
        workspacePath: null,
        activeFile: null,
        selection: null,
        diagnostics: [],
        databaseContext: { ...context, rows: [[123]] },
      })
    ).toBe(false);
  });
  it('rejects malformed and oversized data', () => {
    for (const override of [
      { selectedRowCount: -1 },
      { rows: [['x']] },
      { rows: [['x'.repeat(4001), null]] },
      { scope: 'table' },
      { columns: Array.from({ length: 65 }, () => ({ name: 'x', type: 'text' })) },
    ]) {
      expect(isDatabaseContext({ ...context, ...override })).toBe(false);
    }
  });
  it('detaches queued values and column metadata', () => {
    const copy = cloneDatabaseContext(context)!;
    copy.rows[0]![0] = 'changed';
    copy.columns[0]!.name = 'changed';
    expect(context.rows[0]![0]).toBe('9007199254740993');
    expect(context.columns[0]!.name).toBe('id');
    expect(databaseContextDetail(context)).toBe('1 row; unsubmitted edits');
  });
});
