/* oxlint-disable anti-slop/no-runtime-typeof, anti-slop/no-unknown-parameters -- Persisted and protocol model preferences are decoded at this shared I/O boundary. */
import type { ModelPreferences } from './protocol';
import { asRecord } from './type-utils';

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
