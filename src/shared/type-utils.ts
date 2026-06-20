export function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

export function getString(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}
