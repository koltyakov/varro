/* oxlint-disable anti-slop/no-runtime-typeof, anti-slop/no-unknown-parameters -- Persisted and protocol model preferences are decoded at this shared I/O boundary. */
import type { ModelPreferences } from './protocol';
import { asRecord } from './type-utils';

const MAX_MODEL_PREFERENCE_ENTRIES = 10_000;
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
  return Array.isArray(value)
    ? [...new Set(value.filter((item): item is string => typeof item === 'string'))]
    : [];
}

function parseStringRecord(value: unknown): Record<string, string> {
  const record = asRecord(value);
  return record
    ? Object.fromEntries(
        Object.entries(record).filter(
          (entry): entry is [string, string] => typeof entry[1] === 'string'
        )
      )
    : {};
}

function parseNullableStringRecord(value: unknown): Record<string, string | null> {
  const record = asRecord(value);
  return record
    ? Object.fromEntries(
        Object.entries(record).filter(
          (entry): entry is [string, string | null] =>
            typeof entry[1] === 'string' || entry[1] === null
        )
      )
    : {};
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
  return (
    !!record &&
    areBoundedRecordKeys(Object.keys(record)) &&
    Object.values(record).every(isBoundedString)
  );
}

function isNullableStringRecord(value: unknown): value is Record<string, string | null> {
  const record = asRecord(value);
  return (
    !!record &&
    areBoundedRecordKeys(Object.keys(record)) &&
    Object.values(record).every((item) => item === null || isBoundedString(item))
  );
}

function areBoundedRecordKeys(keys: string[]) {
  return keys.length <= MAX_MODEL_PREFERENCE_ENTRIES && keys.every(isBoundedString);
}

function isBoundedString(value: unknown): value is string {
  return typeof value === 'string' && value.length <= MAX_MODEL_PREFERENCE_STRING_LENGTH;
}
