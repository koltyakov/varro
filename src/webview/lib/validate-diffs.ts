import type { FileDiff } from '../types';

function isFileDiff(value: unknown): value is FileDiff {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  return (
    typeof record.file === 'string' &&
    typeof record.additions === 'number' &&
    typeof record.deletions === 'number'
  );
}

export function validateFileDiffs(value: unknown): FileDiff[] {
  if (!Array.isArray(value)) return [];
  if (value.every(isFileDiff)) return value;
  return value.filter(isFileDiff);
}
