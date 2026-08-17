import { batch } from 'solid-js';
import type { DroppedFile, EditorContext, PermissionMode } from '../../../shared/protocol';
import { isProviderAuthFailure } from '../../../shared/error-classification';
import {
  formatSelectionReference,
  getSelectionRangesFromEditorContext,
  hasExplicitContextForPath,
  subtractContextLineRanges,
} from '../../../shared/context-files';
import { normalizeModelVariant } from '../../../shared/model-variant';
import { createOpenCodeMessageID } from '../../../shared/opencode-id';
import { appStore } from '../../lib/stores/app-store';
import { composerStore } from '../../lib/stores/composer-store';
import { permissionsStore } from '../../lib/stores/permissions-store';
import { routingStore } from '../../lib/stores/routing-store';
import { sessionStore } from '../../lib/stores/session-store';
import { uiStore } from '../../lib/stores/ui-store';
import type {
  AttachedDiagnostics,
  ClipboardImage,
  NativePdfAttachment,
  ModelVariantSelections,
  QueuedMessage,
  SelectedModel,
} from '../../lib/app-state-types';
import { postMessage } from '../../lib/bridge';
import { getPromptTextForClipboardImages } from '../../lib/clipboard-images';
import {
  getClipboardImageAttachmentSequence,
  getContextFileAttachmentSequence,
  getNativePdfAttachmentSequence,
} from '../../lib/attachment-order';
import {
  modelSupportsPdf,
  modelSupportsTools,
  modelSupportsVision,
} from '../../lib/model-capabilities';
import { getVariantsForModel } from '../../lib/model-variants';
import { getNewChatDraftGeneration } from '../../lib/new-chat-draft';
import { getWorkspaceRelativePath, isSamePath } from '../../lib/path-display';
import { getModelVariantSelectionKey } from '../../lib/state-model-selection';
import {
  clearPendingOptimisticUserMessage,
  trackPendingOptimisticUserMessage,
} from '../../lib/state-messages';
import type {
  MessageEntry,
  Agent,
  Part,
  PermissionRule,
  Provider,
  Session,
  SessionStatus,
} from '../../types';
import { canDelegateVision } from '../../lib/vision-delegation';

type ComposerState = {
  selectedAgent: string | null;
  selectedModel: SelectedModel | null;
  providers: Provider[];
  providerDefaults: Record<string, string>;
  modelVariantSelections: ModelVariantSelections;
  editorContext: EditorContext;
  terminalSelection: { text: string; terminalName: string } | null;
  droppedFiles: DroppedFile[];
  clipboardImages: ClipboardImage[];
  nativePdfs?: NativePdfAttachment[];
  attachedDiagnostics?: AttachedDiagnostics | null;
  allAgents?: Agent[];
  visionDelegationTexts?: string[];
};

export type SessionSendBody = {
  messageID?: string;
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
  'droppedFiles' | 'clipboardImages' | 'nativePdfs' | 'terminalSelection' | 'attachedDiagnostics'
>;

type SessionSendOptions = SendFlowOptions & {
  agent?: string;
  selectedModel?: SelectedModel;
  optimisticModel?: SelectedModel;
  preserveModelSelection?: boolean;
  preserveScrollPosition?: boolean;
  queuedAttachments?: QueuedAttachmentSnapshot;
  preserveComposer?: boolean;
  targetSessionId?: string;
};

type CapturedComposerAttachments = {
  snapshot: {
    droppedFiles: DroppedFile[];
    clipboardImages: ClipboardImage[];
    nativePdfs: NativePdfAttachment[];
    terminalSelection: { text: string; terminalName: string } | null;
    attachedDiagnostics?: AttachedDiagnostics | null;
  };
  droppedFileIdentities: Map<string, DroppedFile>;
  clipboardImageIdentities: Map<string, ClipboardImage>;
  nativePdfIdentities: Map<string, NativePdfAttachment>;
  terminalSelectionIdentity: { text: string; terminalName: string } | null;
  attachedDiagnosticsIdentity: AttachedDiagnostics | null;
};

type ClearedComposerAttachments = {
  droppedFiles: DroppedFile[];
  clipboardImages: ClipboardImage[];
  nativePdfs: NativePdfAttachment[];
  terminalSelection: { text: string; terminalName: string } | null;
  attachedDiagnostics: AttachedDiagnostics | null;
};

type StateBoundSendDependencies = {
  getWorkspaceGeneration?(): number;
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

type OptimisticImage = Pick<ClipboardImage, 'url' | 'mime' | 'filename'>;

type SessionSendPayload = {
  body: SessionSendBody;
  effectiveModel: SelectedModel | null;
  optimisticImages?: OptimisticImage[];
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
): SessionSendPayload | null {
  const effectiveModel = routingStore.resolveSelectedModel(
    composerState.selectedModel,
    composerState.providers,
    composerState.providerDefaults,
    { allowHidden: true }
  );
  const includeNativeClipboardImages = effectiveModel
    ? modelSupportsVision(
        effectiveModel.providerID,
        effectiveModel.modelID,
        composerState.providers
      )
    : true;
  const delegateClipboardImages =
    !includeNativeClipboardImages &&
    !!effectiveModel &&
    modelSupportsTools(
      effectiveModel.providerID,
      effectiveModel.modelID,
      composerState.providers
    ) &&
    canDelegateVision(
      [text, ...(composerState.visionDelegationTexts ?? [])],
      composerState.allAgents ?? [],
      composerState.providers
    ) &&
    composerState.clipboardImages.every((image) => image.contextFile);
  const includeClipboardImages = includeNativeClipboardImages || delegateClipboardImages;
  const promptText = getPromptTextForClipboardImages(
    text,
    composerState.clipboardImages,
    includeClipboardImages
  );
  const includeNativePdfs = effectiveModel
    ? modelSupportsPdf(effectiveModel.providerID, effectiveModel.modelID, composerState.providers)
    : false;
  const parts: SessionSendBody['parts'] = [];
  if (promptText.trim()) parts.push({ type: 'text', text: promptText });

  const workspacePath = composerState.editorContext.workspacePath;
  if (workspacePath) {
    parts.push({ type: 'text', text: `[Working directory: ${workspacePath}]` });
  }

  const selection = composerState.editorContext.selection;
  const activeFile = composerState.editorContext.activeFile;
  const currentDocumentEnabled = isCurrentDocumentEnabled(sessionId);
  const editorText = composerState.editorContext.editorText;
  if (editorText && currentDocumentEnabled) {
    const range = `lines ${editorText.range.startLine}-${editorText.range.endLine}`;
    const source = editorText.kind === 'selection' ? 'Unsaved selection' : 'Unsaved buffer';
    const truncation = editorText.truncated ? '; truncated' : '';
    parts.push({
      type: 'text',
      text: `[${source} from ${editorText.relativePath} ${range}${truncation}]\n\`\`\`${editorText.language || 'text'}\n${editorText.text}\n\`\`\``,
    });
  } else if (activeFile && currentDocumentEnabled) {
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

  if (composerState.attachedDiagnostics) {
    const attached = composerState.attachedDiagnostics;
    const rows = attached.diagnostics.map((diagnostic) => {
      const path = getWorkspaceRelativePath(diagnostic.path, workspacePath) ?? diagnostic.path;
      const message = diagnostic.message.replace(/\s+/g, ' ').slice(0, 500);
      return `${diagnostic.severity.toUpperCase()} ${path}:${diagnostic.line} - ${message}`;
    });
    parts.push({
      type: 'text',
      text: `[Attached diagnostics: ${attached.diagnostics.length} of ${attached.total}]\n${rows.join('\n')}`,
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
    ...(composerState.nativePdfs ?? []).map((pdf) => ({
      kind: 'pdf' as const,
      sequence: pdf.attachmentSequence ?? Number.MAX_SAFE_INTEGER,
      pdf,
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

    if (attachment.kind === 'pdf') {
      if (includeNativePdfs) {
        parts.push({
          type: 'file',
          mime: 'application/pdf',
          filename: attachment.pdf.filename,
          url: attachment.pdf.url,
        });
      } else if (attachment.pdf.contextFile) {
        parts.push({
          type: 'text',
          text: `[Attached file: ${getAttachmentReference(attachment.pdf.contextFile, workspacePath)}]`,
        });
      }
      continue;
    }
    if (includeNativeClipboardImages) {
      parts.push({
        type: 'file',
        mime: attachment.image.mime,
        filename: attachment.image.filename,
        url: attachment.image.url,
      });
      continue;
    }
    if (!delegateClipboardImages || !attachment.image.contextFile) continue;
    const imagePath = attachment.image.contextFile.path.replace(/\\/g, '/');
    parts.push({
      type: 'text',
      text: `[Image for @vision: ${imagePath}]\nWhen calling the vision subagent, include {file:${imagePath}} in its task prompt.`,
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
    const rememberedVariant =
      composerState.modelVariantSelections[
        getModelVariantSelectionKey(body.model.providerID, body.model.modelID)
      ];
    if (rememberedVariant !== null) {
      const variants = getVariantsForModel(
        body.model.providerID,
        body.model.modelID,
        composerState.providers
      );
      const validRememberedVariant =
        rememberedVariant && variants.includes(rememberedVariant) ? rememberedVariant : null;
      body.variant = validRememberedVariant || undefined;
    }
  }
  if (options?.noReply) body.noReply = true;
  if (options?.delivery) body.delivery = options.delivery;

  return {
    body,
    effectiveModel,
    ...(delegateClipboardImages
      ? {
          optimisticImages: composerState.clipboardImages.map(({ url, mime, filename }) => ({
            url,
            mime,
            filename,
          })),
        }
      : {}),
  };
}

export function getQueuedAttachmentSnapshot(composerState: {
  droppedFiles: DroppedFile[];
  clipboardImages: ClipboardImage[];
  nativePdfs?: NativePdfAttachment[];
  terminalSelection: { text: string; terminalName: string } | null;
  attachedDiagnostics?: AttachedDiagnostics | null;
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
      ...(image.contextFile ? { contextFile: { ...image.contextFile } } : {}),
      attachmentSequence: image.attachmentSequence ?? getClipboardImageAttachmentSequence(image.id),
    })),
    nativePdfs: (composerState.nativePdfs ?? []).map((pdf) => ({
      ...pdf,
      attachmentSequence: pdf.attachmentSequence ?? getNativePdfAttachmentSequence(pdf.id),
    })),
    terminalSelection: composerState.terminalSelection
      ? {
          text: composerState.terminalSelection.text,
          terminalName: composerState.terminalSelection.terminalName,
        }
      : null,
    ...(composerState.attachedDiagnostics
      ? {
          attachedDiagnostics: {
            diagnostics: composerState.attachedDiagnostics.diagnostics.map((diagnostic) => ({
              ...diagnostic,
            })),
            total: composerState.attachedDiagnostics.total,
          },
        }
      : {}),
  };
}

function captureComposerAttachments(
  queuedAttachments: QueuedAttachmentSnapshot | undefined
): CapturedComposerAttachments {
  const liveDroppedFiles = [...appStore.state.droppedFiles];
  const liveClipboardImages = [...appStore.state.clipboardImages];
  const liveNativePdfs = [...appStore.state.nativePdfs];
  const liveTerminalSelection = appStore.state.terminalSelection;
  const liveAttachedDiagnostics = appStore.state.attachedDiagnostics;
  const source = queuedAttachments
    ? {
        droppedFiles: queuedAttachments.droppedFiles ?? [],
        clipboardImages: queuedAttachments.clipboardImages ?? [],
        nativePdfs: queuedAttachments.nativePdfs ?? [],
        terminalSelection: queuedAttachments.terminalSelection ?? null,
        attachedDiagnostics: queuedAttachments.attachedDiagnostics ?? null,
      }
    : {
        droppedFiles: liveDroppedFiles,
        clipboardImages: liveClipboardImages,
        nativePdfs: liveNativePdfs,
        terminalSelection: liveTerminalSelection,
        attachedDiagnostics: liveAttachedDiagnostics,
      };
  const queuedSnapshot = getQueuedAttachmentSnapshot(source);
  const snapshot = {
    droppedFiles: queuedSnapshot.droppedFiles ?? [],
    clipboardImages: queuedSnapshot.clipboardImages ?? [],
    nativePdfs: queuedSnapshot.nativePdfs ?? [],
    terminalSelection: queuedSnapshot.terminalSelection ?? null,
    ...(queuedSnapshot.attachedDiagnostics
      ? { attachedDiagnostics: queuedSnapshot.attachedDiagnostics }
      : {}),
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
  const nativePdfIdentities = new Map<string, NativePdfAttachment>();
  for (const sent of snapshot.nativePdfs) {
    const live = liveNativePdfs.find((pdf) => pdf.id === sent.id && areNativePdfsEqual(pdf, sent));
    if (live) nativePdfIdentities.set(sent.id, live);
  }

  return {
    snapshot,
    droppedFileIdentities,
    clipboardImageIdentities,
    nativePdfIdentities,
    terminalSelectionIdentity:
      snapshot.terminalSelection &&
      liveTerminalSelection &&
      areTerminalSelectionsEqual(snapshot.terminalSelection, liveTerminalSelection)
        ? liveTerminalSelection
        : null,
    attachedDiagnosticsIdentity:
      snapshot.attachedDiagnostics &&
      liveAttachedDiagnostics &&
      areAttachedDiagnosticsEqual(snapshot.attachedDiagnostics, liveAttachedDiagnostics)
        ? liveAttachedDiagnostics
        : null,
  };
}

function clearCapturedComposerAttachments(
  captured: CapturedComposerAttachments
): ClearedComposerAttachments {
  const cleared: ClearedComposerAttachments = {
    droppedFiles: [],
    clipboardImages: [],
    nativePdfs: [],
    terminalSelection: null,
    attachedDiagnostics: null,
  };
  for (const sent of captured.snapshot.droppedFiles) {
    const current = appStore.state.droppedFiles.find((file) => file.path === sent.path);
    if (
      !current ||
      current !== captured.droppedFileIdentities.get(sent.path) ||
      !areDroppedFilesEqual(current, sent)
    ) {
      continue;
    }
    cleared.droppedFiles.push(sent);
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
    cleared.clipboardImages.push(sent);
    composerStore.removeSentClipboardImage(current.id);
  }

  for (const sent of captured.snapshot.nativePdfs) {
    const current = appStore.state.nativePdfs.find((pdf) => pdf.id === sent.id);
    if (
      !current ||
      current !== captured.nativePdfIdentities.get(sent.id) ||
      !areNativePdfsEqual(current, sent)
    ) {
      continue;
    }
    cleared.nativePdfs.push(sent);
    composerStore.removeNativePdf(current.id);
  }

  const currentTerminalSelection = appStore.state.terminalSelection;
  const terminalSelectionCleared =
    !!captured.snapshot.terminalSelection &&
    currentTerminalSelection === captured.terminalSelectionIdentity &&
    areTerminalSelectionsEqual(currentTerminalSelection, captured.snapshot.terminalSelection);
  if (terminalSelectionCleared) {
    cleared.terminalSelection = captured.snapshot.terminalSelection;
    composerStore.clearTerminalSelection();
  }
  const currentAttachedDiagnostics = appStore.state.attachedDiagnostics;
  if (
    captured.snapshot.attachedDiagnostics &&
    currentAttachedDiagnostics === captured.attachedDiagnosticsIdentity &&
    areAttachedDiagnosticsEqual(currentAttachedDiagnostics, captured.snapshot.attachedDiagnostics)
  ) {
    cleared.attachedDiagnostics = captured.snapshot.attachedDiagnostics;
    composerStore.clearAttachedDiagnostics();
  }

  return cleared;
}

function commitClearedComposerAttachments(cleared: ClearedComposerAttachments) {
  const removedFilePaths = cleared.droppedFiles
    .map((file) => file.path)
    .filter((path) => !appStore.state.droppedFiles.some((file) => file.path === path));

  if (removedFilePaths.length > 0) {
    if (appStore.state.droppedFiles.length === 0) {
      postMessage({ type: 'files/clear' });
    } else {
      for (const path of removedFilePaths) {
        postMessage({ type: 'files/remove', payload: { path } });
      }
    }
  }
  if (cleared.terminalSelection && !appStore.state.terminalSelection) {
    postMessage({ type: 'terminal-selection/clear' });
  }
}

function restoreClearedComposerAttachments(cleared: ClearedComposerAttachments) {
  for (const file of cleared.droppedFiles) {
    if (!appStore.state.droppedFiles.some((current) => current.path === file.path)) {
      composerStore.addContextFile({
        ...file,
        lineRanges: file.lineRanges?.map((range) => ({ ...range })),
      });
    }
  }
  for (const image of cleared.clipboardImages) {
    if (!appStore.state.clipboardImages.some((current) => current.id === image.id)) {
      composerStore.addClipboardImage({ ...image });
    }
  }
  for (const pdf of cleared.nativePdfs) {
    if (!appStore.state.nativePdfs.some((current) => current.id === pdf.id)) {
      composerStore.addNativePdf({ ...pdf });
    }
  }
  if (cleared.terminalSelection && !appStore.state.terminalSelection) {
    composerStore.setTerminalSelection({ ...cleared.terminalSelection });
  }
  if (cleared.attachedDiagnostics && !appStore.state.attachedDiagnostics) {
    appStore.setState('attachedDiagnostics', {
      diagnostics: cleared.attachedDiagnostics.diagnostics.map((diagnostic) => ({ ...diagnostic })),
      total: cleared.attachedDiagnostics.total,
    });
  }
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
    left.contextFile?.path === right.contextFile?.path &&
    left.contextFile?.relativePath === right.contextFile?.relativePath &&
    (left.attachmentSequence ?? getClipboardImageAttachmentSequence(left.id)) ===
      (right.attachmentSequence ?? getClipboardImageAttachmentSequence(right.id))
  );
}

function areNativePdfsEqual(left: NativePdfAttachment, right: NativePdfAttachment) {
  return (
    left.id === right.id &&
    left.url === right.url &&
    left.mime === right.mime &&
    left.filename === right.filename &&
    left.size === right.size &&
    left.contextFile?.path === right.contextFile?.path &&
    left.contextFile?.relativePath === right.contextFile?.relativePath &&
    (left.attachmentSequence ?? getNativePdfAttachmentSequence(left.id)) ===
      (right.attachmentSequence ?? getNativePdfAttachmentSequence(right.id))
  );
}

function areTerminalSelectionsEqual(
  left: { text: string; terminalName: string } | null,
  right: { text: string; terminalName: string } | null
) {
  return !!left && !!right && left.text === right.text && left.terminalName === right.terminalName;
}

function areAttachedDiagnosticsEqual(
  left: AttachedDiagnostics | null,
  right: AttachedDiagnostics | null
) {
  return JSON.stringify(left) === JSON.stringify(right);
}

export class SessionSendOperations {
  private pendingLazySessionCreation: {
    draftGeneration: number;
    workspaceGeneration: number;
    promise: Promise<string | null>;
  } | null = null;
  constructor(private readonly deps: StateBoundSendDependencies) {}

  private readonly createSessionForSend = (
    initialPermissionMode: PermissionMode,
    draftGeneration: number,
    workspaceGeneration: number
  ) => {
    if (
      this.pendingLazySessionCreation?.draftGeneration === draftGeneration &&
      this.pendingLazySessionCreation.workspaceGeneration === workspaceGeneration
    ) {
      return this.pendingLazySessionCreation.promise;
    }

    const creation = this.deps.createSession(initialPermissionMode);
    const pending = { draftGeneration, workspaceGeneration, promise: creation };
    this.pendingLazySessionCreation = pending;
    void creation.then(
      () => {
        if (this.pendingLazySessionCreation === pending) this.pendingLazySessionCreation = null;
      },
      () => {
        if (this.pendingLazySessionCreation === pending) this.pendingLazySessionCreation = null;
      }
    );
    return creation;
  };

  readonly prepareSendMessage = (text: string, options?: SessionSendOptions) => {
    const activeSessionId = appStore.state.activeSessionId;
    const targetSessionId = options?.targetSessionId ?? activeSessionId;
    const defaultPermissionMode = permissionsStore.getPermissionModeForSession(null);
    const selectedAgent =
      options?.agent ??
      routingStore.getSelectedAgentForSession(targetSessionId) ??
      appStore.state.selectedAgent;
    const selectedModel =
      options?.selectedModel ??
      routingStore.getSelectedModelForSession(targetSessionId) ??
      appStore.state.selectedModel;
    const modelVariantSelections = { ...appStore.state.modelVariantSelections };
    if (options?.selectedModel && !options.selectedModel.variant) {
      modelVariantSelections[
        getModelVariantSelectionKey(options.selectedModel.providerID, options.selectedModel.modelID)
      ] = null;
    }
    const capturedAttachments = captureComposerAttachments(options?.queuedAttachments);
    const capturedComposerState: ComposerState = {
      selectedAgent,
      selectedModel: selectedModel ? { ...selectedModel } : null,
      providers: [...appStore.state.providers],
      providerDefaults: { ...appStore.state.providerDefaults },
      modelVariantSelections,
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
      allAgents: appStore.state.allAgents.map((agent) => ({
        ...agent,
        ...(agent.model ? { model: { ...agent.model } } : {}),
      })),
      visionDelegationTexts: targetSessionId
        ? appStore.state.messages.flatMap((entry) =>
            entry.info.sessionID === targetSessionId && entry.info.role === 'user'
              ? entry.parts.flatMap((part) => (part.type === 'text' ? [part.text] : []))
              : []
          )
        : [],
    };
    const currentDocumentEnabled = composerStore.getCurrentDocumentEnabled(targetSessionId);
    const ensureSessionPermission = this.deps.ensureSessionPermission;
    const draftGeneration = getNewChatDraftGeneration();
    const workspaceGeneration = this.deps.getWorkspaceGeneration?.() ?? 0;
    let clearedAttachments: ClearedComposerAttachments | null = null;
    return (beforeOptimisticPublish?: () => void) =>
      sendMessageWithDependencies(
        {
          getActiveSessionId: () => appStore.state.activeSessionId,
          getDefaultPermissionMode: () => defaultPermissionMode,
          getSelectedAgent: () => selectedAgent,
          applySelectedAgentForSession: (agent, sessionId) =>
            routingStore.setSelectedAgent(agent, { sessionId, persistGlobal: false }),
          createSession: (initialPermissionMode) =>
            this.createSessionForSend(initialPermissionMode, draftGeneration, workspaceGeneration),
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
          applyEffectiveModel: options?.preserveModelSelection
            ? () => {}
            : (model, sessionId) =>
                routingStore.setSelectedModel(model, { sessionId, persistGlobal: false }),
          resetTodoSync: this.deps.resetTodoSync,
          clearTodos: composerStore.clearTodos,
          clearSessionUsageLimit: clearSessionUsageLimitForSessionTree,
          setSessionFailed: sessionStore.setSessionFailed,
          beforeOptimisticPublish,
          appendOptimisticMessage: appendOptimisticMessageToActiveSession,
          removeOptimisticMessage: removeOptimisticMessageFromActiveSession,
          sendAsync: this.deps.sendAsync,
          getMessageCount: this.deps.getMessageCount,
          clearDroppedFiles: composerStore.clearDroppedFiles,
          clearTerminalSelection: composerStore.clearTerminalSelection,
          clearClipboardImages: composerStore.clearClipboardImages,
          postFilesClear: () => postMessage({ type: 'files/clear' }),
          postTerminalSelectionClear: () => postMessage({ type: 'terminal-selection/clear' }),
          clearSentComposerAttachments: () => {
            clearedAttachments ??= clearCapturedComposerAttachments(capturedAttachments);
          },
          commitSentComposerAttachments: (sentSessionId) => {
            if (!clearedAttachments) return;
            const imagePaths = clearedAttachments.clipboardImages.flatMap((image) =>
              image.contextFile ? [image.contextFile.path] : []
            );
            if (imagePaths.length > 0) {
              postMessage({
                type: 'images/release',
                payload: { paths: imagePaths, deferred: true, sessionId: sentSessionId },
              });
            }
            commitClearedComposerAttachments(clearedAttachments);
            clearedAttachments = null;
          },
          restoreSentComposerAttachments: () => {
            if (!clearedAttachments) return;
            restoreClearedComposerAttachments(clearedAttachments);
            clearedAttachments = null;
          },
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

  readonly revalidateProviderAuth = () => {
    return revalidateProviderAuthWithDependencies({
      getActiveSessionId: () => appStore.state.activeSessionId,
      getMessages: () => appStore.state.messages,
      isSessionWorking: (sessionId) =>
        uiStore.isLoading() ||
        appStore.state.sessionStatus[sessionId]?.type === 'busy' ||
        appStore.state.sessionStatus[sessionId]?.type === 'retry',
      retryMessage: this.retryMessage,
    });
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
    ): SessionSendPayload | null;
    requestMessageListScrollToBottom(targetMessageId?: string): void;
    startLoading(): void;
    setError(message: string | null): void;
    applyEffectiveModel(model: SelectedModel, sessionId: string): void;
    resetTodoSync(): void;
    clearTodos(): void;
    clearSessionUsageLimit(sessionId: string): void;
    setSessionFailed(sessionId: string, failed: boolean): void;
    beforeOptimisticPublish?(): void;
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
    commitSentComposerAttachments?(sessionId: string): void;
    restoreSentComposerAttachments?(): void;
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
    // session - otherwise the first message in a fresh chat ignores the chosen agent.
    const intendedAgent = deps.getSelectedAgent?.() ?? null;
    const createdId = await deps.createSession(deps.getDefaultPermissionMode());
    if (!createdId) return false;
    sessionId = createdId;
    if (intendedAgent && deps.getActiveSessionId() === sessionId) {
      deps.applySelectedAgentForSession?.(intendedAgent, sessionId);
    }
  }

  if (deps.ensureSessionPermission && !(await deps.ensureSessionPermission(sessionId)))
    return false;

  deps.clearPendingAbort(sessionId);
  await deps.syncSessionMcps(sessionId);

  const sendPayload = deps.buildSendPayload(sessionId, text, options);
  if (!sendPayload) return false;
  const { body, effectiveModel, optimisticImages } = sendPayload;
  const messageId = createOpenCodeMessageID();
  const sendBody = { ...body, messageID: messageId };
  if (sendBody.variant === undefined) delete sendBody.variant;

  const expectsAssistantReply = !sendBody.noReply && sendBody.delivery !== 'steer';
  const optimisticMessage = createOptimisticUserMessage(
    sessionId,
    messageId,
    sendBody,
    sendBody.agent ?? deps.getSelectedAgent?.() ?? 'build',
    effectiveModel,
    options?.optimisticModel,
    optimisticImages
  );
  batch(() => {
    if (optimisticMessage) deps.beforeOptimisticPublish?.();
    if (expectsAssistantReply) {
      deps.setSessionFailed(sessionId, false);
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
    if (deps.getActiveSessionId() === sessionId && !options?.preserveScrollPosition) {
      deps.requestMessageListScrollToBottom(
        expectsAssistantReply && optimisticMessage ? messageId : undefined
      );
    }
    if (optimisticMessage) {
      deps.appendOptimisticMessage?.(optimisticMessage);
    }
  });

  const shouldClearComposer = deps.shouldClearComposerAfterSend();
  const canClearComposerBeforeSend =
    shouldClearComposer &&
    !!deps.clearSentComposerAttachments &&
    !!deps.commitSentComposerAttachments &&
    !!deps.restoreSentComposerAttachments;
  if (canClearComposerBeforeSend) deps.clearSentComposerAttachments?.();

  try {
    await deps.sendAsync(sessionId, sendBody);
    if (shouldClearComposer) {
      if (canClearComposerBeforeSend) {
        deps.commitSentComposerAttachments?.(sessionId);
      } else if (deps.clearSentComposerAttachments) {
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
    if (canClearComposerBeforeSend) deps.restoreSentComposerAttachments?.();
    if (optimisticMessage) deps.removeOptimisticMessage?.(optimisticMessage.info.id);
    if (expectsAssistantReply) {
      deps.setSessionFailed(sessionId, true);
      deps.setSessionStatusEntry?.(sessionId, { type: 'idle' });
      if (deps.getActiveSessionId() === sessionId) deps.stopLoading();
    }
    const baseMessage = err instanceof Error ? err.message : 'Failed to send message';
    if (deps.getActiveSessionId() !== sessionId) return false;
    if (sendBody.model) {
      deps.setError(
        `Failed to send with ${sendBody.model.providerID}/${sendBody.model.modelID}: ${baseMessage}`
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
  trackPendingOptimisticUserMessage(entry.info.sessionID, entry.info.id);
  appStore.setState('messages', (messages) => [...messages, entry]);
  appStore.defaultAppState.messageIndex.invalidate();
}

function removeOptimisticMessageFromActiveSession(messageId: string) {
  const optimisticEntry = appStore.state.messages.find((message) => message.info.id === messageId);
  if (optimisticEntry) {
    clearPendingOptimisticUserMessage(optimisticEntry.info.sessionID, messageId);
  }
  const nextMessages = appStore.state.messages.filter((entry) => entry.info.id !== messageId);
  if (nextMessages.length === appStore.state.messages.length) return;
  appStore.setState('messages', nextMessages);
  appStore.defaultAppState.messageIndex.invalidate();
}

function createOptimisticUserMessage(
  sessionId: string,
  messageId: string,
  body: SessionSendBody,
  agent: string,
  effectiveModel: SelectedModel | null,
  optimisticModelFallback?: SelectedModel,
  optimisticImages: OptimisticImage[] = []
): OptimisticMessageEntry | null {
  const model = body.model ?? effectiveModel ?? optimisticModelFallback;
  if (!model) return null;

  const created = Date.now();
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
  parts.push(
    ...optimisticImages.map((image, index): Part => ({
      id: `${messageId}-optimistic-file-${index}`,
      sessionID: sessionId,
      messageID: messageId,
      type: 'file',
      mime: image.mime,
      filename: image.filename,
      url: image.url,
    }))
  );
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
  if (required.length === 0) return !current || current.length === 0;
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

export function revalidateProviderAuthWithDependencies(deps: {
  getActiveSessionId(): string | null;
  getMessages(): MessageEntry[];
  isSessionWorking(sessionId: string): boolean;
  retryMessage(messageId: string, sessionId: string): Promise<void>;
}) {
  const sessionId = deps.getActiveSessionId();
  if (!sessionId || deps.isSessionWorking(sessionId)) return false;

  const messages = deps.getMessages();
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (!message || message.info.sessionID !== sessionId) continue;
    if (message.info.role !== 'assistant' || !isProviderAuthFailure(message.info.error))
      return false;
    void deps.retryMessage(message.info.id, sessionId);
    return true;
  }

  return false;
}
