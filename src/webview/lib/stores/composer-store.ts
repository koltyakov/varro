import type { EditorContext } from '../../../shared/protocol';
import {
  addClipboardImage,
  addContextFile,
  addContextFiles,
  adoptDraftCurrentDocumentState,
  clearClipboardImages,
  clearContextFiles,
  clearCurrentDocumentStateForSession,
  clearDraftCurrentDocumentState,
  getCurrentDocumentEnabled,
  inputText,
  nextPastedImageIndex,
  rememberCurrentDocumentNavigation,
  removeClipboardImage,
  removeContextFile,
  resetPastedImageIndex,
  setCurrentDocumentEnabled,
  setInputText,
  setNextPastedImageIndex,
  setState,
  toggleCurrentDocumentEnabled,
} from '../state';

export const composerStore = {
  inputText,
  setInputText,
  nextPastedImageIndex,
  setNextPastedImageIndex,
  addContextFile,
  addContextFiles,
  removeContextFile,
  clearContextFiles,
  addClipboardImage,
  removeClipboardImage,
  removeSentClipboardImage(id: string) {
    removeClipboardImage(id, false);
  },
  clearClipboardImages,
  resetPastedImageIndex,
  getCurrentDocumentEnabled,
  setCurrentDocumentEnabled,
  toggleCurrentDocumentEnabled,
  rememberCurrentDocumentNavigation,
  adoptDraftCurrentDocumentState,
  clearDraftCurrentDocumentState,
  clearCurrentDocumentStateForSession,
  setEditorContext(payload: EditorContext) {
    setState('editorContext', payload);
  },
  setTerminalSelection(payload: { text: string; terminalName: string } | null) {
    setState('terminalSelection', payload);
  },
  clearTerminalSelection() {
    setState('terminalSelection', null);
  },
  clearDroppedFiles() {
    setState('droppedFiles', []);
  },
  clearTodos() {
    setState('todos', []);
  },
};

export type ComposerStore = typeof composerStore;
