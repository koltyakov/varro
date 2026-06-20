import type { ProviderLimitStatus } from '../../shared/protocol';

export function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

export function getString(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

export function parseFiniteNumber(value: unknown): number | null {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value !== 'string') return null;
  const normalized = value.trim().replace(/,/g, '');
  if (!normalized) return null;
  const parsed = Number(normalized);
  return Number.isFinite(parsed) ? parsed : null;
}

export function clampPercent(value: number | null): number | null {
  if (value == null || !Number.isFinite(value)) return null;
  return Math.round(Math.max(0, Math.min(100, value)) * 1000) / 1000;
}

export function toLabel(value: string): string {
  return (
    value
      .replace(/[_-]+/g, ' ')
      .trim()
      .replace(/\b\w/g, (match) => match.toUpperCase()) || 'Limit'
  );
}

export function unsupportedProviderStatus(
  providerID: string,
  modelID: string | null | undefined,
  checkedAt: number,
  note: string
): ProviderLimitStatus {
  return {
    status: 'unsupported',
    source: 'provider',
    providerID,
    modelID,
    checkedAt,
    note,
  };
}
