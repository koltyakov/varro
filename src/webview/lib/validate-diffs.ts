import type { FileDiff } from '../types';
import { isNumber, isString, type UnknownRecord, isObject } from './runtime-values';

function isFileDiff<T>(value: T): value is T & FileDiff {
  if (!isRecord(value)) return false;
  const record = value;
  return (
    (record.file === undefined || isString(record.file)) &&
    (record.before === undefined || isString(record.before)) &&
    (record.after === undefined || isString(record.after)) &&
    (record.patch === undefined || isString(record.patch)) &&
    isNumber(record.additions) &&
    isNumber(record.deletions)
  );
}

function isRecord<T>(value: T): value is T & UnknownRecord {
  return !!value && isObject(value) && !Array.isArray(value);
}

export function validateFileDiffs<T>(value: T): FileDiff[] {
  if (Array.isArray(value) && value.every(isFileDiff)) return value;
  if (Array.isArray(value)) return value.filter(isFileDiff);
  if (isFileDiff(value)) return [value];
  if (!isRecord(value)) return [];
  return Object.values(value).filter(isFileDiff);
}
