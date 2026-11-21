import { normalizeWorkspaceIdentity } from '../../shared/workspace-path';
import type { AppState } from './app-state';
import { asRecord, isString } from './runtime-values';
import { STORAGE_KEYS, readStored, writeStored } from './state-storage';
import { readWebviewInstanceContext } from './state-stored-values';

const INPUT_DRAFT_WRITE_DELAY_MS = 100;
const NO_PENDING_DRAFT = Symbol('no-pending-draft');

let pendingDraft: string | typeof NO_PENDING_DRAFT = NO_PENDING_DRAFT;
let pendingKey: string = STORAGE_KEYS.inputDraft;
let writeTimer: ReturnType<typeof setTimeout> | undefined;
let lifecycleListenersInstalled = false;

export function inputDraftKey(workspace: string | null | undefined, sessionId: string | null) {
  return `${STORAGE_KEYS.inputDraft}:${JSON.stringify([readWebviewInstanceContext()?.viewId ?? null, normalizeWorkspaceIdentity(workspace), sessionId])}`;
}

type DraftTray = Pick<AppState, 'droppedFiles' | 'clipboardImages'>;

function markerBindings(text: string, tray: DraftTray) {
  const markers: Record<string, string> = {};
  if (text.includes('@'))
    for (const file of tray.droppedFiles) {
      const marker = `@${file.relativePath || file.path}`;
      if (text.includes(marker)) markers[marker] = file.path;
    }
  if (text.includes('['))
    for (const image of tray.clipboardImages) {
      const marker = `[${image.filename}]`;
      if (text.includes(marker)) markers[marker] = image.id;
    }
  return markers;
}

// The tray is view-owned. Capture marker identity on navigation (never on a
// keystroke) so an old @file or [Image 1] cannot become a chip for a namesake.
export function parkDraftMarkers(key: string, text: string, tray: DraftTray) {
  const bindings = text.includes('@') || text.includes('[') ? markerBindings(text, tray) : null;
  if (bindings || readStored(`${key}:markers`) !== null) writeStored(`${key}:markers`, bindings);
}

export function restoreDraftText(key: string, tray: DraftTray) {
  const checkpoint = readInputDraft(key) ?? '';
  let text = checkpoint;
  if (!text.includes('@') && !text.includes('[')) return text;
  const stored = asRecord(readStored<unknown>(`${key}:markers`));
  if (!stored) return text;
  const current = markerBindings(text, tray);
  for (const marker of new Set([...Object.keys(stored), ...Object.keys(current)])) {
    if (stored[marker] === current[marker]) continue;
    // Preserve the original path as plain text. For removed images use the
    // same unbound placeholder that removing an attached image normally uses.
    const original = stored[marker];
    text = text.replaceAll(marker, () =>
      marker.startsWith('@') && isString(original) ? original : '_____'
    );
  }
  if (checkpoint !== text) writeInputDraft(text, key);
  writeStored(`${key}:markers`, null);
  return text;
}

export function readInputDraft(key: string = STORAGE_KEYS.inputDraft): string | null {
  installLifecycleListeners();
  if (pendingDraft !== NO_PENDING_DRAFT && pendingKey === key) return pendingDraft;
  const stored = readStored<unknown>(key);
  return isString(stored) && stored.length > 0 ? stored : null;
}

export function writeInputDraft(value: string, key: string = STORAGE_KEYS.inputDraft) {
  installLifecycleListeners();
  if (key !== pendingKey) flushInputDraft();
  pendingKey = key;
  if (readWebviewInstanceContext()) {
    // VS Code can snapshot the webview before pagehide or a debounce runs.
    // Checkpoint each native draft mutation, but skip unchanged values.
    cancelPendingWrite();
    if (value) {
      if (readStored<unknown>(key) !== value) {
        writeStored(key, value);
      }
    } else {
      writeStored(key, null);
    }
    return;
  }
  if (!value) {
    cancelPendingWrite();
    writeStored(key, null);
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
  writeStored(pendingKey, value);
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
