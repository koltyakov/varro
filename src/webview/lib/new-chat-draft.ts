import { batch } from 'solid-js';
import {
  clearClipboardImages,
  clearContextFiles,
  clearMessages,
  inputText,
  isSessionAwaitingInput,
  persistActiveSessionId,
  resetPastedImageIndex,
  setError,
  setInputText,
  setPersistentShowSessionPicker,
  setShowModelPicker,
  setShowSettings,
  setState,
  state,
  stopLoading,
} from './state';
import { postMessage } from './bridge';
import { isEmptySession } from './empty-session';
import { resetMessageEditState } from './message-edit-state';
import { resetToolCallExpansionState } from './tool-call-expansion-state';

export function getDiscardableActiveBlankSessionId(): string | false {
  const sessionId = state.activeSessionId;
  if (!sessionId || state.messages.length > 0) return false;
  const session = state.sessions.find((item) => item.id === sessionId);
  if (!session || !isEmptySession(session)) return false;
  if (state.queuedMessages.some((item) => item.sessionId === sessionId)) return false;
  if (isSessionAwaitingInput(sessionId)) return false;
  const statusType = state.sessionStatus[sessionId]?.type;
  return statusType !== 'busy' && statusType !== 'retry' ? sessionId : false;
}

/**
 * Switches the UI to a blank "New Chat" draft without creating a session on
 * the server; the session is created lazily when the first message is sent.
 * An untouched blank active session is reused instead of being abandoned.
 */
export function startNewChatDraft() {
  const blankSessionId = getDiscardableActiveBlankSessionId();
  const craftedText = inputText();
  batch(() => {
    resetMessageEditState();
    clearContextFiles();
    clearClipboardImages();
    resetPastedImageIndex();
    setState('terminalSelection', null);
    setInputText(craftedText);
    resetToolCallExpansionState();
    clearMessages();
    if (!blankSessionId) {
      setState('activeSessionId', null);
      persistActiveSessionId(null);
    }
    setError(null);
    setShowSettings(false);
    setShowModelPicker(false);
    stopLoading();
    setPersistentShowSessionPicker(false);
  });
  postMessage({ type: 'files/clear' });
  postMessage({ type: 'terminal-selection/clear' });
}
