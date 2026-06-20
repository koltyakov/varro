import type { Message, Part } from '../types';

export type MessageEntry = { info: Message; parts: Part[] };

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

function deepEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (a === null || b === null || typeof a !== 'object' || typeof b !== 'object') return false;
  if (Array.isArray(a)) {
    if (!Array.isArray(b) || a.length !== b.length) return false;
    for (let i = 0; i < a.length; i += 1) {
      if (!deepEqual(a[i], b[i])) return false;
    }
    return true;
  }
  if (Array.isArray(b)) return false;

  const aKeys = Object.keys(a as Record<string, unknown>);
  const bKeys = Object.keys(b as Record<string, unknown>);
  if (aKeys.length !== bKeys.length) return false;
  for (const key of aKeys) {
    if (!Object.prototype.hasOwnProperty.call(b, key)) return false;
    if (!deepEqual((a as Record<string, unknown>)[key], (b as Record<string, unknown>)[key])) {
      return false;
    }
  }
  return true;
}
