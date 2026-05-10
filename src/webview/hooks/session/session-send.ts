import type { DroppedFile, EditorContext } from '../../../shared/protocol';
import {
  formatSelectionReference,
  getSelectionRangesFromEditorContext,
  hasExplicitContextForPath,
  subtractContextLineRanges,
} from '../../../shared/context-files';
import { appStore } from '../../lib/stores/app-store';
import { composerStore } from '../../lib/stores/composer-store';
import { permissionsStore } from '../../lib/stores/permissions-store';
import { routingStore } from '../../lib/stores/routing-store';
import { sessionStore } from '../../lib/stores/session-store';
import { uiStore } from '../../lib/stores/ui-store';
import type { ClipboardImage, QueuedMessage, SelectedModel } from '../../lib/app-state-types';
import { postMessage } from '../../lib/bridge';
import { getPromptTextForClipboardImages } from '../../lib/clipboard-images';
import {
  getClipboardImageAttachmentSequence,
  getContextFileAttachmentSequence,
} from '../../lib/attachment-order';
import { modelSupportsVision } from '../../lib/model-capabilities';
import { getPreferredVariant, normalizeModelVariant } from '../../lib/model-variants';
import { getWorkspaceRelativePath, isSamePath } from '../../lib/path-display';
import type { Provider } from '../../types';

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

export type QueuedAttachmentSnapshot = Pick<
  QueuedMessage,
  'droppedFiles' | 'clipboardImages' | 'terminalSelection'
>;

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
  logError?(context: string, err: unknown): void;
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
  const effectiveModel = routingStore.resolveSelectedModel(
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

  const orderedAttachments = [
    ...composerState.droppedFiles.map((file) => ({
      kind: 'file' as const,
      sequence: file.attachmentSequence ?? Number.MAX_SAFE_INTEGER,
      file,
    })),
    ...composerState.clipboardImages.map((image) => ({
      kind: 'image' as const,
      sequence: image.attachmentSequence ?? Number.MAX_SAFE_INTEGER,
      image,
    })),
  ].toSorted((a, b) => a.sequence - b.sequence);

  for (const attachment of orderedAttachments) {
    if (attachment.kind === 'file') {
      if (isSamePath(attachment.file.path, activeFile?.path)) continue;
      const fileReference = getAttachmentReference(attachment.file, workspacePath);
      parts.push({
        type: 'text',
        text: attachment.file.lineRanges?.length
          ? formatSelectionReference(fileReference, attachment.file.lineRanges)
          : fileReference,
      });
      continue;
    }

    if (!includeClipboardImages) continue;
    parts.push({
      type: 'file',
      mime: attachment.image.mime,
      filename: attachment.image.filename,
      url: attachment.image.url,
    });
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
    body.variant =
      normalizeModelVariant(effectiveModel.modelID, effectiveModel.variant) || undefined;
  } else if (body.model) {
    body.variant =
      getPreferredVariant(body.model.providerID, body.model.modelID, composerState.providers) ||
      undefined;
  }
  if (options?.noReply) body.noReply = true;

  return { body, effectiveModel };
}

export function getQueuedAttachmentSnapshot(composerState: {
  droppedFiles: DroppedFile[];
  clipboardImages: ClipboardImage[];
  terminalSelection: { text: string; terminalName: string } | null;
}): QueuedAttachmentSnapshot {
  return {
    droppedFiles: composerState.droppedFiles.map((file) => ({
      path: file.path,
      relativePath: file.relativePath,
      type: file.type,
      attachmentSequence: file.attachmentSequence ?? getContextFileAttachmentSequence(file.path),
      lineRanges: file.lineRanges?.map((range) => ({
        startLine: range.startLine,
        endLine: range.endLine,
      })),
    })),
    clipboardImages: composerState.clipboardImages.map((image) => ({
      id: image.id,
      url: image.url,
      mime: image.mime,
      filename: image.filename,
      size: image.size,
      attachmentSequence: image.attachmentSequence ?? getClipboardImageAttachmentSequence(image.id),
    })),
    terminalSelection: composerState.terminalSelection
      ? {
          text: composerState.terminalSelection.text,
          terminalName: composerState.terminalSelection.terminalName,
        }
      : null,
  };
}

export class SessionSendOperations {
  constructor(private readonly deps: StateBoundSendDependencies) {}

  readonly sendMessage = async (
    text: string,
    options?: SendFlowOptions & {
      queuedAttachments?: QueuedAttachmentSnapshot;
      preserveComposer?: boolean;
    }
  ) => {
    await sendMessageWithDependencies(
      {
        getActiveSessionId: () => appStore.state.activeSessionId,
        getDefaultPermissionMode: () => permissionsStore.getPermissionModeForSession(null),
        createSession: this.deps.createSession,
        clearPendingAbort: this.deps.clearPendingAbort,
        syncSessionMcps: this.deps.syncSessionMcps,
        buildSendPayload: (sessionId, nextText, nextOptions) =>
          buildSessionSendBody(
            {
              selectedAgent: appStore.state.selectedAgent,
              selectedModel: appStore.state.selectedModel,
              providers: appStore.state.providers,
              providerDefaults: appStore.state.providerDefaults,
              editorContext: appStore.state.editorContext,
              terminalSelection:
                nextOptions?.queuedAttachments?.terminalSelection ??
                appStore.state.terminalSelection,
              droppedFiles:
                nextOptions?.queuedAttachments?.droppedFiles ?? appStore.state.droppedFiles,
              clipboardImages:
                nextOptions?.queuedAttachments?.clipboardImages ?? appStore.state.clipboardImages,
            },
            sessionId,
            nextText,
            composerStore.getCurrentDocumentEnabled,
            nextOptions
          ),
        requestMessageListScrollToBottom: uiStore.requestMessageListScrollToBottom,
        startLoading: uiStore.startLoading,
        setError: uiStore.setError,
        applyEffectiveModel: (model, sessionId) =>
          routingStore.setSelectedModel(model, { sessionId }),
        resetTodoSync: this.deps.resetTodoSync,
        clearTodos: composerStore.clearTodos,
        clearSessionUsageLimit: (sessionId) => sessionStore.setSessionUsageLimit(sessionId, null),
        sendAsync: this.deps.sendAsync,
        getMessageCount: () => appStore.state.messages.length,
        clearDroppedFiles: composerStore.clearDroppedFiles,
        clearTerminalSelection: composerStore.clearTerminalSelection,
        clearClipboardImages: composerStore.clearClipboardImages,
        postFilesClear: () => postMessage({ type: 'files/clear' }),
        postTerminalSelectionClear: () => postMessage({ type: 'terminal-selection/clear' }),
        syncSession: this.deps.syncSession,
        syncSessionMessages: this.deps.syncSessionMessages,
        recheckSessionStatus: this.deps.recheckSessionStatus,
        stopLoading: uiStore.stopLoading,
        shouldClearComposerAfterSend: () => !options?.preserveComposer,
      },
      text,
      options
    );
  };

  readonly retryMessage = async (messageId: string, sessionId = appStore.state.activeSessionId) => {
    await retryMessageWithDependencies(
      {
        getActiveSessionId: () => appStore.state.activeSessionId,
        hasAssistantMessage: (targetMessageId) =>
          appStore.state.messages.some(
            (entry) => entry.info.role === 'assistant' && entry.info.id === targetMessageId
          ),
        startLoading: uiStore.startLoading,
        setError: uiStore.setError,
        clearPendingAbort: this.deps.clearPendingAbort,
        clearSessionUsageLimit: (targetSessionId) =>
          sessionStore.setSessionUsageLimit(targetSessionId, null),
        setSessionFailed: sessionStore.setSessionFailed,
        continueInterruptedSession: this.deps.continueInterruptedSession,
        stopLoading: uiStore.stopLoading,
      },
      messageId,
      sessionId
    );
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
      options?: SendFlowOptions & {
        queuedAttachments?: QueuedAttachmentSnapshot;
        preserveComposer?: boolean;
      }
    ): { body: SessionSendBody; effectiveModel: SelectedModel | null } | null;
    requestMessageListScrollToBottom(): void;
    startLoading(): void;
    setError(message: string | null): void;
    applyEffectiveModel(model: SelectedModel, sessionId: string): void;
    resetTodoSync(): void;
    clearTodos(): void;
    clearSessionUsageLimit(sessionId: string): void;
    sendAsync(sessionId: string, body: SessionSendBody): Promise<unknown>;
    getMessageCount(): number;
    clearDroppedFiles(): void;
    clearTerminalSelection(): void;
    clearClipboardImages(): void;
    postFilesClear(): void;
    postTerminalSelectionClear(): void;
    syncSession(sessionId: string): Promise<void>;
    syncSessionMessages(sessionId: string): Promise<void>;
    recheckSessionStatus(sessionId: string): Promise<void>;
    stopLoading(): void;
    shouldClearComposerAfterSend(): boolean;
    logError?(context: string, err: unknown): void;
  },
  text: string,
  options?: SendFlowOptions & {
    queuedAttachments?: QueuedAttachmentSnapshot;
    preserveComposer?: boolean;
  }
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
    const preSyncMessageCount = deps.getMessageCount();
    if (deps.shouldClearComposerAfterSend()) {
      deps.clearDroppedFiles();
      deps.clearTerminalSelection();
      deps.clearClipboardImages();
      deps.postFilesClear();
      deps.postTerminalSelectionClear();
    }
    const syncResults = await Promise.allSettled([
      deps.syncSession(sessionId),
      deps.syncSessionMessages(sessionId),
      deps.recheckSessionStatus(sessionId),
    ]);
    if (deps.getActiveSessionId() === sessionId && deps.getMessageCount() <= preSyncMessageCount) {
      await retryPostSendMessageSync(deps, sessionId);
    }
    const failures = syncResults.filter(
      (result): result is PromiseRejectedResult => result.status === 'rejected'
    );
    if (failures.length > 0) {
      for (const failure of failures) {
        deps.logError?.('postSendSync', failure.reason);
      }
      if (failures.length === syncResults.length) {
        deps.stopLoading();
      }
    }
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

async function retryPostSendMessageSync(
  deps: {
    getActiveSessionId(): string | null;
    getMessageCount(): number;
    syncSessionMessages(sessionId: string): Promise<void>;
    logError?(context: string, err: unknown): void;
  },
  sessionId: string
) {
  for (const delayMs of [250, 750]) {
    await new Promise((resolve) => setTimeout(resolve, delayMs));
    if (deps.getActiveSessionId() !== sessionId || deps.getMessageCount() > 0) return;
    try {
      await deps.syncSessionMessages(sessionId);
    } catch (err) {
      deps.logError?.('postSendMessageSyncRetry', err);
    }
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
