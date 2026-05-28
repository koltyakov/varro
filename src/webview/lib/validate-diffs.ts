import type { FileDiff } from '../types';

function isFileDiff(value: unknown): value is FileDiff {
  if (!isRecord(value)) return false;
  const record = value;
  return (
    typeof record.file === 'string' &&
    typeof record.additions === 'number' &&
    typeof record.deletions === 'number'
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

export function validateFileDiffs(value: unknown): FileDiff[] {
  if (Array.isArray(value) && value.every(isFileDiff)) return value;
  if (Array.isArray(value)) return value.filter(isFileDiff);
  if (isFileDiff(value)) return [value];
  if (!isRecord(value)) return [];
  return Object.values(value).filter(isFileDiff);
}
