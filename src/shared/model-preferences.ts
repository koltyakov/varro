/* oxlint-disable anti-slop/no-runtime-typeof, anti-slop/no-unknown-parameters -- Persisted and protocol model preferences are decoded at this shared I/O boundary. */
import type { ModelPreferences } from './protocol';
import type { UnknownRecord } from './type-utils';
import { asRecord } from './type-utils';

const MAX_MODEL_PREFERENCE_ENTRIES = 10_000;
const MAX_MODEL_PREFERENCE_INSPECTED_ENTRIES = 20_000;
const MAX_MODEL_PREFERENCE_STRING_LENGTH = 4_096;

export function parseModelPreferences(value: unknown): ModelPreferences {
  const record = asRecord(value);
  return {
    modelVariantSelections: parseNullableStringRecord(record?.modelVariantSelections),
    hiddenProviders: parseStringArray(record?.hiddenProviders),
    hiddenModels: parseStringArray(record?.hiddenModels),
    addedModels: parseStringArray(record?.addedModels),
    pinnedModels: parseStringArray(record?.pinnedModels),
    modelDisplayNames: parseStringRecord(record?.modelDisplayNames),
  };
}

export function parseRequiredModelPreferences(value: unknown): ModelPreferences | null {
  const record = asRecord(value);
  if (
    !record ||
    !isNullableStringRecord(record.modelVariantSelections) ||
    !isStringArray(record.hiddenProviders) ||
    !isStringArray(record.hiddenModels) ||
    !isStringArray(record.addedModels) ||
    !isStringArray(record.pinnedModels) ||
    !isStringRecord(record.modelDisplayNames)
  ) {
    return null;
  }
  return parseModelPreferences(record);
}

function parseStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  const result: string[] = [];
  const seen = new Set<string>();
  const inspected = Math.min(value.length, MAX_MODEL_PREFERENCE_INSPECTED_ENTRIES);
  for (let index = 0; index < inspected; index += 1) {
    const item = value[index];
    if (!isBoundedString(item) || seen.has(item)) continue;
    seen.add(item);
    result.push(item);
    if (result.length >= MAX_MODEL_PREFERENCE_ENTRIES) break;
  }
  return result;
}

function parseStringRecord(value: unknown): Record<string, string> {
  const record = asRecord(value);
  if (!record) return {};
  const entries: Array<[string, string]> = [];
  forEachBoundedRecordEntry(record, (key, item) => {
    if (isBoundedString(key) && isBoundedString(item)) entries.push([key, item]);
    return entries.length < MAX_MODEL_PREFERENCE_ENTRIES;
  });
  return Object.fromEntries(entries);
}

function parseNullableStringRecord(value: unknown): Record<string, string | null> {
  const record = asRecord(value);
  if (!record) return {};
  const entries: Array<[string, string | null]> = [];
  forEachBoundedRecordEntry(record, (key, item) => {
    if (isBoundedString(key) && (item === null || isBoundedString(item))) {
      entries.push([key, item]);
    }
    return entries.length < MAX_MODEL_PREFERENCE_ENTRIES;
  });
  return Object.fromEntries(entries);
}

function isStringArray(value: unknown): value is string[] {
  return (
    Array.isArray(value) &&
    value.length <= MAX_MODEL_PREFERENCE_ENTRIES &&
    value.every(isBoundedString)
  );
}

function isStringRecord(value: unknown): value is Record<string, string> {
  const record = asRecord(value);
  return !!record && isBoundedRecord(record, isBoundedString);
}

function isNullableStringRecord(value: unknown): value is Record<string, string | null> {
  const record = asRecord(value);
  return !!record && isBoundedRecord(record, (item) => item === null || isBoundedString(item));
}

function isBoundedRecord(record: UnknownRecord, isValidValue: (value: unknown) => boolean) {
  let count = 0;
  let valid = true;
  forEachBoundedRecordEntry(record, (key, item) => {
    count += 1;
    valid = count <= MAX_MODEL_PREFERENCE_ENTRIES && isBoundedString(key) && isValidValue(item);
    return valid;
  });
  return valid;
}

function forEachBoundedRecordEntry(
  record: UnknownRecord,
  callback: (key: string, value: unknown) => boolean
) {
  let inspected = 0;
  for (const key in record) {
    if (!Object.hasOwn(record, key)) continue;
    if (inspected >= MAX_MODEL_PREFERENCE_INSPECTED_ENTRIES) break;
    inspected += 1;
    if (!callback(key, record[key])) break;
  }
}

function isBoundedString(value: unknown): value is string {
  return typeof value === 'string' && value.length <= MAX_MODEL_PREFERENCE_STRING_LENGTH;
}
