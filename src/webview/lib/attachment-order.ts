import type { DroppedFile } from '../../shared/protocol';
import { normalizeWorkspaceIdentity } from '../../shared/workspace-path';
import type { ClipboardImage, NativePdfAttachment } from './app-state-types';
import { isNumber } from './runtime-values';

let nextAttachmentSequence = 1;

const contextFileAttachmentSequences = new Map<string, number>();
const clipboardImageAttachmentSequences = new Map<string, number>();
const nativePdfAttachmentSequences = new Map<string, number>();

function reserveAttachmentSequence(sequence?: number) {
  if (isNumber(sequence) && Number.isFinite(sequence)) {
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
  return contextFileAttachmentSequences.get(contextFileKey(path));
}

export function ensureContextFileAttachmentSequence(path: string, sequence?: number) {
  const key = contextFileKey(path);
  const existing = contextFileAttachmentSequences.get(key);
  if (existing !== undefined) return existing;

  const next = reserveAttachmentSequence(sequence);
  contextFileAttachmentSequences.set(key, next);
  return next;
}

export function removeContextFileAttachmentSequence(path: string) {
  contextFileAttachmentSequences.delete(contextFileKey(path));
}

export function clearContextFileAttachmentSequences() {
  contextFileAttachmentSequences.clear();
}

function contextFileKey(path: string): string {
  const normalized = path.replace(/\\/g, '/');
  return normalizeWorkspaceIdentity(normalized) ?? normalized;
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

export function seedNativePdfAttachmentSequences(pdfs: readonly NativePdfAttachment[]) {
  for (const pdf of pdfs) ensureNativePdfAttachmentSequence(pdf.id, pdf.attachmentSequence);
}

export function getNativePdfAttachmentSequence(id: string) {
  return nativePdfAttachmentSequences.get(id);
}

export function ensureNativePdfAttachmentSequence(id: string, sequence?: number) {
  const existing = nativePdfAttachmentSequences.get(id);
  if (existing !== undefined) return existing;
  const next = reserveAttachmentSequence(sequence);
  nativePdfAttachmentSequences.set(id, next);
  return next;
}

export function removeNativePdfAttachmentSequence(id: string) {
  nativePdfAttachmentSequences.delete(id);
}

export function clearNativePdfAttachmentSequences() {
  nativePdfAttachmentSequences.clear();
}

export function resetAttachmentOrderState() {
  nextAttachmentSequence = 1;
  clearContextFileAttachmentSequences();
  clearClipboardImageAttachmentSequences();
  clearNativePdfAttachmentSequences();
}
