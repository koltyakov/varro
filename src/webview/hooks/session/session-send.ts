import type { DroppedFile, EditorContext, PermissionMode } from '../../../shared/protocol';
import {
  formatSelectionReference,
  getSelectionRangesFromEditorContext,
  hasExplicitContextForPath,
  subtractContextLineRanges,
} from '../../../shared/context-files';
import { normalizeModelVariant } from '../../../shared/model-variant';
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
import { getPreferredVariant } from '../../lib/model-variants';
import { getWorkspaceRelativePath, isSamePath } from '../../lib/path-display';
import type {
  MessageEntry,
  Part,
  PermissionRule,
  Provider,
  Session,
  SessionStatus,
} from '../../types';

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
  delivery?: 'steer' | 'queue';
  variant?: string;
};

type SendFlowOptions = { noReply?: boolean; delivery?: 'steer' | 'queue' };

export type QueuedAttachmentSnapshot = Pick<
  QueuedMessage,
  'droppedFiles' | 'clipboardImages' | 'terminalSelection'
>;

type SessionSendOptions = SendFlowOptions & {
  queuedAttachments?: QueuedAttachmentSnapshot;
  preserveComposer?: boolean;
  targetSessionId?: string;
};

type CapturedComposerAttachments = {
  snapshot: {
    droppedFiles: DroppedFile[];
    clipboardImages: ClipboardImage[];
    terminalSelection: { text: string; terminalName: string } | null;
  };
  droppedFileIdentities: Map<string, DroppedFile>;
  clipboardImageIdentities: Map<string, ClipboardImage>;
  terminalSelectionIdentity: { text: string; terminalName: string } | null;
};

type StateBoundSendDependencies = {
  createSession(initialPermissionMode: PermissionMode): Promise<string | null>;
  ensureSessionPermission?(sessionId: string): Promise<boolean>;
  clearPendingAbort(sessionId: string): void;
  resetTodoSync(): void;
  syncSessionMcps(sessionId: string): Promise<void>;
  sendAsync(sessionId: string, body: SessionSendBody): Promise<unknown>;
  syncSession(sessionId: string): Promise<void>;
  syncSessionMessages(sessionId: string): Promise<void>;
  recheckSessionStatus(sessionId: string): Promise<void>;
  setSessionStatusEntry(sessionId: string, status: SessionStatus): void;
  getMessageCount(sessionId: string): number;
  continueInterruptedSession(sessionId: string): Promise<void>;
  logError?(context: string, err: unknown): void;
};

type OptimisticMessageEntry = MessageEntry;

let optimisticMessageSequence = 0;

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
      if (currentDocumentEnabled && isSamePath(attachment.file.path, activeFile?.path)) continue;
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
  if (options?.delivery) body.delivery = options.delivery;

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
      ...(image.contentKey ? { contentKey: image.contentKey } : {}),
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

function captureComposerAttachments(
  queuedAttachments: QueuedAttachmentSnapshot | undefined
): CapturedComposerAttachments {
  const liveDroppedFiles = [...appStore.state.droppedFiles];
  const liveClipboardImages = [...appStore.state.clipboardImages];
  const liveTerminalSelection = appStore.state.terminalSelection;
  const source = queuedAttachments
    ? {
        droppedFiles: queuedAttachments.droppedFiles ?? [],
        clipboardImages: queuedAttachments.clipboardImages ?? [],
        terminalSelection: queuedAttachments.terminalSelection ?? null,
      }
    : {
        droppedFiles: liveDroppedFiles,
        clipboardImages: liveClipboardImages,
        terminalSelection: liveTerminalSelection,
      };
  const queuedSnapshot = getQueuedAttachmentSnapshot(source);
  const snapshot = {
    droppedFiles: queuedSnapshot.droppedFiles ?? [],
    clipboardImages: queuedSnapshot.clipboardImages ?? [],
    terminalSelection: queuedSnapshot.terminalSelection ?? null,
  };
  const droppedFileIdentities = new Map<string, DroppedFile>();
  for (const sent of snapshot.droppedFiles) {
    const live = liveDroppedFiles.find(
      (file) => file.path === sent.path && areDroppedFilesEqual(file, sent)
    );
    if (live) droppedFileIdentities.set(sent.path, live);
  }
  const clipboardImageIdentities = new Map<string, ClipboardImage>();
  for (const sent of snapshot.clipboardImages) {
    const live = liveClipboardImages.find(
      (image) => image.id === sent.id && areClipboardImagesEqual(image, sent)
    );
    if (live) clipboardImageIdentities.set(sent.id, live);
  }

  return {
    snapshot,
    droppedFileIdentities,
    clipboardImageIdentities,
    terminalSelectionIdentity:
      snapshot.terminalSelection &&
      liveTerminalSelection &&
      areTerminalSelectionsEqual(snapshot.terminalSelection, liveTerminalSelection)
        ? liveTerminalSelection
        : null,
  };
}

function clearCapturedComposerAttachments(captured: CapturedComposerAttachments) {
  const removedFilePaths: string[] = [];
  for (const sent of captured.snapshot.droppedFiles) {
    const current = appStore.state.droppedFiles.find((file) => file.path === sent.path);
    if (
      !current ||
      current !== captured.droppedFileIdentities.get(sent.path) ||
      !areDroppedFilesEqual(current, sent)
    ) {
      continue;
    }
    removedFilePaths.push(current.path);
    composerStore.removeContextFile(current.path);
  }

  for (const sent of captured.snapshot.clipboardImages) {
    const current = appStore.state.clipboardImages.find((image) => image.id === sent.id);
    if (
      !current ||
      current !== captured.clipboardImageIdentities.get(sent.id) ||
      !areClipboardImagesEqual(current, sent)
    ) {
      continue;
    }
    composerStore.removeSentClipboardImage(current.id);
  }

  const currentTerminalSelection = appStore.state.terminalSelection;
  const terminalSelectionCleared =
    !!captured.snapshot.terminalSelection &&
    currentTerminalSelection === captured.terminalSelectionIdentity &&
    areTerminalSelectionsEqual(currentTerminalSelection, captured.snapshot.terminalSelection);
  if (terminalSelectionCleared) composerStore.clearTerminalSelection();

  if (removedFilePaths.length > 0) {
    if (appStore.state.droppedFiles.length === 0) {
      postMessage({ type: 'files/clear' });
    } else {
      for (const path of removedFilePaths) {
        postMessage({ type: 'files/remove', payload: { path } });
      }
    }
  }
  if (terminalSelectionCleared) postMessage({ type: 'terminal-selection/clear' });
}

function areDroppedFilesEqual(left: DroppedFile, right: DroppedFile) {
  if (
    left.path !== right.path ||
    left.relativePath !== right.relativePath ||
    left.type !== right.type ||
    (left.attachmentSequence ?? getContextFileAttachmentSequence(left.path)) !==
      (right.attachmentSequence ?? getContextFileAttachmentSequence(right.path))
  ) {
    return false;
  }
  const leftRanges = left.lineRanges ?? [];
  const rightRanges = right.lineRanges ?? [];
  return (
    leftRanges.length === rightRanges.length &&
    leftRanges.every(
      (range, index) =>
        range.startLine === rightRanges[index]?.startLine &&
        range.endLine === rightRanges[index]?.endLine
    )
  );
}

function areClipboardImagesEqual(left: ClipboardImage, right: ClipboardImage) {
  return (
    left.id === right.id &&
    left.url === right.url &&
    left.mime === right.mime &&
    left.filename === right.filename &&
    left.size === right.size &&
    left.contentKey === right.contentKey &&
    (left.attachmentSequence ?? getClipboardImageAttachmentSequence(left.id)) ===
      (right.attachmentSequence ?? getClipboardImageAttachmentSequence(right.id))
  );
}

function areTerminalSelectionsEqual(
  left: { text: string; terminalName: string } | null,
  right: { text: string; terminalName: string } | null
) {
  return !!left && !!right && left.text === right.text && left.terminalName === right.terminalName;
}

export class SessionSendOperations {
  constructor(private readonly deps: StateBoundSendDependencies) {}

  readonly prepareSendMessage = (text: string, options?: SessionSendOptions) => {
    const activeSessionId = appStore.state.activeSessionId;
    const targetSessionId = options?.targetSessionId ?? activeSessionId;
    const defaultPermissionMode = permissionsStore.getPermissionModeForSession(null);
    const selectedAgent = appStore.state.selectedAgent;
    const capturedAttachments = captureComposerAttachments(options?.queuedAttachments);
    const capturedComposerState: ComposerState = {
      selectedAgent,
      selectedModel: appStore.state.selectedModel ? { ...appStore.state.selectedModel } : null,
      providers: [...appStore.state.providers],
      providerDefaults: { ...appStore.state.providerDefaults },
      editorContext: {
        ...appStore.state.editorContext,
        activeFile: appStore.state.editorContext.activeFile
          ? { ...appStore.state.editorContext.activeFile }
          : null,
        selection: appStore.state.editorContext.selection
          ? { ...appStore.state.editorContext.selection }
          : null,
        diagnostics: appStore.state.editorContext.diagnostics.map((diagnostic) => ({
          ...diagnostic,
        })),
      },
      ...capturedAttachments.snapshot,
    };
    const currentDocumentEnabled = composerStore.getCurrentDocumentEnabled(targetSessionId);
    const ensureSessionPermission = this.deps.ensureSessionPermission;
    return () =>
      sendMessageWithDependencies(
        {
          getActiveSessionId: () => appStore.state.activeSessionId,
          getDefaultPermissionMode: () => defaultPermissionMode,
          getSelectedAgent: () => selectedAgent,
          applySelectedAgentForSession: (agent, sessionId) =>
            routingStore.setSelectedAgent(agent, { sessionId, persistGlobal: false }),
          createSession: this.deps.createSession,
          ensureSessionPermission,
          clearPendingAbort: this.deps.clearPendingAbort,
          syncSessionMcps: this.deps.syncSessionMcps,
          buildSendPayload: (sessionId, nextText, nextOptions) =>
            buildSessionSendBody(
              capturedComposerState,
              sessionId,
              nextText,
              () => currentDocumentEnabled,
              nextOptions
            ),
          requestMessageListScrollToBottom: uiStore.requestMessageListScrollToBottom,
          startLoading: uiStore.startLoading,
          setError: uiStore.setError,
          applyEffectiveModel: (model, sessionId) =>
            routingStore.setSelectedModel(model, { sessionId }),
          resetTodoSync: this.deps.resetTodoSync,
          clearTodos: composerStore.clearTodos,
          clearSessionUsageLimit: clearSessionUsageLimitForSessionTree,
          appendOptimisticMessage: appendOptimisticMessageToActiveSession,
          removeOptimisticMessage: removeOptimisticMessageFromActiveSession,
          sendAsync: this.deps.sendAsync,
          getMessageCount: this.deps.getMessageCount,
          clearDroppedFiles: composerStore.clearDroppedFiles,
          clearTerminalSelection: composerStore.clearTerminalSelection,
          clearClipboardImages: composerStore.clearClipboardImages,
          postFilesClear: () => postMessage({ type: 'files/clear' }),
          postTerminalSelectionClear: () => postMessage({ type: 'terminal-selection/clear' }),
          clearSentComposerAttachments: () => clearCapturedComposerAttachments(capturedAttachments),
          syncSession: this.deps.syncSession,
          syncSessionMessages: this.deps.syncSessionMessages,
          recheckSessionStatus: this.deps.recheckSessionStatus,
          setSessionStatusEntry: this.deps.setSessionStatusEntry,
          stopLoading: uiStore.stopLoading,
          shouldClearComposerAfterSend: () => !options?.preserveComposer,
        },
        text,
        options
      );
  };

  readonly sendMessage = async (text: string, options?: SessionSendOptions) => {
    return await this.prepareSendMessage(text, options)();
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
        clearSessionUsageLimit: clearSessionUsageLimitForSessionTree,
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
    getDefaultPermissionMode(): PermissionMode;
    getSelectedAgent?(): string | null;
    applySelectedAgentForSession?(agent: string, sessionId: string): void;
    createSession(initialPermissionMode: PermissionMode): Promise<string | null>;
    ensureSessionPermission?(sessionId: string): Promise<boolean>;
    clearPendingAbort(sessionId: string): void;
    syncSessionMcps(sessionId: string): Promise<void>;
    buildSendPayload(
      sessionId: string,
      text: string,
      options?: SessionSendOptions
    ): { body: SessionSendBody; effectiveModel: SelectedModel | null } | null;
    requestMessageListScrollToBottom(): void;
    startLoading(): void;
    setError(message: string | null): void;
    applyEffectiveModel(model: SelectedModel, sessionId: string): void;
    resetTodoSync(): void;
    clearTodos(): void;
    clearSessionUsageLimit(sessionId: string): void;
    appendOptimisticMessage?(entry: OptimisticMessageEntry): void;
    removeOptimisticMessage?(messageId: string): void;
    sendAsync(sessionId: string, body: SessionSendBody): Promise<unknown>;
    getMessageCount(sessionId: string): number;
    clearDroppedFiles(): void;
    clearTerminalSelection(): void;
    clearClipboardImages(): void;
    postFilesClear(): void;
    postTerminalSelectionClear(): void;
    clearSentComposerAttachments?(): void;
    syncSession(sessionId: string): Promise<void>;
    syncSessionMessages(sessionId: string): Promise<void>;
    recheckSessionStatus(sessionId: string): Promise<void>;
    setSessionStatusEntry?(sessionId: string, status: SessionStatus): void;
    stopLoading(): void;
    shouldClearComposerAfterSend(): boolean;
    logError?(context: string, err: unknown): void;
  },
  text: string,
  options?: SessionSendOptions
): Promise<boolean> {
  let sessionId = options?.targetSessionId ?? deps.getActiveSessionId();
  if (!sessionId) {
    // Creating a session resets the active agent to the session default (e.g. build),
    // so capture the agent the user selected in the composer and re-apply it to the new
    // session — otherwise the first message in a fresh chat ignores the chosen agent.
    const intendedAgent = deps.getSelectedAgent?.() ?? null;
    const createdId = await deps.createSession(deps.getDefaultPermissionMode());
    if (!createdId) return false;
    sessionId = createdId;
    if (intendedAgent) deps.applySelectedAgentForSession?.(intendedAgent, sessionId);
  }

  if (deps.ensureSessionPermission && !(await deps.ensureSessionPermission(sessionId)))
    return false;

  deps.clearPendingAbort(sessionId);
  await deps.syncSessionMcps(sessionId);

  const sendPayload = deps.buildSendPayload(sessionId, text, options);
  if (!sendPayload) return false;
  const { body, effectiveModel } = sendPayload;

  const expectsAssistantReply = !body.noReply && body.delivery !== 'steer';
  if (expectsAssistantReply) {
    deps.setSessionStatusEntry?.(sessionId, { type: 'busy' });
  }
  if (expectsAssistantReply && deps.getActiveSessionId() === sessionId) {
    deps.startLoading();
  }
  if (deps.getActiveSessionId() === sessionId) deps.setError(null);
  if (effectiveModel && deps.getActiveSessionId() === sessionId) {
    deps.applyEffectiveModel(effectiveModel, sessionId);
  }

  deps.clearSessionUsageLimit(sessionId);
  const optimisticMessage = createOptimisticUserMessage(
    sessionId,
    body,
    body.agent ?? deps.getSelectedAgent?.() ?? 'build',
    effectiveModel
  );
  if (optimisticMessage) {
    deps.appendOptimisticMessage?.(optimisticMessage);
  }
  if (deps.getActiveSessionId() === sessionId) deps.requestMessageListScrollToBottom();

  try {
    await deps.sendAsync(sessionId, body);
    if (deps.shouldClearComposerAfterSend()) {
      if (deps.clearSentComposerAttachments) {
        deps.clearSentComposerAttachments();
      } else if (deps.getActiveSessionId() === sessionId) {
        deps.clearDroppedFiles();
        deps.clearTerminalSelection();
        deps.clearClipboardImages();
        deps.postFilesClear();
        deps.postTerminalSelectionClear();
      }
    }
    const syncResults = await Promise.allSettled([
      deps.syncSession(sessionId),
      deps.syncSessionMessages(sessionId),
      deps.recheckSessionStatus(sessionId),
    ]);
    if (deps.getMessageCount(sessionId) === 0) {
      if (optimisticMessage) deps.appendOptimisticMessage?.(optimisticMessage);
      await retryPostSendMessageSync(deps, sessionId);
    }
    const failures = syncResults.filter(
      (result): result is PromiseRejectedResult => result.status === 'rejected'
    );
    if (failures.length > 0) {
      for (const failure of failures) {
        deps.logError?.('postSendSync', failure.reason);
      }
      if (
        expectsAssistantReply &&
        failures.length === syncResults.length &&
        deps.getActiveSessionId() === sessionId
      ) {
        deps.stopLoading();
      }
    }
    return true;
  } catch (err) {
    if (optimisticMessage) deps.removeOptimisticMessage?.(optimisticMessage.info.id);
    if (expectsAssistantReply) {
      deps.setSessionStatusEntry?.(sessionId, { type: 'idle' });
      if (deps.getActiveSessionId() === sessionId) deps.stopLoading();
    }
    const baseMessage = err instanceof Error ? err.message : 'Failed to send message';
    if (deps.getActiveSessionId() !== sessionId) return false;
    if (body.model) {
      deps.setError(
        `Failed to send with ${body.model.providerID}/${body.model.modelID}: ${baseMessage}`
      );
      return false;
    }
    deps.setError(baseMessage);
    return false;
  }
}

function clearSessionUsageLimitForSessionTree(sessionId: string) {
  const rootId = sessionStore.getSessionTreeRootId(sessionId) || sessionId;
  const sessionIds = sessionStore.getSessionTreeIds(rootId);
  for (const id of sessionIds.length > 0 ? sessionIds : [sessionId]) {
    sessionStore.setSessionUsageLimit(id, null);
  }
}

function appendOptimisticMessageToActiveSession(entry: OptimisticMessageEntry) {
  if (appStore.state.activeSessionId !== entry.info.sessionID) return;
  appStore.setState('messages', (messages) => [...messages, entry]);
  appStore.defaultAppState.messageIndex.invalidate();
}

function removeOptimisticMessageFromActiveSession(messageId: string) {
  const nextMessages = appStore.state.messages.filter((entry) => entry.info.id !== messageId);
  if (nextMessages.length === appStore.state.messages.length) return;
  appStore.setState('messages', nextMessages);
  appStore.defaultAppState.messageIndex.invalidate();
}

function createOptimisticUserMessage(
  sessionId: string,
  body: SessionSendBody,
  agent: string,
  effectiveModel: SelectedModel | null
): OptimisticMessageEntry | null {
  const model = body.model ?? effectiveModel;
  if (!model) return null;

  const sequence = optimisticMessageSequence++;
  const created = Date.now();
  const messageId = `optimistic-user-${created}-${sequence}`;
  const parts = body.parts.flatMap((part, index): Part[] => {
    const id = `${messageId}-part-${index}`;
    if (part.type === 'text') {
      return [
        {
          id,
          sessionID: sessionId,
          messageID: messageId,
          type: 'text',
          text: part.text ?? '',
          synthetic: true,
        },
      ];
    }
    if (part.type === 'file' && part.mime && part.url) {
      return [
        {
          id,
          sessionID: sessionId,
          messageID: messageId,
          type: 'file',
          mime: part.mime,
          filename: part.filename,
          url: part.url,
        },
      ];
    }
    return [];
  });
  if (parts.length === 0) return null;

  const modelVariant =
    'variant' in model && typeof model.variant === 'string' ? model.variant : undefined;
  const variant = body.variant ?? modelVariant;
  const optimisticModel = {
    providerID: model.providerID,
    modelID: model.modelID,
    ...(variant ? { variant } : {}),
  };

  return {
    info: {
      id: messageId,
      sessionID: sessionId,
      role: 'user',
      time: { created },
      agent,
      model: optimisticModel,
    },
    parts,
  };
}

export async function ensureSessionPermissionWithDependencies(
  deps: {
    getSession(sessionId: string): Pick<Session, 'permission'> | null | undefined;
    buildPermissionRules(mode: PermissionMode): PermissionRule[];
    getPermissionMode(sessionId: string): PermissionMode;
    updateSessionPermission(
      sessionId: string,
      input: { permission: PermissionRule[] }
    ): Promise<Session>;
    upsertSession(session: Session): void;
    setError(message: string): void;
  },
  sessionId: string
): Promise<boolean> {
  const session = deps.getSession(sessionId);
  const permission = deps.buildPermissionRules(deps.getPermissionMode(sessionId));
  if (hasPermissionRules(session?.permission, permission)) return true;

  try {
    const updated = await deps.updateSessionPermission(sessionId, { permission });
    deps.upsertSession(updated);
    return true;
  } catch (err) {
    deps.setError(err instanceof Error ? err.message : 'Failed to update permissions');
    return false;
  }
}

function hasPermissionRules(current: PermissionRule[] | undefined, required: PermissionRule[]) {
  if (!Array.isArray(current) || current.length === 0) return false;
  return required.every((requiredRule) =>
    current.some(
      (rule) =>
        rule.permission === requiredRule.permission &&
        rule.pattern === requiredRule.pattern &&
        rule.action === requiredRule.action
    )
  );
}

async function retryPostSendMessageSync(
  deps: {
    getMessageCount(sessionId: string): number;
    syncSessionMessages(sessionId: string): Promise<void>;
    logError?(context: string, err: unknown): void;
  },
  sessionId: string
) {
  for (const delayMs of [250, 750]) {
    await new Promise((resolve) => setTimeout(resolve, delayMs));
    if (deps.getMessageCount(sessionId) > 0) return;
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
