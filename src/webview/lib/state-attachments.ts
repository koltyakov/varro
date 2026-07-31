import { produce } from 'solid-js/store';
import type { ClipboardImage } from './app-state-types';
import type { DroppedFile } from '../../shared/protocol';
import { mergeContextFile } from '../../shared/context-files';
import { inputText, setInputText, setNextPastedImageIndex, setState, state } from './app-state';
import {
  clearClipboardImageAttachmentSequences,
  clearContextFileAttachmentSequences,
  ensureClipboardImageAttachmentSequence,
  ensureContextFileAttachmentSequence,
  removeClipboardImageAttachmentSequence,
  removeContextFileAttachmentSequence,
  seedClipboardImageAttachmentSequences,
  seedContextFileAttachmentSequences,
} from './attachment-order';
import { STORAGE_KEYS, writeStored } from './state-storage';
import { readStoredBooleanRecord } from './state-stored-values';

export const MAX_CLIPBOARD_IMAGES = 5;
export const MAX_CLIPBOARD_IMAGE_SIZE = 5 * 1024 * 1024;

export function getCurrentDocumentEnabled(
  sessionId: string | null | undefined = state.activeSessionId
) {
  return sessionId
    ? (state.currentDocumentEnabledBySession[sessionId] ?? state.currentDocumentEnabled)
    : (state.draftCurrentDocumentEnabled ?? state.currentDocumentEnabled);
}

export function setCurrentDocumentEnabled(
  enabled: boolean,
  sessionId: string | null | undefined = state.activeSessionId
) {
  setState('currentDocumentEnabled', enabled);
  setState('currentDocumentEnabledBySession', (sessions) =>
    Object.fromEntries(Object.keys(sessions).map((id) => [id, enabled]))
  );
  if (state.draftCurrentDocumentEnabled !== null) {
    setState('draftCurrentDocumentEnabled', enabled);
  }
  if (sessionId) {
    setState('currentDocumentEnabledBySession', sessionId, enabled);
  } else {
    setState('draftCurrentDocumentEnabled', enabled);
  }
  saveProjectCurrentDocumentEnabled(enabled);
}

export function toggleCurrentDocumentEnabled(
  sessionId: string | null | undefined = state.activeSessionId
) {
  setCurrentDocumentEnabled(!getCurrentDocumentEnabled(sessionId), sessionId);
}

export function rememberCurrentDocumentNavigation(
  previousPath: string | null | undefined,
  nextPath: string | null | undefined,
  sessionId: string | null | undefined = state.activeSessionId
) {
  if (!previousPath || !nextPath || previousPath === nextPath) return;
  if (getCurrentDocumentEnabled(sessionId)) return;
  setCurrentDocumentEnabled(false, sessionId);
}

export function syncCurrentDocumentForWorkspace(workspacePath: string | null) {
  const normalizedWorkspace = normalizeWorkspacePath(workspacePath);
  const projectValues = readStoredBooleanRecord(STORAGE_KEYS.projectCurrentDocumentEnabled);
  setState(
    'currentDocumentEnabled',
    normalizedWorkspace ? (projectValues[normalizedWorkspace] ?? true) : true
  );
  setState('draftCurrentDocumentEnabled', null);
  setState('currentDocumentEnabledBySession', {});
}

function saveProjectCurrentDocumentEnabled(enabled: boolean) {
  const workspacePath = normalizeWorkspacePath(state.editorContext.workspacePath);
  if (!workspacePath) return;
  const projectValues = readStoredBooleanRecord(STORAGE_KEYS.projectCurrentDocumentEnabled);
  projectValues[workspacePath] = enabled;
  writeStored(STORAGE_KEYS.projectCurrentDocumentEnabled, projectValues);
}

function normalizeWorkspacePath(path: string | null | undefined): string | null {
  return path?.replace(/\\/g, '/').replace(/\/+$/, '') || null;
}

export function adoptDraftCurrentDocumentState(sessionId: string) {
  if (!sessionId || state.draftCurrentDocumentEnabled === null) return;
  setState('currentDocumentEnabledBySession', sessionId, state.draftCurrentDocumentEnabled);
  clearDraftCurrentDocumentState();
}

export function clearDraftCurrentDocumentState() {
  setState('draftCurrentDocumentEnabled', null);
}

export function clearCurrentDocumentStateForSession(sessionId: string) {
  if (!(sessionId in state.currentDocumentEnabledBySession)) return;
  setState(
    'currentDocumentEnabledBySession',
    produce((sessions) => {
      delete sessions[sessionId];
    })
  );
}

export function addContextFile(file: DroppedFile) {
  const attachmentSequence = ensureContextFileAttachmentSequence(
    file.path,
    file.attachmentSequence
  );
  setState(
    'droppedFiles',
    produce((files) => {
      const idx = files.findIndex((f) => f.path === file.path);
      if (idx === -1) {
        files.push({ ...file, attachmentSequence });
        return;
      }
      files[idx] = { ...mergeContextFile(files[idx], file), attachmentSequence };
    })
  );
}

export function addContextFiles(files: DroppedFile[]) {
  if (files.length === 0) return;
  setState(
    'droppedFiles',
    produce((current) => {
      for (const file of files) {
        const attachmentSequence = ensureContextFileAttachmentSequence(
          file.path,
          file.attachmentSequence
        );
        const idx = current.findIndex((item) => item.path === file.path);
        if (idx === -1) {
          current.push({ ...file, attachmentSequence });
          continue;
        }
        current[idx] = { ...mergeContextFile(current[idx], file), attachmentSequence };
      }
    })
  );
}

export function removeContextFile(path: string) {
  removeContextFileAttachmentSequence(path);
  setState(
    'droppedFiles',
    produce((files) => {
      const idx = files.findIndex((f) => f.path === path);
      if (idx !== -1) files.splice(idx, 1);
    })
  );
}

export function clearContextFiles() {
  clearContextFileAttachmentSequences();
  setState('droppedFiles', []);
}

export function replaceContextFiles(files: DroppedFile[]) {
  clearContextFileAttachmentSequences();
  seedContextFileAttachmentSequences(files);
  setState(
    'droppedFiles',
    files.map((file) => ({ ...file }))
  );
}

/**
 * Replaces the attached images, enforcing the cap. Callers that add one image at
 * a time refuse to run once the list is full, so an over-cap list seeded here
 * (a message authored elsewhere with more attachments, say) would otherwise
 * never shrink back. Returns the images that were dropped so the caller can
 * reconcile their `[filename]` markers in whatever text it is about to apply.
 */
export function replaceClipboardImages(images: ClipboardImage[]): ClipboardImage[] {
  const capped = images.slice(-MAX_CLIPBOARD_IMAGES);
  const dropped = images.slice(0, images.length - capped.length);
  clearClipboardImageAttachmentSequences();
  seedClipboardImageAttachmentSequences(capped);
  setState(
    'clipboardImages',
    capped.map((image) => ({ ...image }))
  );
  return dropped;
}

/** Blanks the markers of images that are no longer attached. */
export function stripClipboardImagePlaceholders(text: string, images: ClipboardImage[]) {
  let result = text;
  for (const image of images) {
    result = result.split(`[${image.filename}]`).join('_____');
  }
  return result;
}

export function addClipboardImage(image: ClipboardImage) {
  if (image.size > MAX_CLIPBOARD_IMAGE_SIZE) return false;

  const duplicateKey = image.contentKey ?? image.url;
  if (state.clipboardImages.some((item) => (item.contentKey ?? item.url) === duplicateKey)) {
    return false;
  }

  const attachmentSequence = ensureClipboardImageAttachmentSequence(
    image.id,
    image.attachmentSequence
  );
  setState(
    'clipboardImages',
    produce((images) => {
      // Loop rather than drop one so this converges regardless of how the list
      // got over the cap; `replaceClipboardImages` is what keeps it from
      // happening in the first place.
      while (images.length >= MAX_CLIPBOARD_IMAGES) {
        const removed = images.shift();
        if (!removed) break;
        removeClipboardImageAttachmentSequence(removed.id);
      }
      if (!images.find((item) => item.id === image.id)) {
        images.push({ ...image, attachmentSequence });
      }
    })
  );

  return true;
}

export function removeClipboardImage(id: string, replacePlaceholder = true) {
  const image = state.clipboardImages.find((item) => item.id === id);
  removeClipboardImageAttachmentSequence(id);
  setState(
    'clipboardImages',
    produce((images) => {
      const idx = images.findIndex((item) => item.id === id);
      if (idx !== -1) images.splice(idx, 1);
    })
  );
  if (image && replacePlaceholder) replaceClipboardImagePlaceholder(image.filename);
}

export function clearClipboardImages() {
  for (const image of state.clipboardImages) {
    replaceClipboardImagePlaceholder(image.filename);
  }
  clearClipboardImageAttachmentSequences();
  setState('clipboardImages', []);
  if (inputText().trim().length === 0) setNextPastedImageIndex(1);
}

function replaceClipboardImagePlaceholder(filename: string) {
  const placeholder = `[${filename}]`;
  const text = inputText();
  if (!text.includes(placeholder)) return;
  setInputText(text.split(placeholder).join('_____'));
}

export function resetPastedImageIndex() {
  setNextPastedImageIndex(1);
}
