import { createSignal } from 'solid-js';
import { STORAGE_KEYS, readStored, writeStored } from './state-storage';

type Selection = {
  windowId: string;
  checkedAt: number;
};

type SelectionMap = Record<string, Selection>;

const initial = readStored<SelectionMap>(STORAGE_KEYS.providerLimitWindow) ?? {};

const [selections, setSelections] = createSignal<SelectionMap>(initial);

export function getSelectedProviderLimitWindowId(providerID: string | null | undefined) {
  if (!providerID) return null;
  return selections()[providerID]?.windowId ?? null;
}

export function getSelectedProviderLimitWindowCheckedAt(providerID: string | null | undefined) {
  if (!providerID) return null;
  return selections()[providerID]?.checkedAt ?? null;
}

export function setSelectedProviderLimitWindowId(
  providerID: string,
  windowId: string,
  checkedAt = 0
) {
  const current = selections();
  const existing = current[providerID];
  if (existing?.windowId === windowId && existing.checkedAt === checkedAt) return;
  const next = { ...current, [providerID]: { windowId, checkedAt } };
  setSelections(next);
  writeStored(STORAGE_KEYS.providerLimitWindow, next);
}

export function clearSelectedProviderLimitWindowId(providerID: string) {
  const current = selections();
  if (!(providerID in current)) return;
  const next = { ...current };
  delete next[providerID];
  setSelections(next);
  writeStored(STORAGE_KEYS.providerLimitWindow, next);
}

// Test-only reset hook (not exported via barrel).
export function __resetProviderLimitWindowSelectionsForTests() {
  setSelections({});
  writeStored(STORAGE_KEYS.providerLimitWindow, null);
}
