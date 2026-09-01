import { batch } from 'solid-js';
import {
  clearMessages,
  inputText,
  isSessionAwaitingInput,
  persistActiveSessionId,
  requestComposerFocus,
  restoreSelectedModelForComposer,
  setError,
  setInputText,
  setPersistentShowSessionPicker,
  setShowModelPicker,
  setShowModels,
  setState,
  state,
  stopLoading,
} from './state';
import { isEmptySession } from './empty-session';
import { resetMessageEditState } from './message-edit-state';
import { resetToolCallExpansionState } from './tool-call-expansion-state';

let newChatDraftGeneration = 0;

export function getNewChatDraftGeneration() {
  return newChatDraftGeneration;
}

export function getDiscardableActiveBlankSessionId(): string | false {
  const sessionId = state.activeSessionId;
  if (!sessionId || state.messagesLoading || state.messages.length > 0) return false;
  const session = state.sessions.find((item) => item.id === sessionId);
  if (!session || !isEmptySession(session)) return false;
  if (state.queuedMessages.some((item) => item.sessionId === sessionId)) return false;
  if (isSessionAwaitingInput(sessionId)) return false;
  const statusType = state.sessionStatus[sessionId]?.type;
  return statusType !== 'busy' && statusType !== 'retry' ? sessionId : false;
}

export function detachDiscardableActiveBlankSession(): string | false {
  const sessionId = getDiscardableActiveBlankSessionId();
  if (!sessionId) return false;

  newChatDraftGeneration += 1;
  batch(() => {
    setState('activeSessionId', null);
    persistActiveSessionId(null);
  });
  return sessionId;
}

/**
 * Switches the UI to a blank "New Chat" draft without creating a session on
 * the server; the session is created lazily when the first message is sent.
 * An untouched blank active session is reused instead of being abandoned.
 */
export function startNewChatDraft() {
  newChatDraftGeneration += 1;
  const draftGeneration = newChatDraftGeneration;
  const blankSessionId = getDiscardableActiveBlankSessionId();
  const deferTranscriptClear = !blankSessionId && state.messages.length > 0;
  const craftedText = inputText();
  batch(() => {
    resetMessageEditState();
    setInputText(craftedText);
    resetToolCallExpansionState();
    // Detach first so a live virtualized transcript can unmount before its
    // backing entries disappear. Clearing both in one reactive flush can leave
    // rows and streaming effects reading entries that were just removed.
    if (!deferTranscriptClear) clearMessages();
    setState('messagesLoading', false);
    if (!blankSessionId) {
      setState('activeSessionId', null);
      persistActiveSessionId(null);
    }
    setError(null);
    setShowModels(false);
    setShowModelPicker(false);
    stopLoading();
    setPersistentShowSessionPicker(false);
    restoreSelectedModelForComposer(null);
    requestComposerFocus();
  });

  if (deferTranscriptClear) {
    requestAnimationFrame(() => {
      setTimeout(() => {
        // A selection, send, or another New Chat now owns the transcript.
        if (newChatDraftGeneration !== draftGeneration || state.activeSessionId) return;
        clearMessages();
      }, 0);
    });
  }
}
