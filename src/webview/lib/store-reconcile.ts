import { reconcile } from 'solid-js';

/** Keys of `T` whose non-null value is an object or array, the only shapes `reconcile` can merge into. */
type ReconcilableKey<T> = {
  [K in keyof T]-?: NonNullable<T[K]> extends object ? K : never;
}[keyof T];

/**
 * Replaces one object- or array-valued field of a store draft. When both values are present, the
 * incoming value is reconciled into the current one so unchanged nested values keep their
 * identity; `null` or `undefined` on either side is assigned directly. Assign scalar fields
 * directly instead: Solid can only reconcile into a store proxy.
 */
export function reconcileStoreField<T extends object, K extends ReconcilableKey<T>>(
  draft: T,
  key: K,
  incoming: T[K]
): void {
  const current = draft[key];
  if (incoming === null || incoming === undefined || current === null || current === undefined) {
    draft[key] = incoming;
  } else {
    reconcile(incoming)(current);
  }
}
