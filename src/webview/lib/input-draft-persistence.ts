import { STORAGE_KEYS, readStored, writeStored } from './state-storage';
import { isString } from './runtime-values';

const INPUT_DRAFT_WRITE_DELAY_MS = 100;
const NO_PENDING_DRAFT = Symbol('no-pending-draft');

let pendingDraft: string | typeof NO_PENDING_DRAFT = NO_PENDING_DRAFT;
let writeTimer: ReturnType<typeof setTimeout> | undefined;
let lifecycleListenersInstalled = false;

export function readInputDraft(): string | null {
  installLifecycleListeners();
  if (pendingDraft !== NO_PENDING_DRAFT) return pendingDraft;
  const stored = readStored<unknown>(STORAGE_KEYS.inputDraft);
  return isString(stored) && stored.length > 0 ? stored : null;
}

export function writeInputDraft(value: string) {
  installLifecycleListeners();
  if (!value) {
    cancelPendingWrite();
    writeStored(STORAGE_KEYS.inputDraft, null);
    return;
  }

  pendingDraft = value;
  if (writeTimer !== undefined) clearTimeout(writeTimer);
  writeTimer = setTimeout(flushInputDraft, INPUT_DRAFT_WRITE_DELAY_MS);
}

export function flushInputDraft() {
  if (pendingDraft === NO_PENDING_DRAFT) return;
  const value = pendingDraft;
  cancelPendingWrite();
  writeStored(STORAGE_KEYS.inputDraft, value);
}

function cancelPendingWrite() {
  if (writeTimer !== undefined) clearTimeout(writeTimer);
  writeTimer = undefined;
  pendingDraft = NO_PENDING_DRAFT;
}

function installLifecycleListeners() {
  if (lifecycleListenersInstalled) return;
  lifecycleListenersInstalled = true;
  window.addEventListener('pagehide', flushInputDraft);
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'hidden') flushInputDraft();
  });
}
