import { asRecord, isString, isBoolean, isNumber } from './type-utils';

/** Opaque, JSON-only host context. Unknown providers and schema versions survive persistence. */
export interface ExtensionContext {
  provider: string;
  version: number;
  label: string;
  placement: 'replace-document' | 'alongside-document';
  data: unknown;
  captured?: {
    text: string;
    detail?: string;
    icon?: 'table' | 'terminal' | 'file';
  };
}

export const EXTENSION_CONTEXT_MARKER = '[Extension context]';
export const EXTENSION_ID_PATTERN = /^[a-z][a-z0-9-]*(?:\.[a-z][a-z0-9-]*)+$/;

function isJson<T>(value: T, depth = 0): boolean {
  if (depth > 32) return false;
  if (value === null || isString(value) || isBoolean(value)) return true;
  if (isNumber(value)) return Number.isFinite(value);
  if (Array.isArray(value)) return value.every((item) => isJson(item, depth + 1));
  const record = asRecord(value);
  return (
    !!record &&
    (Object.getPrototypeOf(record) === Object.prototype ||
      Object.getPrototypeOf(record) === null) &&
    Object.values(record).every((item) => isJson(item, depth + 1))
  );
}

export function isExtensionContext<T>(value: T): value is T & ExtensionContext {
  const record = asRecord(value);
  if (
    !record ||
    !isString(record.provider) ||
    record.provider.length > 128 ||
    !EXTENSION_ID_PATTERN.test(record.provider) ||
    !Number.isSafeInteger(record.version) ||
    Number(record.version) < 1 ||
    !isString(record.label) ||
    !record.label ||
    record.label.length > 1_000 ||
    (record.placement !== 'replace-document' && record.placement !== 'alongside-document') ||
    !Object.hasOwn(record, 'data') ||
    !isJson(record)
  )
    return false;
  if (record.captured !== undefined) {
    const captured = asRecord(record.captured);
    if (
      !captured ||
      !isString(captured.text) ||
      !captured.text.trim() ||
      (captured.detail !== undefined &&
        (!isString(captured.detail) || captured.detail.length > 4_000)) ||
      (captured.icon !== undefined &&
        !['table', 'terminal', 'file'].includes(String(captured.icon)))
    )
      return false;
  }
  return JSON.stringify(record).length <= 512_000;
}

export function isExtensionContexts<T>(value: T): value is T & ExtensionContext[] {
  return (
    Array.isArray(value) &&
    value.length <= 32 &&
    value.every(isExtensionContext) &&
    JSON.stringify(value).length <= 1_024_000
  );
}

export function cloneExtensionContexts(
  contexts: ExtensionContext[] | undefined
): ExtensionContext[] | undefined {
  if (contexts === undefined) return undefined;
  if (!isExtensionContexts(contexts)) throw new Error('Invalid extension context snapshot');
  const cloned: unknown = JSON.parse(JSON.stringify(contexts));
  if (!isExtensionContexts(cloned)) throw new Error('Invalid cloned extension context');
  return cloned;
}

export function formatExtensionContext(context: ExtensionContext): string {
  if (!isExtensionContext(context) || !context.captured)
    throw new Error(`Uncaptured context: ${context.provider}`);
  const text = JSON.stringify(context, null, 2);
  const fence = '`'.repeat(
    Math.max(3, ...[...text.matchAll(/`+/g)].map((match) => match[0].length + 1))
  );
  return `${EXTENSION_CONTEXT_MARKER}\n${fence}json\n${text}\n${fence}`;
}

/** Called only outside an existing code fence. Malformed or future envelopes remain visible. */
export function readExtensionContextBlock(
  lines: string[],
  index: number
): { context: ExtensionContext; end: number } | null {
  if (lines[index]?.trim() !== EXTENSION_CONTEXT_MARKER) return null;
  const opening = lines[index + 1]?.trim().match(/^(`{3,})json$/);
  if (!opening) return null;
  const end = lines.findIndex(
    (line, position) => position > index + 1 && line.trim() === opening[1]
  );
  if (end < 0) return null;
  try {
    const context: unknown = JSON.parse(lines.slice(index + 2, end).join('\n'));
    return isExtensionContext(context) && context.captured ? { context, end } : null;
  } catch {
    return null;
  }
}
