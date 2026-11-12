import { createSignal } from 'solid-js';
import { asRecord, isString } from './runtime-values';
import { readStored, STORAGE_KEYS, writeStored } from './state-storage';

type CodexLoginWarningDismissal = { connectionID: string; dismissed: boolean };

const [version, setVersion] = createSignal(0);

export const codexLoginWarningDismissal = {
  read(): CodexLoginWarningDismissal | null {
    version();
    const stored = asRecord(readStored<unknown>(STORAGE_KEYS.codexLoginWarningDismissal));
    return stored && isString(stored.connectionID) && stored.connectionID.trim()
      ? { connectionID: stored.connectionID, dismissed: stored.dismissed === true }
      : null;
  },

  reload() {
    setVersion((value) => value + 1);
  },

  observe(connectionID: string) {
    if (this.read()?.connectionID === connectionID) return;
    writeStored(STORAGE_KEYS.codexLoginWarningDismissal, { connectionID, dismissed: false });
    this.reload();
  },

  dismiss(connectionID: string) {
    writeStored(STORAGE_KEYS.codexLoginWarningDismissal, { connectionID, dismissed: true });
    this.reload();
  },

  reset() {
    if (!this.read()) return;
    writeStored(STORAGE_KEYS.codexLoginWarningDismissal, null);
    this.reload();
  },
};
