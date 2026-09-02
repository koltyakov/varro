/* oxlint-disable anti-slop/no-runtime-typeof, anti-slop/no-unknown-parameters -- Provider adapters share runtime decoders for untrusted API values. */
import type { ProviderLimitStatus } from '../../shared/protocol';
import type { JsonValue } from '../../shared/type-utils';

export { asRecord, getString } from '../../shared/type-utils';

export const PROVIDER_RESPONSE_MAX_BYTES = 1024 * 1024;

export async function readBoundedResponseText(
  response: Response,
  maxBytes = PROVIDER_RESPONSE_MAX_BYTES
): Promise<string> {
  const contentLength = Number(response.headers.get('content-length'));
  if (Number.isFinite(contentLength) && contentLength > maxBytes) {
    await response.body?.cancel().catch(() => {});
    throw new Error(`Provider response exceeded the ${maxBytes}-byte safety limit`);
  }
  if (!response.body) return '';

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let bytes = 0;
  let text = '';
  try {
    while (true) {
      const result = await reader.read();
      if (result.done) break;
      bytes += result.value.byteLength;
      if (bytes > maxBytes) {
        await reader.cancel().catch(() => {});
        throw new Error(`Provider response exceeded the ${maxBytes}-byte safety limit`);
      }
      text += decoder.decode(result.value, { stream: true });
    }
    return text + decoder.decode();
  } finally {
    reader.releaseLock();
  }
}

export async function readBoundedResponseJson(response: Response): Promise<JsonValue> {
  const text = await readBoundedResponseText(response);
  // SAFETY: JSON.parse returns only values represented by JsonValue when parsing succeeds.
  return text ? (JSON.parse(text) as JsonValue) : null;
}

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
