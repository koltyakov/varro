export interface HealthResponse {
  healthy: boolean;
  version?: string;
}

export function parseHealthResponse<T>(value: T): HealthResponse | null {
  const record = asRecord(value);
  if (!record || !isBoolean(record.healthy)) return null;
  if (record.version !== undefined && !isString(record.version)) return null;
  return record.version === undefined
    ? { healthy: record.healthy }
    : { healthy: record.healthy, version: record.version };
}
import { asRecord, isBoolean, isString } from './type-utils';
