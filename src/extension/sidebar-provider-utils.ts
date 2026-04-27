import type { OpenCodeModelRoute, ServerEvent } from '../shared/protocol';

export function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === 'object' ? (value as Record<string, unknown>) : undefined;
}

export function assertValidJson(value: string, label: string) {
  try {
    JSON.parse(value);
  } catch (err) {
    throw new Error(
      `${label} returned invalid JSON: ${err instanceof Error ? err.message : String(err)}`,
      { cause: err }
    );
  }
}

export function normalizeCliOutput(value: unknown): string {
  if (typeof value === 'string') return value.trim();
  if (Buffer.isBuffer(value)) return value.toString('utf-8').trim();
  return String(value ?? '').trim();
}

export function parseModelRoute(value: unknown): OpenCodeModelRoute | null {
  if (typeof value !== 'string') return null;
  const separatorIndex = value.indexOf('/');
  if (separatorIndex <= 0 || separatorIndex === value.length - 1) return null;
  return {
    providerID: value.slice(0, separatorIndex),
    modelID: value.slice(separatorIndex + 1),
  };
}

export function getSessionIdsForEvent(event: ServerEvent) {
  const ids = new Set<string>();
  const properties = asRecord(event.properties);
  const add = (value: unknown) => {
    if (typeof value === 'string' && value) ids.add(value);
  };

  add(properties?.sessionID);
  add(asRecord(properties?.info)?.id);
  add(asRecord(properties?.info)?.sessionID);
  add(asRecord(properties?.part)?.sessionID);

  return [...ids];
}
