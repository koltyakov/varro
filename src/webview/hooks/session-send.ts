import type { DroppedFile, EditorContext } from '../../shared/protocol';
import {
  formatSelectionReference,
  getSelectionRangesFromEditorContext,
  hasExplicitContextForPath,
  subtractContextLineRanges,
} from '../../shared/context-files';
import {
  clearClipboardImages,
  getCurrentDocumentEnabled,
  getPermissionModeForSession,
  requestMessageListScrollToBottom,
  setError,
  setSelectedModel,
  setSessionFailed,
  setSessionUsageLimit,
  setState,
  startLoading,
  state,
  stopLoading,
  resolveSelectedModel,
} from '../lib/state';
import type { ClipboardImage, SelectedModel } from '../lib/app-state-types';
import { getPromptTextForClipboardImages } from '../lib/clipboard-images';
import { postMessage } from '../lib/bridge';
import { modelSupportsVision } from '../lib/model-capabilities';
import { getPreferredVariant } from '../lib/model-variants';
import { getWorkspaceRelativePath, isSamePath } from '../lib/path-display';
import type { Provider } from '../types';

type ComposerState = {
  selectedAgent: string | null;
  selectedModel: SelectedModel | null;
  providers: Provider[];
  providerDefaults: Record<string, string>;
  editorContext: EditorContext;
  terminalSelection: { text: string; terminalName: string } | null;
  droppedFiles: DroppedFile[];
  clipboardImages: ClipboardImage[];
};

export type SessionSendBody = {
  parts: Array<{
    type: string;
    text?: string;
    mime?: string;
    filename?: string;
    url?: string;
  }>;
  model?: { providerID: string; modelID: string };
  agent?: string;
  noReply?: boolean;
  variant?: string;
};

type SendFlowOptions = { noReply?: boolean };

type StateBoundSendDependencies = {
  createSession(initialPermissionMode: 'default' | 'full'): Promise<string | null>;
  clearPendingAbort(sessionId: string): void;
  resetTodoSync(): void;
  syncSessionMcps(sessionId: string): Promise<void>;
  sendAsync(sessionId: string, body: SessionSendBody): Promise<unknown>;
  syncSession(sessionId: string): Promise<void>;
  syncSessionMessages(sessionId: string): Promise<void>;
  recheckSessionStatus(sessionId: string): Promise<void>;
  continueInterruptedSession(sessionId: string): Promise<void>;
};

export function getAttachmentReference(
  file: { path: string; type: 'file' | 'directory' },
  workspacePath: string | null
) {
  const relativePath = getWorkspaceRelativePath(file.path, workspacePath) ?? file.path;
  const normalizedPath = relativePath.replace(/\\/g, '/').replace(/\/+$/, '');
  if (file.type === 'directory') {
    return normalizedPath === '.' ? './' : `${normalizedPath}/`;
  }
  return normalizedPath;
}

export function buildSessionSendBody(
  composerState: ComposerState,
  sessionId: string,
  text: string,
  isCurrentDocumentEnabled: (sessionId: string) => boolean,
  options?: SendFlowOptions
): { body: SessionSendBody; effectiveModel: SelectedModel | null } | null {
  const effectiveModel = resolveSelectedModel(
    composerState.selectedModel,
    composerState.providers,
    composerState.providerDefaults
  );
  const includeClipboardImages = effectiveModel
    ? modelSupportsVision(
        effectiveModel.providerID,
        effectiveModel.modelID,
        composerState.providers
      )
    : true;
  const promptText = getPromptTextForClipboardImages(
    text,
    composerState.clipboardImages,
    includeClipboardImages
  );

  const parts: SessionSendBody['parts'] = [];
  if (promptText.trim()) parts.push({ type: 'text', text: promptText });

  const workspacePath = composerState.editorContext.workspacePath;
  if (workspacePath) {
    parts.push({ type: 'text', text: `[Working directory: ${workspacePath}]` });
  }

  const selection = composerState.editorContext.selection;
  const activeFile = composerState.editorContext.activeFile;
  const currentDocumentEnabled = isCurrentDocumentEnabled(sessionId);
  if (activeFile && currentDocumentEnabled) {
    const activeFilePath = getAttachmentReference(
      { path: activeFile.path, type: 'file' },
      workspacePath
    );
    const explicitContext = hasExplicitContextForPath(composerState.droppedFiles, activeFile.path);
    const activeSelectionRanges = getSelectionRangesFromEditorContext(selection);
    const explicitSelectionRanges =
      explicitContext?.type === 'file' ? explicitContext.lineRanges : undefined;
    const uniqueActiveSelectionRanges = subtractContextLineRanges(
      activeSelectionRanges,
      explicitSelectionRanges
    );

    if (explicitContext) {
      if (uniqueActiveSelectionRanges.length > 0) {
        parts.push({
          type: 'text',
          text: formatSelectionReference(activeFilePath, uniqueActiveSelectionRanges),
        });
      }
      parts.push({
        type: 'text',
        text:
          explicitSelectionRanges && explicitSelectionRanges.length > 0
            ? formatSelectionReference(activeFilePath, explicitSelectionRanges)
            : activeFilePath,
      });
    } else {
      parts.push({
        type: 'text',
        text:
          uniqueActiveSelectionRanges.length > 0
            ? formatSelectionReference(activeFilePath, uniqueActiveSelectionRanges)
            : `[Active file: ${activeFilePath}]`,
      });
    }
  }

  const terminalSelection = composerState.terminalSelection;
  if (terminalSelection) {
    parts.push({
      type: 'text',
      text: `[Selection from terminal ${terminalSelection.terminalName}]\n\`\`\`text\n${terminalSelection.text}\n\`\`\``,
    });
  }

  for (const file of composerState.droppedFiles) {
    if (isSamePath(file.path, activeFile?.path)) continue;
    const fileReference = getAttachmentReference(file, workspacePath);
    parts.push({
      type: 'text',
      text: file.lineRanges?.length
        ? formatSelectionReference(fileReference, file.lineRanges)
        : fileReference,
    });
  }

  if (includeClipboardImages) {
    for (const image of composerState.clipboardImages) {
      parts.push({
        type: 'file',
        mime: image.mime,
        filename: image.filename,
        url: image.url,
      });
    }
  }

  if (parts.length === 0) return null;

  const body: SessionSendBody = { parts };
  if (composerState.selectedAgent) body.agent = composerState.selectedAgent;
  if (effectiveModel) {
    body.model = {
      providerID: effectiveModel.providerID,
      modelID: effectiveModel.modelID,
    };
  }
  if (effectiveModel?.variant) {
    body.variant = effectiveModel.variant;
  } else if (body.model) {
    body.variant =
      getPreferredVariant(body.model.providerID, body.model.modelID, composerState.providers) ||
      undefined;
  }
  if (options?.noReply) body.noReply = true;

  return { body, effectiveModel };
}

export function createSessionSendOperations(deps: StateBoundSendDependencies) {
  const sendMessage = async (text: string, options?: SendFlowOptions) => {
    await sendMessageWithDependencies(
      {
        getActiveSessionId: () => state.activeSessionId,
        getDefaultPermissionMode: () => getPermissionModeForSession(null),
        createSession: deps.createSession,
        clearPendingAbort: deps.clearPendingAbort,
        syncSessionMcps: deps.syncSessionMcps,
        buildSendPayload: (sessionId, nextText, nextOptions) =>
          buildSessionSendBody(
            {
              selectedAgent: state.selectedAgent,
              selectedModel: state.selectedModel,
              providers: state.providers,
              providerDefaults: state.providerDefaults,
              editorContext: state.editorContext,
              terminalSelection: state.terminalSelection,
              droppedFiles: state.droppedFiles,
              clipboardImages: state.clipboardImages,
            },
            sessionId,
            nextText,
            getCurrentDocumentEnabled,
            nextOptions
          ),
        requestMessageListScrollToBottom,
        startLoading,
        setError,
        applyEffectiveModel: (model, sessionId) => setSelectedModel(model, { sessionId }),
        resetTodoSync: deps.resetTodoSync,
        clearTodos: () => setState('todos', []),
        clearSessionUsageLimit: (sessionId) => setSessionUsageLimit(sessionId, null),
        sendAsync: deps.sendAsync,
        clearDroppedFiles: () => setState('droppedFiles', []),
        clearTerminalSelection: () => setState('terminalSelection', null),
        clearClipboardImages,
        postFilesClear: () => postMessage({ type: 'files/clear' }),
        postTerminalSelectionClear: () => postMessage({ type: 'terminal-selection/clear' }),
        syncSession: deps.syncSession,
        syncSessionMessages: deps.syncSessionMessages,
        recheckSessionStatus: deps.recheckSessionStatus,
        stopLoading,
      },
      text,
      options
    );
  };

  const retryMessage = async (messageId: string, sessionId = state.activeSessionId) => {
    await retryMessageWithDependencies(
      {
        getActiveSessionId: () => state.activeSessionId,
        hasAssistantMessage: (targetMessageId) =>
          state.messages.some(
            (entry) => entry.info.role === 'assistant' && entry.info.id === targetMessageId
          ),
        startLoading,
        setError,
        clearPendingAbort: deps.clearPendingAbort,
        clearSessionUsageLimit: (targetSessionId) => setSessionUsageLimit(targetSessionId, null),
        setSessionFailed,
        continueInterruptedSession: deps.continueInterruptedSession,
        stopLoading,
      },
      messageId,
      sessionId
    );
  };

  return {
    sendMessage,
    retryMessage,
  };
}

export async function sendMessageWithDependencies(
  deps: {
    getActiveSessionId(): string | null;
    getDefaultPermissionMode(): 'default' | 'full';
    createSession(initialPermissionMode: 'default' | 'full'): Promise<string | null>;
    clearPendingAbort(sessionId: string): void;
    syncSessionMcps(sessionId: string): Promise<void>;
    buildSendPayload(
      sessionId: string,
      text: string,
      options?: SendFlowOptions
    ): { body: SessionSendBody; effectiveModel: SelectedModel | null } | null;
    requestMessageListScrollToBottom(): void;
    startLoading(): void;
    setError(message: string | null): void;
    applyEffectiveModel(model: SelectedModel, sessionId: string): void;
    resetTodoSync(): void;
    clearTodos(): void;
    clearSessionUsageLimit(sessionId: string): void;
    sendAsync(sessionId: string, body: SessionSendBody): Promise<unknown>;
    clearDroppedFiles(): void;
    clearTerminalSelection(): void;
    clearClipboardImages(): void;
    postFilesClear(): void;
    postTerminalSelectionClear(): void;
    syncSession(sessionId: string): Promise<void>;
    syncSessionMessages(sessionId: string): Promise<void>;
    recheckSessionStatus(sessionId: string): Promise<void>;
    stopLoading(): void;
  },
  text: string,
  options?: SendFlowOptions
) {
  let sessionId = deps.getActiveSessionId();
  if (!sessionId) {
    const createdId = await deps.createSession(deps.getDefaultPermissionMode());
    if (!createdId) return;
    sessionId = createdId;
  }

  const currentSessionId = deps.getActiveSessionId();
  if (currentSessionId && currentSessionId !== sessionId) {
    sessionId = currentSessionId;
  }

  deps.clearPendingAbort(sessionId);
  await deps.syncSessionMcps(sessionId);

  const sendPayload = deps.buildSendPayload(sessionId, text, options);
  if (!sendPayload) return;
  const { body, effectiveModel } = sendPayload;

  deps.requestMessageListScrollToBottom();
  deps.startLoading();
  deps.setError(null);
  if (effectiveModel) {
    deps.applyEffectiveModel(effectiveModel, sessionId);
  }

  deps.resetTodoSync();
  deps.clearTodos();
  deps.clearSessionUsageLimit(sessionId);

  try {
    await deps.sendAsync(sessionId, body);
    deps.clearDroppedFiles();
    deps.clearTerminalSelection();
    deps.clearClipboardImages();
    deps.postFilesClear();
    deps.postTerminalSelectionClear();
    await Promise.all([
      deps.syncSession(sessionId),
      deps.syncSessionMessages(sessionId),
      deps.recheckSessionStatus(sessionId),
    ]).catch(() => {});
  } catch (err) {
    deps.stopLoading();
    const baseMessage = err instanceof Error ? err.message : 'Failed to send message';
    if (body.model) {
      deps.setError(
        `Failed to send with ${body.model.providerID}/${body.model.modelID}: ${baseMessage}`
      );
      return;
    }
    deps.setError(baseMessage);
  }
}

export async function retryMessageWithDependencies(
  deps: {
    getActiveSessionId(): string | null;
    hasAssistantMessage(messageId: string): boolean;
    startLoading(): void;
    setError(message: string | null): void;
    clearPendingAbort(sessionId: string): void;
    clearSessionUsageLimit(sessionId: string): void;
    setSessionFailed(sessionId: string, failed: boolean): void;
    continueInterruptedSession(sessionId: string): Promise<void>;
    stopLoading(): void;
  },
  messageId: string,
  sessionId: string | null
) {
  if (!sessionId || sessionId !== deps.getActiveSessionId()) return;
  if (!deps.hasAssistantMessage(messageId)) return;

  deps.startLoading();
  deps.setError(null);
  deps.clearPendingAbort(sessionId);
  deps.clearSessionUsageLimit(sessionId);
  deps.setSessionFailed(sessionId, false);

  try {
    await deps.continueInterruptedSession(sessionId);
  } catch (err) {
    deps.stopLoading();
    deps.setSessionFailed(sessionId, true);
    deps.setError(err instanceof Error ? err.message : 'Failed to retry message');
  }
}
