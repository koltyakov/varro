// Opaque protocol objects must preserve values until an owner-specific parser validates them.
// oxlint-disable-next-line anti-slop/no-unsafe-dictionary-type
export type UnknownRecord = Record<string, unknown>;

export type JsonValue = string | number | boolean | null | JsonValue[] | JsonObject;

export interface JsonObject {
  [key: string]: JsonValue | undefined;
}

function isNonArrayObject<T>(value: T): value is T & object {
  // oxlint-disable-next-line anti-slop/no-runtime-typeof -- This is the object boundary check used before record access.
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

export function asRecord<T>(value: T): UnknownRecord | null {
  if (!isNonArrayObject(value)) return null;
  // SAFETY: Callers use this only for JSON/structured-clone payloads, and the check excludes null and arrays.
  return value as UnknownRecord;
}

export function isString<T>(value: T): value is T & string {
  // oxlint-disable-next-line anti-slop/no-runtime-typeof -- This guard validates a primitive at a protocol boundary.
  return typeof value === 'string';
}

export function isNumber<T>(value: T): value is T & number {
  // oxlint-disable-next-line anti-slop/no-runtime-typeof -- This guard validates a primitive at a protocol boundary.
  return typeof value === 'number';
}

export function isBoolean<T>(value: T): value is T & boolean {
  // oxlint-disable-next-line anti-slop/no-runtime-typeof -- This guard validates a primitive at a protocol boundary.
  return typeof value === 'boolean';
}

export function getString<T>(value: T): string {
  return isString(value) ? value.trim() : '';
}
