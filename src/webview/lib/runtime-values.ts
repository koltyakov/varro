import { asRecord, getString, isBoolean, isNumber, isString } from '../../shared/type-utils';

export { asRecord, getString, isBoolean, isNumber, isString };
export type { UnknownRecord, JsonValue } from '../../shared/type-utils';
import type { UnknownRecord } from '../../shared/type-utils';

export function isObject<T>(value: T): value is T & object {
  return asRecord(value) !== null || Array.isArray(value);
}

export function isRecord<T>(value: T): value is T & UnknownRecord {
  return asRecord(value) !== null;
}

export function isFunction<T>(value: T): value is Extract<T, (...args: never[]) => void> {
  return /\[object (?:Async|Generator)?Function\]/.test(Object.prototype.toString.call(value));
}
