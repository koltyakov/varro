import { createSignal } from 'solid-js';
import type { DroppedFile } from '../../shared/protocol';
import type { ClipboardImage } from './app-state-types';

export type MessageEditContext = {
  files: DroppedFile[];
  images: ClipboardImage[];
  terminalSelection: { text: string; terminalName: string } | null;
};

export type MessageEditDraftBackup = MessageEditContext & { text: string };

export type MessageEditRequest = {
  messageId: string;
  sessionId: string;
  text: string;
  context: MessageEditContext;
};

const [editingMessage, setEditingMessage] = createSignal<MessageEditRequest | null>(null);
let messageEditDraftBackup: MessageEditDraftBackup | null = null;

// DOM node inside the edited message row that hosts the relocated composer.
// Null when no row currently offers an inline slot (not editing, or the row
// is virtualized away) — the composer then falls back to its bottom slot.
const [inlineEditMount, setInlineEditMount] = createSignal<HTMLElement | null>(null);

export { editingMessage, inlineEditMount };

export function registerInlineEditMount(element: HTMLElement) {
  setInlineEditMount(element);
}

export function unregisterInlineEditMount(element: HTMLElement) {
  setInlineEditMount((current) => (current === element ? null : current));
}

export function editingMessageId() {
  return editingMessage()?.messageId ?? null;
}

export function startEditingMessage(
  messageId: string,
  sessionId: string,
  text: string,
  context: MessageEditContext = { files: [], images: [], terminalSelection: null }
) {
  if (!editingMessage()) clearMessageEditDraftBackup();
  setEditingMessage({ messageId, sessionId, text, context });
}

export function stopEditingMessage(messageId: string) {
  const current = editingMessage();
  if (current?.messageId !== messageId) return;
  setEditingMessage(null);
  clearMessageEditDraftBackup();
}

export function resetMessageEditState() {
  setEditingMessage(null);
  clearMessageEditDraftBackup();
}

export function getMessageEditDraftBackup() {
  return messageEditDraftBackup;
}

export function setMessageEditDraftBackup(backup: MessageEditDraftBackup) {
  messageEditDraftBackup = backup;
}

export function clearMessageEditDraftBackup() {
  messageEditDraftBackup = null;
}
