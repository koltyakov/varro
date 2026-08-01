export interface HealthResponse {
  healthy: boolean;
  version?: string;
}

export function parseHealthResponse(value: unknown): HealthResponse | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  if (typeof record.healthy !== 'boolean') return null;
  if (record.version !== undefined && typeof record.version !== 'string') return null;
  return record.version === undefined
    ? { healthy: record.healthy }
    : { healthy: record.healthy, version: record.version };
}
