import { createSignal } from 'solid-js';
import { isNumber, isObject } from './runtime-values';
import { STORAGE_KEYS, readStored, writeStored } from './state-storage';

// Older markers only label finished plans; keep storage bounded.
const MAX_STORED_HANDOFFS = 200;

function readHandoffs(): Record<string, number> {
  const stored = readStored<unknown>(STORAGE_KEYS.planHandoffs);
  if (!isObject(stored)) return {};
  return Object.fromEntries(
    Object.entries(stored).filter((entry): entry is [string, number] => isNumber(entry[1]))
  );
}

// Solid 2 reads return the previous value until flush, so writes build on this copy and
// the signal only notifies readers.
let currentHandoffs = readHandoffs();
const [handoffs, setHandoffs] = createSignal<Record<string, number>>(currentHandoffs);

/**
 * Whether this plan message was sent to a new chat; whether it finished there is up to the user.
 * Keyed by message, not session, so a later plan skipped in the same chat reads as skipped.
 */
export function isPlanHandedOff(planMessageId: string) {
  handoffs();
  return Object.hasOwn(currentHandoffs, planMessageId);
}

export function recordPlanHandoff(planMessageId: string, now = Date.now()) {
  const entries = Object.entries({ ...currentHandoffs, [planMessageId]: now })
    .toSorted(([, left], [, right]) => right - left)
    .slice(0, MAX_STORED_HANDOFFS);
  currentHandoffs = Object.fromEntries(entries);
  setHandoffs(currentHandoffs);
  writeStored(STORAGE_KEYS.planHandoffs, currentHandoffs);
}
