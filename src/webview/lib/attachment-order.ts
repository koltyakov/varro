import type { DroppedFile } from '../../shared/protocol';
import type { ClipboardImage } from './app-state-types';

let nextAttachmentSequence = 1;

const contextFileAttachmentSequences = new Map<string, number>();
const clipboardImageAttachmentSequences = new Map<string, number>();

function reserveAttachmentSequence(sequence?: number) {
  if (typeof sequence === 'number' && Number.isFinite(sequence)) {
    nextAttachmentSequence = Math.max(nextAttachmentSequence, sequence + 1);
    return sequence;
  }

  const next = nextAttachmentSequence;
  nextAttachmentSequence += 1;
  return next;
}

export function seedContextFileAttachmentSequences(files: readonly DroppedFile[]) {
  for (const file of files) {
    ensureContextFileAttachmentSequence(file.path, file.attachmentSequence);
  }
}

export function getContextFileAttachmentSequence(path: string) {
  return contextFileAttachmentSequences.get(path);
}

export function ensureContextFileAttachmentSequence(path: string, sequence?: number) {
  const existing = contextFileAttachmentSequences.get(path);
  if (existing !== undefined) return existing;

  const next = reserveAttachmentSequence(sequence);
  contextFileAttachmentSequences.set(path, next);
  return next;
}

export function removeContextFileAttachmentSequence(path: string) {
  contextFileAttachmentSequences.delete(path);
}

export function clearContextFileAttachmentSequences() {
  contextFileAttachmentSequences.clear();
}

export function seedClipboardImageAttachmentSequences(images: readonly ClipboardImage[]) {
  for (const image of images) {
    ensureClipboardImageAttachmentSequence(image.id, image.attachmentSequence);
  }
}

export function getClipboardImageAttachmentSequence(id: string) {
  return clipboardImageAttachmentSequences.get(id);
}

export function ensureClipboardImageAttachmentSequence(id: string, sequence?: number) {
  const existing = clipboardImageAttachmentSequences.get(id);
  if (existing !== undefined) return existing;

  const next = reserveAttachmentSequence(sequence);
  clipboardImageAttachmentSequences.set(id, next);
  return next;
}

export function removeClipboardImageAttachmentSequence(id: string) {
  clipboardImageAttachmentSequences.delete(id);
}

export function clearClipboardImageAttachmentSequences() {
  clipboardImageAttachmentSequences.clear();
}

export function resetAttachmentOrderState() {
  nextAttachmentSequence = 1;
  clearContextFileAttachmentSequences();
  clearClipboardImageAttachmentSequences();
}
