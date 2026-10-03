import { asRecord, getString, isBoolean, isNumber, isString } from '../../shared/type-utils';

export { asRecord, getString, isBoolean, isNumber, isString };
export { isObject, isRecord } from '../../shared/type-utils';
export type { UnknownRecord, JsonValue } from '../../shared/type-utils';

export function isFunction<T>(value: T): value is Extract<T, (...args: never[]) => void> {
  return /\[object (?:Async|Generator)?Function\]/.test(Object.prototype.toString.call(value));
}
