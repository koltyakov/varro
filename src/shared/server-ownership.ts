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

export function parseManagedServerOwnershipLease(
  value: unknown
): ManagedServerOwnershipLease | null {
  if (!value || typeof value !== 'object') return null;
  const record = value as Record<string, unknown>;
  if (record.version !== 1) return null;
  if (!Number.isSafeInteger(record.pid) || (record.pid as number) <= 0) return null;
  if (
    !Number.isSafeInteger(record.port) ||
    (record.port as number) <= 0 ||
    (record.port as number) > 65_535
  ) {
    return null;
  }
  if (typeof record.executable !== 'string' || !record.executable.trim()) return null;
  if (typeof record.birthIdentity !== 'string' || !record.birthIdentity.trim()) return null;
  if (typeof record.owner !== 'string' || !record.owner.trim()) return null;
  if (typeof record.host !== 'string' || !record.host.trim()) return null;
  const hasHostPid = record.hostPid !== undefined;
  const hasHostBirthIdentity = record.hostBirthIdentity !== undefined;
  if (hasHostPid !== hasHostBirthIdentity) return null;
  if (hasHostPid && (!Number.isSafeInteger(record.hostPid) || (record.hostPid as number) <= 0)) {
    return null;
  }
  if (
    hasHostBirthIdentity &&
    (typeof record.hostBirthIdentity !== 'string' || !record.hostBirthIdentity.trim())
  ) {
    return null;
  }
  if (record.state !== 'active' && record.state !== 'relinquished') return null;
  if (typeof record.createdAt !== 'number' || !Number.isFinite(record.createdAt)) return null;
  if (record.configPath !== undefined && typeof record.configPath !== 'string') return null;

  return {
    version: 1,
    pid: record.pid as number,
    port: record.port as number,
    executable: record.executable,
    birthIdentity: record.birthIdentity,
    owner: record.owner,
    host: record.host,
    ...(hasHostPid
      ? {
          hostPid: record.hostPid as number,
          hostBirthIdentity: record.hostBirthIdentity as string,
        }
      : {}),
    state: record.state,
    createdAt: record.createdAt,
    ...(record.configPath ? { configPath: record.configPath as string } : {}),
  };
}
