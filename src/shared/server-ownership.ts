export interface ManagedServerOwnershipLease {
  version: 1;
  pid: number;
  port: number;
  executable: string;
  birthIdentity: string;
  owner: string;
  host: string;
  hostPid?: number;
  hostBirthIdentity?: string;
  state: 'active' | 'relinquished';
  createdAt: number;
  configPath?: string;
}

export function parseManagedServerOwnershipLease<T>(value: T): ManagedServerOwnershipLease | null {
  const record = asRecord(value);
  if (!record) return null;
  if (record.version !== 1) return null;
  if (!isNumber(record.pid) || !Number.isSafeInteger(record.pid) || record.pid <= 0) return null;
  if (
    !isNumber(record.port) ||
    !Number.isSafeInteger(record.port) ||
    record.port <= 0 ||
    record.port > 65_535
  ) {
    return null;
  }
  if (!isString(record.executable) || !record.executable.trim()) return null;
  if (!isString(record.birthIdentity) || !record.birthIdentity.trim()) return null;
  if (!isString(record.owner) || !record.owner.trim()) return null;
  if (!isString(record.host) || !record.host.trim()) return null;
  const hasHostPid = record.hostPid !== undefined;
  const hasHostBirthIdentity = record.hostBirthIdentity !== undefined;
  if (hasHostPid !== hasHostBirthIdentity) return null;
  if (
    hasHostPid &&
    (!isNumber(record.hostPid) || !Number.isSafeInteger(record.hostPid) || record.hostPid <= 0)
  ) {
    return null;
  }
  if (
    hasHostBirthIdentity &&
    (!isString(record.hostBirthIdentity) || !record.hostBirthIdentity.trim())
  ) {
    return null;
  }
  if (record.state !== 'active' && record.state !== 'relinquished') return null;
  if (!isNumber(record.createdAt) || !Number.isFinite(record.createdAt)) return null;
  if (record.configPath !== undefined && !isString(record.configPath)) return null;

  const lease: ManagedServerOwnershipLease = {
    version: 1,
    pid: record.pid,
    port: record.port,
    executable: record.executable,
    birthIdentity: record.birthIdentity,
    owner: record.owner,
    host: record.host,
    state: record.state,
    createdAt: record.createdAt,
  };
  if (hasHostPid && isNumber(record.hostPid) && isString(record.hostBirthIdentity)) {
    lease.hostPid = record.hostPid;
    lease.hostBirthIdentity = record.hostBirthIdentity;
  }
  if (record.configPath) lease.configPath = record.configPath;
  return lease;
}
import { asRecord, isNumber, isString } from './type-utils';
