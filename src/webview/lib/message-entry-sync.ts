import type { MessageEntry } from '../types';
import type { UnknownRecord } from '../../shared/type-utils';
import { isObject } from './runtime-values';

export function getSharedMessagePrefixLength(current: MessageEntry[], incoming: MessageEntry[]) {
  const minLen = Math.min(current.length, incoming.length);
  let index = 0;
  while (index < minLen && current[index]!.info.id === incoming[index]!.info.id) {
    index += 1;
  }
  return index;
}

export function areMessageEntriesEquivalent(left: MessageEntry, right: MessageEntry) {
  if (left === right) return true;
  if (left.info !== right.info && !deepEqual(left.info, right.info)) return false;
  if (left.parts === right.parts) return true;
  if (left.parts.length !== right.parts.length) return false;

  for (let index = 0; index < left.parts.length; index += 1) {
    if (
      left.parts[index] !== right.parts[index] &&
      !deepEqual(left.parts[index], right.parts[index])
    ) {
      return false;
    }
  }
  return true;
}

function deepEqual<T>(a: T, b: T): boolean {
  if (a === b) return true;
  if (a === null || b === null || !isObject(a) || !isObject(b)) return false;
  if (Array.isArray(a)) {
    if (!Array.isArray(b) || a.length !== b.length) return false;
    for (let i = 0; i < a.length; i += 1) {
      if (!deepEqual(a[i], b[i])) return false;
    }
    return true;
  }
  if (Array.isArray(b)) return false;

  // SAFETY: The surrounding shape or discriminator check establishes the UnknownRecord contract used below.
  const aKeys = Object.keys(a as UnknownRecord);
  // SAFETY: The surrounding shape or discriminator check establishes the UnknownRecord contract used below.
  const bKeys = Object.keys(b as UnknownRecord);
  if (aKeys.length !== bKeys.length) return false;
  for (const key of aKeys) {
    if (!Object.prototype.hasOwnProperty.call(b, key)) return false;
    // SAFETY: The surrounding shape or discriminator check establishes the UnknownRecord contract used below.
    if (!deepEqual((a as UnknownRecord)[key], (b as UnknownRecord)[key])) {
      return false;
    }
  }
  return true;
}
