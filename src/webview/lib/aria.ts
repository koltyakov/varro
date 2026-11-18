/** ARIA booleans are enumerated text attributes, not HTML presence attributes. */
export function ariaBoolean(value: boolean): 'true' | 'false';
export function ariaBoolean(value: boolean | undefined): 'true' | 'false' | undefined;
export function ariaBoolean<T extends string | undefined>(value: T): T;
export function ariaBoolean<const T extends string | undefined>(
  value: boolean | T
): 'true' | 'false' | T;
export function ariaBoolean(value: boolean | string | undefined): string | undefined {
  return value === true ? 'true' : value === false ? 'false' : value;
}
