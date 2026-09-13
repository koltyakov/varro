import type { DatabaseAttachment, DatabaseContext, DatabaseTableReference } from './protocol';
import { asRecord, isString, isBoolean, isNumber } from './type-utils';

function isBoundedText<T>(value: T, max: number): boolean {
  return isString(value) && value.length <= max;
}

export function isDatabaseTableReference(value: unknown): value is DatabaseTableReference {
  const record = asRecord(value);
  return (
    !!record &&
    isString(record.id) &&
    record.id.length > 0 &&
    record.id.length <= 128 &&
    isBoundedText(record.name, 1_000) &&
    isBoundedText(record.dataSource, 1_000)
  );
}

export function isDatabaseContext(value: unknown): value is DatabaseContext {
  const record = asRecord(value);
  if (!record) return false;
  if (!isBoundedText(record.name, 1_000) || !isBoundedText(record.filter, 4_000)) return false;
  if (record.dataSource !== null && !isBoundedText(record.dataSource, 1_000)) return false;
  if (record.dialect !== null && !isBoundedText(record.dialect, 1_000)) return false;
  if (record.scope !== 'table' && record.scope !== 'selected-rows' && record.scope !== 'ddl')
    return false;
  if (record.ddl !== undefined && !isBoundedText(record.ddl, 40_000)) return false;
  if (record.scope === 'ddl' && !isString(record.ddl)) return false;
  if (
    !isBoolean(record.pendingChanges) ||
    !isBoolean(record.cellEditing) ||
    !isBoolean(record.truncated)
  )
    return false;
  if (
    !isNumber(record.selectedRowCount) ||
    !Number.isSafeInteger(record.selectedRowCount) ||
    record.selectedRowCount < 0
  )
    return false;
  if (!isNumber(record.pageStart) || !Number.isSafeInteger(record.pageStart)) return false;
  if (
    !Array.isArray(record.columns) ||
    record.columns.length > 64 ||
    !record.columns.every((column) => {
      const item = asRecord(column);
      return item && isBoundedText(item.name, 256) && isBoundedText(item.type, 256);
    })
  )
    return false;
  const columnCount = record.columns.length;
  if (
    !Array.isArray(record.rows) ||
    record.rows.length > 200 ||
    record.rows.length > record.selectedRowCount ||
    !record.rows.every(
      (row) =>
        Array.isArray(row) &&
        row.length === columnCount &&
        row.every((cell) => cell === null || isBoundedText(cell, 4_000))
    )
  )
    return false;
  if ((record.scope !== 'selected-rows') !== (record.selectedRowCount === 0)) return false;
  return JSON.stringify(record.rows).length <= 81_000;
}

export function cloneDatabaseContext(
  context: DatabaseContext | null | undefined
): DatabaseContext | null | undefined {
  return context
    ? {
        ...context,
        columns: context.columns.map((column) => ({ ...column })),
        rows: context.rows.map((row) => [...row]),
      }
    : context;
}

export function databaseContextDetail(context: DatabaseContext): string {
  return databaseAttachmentDetail({ ...context, rowCount: context.rows.length });
}

export function databaseAttachmentDetail(context: DatabaseAttachment): string {
  const scope =
    context.scope === 'ddl'
      ? 'DDL'
      : context.scope === 'table'
        ? 'table'
        : `${context.rowCount}${context.rowCount < context.selectedRowCount ? ` of ${context.selectedRowCount}` : ''} ${context.selectedRowCount === 1 ? 'row' : 'rows'}`;
  return `${scope}${context.truncated ? '; truncated' : ''}${context.pendingChanges ? '; unsubmitted edits' : ''}${context.cellEditing ? '; active cell edit not captured' : ''}`;
}

export function isDatabaseAttachment(value: unknown): value is DatabaseAttachment {
  const record = asRecord(value);
  if (
    !record ||
    !isBoundedText(record.name, 1_000) ||
    (record.dataSource !== null && !isBoundedText(record.dataSource, 1_000))
  )
    return false;
  if (record.scope !== 'table' && record.scope !== 'selected-rows' && record.scope !== 'ddl')
    return false;
  if (
    !isNumber(record.rowCount) ||
    !Number.isSafeInteger(record.rowCount) ||
    record.rowCount < 0 ||
    record.rowCount > 200
  )
    return false;
  if (
    !isNumber(record.selectedRowCount) ||
    !Number.isSafeInteger(record.selectedRowCount) ||
    record.selectedRowCount < record.rowCount
  )
    return false;
  return (
    (record.scope !== 'selected-rows') === (record.selectedRowCount === 0) &&
    isBoolean(record.truncated) &&
    isBoolean(record.pendingChanges) &&
    isBoolean(record.cellEditing)
  );
}

const DATABASE_ATTACHMENT_PREFIX = '[Attached database table: ';

export function formatDatabaseAttachmentReference(
  path: string,
  database: DatabaseAttachment
): string {
  return `${DATABASE_ATTACHMENT_PREFIX}${JSON.stringify({ path, database })}]`;
}

export function parseDatabaseAttachmentReference(
  text: string
): { path: string; database: DatabaseAttachment } | null {
  if (!text.startsWith(DATABASE_ATTACHMENT_PREFIX) || !text.endsWith(']')) return null;
  try {
    const record = asRecord(JSON.parse(text.slice(DATABASE_ATTACHMENT_PREFIX.length, -1)));
    return record &&
      isString(record.path) &&
      record.path.length > 0 &&
      record.path.length <= 32_768 &&
      !record.path.includes('\0') &&
      isDatabaseAttachment(record.database)
      ? { path: record.path, database: record.database }
      : null;
  } catch {
    return null;
  }
}
