import type { ProviderLimitStatus } from '../../shared/protocol';

export { asRecord, getString } from '../../shared/type-utils';

export function parseFiniteNumber(value: unknown): number | null {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  if (!trimmed) return null;
  // Strip thousands separators only. Stripping every comma turns a decimal
  // comma ("1,5") into a hundredfold-larger integer.
  const normalized = /^[+-]?\d{1,3}(?:,\d{3})+(?:\.\d+)?$/.test(trimmed)
    ? trimmed.replace(/,/g, '')
    : trimmed;
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
