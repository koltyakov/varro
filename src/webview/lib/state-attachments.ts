import { storePath } from '@solidjs/signals';

import type { ClipboardImage, NativePdfAttachment } from './app-state-types';
import {
  MAX_CLIPBOARD_IMAGES,
  MAX_CLIPBOARD_IMAGE_SIZE,
  type DroppedFile,
} from '../../shared/protocol';
import { mergeContextFile } from '../../shared/context-files';
import { setInputText, setNextPastedImageIndex, setState, state } from './app-state';
import {
  clearClipboardImageAttachmentSequences,
  clearContextFileAttachmentSequences,
  ensureClipboardImageAttachmentSequence,
  ensureContextFileAttachmentSequence,
  removeClipboardImageAttachmentSequence,
  removeContextFileAttachmentSequence,
  seedClipboardImageAttachmentSequences,
  seedContextFileAttachmentSequences,
  clearNativePdfAttachmentSequences,
  ensureNativePdfAttachmentSequence,
  removeNativePdfAttachmentSequence,
  seedNativePdfAttachmentSequences,
} from './attachment-order';
import { MAX_NATIVE_PDF_TOTAL_BYTES } from '../../shared/native-pdf';
import { STORAGE_KEYS, writeStored } from './state-storage';
import { postMessage } from './bridge';
import { readStoredBooleanRecord } from './state-stored-values';
import { isSamePath } from './path-display';

export { MAX_CLIPBOARD_IMAGES, MAX_CLIPBOARD_IMAGE_SIZE };

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
  setState(storePath('currentDocumentEnabled', enabled));
  setState(
    storePath('currentDocumentEnabledBySession', (sessions) =>
      Object.fromEntries(Object.keys(sessions).map((id) => [id, enabled]))
    )
  );
  if (state.draftCurrentDocumentEnabled !== null) {
    setState(storePath('draftCurrentDocumentEnabled', enabled));
  }
  if (sessionId) {
    setState(storePath('currentDocumentEnabledBySession', sessionId, enabled));
  } else {
    setState(storePath('draftCurrentDocumentEnabled', enabled));
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
    storePath(
      'currentDocumentEnabled',
      normalizedWorkspace ? (projectValues[normalizedWorkspace] ?? true) : true
    )
  );
  setState(storePath('draftCurrentDocumentEnabled', null));
  setState(storePath('currentDocumentEnabledBySession', {}));
  const issueValues = readStoredBooleanRecord(STORAGE_KEYS.projectIssuesEnabled);
  setState(
    storePath(
      'issuesEnabled',
      normalizedWorkspace ? (issueValues[normalizedWorkspace] ?? true) : true
    )
  );
}

export function toggleIssuesEnabled() {
  const enabled = !state.issuesEnabled;
  setState(storePath('issuesEnabled', enabled));
  const workspacePath = normalizeWorkspacePath(state.editorContext.workspacePath);
  if (!workspacePath) return;
  const values = readStoredBooleanRecord(STORAGE_KEYS.projectIssuesEnabled);
  values[workspacePath] = enabled;
  writeStored(STORAGE_KEYS.projectIssuesEnabled, values);
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
  setState(
    storePath('currentDocumentEnabledBySession', sessionId, state.draftCurrentDocumentEnabled)
  );
  clearDraftCurrentDocumentState();
}

export function clearDraftCurrentDocumentState() {
  setState(storePath('draftCurrentDocumentEnabled', null));
}

export function clearCurrentDocumentStateForSession(sessionId: string) {
  if (!(sessionId in state.currentDocumentEnabledBySession)) return;
  setState(
    storePath('currentDocumentEnabledBySession', (sessions) => {
      delete sessions[sessionId];

      return sessions;
    })
  );
}

/**
 * Applies a session-only value without changing the saved project preference.
 * The returned restore is skipped when the toggle changed in the meantime.
 */
export function overrideCurrentDocumentEnabledForSession(sessionId: string, enabled: boolean) {
  const hadOverride = sessionId in state.currentDocumentEnabledBySession;
  const previous = state.currentDocumentEnabledBySession[sessionId];
  setState(storePath('currentDocumentEnabledBySession', sessionId, enabled));
  return () => {
    if (state.currentDocumentEnabledBySession[sessionId] !== enabled) return;
    if (hadOverride && previous !== undefined) {
      setState(storePath('currentDocumentEnabledBySession', sessionId, previous));
    } else {
      clearCurrentDocumentStateForSession(sessionId);
    }
  };
}

export function addContextFile(file: DroppedFile) {
  const attachmentSequence = ensureContextFileAttachmentSequence(
    file.path,
    file.attachmentSequence
  );
  setState(
    storePath('droppedFiles', (files) => {
      const idx = files.findIndex((current) => isSamePath(current.path, file.path));
      if (idx === -1) {
        files.push({ ...file, attachmentSequence });
        return files;
      }
      files[idx] = { ...mergeContextFile(files[idx], file), attachmentSequence };

      return files;
    })
  );
  persistContextFiles();
}

export function addContextFiles(files: DroppedFile[]) {
  if (files.length === 0) return;
  setState(
    storePath('droppedFiles', (current) => {
      for (const file of files) {
        const attachmentSequence = ensureContextFileAttachmentSequence(
          file.path,
          file.attachmentSequence
        );
        const idx = current.findIndex((item) => isSamePath(item.path, file.path));
        if (idx === -1) {
          current.push({ ...file, attachmentSequence });
          continue;
        }
        current[idx] = { ...mergeContextFile(current[idx], file), attachmentSequence };
      }

      return current;
    })
  );
  persistContextFiles();
}

export function removeContextFile(path: string) {
  removeContextFileAttachmentSequence(path);
  setState(
    storePath('droppedFiles', (files) => {
      const idx = files.findIndex((file) => isSamePath(file.path, path));
      if (idx !== -1) files.splice(idx, 1);

      return files;
    })
  );
  persistContextFiles();
}

export function clearContextFiles() {
  clearContextFileAttachmentSequences();
  setState(storePath('droppedFiles', []));
  persistContextFiles();
}

export function replaceContextFiles(files: DroppedFile[]) {
  clearContextFileAttachmentSequences();
  seedContextFileAttachmentSequences(files);
  setState(
    storePath(
      'droppedFiles',
      files.map((file) => ({ ...file }))
    )
  );
  persistContextFiles();
}

function persistContextFiles() {
  setState((draft) => {
    const files = draft.droppedFiles.map((file) => ({
      ...file,
      lineRanges: file.lineRanges?.map((range) => ({ ...range })),
    }));
    writeStored(STORAGE_KEYS.inputDraftFiles, files.length > 0 ? files : null);
  });
}

/**
 * Replaces the attached images, enforcing the cap. Callers that add one image at
 * a time refuse to run once the list is full, so an over-cap list seeded here
 * (a message authored elsewhere with more attachments, say) would otherwise
 * never shrink back. Returns the images that were dropped so the caller can
 * reconcile their `[filename]` markers in whatever text it is about to apply.
 */
export function replaceClipboardImages(images: ClipboardImage[]): ClipboardImage[] {
  const dropped = applyClipboardImages(images);
  persistClipboardImages();
  return dropped;
}

export function syncClipboardImages(images: ClipboardImage[]) {
  applyClipboardImages(images);
}

function applyClipboardImages(images: ClipboardImage[]): ClipboardImage[] {
  const capped = images.slice(-MAX_CLIPBOARD_IMAGES);
  const dropped = images.slice(0, images.length - capped.length);
  clearClipboardImageAttachmentSequences();
  seedClipboardImageAttachmentSequences(capped);
  setState(
    storePath(
      'clipboardImages',
      capped.map((image) => ({ ...image }))
    )
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
  return addClipboardImages([image]).length === 1;
}

export function addClipboardImages(images: ClipboardImage[]): ClipboardImage[] {
  const accepted: ClipboardImage[] = [];
  setState((draft) => {
    const duplicateKeys = new Set(
      draft.clipboardImages.map((image) => image.contentKey ?? image.url)
    );
    const existingIds = new Set(draft.clipboardImages.map((image) => image.id));
    for (const image of images) {
      const duplicateKey = image.contentKey ?? image.url;
      if (
        image.size > MAX_CLIPBOARD_IMAGE_SIZE ||
        duplicateKeys.has(duplicateKey) ||
        existingIds.has(image.id)
      ) {
        continue;
      }
      duplicateKeys.add(duplicateKey);
      existingIds.add(image.id);
      accepted.push({
        ...image,
        attachmentSequence: ensureClipboardImageAttachmentSequence(
          image.id,
          image.attachmentSequence
        ),
      });
    }
    if (accepted.length === 0) return;

    const currentImages = draft.clipboardImages;
    for (const image of accepted) {
      // Loop rather than drop one so this converges regardless of how the list
      // got over the cap; `replaceClipboardImages` is what keeps it from
      // happening in the first place.
      while (currentImages.length >= MAX_CLIPBOARD_IMAGES) {
        const removed = currentImages.shift();
        if (!removed) break;
        removeClipboardImageAttachmentSequence(removed.id);
      }
      currentImages.push(image);
    }
  });
  if (accepted.length > 0) persistClipboardImages();
  return accepted;
}

export function setClipboardImageContextFile(id: string, contextFile: DroppedFile) {
  if (!state.clipboardImages.some((item) => item.id === id)) return false;
  setState(
    storePath('clipboardImages', (images) => {
      const image = images.find((item) => item.id === id);
      if (image) image.contextFile = { ...contextFile };

      return images;
    })
  );
  return true;
}

export function removeClipboardImage(id: string, replacePlaceholder = true) {
  const image = state.clipboardImages.find((item) => item.id === id);
  removeClipboardImageAttachmentSequence(id);
  setState(
    storePath('clipboardImages', (images) => {
      const idx = images.findIndex((item) => item.id === id);
      if (idx !== -1) images.splice(idx, 1);

      return images;
    })
  );
  persistClipboardImages();
  if (image && replacePlaceholder) replaceClipboardImagePlaceholder(image.filename);
}

export function clearClipboardImages() {
  setState((draft) => {
    const images = draft.clipboardImages;
    setInputText((text) => {
      const stripped = stripClipboardImagePlaceholders(text, images);
      if (stripped.trim().length === 0) setNextPastedImageIndex(1);
      return stripped;
    });
    draft.clipboardImages = [];
  });
  clearClipboardImageAttachmentSequences();
  persistClipboardImages();
}

function persistClipboardImages() {
  setState((draft) => {
    postMessage({
      type: 'composer/images-update',
      payload: { images: draft.clipboardImages.map((image) => ({ ...image })) },
    });
  });
}

function replaceClipboardImagePlaceholder(filename: string) {
  const placeholder = `[${filename}]`;
  setInputText((text) => text.split(placeholder).join('_____'));
}

export function resetPastedImageIndex() {
  setNextPastedImageIndex(1);
}

export function replaceNativePdfs(pdfs: NativePdfAttachment[]): NativePdfAttachment[] {
  const accepted: NativePdfAttachment[] = [];
  let totalSize = 0;
  for (const pdf of pdfs) {
    if (totalSize + pdf.size > MAX_NATIVE_PDF_TOTAL_BYTES) continue;
    totalSize += pdf.size;
    accepted.push({
      ...pdf,
      contextFile: pdf.contextFile ? { ...pdf.contextFile } : undefined,
    });
  }
  clearNativePdfAttachmentSequences();
  seedNativePdfAttachmentSequences(accepted);
  setState(storePath('nativePdfs', accepted));
  return pdfs.filter((pdf) => !accepted.some((item) => item.id === pdf.id));
}

export function addNativePdf(pdf: NativePdfAttachment) {
  if (
    state.nativePdfs.some((item) => item.id === pdf.id || item.url === pdf.url) ||
    state.nativePdfs.reduce((total, item) => total + item.size, 0) + pdf.size >
      MAX_NATIVE_PDF_TOTAL_BYTES
  ) {
    return false;
  }
  const attachmentSequence = ensureNativePdfAttachmentSequence(pdf.id, pdf.attachmentSequence);
  setState(
    storePath('nativePdfs', (pdfs) => [
      ...pdfs,
      {
        ...pdf,
        contextFile: pdf.contextFile ? { ...pdf.contextFile } : undefined,
        attachmentSequence,
      },
    ])
  );
  return true;
}

export function addNativePdfs(pdfs: NativePdfAttachment[]) {
  return pdfs.filter((pdf) => !addNativePdf(pdf));
}

export function setNativePdfContextFile(id: string, contextFile: DroppedFile) {
  if (!state.nativePdfs.some((pdf) => pdf.id === id)) return false;
  setState(
    storePath('nativePdfs', (pdfs) =>
      pdfs.map((pdf) =>
        pdf.id === id ? { ...pdf, contextFile: { ...contextFile, type: 'file' as const } } : pdf
      )
    )
  );
  return true;
}

export function removeNativePdf(id: string) {
  removeNativePdfAttachmentSequence(id);
  setState(storePath('nativePdfs', (pdfs) => pdfs.filter((pdf) => pdf.id !== id)));
}

export function clearNativePdfs() {
  clearNativePdfAttachmentSequences();
  setState(storePath('nativePdfs', []));
}
