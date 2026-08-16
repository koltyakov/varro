import {
  Show,
  Suspense,
  batch,
  createEffect,
  createMemo,
  createSignal,
  lazy,
  onCleanup,
  onMount,
  untrack,
} from 'solid-js';
import {
  state,
  inputText,
  inputTextMutationVersion,
  setState,
  setInputText,
  nextPastedImageIndex,
  setNextPastedImageIndex,
  resetPastedImageIndex,
  hasActiveQuestion,
  hasActivePermission,
  setSelectedAgent,
  setSelectedModel,
  resolveSelectedModel,
  addClipboardImage,
  addNativePdf,
  clearClipboardImages,
  clearNativePdfs,
  MAX_CLIPBOARD_IMAGES,
  MAX_CLIPBOARD_IMAGE_SIZE,
  showModelPicker,
  setShowModelPicker,
  setPersistentShowSessionPicker as setShowSessionPicker,
  composerFocusKey,
  removeClipboardImage,
  removeNativePdf,
  addContextFile,
  clearContextFiles,
  removeContextFile,
  enqueueMessage,
  reorderQueuedMessage,
  setQueuedMessagePaused,
  replaceQueuedMessage,
  removeQueuedMessage,
  setQueuedMessageDispatchingId as setDispatchingQueuedMessageId,
  setQueuedMessageFailed,
  setQueuedMessageEdit,
  getPermissionModeForSession,
  requestMessageListScrollToBottom,
  getCurrentDocumentEnabled,
  getProviderLimit,
  getModelDisplayName,
  toggleCurrentDocumentEnabled,
  getActiveUsageLimitNotice,
  isActiveSessionWorking,
  getSessionTreeRootId,
  getSessionTreeIds,
  getStoredVariantForModel,
  setSessionUsageLimit,
  isSessionCompacting,
  isSessionAwaitingInput,
  isSessionTreeStatusWorking,
  replaceClipboardImages,
  replaceNativePdfs,
  setNativePdfContextFile,
  setClipboardImageContextFile,
  stripClipboardImagePlaceholders,
  replaceContextFiles,
  connectionInitialized,
  setErrorRetry,
} from '../lib/state';
import { onMessage, postMessage } from '../lib/bridge';
import { client, serverEvents } from '../lib/client';
import { openProviderSetup } from '../lib/provider-setup';
import {
  applySessionMcps,
  sendMessage,
  abortSession,
  continueInterruptedSession,
  compactSession,
  editMessage,
  initSession,
  loadOlderSessionPrompts,
  redoSession,
  undoSession,
  reviewSession,
  updatePermissionModeForSession,
} from '../hooks/useOpenCode';
import {
  editingMessage,
  getMessageEditDraftBackup,
  resetMessageEditState,
  setMessageEditDraftBackup,
  startEditingMessage,
  type MessageEditContext,
} from '../lib/message-edit-state';
import { ralphStore } from '../lib/stores/ralph-store';
import { ralphRunner } from './ralph/ralph-runner';
import type { RalphSelectedModel } from '../../shared/ralph';
import {
  formatAgentInitial,
  formatAgentLabel,
  formatProviderLimitTitle,
  formatVariantInitial,
  formatVariantLabel,
  getProviderLimitCompactBadges,
  hasProviderLimitWindowWithinThreshold,
} from '../lib/format';
import { getVariantsForModel } from '../lib/model-variants';
import { getContextWindow } from '../lib/message-metrics';
import { getPromptTextForClipboardImages } from '../lib/clipboard-images';
import {
  modelSupportsPdf,
  modelSupportsTools,
  modelSupportsVision,
} from '../lib/model-capabilities';
import { canDelegateVision } from '../lib/vision-delegation';
import {
  getClipboardImageAttachmentSequence,
  getContextFileAttachmentSequence,
  getNativePdfAttachmentSequence,
} from '../lib/attachment-order';
import { getLeafPathName, isSamePath } from '../lib/path-display';
import { splitExternalLinkText } from '../lib/external-link';
import type { Session } from '../types';
import {
  formatContextLineRanges,
  getSelectionRangesFromEditorContext,
  hasExplicitContextForPath,
} from '../../shared/context-files';
import { normalizeSessionTitle } from '../../shared/session-title';
import { getQueuedAttachmentSnapshot } from '../hooks/session/session-send';
import {
  createComposerHistory,
  getComposerHistoryAction,
  type ComposerHistoryAction,
  type ComposerSnapshot,
} from '../lib/composer-history';
import { getSessionHistoryPrompts } from '../lib/message-window';
import { collapseExpandedDiffOverlays, hasExpandedDiffOverlay } from '../lib/diff-overlay-state';
import { TodoList } from './TodoList';
import { ChangedFilesList } from './ChangedFilesList';
import { ImagePreviewOverlay, createImagePreviewEffect, type PreviewImage } from './ImagePreview';
import { showSessionActionFeedback } from './chat/SessionActionFeedback';
import { AttachmentStrip } from './chat-input/AttachmentStrip';
import { ChatInputMainToolbar, ChatInputMetaToolbar } from './chat-input/ChatInputToolbar';
import {
  RichComposerArea,
  type RichComposerChip,
  type RichComposerPasteInsertion,
} from './chat-input/RichComposerArea';
import { DropOverlay } from './chat-input/DropOverlay';
import {
  QUEUED_MESSAGE_DRAG_TYPE,
  QueuedMessages,
  type QueuedMessageItem,
} from './chat-input/QueuedMessages';
import { UsageLimitBanner } from './chat-input/UsageLimitBanner';
import {
  estimateContextBreakdown,
  estimateNestedContextBreakdown,
} from '../../shared/context-breakdown';
import type {
  DroppedFile,
  ExtensionMessage,
  InitialWebviewState,
  SessionTokenBreakdown,
} from '../../shared/protocol';
import {
  MAX_DROPPED_CONTENT_FILES,
  MAX_DROPPED_CONTENT_FILE_BYTES,
  MAX_DROPPED_CONTENT_TOTAL_BYTES,
} from '../../shared/dropped-content-policy';
import { MAX_NATIVE_PDF_TOTAL_BYTES, NATIVE_PDF_MIME, isPdfBytes } from '../../shared/native-pdf';
import {
  getSafeUsageLimitAction,
  getUsageLimitPresentation,
  isUsageLimitNoticeVisibleForModel,
  shouldDisplayUsageLimitNotice,
} from '../lib/usage-limit';
import {
  getLatestAssistantMessageInfo,
  getLatestAssistantMessageInfoWithTokens,
  getMessageEntriesForSession,
  getSessionCost,
  getSessionTreeTokenBreakdown,
  getUserMessageHistoryText,
  mergeCompleteTokenBreakdown,
} from './chat-input/message-usage';
import {
  filterCompactProviderLimitForModel,
  isToolbarControlCompacted,
  isToolbarControlHidden,
  type ToolbarCompactMode,
  type ToolbarControl,
} from './chat-input/toolbar-compact';
import { createToolbarFitter } from './chat-input/toolbar-fit';
import { planMessageHistoryNavigation } from './chat-input/message-history-navigation';
import {
  SKILLS_COMMAND_NAME,
  createMentionCompletionSource,
  getActiveCompletion,
  getAgentBadgeLine,
  getCompletionSelection,
  getInlineInsertionSuffix,
  getLeadingSlashCommand,
  getMentionCompletionItems,
  getMentionInsertionTrailingSpace,
  getSessionCompletionItems,
  getSessionReferenceIds,
  normalizeSessionLookupQuery,
  shouldPadInlineInsertion,
  shouldRequestMentionFileSearch,
} from './chat-input/completion';
import { forkActiveSession, getSlashCommands } from './chat-input/slash-commands';
import {
  collectDroppedPaths,
  parseDroppedText,
  readFileAsBase64,
  readFileAsDataUrl,
  readItemByType,
} from './chat-input/drop-paths';
import {
  getPastedContextFiles,
  getPromptTextWithoutContextReferences,
  resolvePastedMentionContextFiles,
} from './chat-input/pasted-context';
import { logError } from '../lib/log';
import {
  acceptQueuedSteer,
  failedSteerQueuedMessageIds,
  getPromptEventText,
  sendQueuedAsSteer,
  steeringQueuedMessageIds,
} from './chat-input/queued-steer';

const LazyModelPicker = lazy(() =>
  import('./ModelPicker').then((module) => ({ default: module.ModelPicker }))
);
const LazyMcpPicker = lazy(() =>
  import('./McpPicker').then((module) => ({ default: module.McpPicker }))
);

const COMPOSER_BUSY_DISPLAY_SETTLE_DELAY_MS = 700;

function isRemoteExtensionHost() {
  return (
    (window as typeof window & { __initialWebviewState?: Partial<InitialWebviewState> })
      .__initialWebviewState?.remoteExtensionHost === true
  );
}

function composerFiles() {
  return state.droppedFiles;
}

function composerClipboardImages() {
  return state.clipboardImages;
}

function composerNativePdfs() {
  return state.nativePdfs;
}

function removeClipboardImageWithCleanup(id: string) {
  const path = state.clipboardImages.find((image) => image.id === id)?.contextFile?.path;
  removeClipboardImage(id);
  if (path) {
    postMessage({
      type: 'images/release',
      payload: { paths: [path], deferred: false },
    });
  }
}

function composerSelection() {
  return state.editorContext.selection;
}

function composerTerminalSelection() {
  return state.terminalSelection;
}

function composerActiveFile() {
  return state.editorContext.activeFile;
}

function queuedMessageEdit() {
  return state.queuedMessageEdit;
}

function dispatchingQueuedMessageId() {
  return state.queuedMessageDispatchingId;
}

function failedQueuedMessageIds() {
  return new Set(state.failedQueuedMessageIds);
}

function canEditQueuedMessage() {
  return (
    inputText().length === 0 &&
    state.droppedFiles.length === 0 &&
    state.clipboardImages.length === 0 &&
    state.nativePdfs.length === 0 &&
    !state.terminalSelection &&
    !state.attachedDiagnostics
  );
}

function isQueuedMessageDrag(event: DragEvent) {
  return Array.from(event.dataTransfer?.types ?? []).includes(QUEUED_MESSAGE_DRAG_TYPE);
}

function activeContextEnabled(sessionId?: string | null) {
  return getCurrentDocumentEnabled(sessionId);
}

function openContextFileInEditor(file: DroppedFile) {
  postMessage({
    type: 'vscode/open',
    payload: { path: file.path, kind: file.type, line: file.lineRanges?.[0]?.startLine },
  });
}

function captureEditDraftBackup(): MessageEditContext & { text: string } {
  return {
    text: inputText(),
    files: state.droppedFiles.map((file) => ({ ...file })),
    images: state.clipboardImages.map((image) => ({ ...image })),
    pdfs: state.nativePdfs.map((pdf) => ({ ...pdf })),
    terminalSelection: state.terminalSelection ? { ...state.terminalSelection } : null,
  };
}

function applyEditContext(context: MessageEditContext, mergeWholeFileIntoActiveContext = false) {
  const activeFile = state.editorContext.activeFile;
  replaceContextFiles(
    context.files.flatMap((file) => {
      const matchesActiveFile =
        activeFile &&
        file.type === 'file' &&
        (isSamePath(file.path, activeFile.path) ||
          isSamePath(file.path, activeFile.relativePath) ||
          isSamePath(file.relativePath, activeFile.relativePath) ||
          [file.path, file.relativePath].some((path) => {
            const normalizedPath = path.replace(/^\.\//, '');
            return (
              !normalizedPath.includes('/') &&
              !normalizedPath.includes('\\') &&
              isSamePath(normalizedPath, getLeafPathName(activeFile.relativePath))
            );
          }));
      if (!matchesActiveFile) return [file];
      if (mergeWholeFileIntoActiveContext && !file.lineRanges?.length) return [];
      return [{ ...file, path: activeFile.path, relativePath: activeFile.relativePath }];
    })
  );
  const droppedImages = replaceClipboardImages(context.images);
  replaceNativePdfs(context.pdfs ?? []);
  setState(
    'terminalSelection',
    context.terminalSelection ? { ...context.terminalSelection } : null
  );
  return droppedImages;
}

function getSessionTreeIdsForSession(sessionId: string | null | undefined) {
  if (!sessionId) return [];
  const rootId = getSessionTreeRootId(sessionId) || sessionId;
  const treeIds = getSessionTreeIds(rootId);
  return treeIds.length > 0 ? treeIds : [sessionId];
}

function clearUsageLimitsForSessionTree(sessionId: string | null | undefined) {
  for (const id of getSessionTreeIdsForSession(sessionId)) {
    setSessionUsageLimit(id, null);
  }
}

function isAbortSlashCommand(text: string) {
  const command = getLeadingSlashCommand(text);
  return !!command && !command.args && (command.name === 'abort' || command.name === 'stop');
}

function requestAbortSession() {
  void abortSession().catch(() => {});
}

type StagedPastedImage = { url: string; mime: string; size: number };
type PastedImageRejection = 'duplicate' | 'limit' | 'oversized' | 'unreadable';

type PasteTransaction = {
  event: ClipboardEvent;
  sessionId: string | null;
  mutationVersion: number;
  value: string;
  pastedText: string;
  contextFiles: DroppedFile[];
  insertion: RichComposerPasteInsertion | null | undefined;
  start: number;
  end: number;
  historyEntry: number | null;
  images: Array<StagedPastedImage | null> | undefined;
  imageRejections: Set<PastedImageRejection>;
  mentions: Awaited<ReturnType<typeof resolvePastedMentionContextFiles>> | undefined;
};

function notifyPastedImageRejections(rejections: Set<PastedImageRejection>) {
  if (rejections.size === 0) return;

  let message: string;
  if (rejections.size > 1) {
    const reasons: string[] = [];
    if (rejections.has('duplicate')) reasons.push('already attached');
    if (rejections.has('limit')) reasons.push(`${MAX_CLIPBOARD_IMAGES}-image limit reached`);
    if (rejections.has('oversized')) {
      reasons.push(`larger than ${MAX_CLIPBOARD_IMAGE_SIZE / (1024 * 1024)} MB`);
    }
    if (rejections.has('unreadable')) reasons.push('could not be read');
    message = `Some images were not pasted: ${reasons.join(', ')}`;
  } else if (rejections.has('duplicate')) {
    message = 'This image is already attached';
  } else if (rejections.has('limit')) {
    message = `You can attach up to ${MAX_CLIPBOARD_IMAGES} images`;
  } else if (rejections.has('oversized')) {
    message = `Images must be ${MAX_CLIPBOARD_IMAGE_SIZE / (1024 * 1024)} MB or smaller`;
  } else {
    message = 'Could not read the pasted image';
  }

  showSessionActionFeedback(message, 'warning');
}

function mergeTransactionFiles(files: DroppedFile[], committedFiles: DroppedFile[]) {
  const next = files.map((file) => ({ ...file }));
  for (const file of committedFiles) {
    const index = next.findIndex((item) => isSamePath(item.path, file.path));
    if (index === -1) next.push({ ...file });
    else next[index] = { ...file };
  }
  return next;
}

function mergeTransactionImages(
  images: ComposerSnapshot['images'],
  committedImages: ComposerSnapshot['images']
) {
  const next = images.map((image) => ({ ...image }));
  for (const image of committedImages) {
    const index = next.findIndex((item) => item.id === image.id);
    if (index === -1) next.push({ ...image });
    else next[index] = { ...image };
  }
  return next;
}

function applyPasteTransactionText(
  snapshot: ComposerSnapshot,
  transaction: PasteTransaction,
  withdrawPastedMention: boolean,
  imageFilenames: string[]
) {
  const insertion = transaction.insertion;
  if (insertion === undefined) return snapshot;
  const start = Math.min(transaction.start, snapshot.text.length);
  const end = Math.min(transaction.end, snapshot.text.length);
  const insertedText = snapshot.text.slice(start, end);
  if (insertion && insertedText !== insertion.text) return snapshot;

  const sourceText = insertion && !withdrawPastedMention ? insertedText : '';
  const before = snapshot.text.slice(0, start);
  const after = snapshot.text.slice(end);
  const textWithoutMarker = `${before}${sourceText}${after}`;
  const marker = imageFilenames.map((filename) => `[${filename}]`).join(' ');
  const markerOffset = before.length + sourceText.length;
  const shouldInsertMarker =
    marker.length > 0 && (insertion !== null || textWithoutMarker.trim().length > 0);
  const prefix =
    shouldInsertMarker && shouldPadInlineInsertion(textWithoutMarker[markerOffset - 1]) ? ' ' : '';
  const suffix = shouldInsertMarker
    ? getInlineInsertionSuffix(textWithoutMarker, markerOffset)
    : '';
  const replacement = `${sourceText}${prefix}${shouldInsertMarker ? marker : ''}${suffix}`;
  const nextText = `${before}${replacement}${after}`;
  const delta = replacement.length - (end - start);
  const nextCaret =
    snapshot.caret > end
      ? snapshot.caret + delta
      : snapshot.caret >= start
        ? start + replacement.length
        : snapshot.caret;
  return { ...snapshot, text: nextText, caret: nextCaret };
}

export async function sendDroppedContent(droppedFiles: File[]) {
  if (droppedFiles.length === 0) return;

  const acceptedFiles: File[] = [];
  let totalSize = 0;
  for (const file of droppedFiles.slice(0, MAX_DROPPED_CONTENT_FILES)) {
    if (
      !Number.isSafeInteger(file.size) ||
      file.size < 0 ||
      file.size > MAX_DROPPED_CONTENT_FILE_BYTES ||
      totalSize + file.size > MAX_DROPPED_CONTENT_TOTAL_BYTES
    ) {
      continue;
    }
    totalSize += file.size;
    acceptedFiles.push(file);
  }

  for (const file of acceptedFiles) {
    try {
      const base64 = await readFileAsBase64(file);
      postMessage({
        type: 'files/drop-content',
        payload: { files: [{ name: file.name, content: base64, size: file.size }] },
      });
    } catch (err) {
      postMessage({
        type: 'log',
        payload: {
          msg: 'sendDroppedContent:readFailed',
          error: err instanceof Error ? err.message : String(err),
          level: 'warn',
        },
      });
    }
  }
}

function isPdfFile(file: File) {
  return file.type === NATIVE_PDF_MIME || file.name.toLowerCase().endsWith('.pdf');
}

async function readPdfFile(file: File) {
  const bytes = new Uint8Array(await file.arrayBuffer());
  if (!isPdfBytes(bytes)) throw new Error('Invalid PDF header');
  const dataUrl = await readFileAsDataUrl(file);
  const encoded = dataUrl.slice(dataUrl.indexOf(',') + 1);
  if (!encoded) throw new Error('Failed to encode PDF');
  return {
    url: `data:${NATIVE_PDF_MIME};base64,${encoded}`,
    size: bytes.byteLength,
  };
}

function attachCurrentDiagnostics() {
  if (state.editorContext.diagnostics.length === 0) {
    showSessionActionFeedback('No issues found');
    return;
  }
  setState('attachedDiagnostics', {
    diagnostics: state.editorContext.diagnostics.map((diagnostic) => ({ ...diagnostic })),
    total: state.editorContext.diagnosticsTotal ?? state.editorContext.diagnostics.length,
  });
}

export function ChatInput(props: { newSession?: boolean; onBeforeSend?: () => void } = {}) {
  let richEditorRef: HTMLDivElement | undefined;
  let containerRef: HTMLDivElement | undefined;
  let inputFrameRef: HTMLDivElement | undefined;
  let permissionPickerRef: HTMLButtonElement | undefined;
  let permissionPopoverRef: HTMLDivElement | undefined;
  let agentPickerRef: HTMLButtonElement | undefined;
  let agentPopoverRef: HTMLDivElement | undefined;
  let workspacePickerRef: HTMLButtonElement | undefined;
  let workspacePopoverRef: HTMLDivElement | undefined;
  let modelPickerRef: HTMLButtonElement | undefined;
  let modelPopoverRef: HTMLDivElement | undefined;
  let mcpPickerRef: HTMLButtonElement | undefined;
  let mcpPopoverRef: HTMLDivElement | undefined;
  let toolbarRef: HTMLDivElement | undefined;
  let toolbarLeftRef: HTMLDivElement | undefined;
  let toolbarRightRef: HTMLDivElement | undefined;
  let variantPickerRef: HTMLButtonElement | undefined;
  let variantPopoverRef: HTMLDivElement | undefined;
  let contextButtonRef: HTMLButtonElement | undefined;
  let contextPopupRef: HTMLDivElement | undefined;
  let providerLimitButtonRef: HTMLButtonElement | undefined;
  let providerLimitPopupRef: HTMLDivElement | undefined;
  let busyMenuRef: HTMLDivElement | undefined;
  let busyToggleRef: HTMLButtonElement | undefined;
  const [isDraggingOver, setIsDraggingOver] = createSignal(false);
  const [showAgentPicker, setShowAgentPicker] = createSignal(false);
  const [showWorkspacePicker, setShowWorkspacePicker] = createSignal(false);
  const [pendingWorkspacePath, setPendingWorkspacePath] = createSignal<string | null>(null);
  const [agentFocusIndex, setAgentFocusIndex] = createSignal(0);
  const [showBusyMenu, setShowBusyMenu] = createSignal(false);
  const [showVariantPicker, setShowVariantPicker] = createSignal(false);
  const [showPermissionModePicker, setShowPermissionModePicker] = createSignal(false);
  const [showContextPopup, setShowContextPopup] = createSignal(false);
  const [completeTokenBreakdown, setCompleteTokenBreakdown] = createSignal<{
    rootId: string;
    breakdown: SessionTokenBreakdown;
    nestedBreakdown: ReturnType<typeof estimateNestedContextBreakdown>;
  } | null>(null);
  const [showProviderLimitPopup, setShowProviderLimitPopup] = createSignal(false);
  const [showMcpPicker, setShowMcpPicker] = createSignal(false);
  const [editSelectedModel, setEditSelectedModel] = createSignal<RalphSelectedModel | null>(null);
  const composerSessionId = () => (props.newSession ? null : state.activeSessionId);
  const composerEditingMessage = () => (props.newSession ? null : editingMessage());
  const composerHasActiveQuestion = () => !props.newSession && hasActiveQuestion();
  const composerHasActivePermission = () => !props.newSession && hasActivePermission();

  async function attachNativePdfFiles(files: File[]) {
    let remaining =
      MAX_NATIVE_PDF_TOTAL_BYTES - state.nativePdfs.reduce((total, pdf) => total + pdf.size, 0);
    let rejected = false;
    for (const file of files) {
      if (!Number.isSafeInteger(file.size) || file.size <= 0 || file.size > remaining) {
        rejected = true;
        continue;
      }
      try {
        const content = await readPdfFile(file);
        const id = createAttachmentID();
        const path = (file as File & { path?: string }).path;
        const added = addNativePdf({
          id,
          url: content.url,
          mime: NATIVE_PDF_MIME,
          filename: file.name || 'document.pdf',
          size: content.size,
          ...(path
            ? { contextFile: { path, relativePath: file.name || path, type: 'file' as const } }
            : {}),
        });
        if (added) {
          remaining -= content.size;
          if (!path) {
            postMessage({
              type: 'pdfs/store',
              payload: {
                id,
                name: file.name || 'document.pdf',
                content: content.url.slice(content.url.indexOf(',') + 1),
                size: content.size,
              },
            });
          }
        } else rejected = true;
      } catch (err) {
        logError('chat-input:readPdf', err);
        rejected = true;
      }
    }
    if (rejected) {
      showSessionActionFeedback('PDFs must be valid and total 20 MiB or less', 'warning');
    }
  }

  createEffect(() => {
    const queuedEdit = queuedMessageEdit();
    if (!queuedEdit) return;
    if (composerSessionId() !== queuedEdit.sessionId) cancelQueuedMessageEdit();
    else if (composerEditingMessage()) setQueuedMessageEdit(null);
  });

  type PopupKind =
    | 'workspace'
    | 'agent'
    | 'variant'
    | 'model'
    | 'permission'
    | 'context'
    | 'providerLimit'
    | 'busy'
    | 'mcp';
  const closePopups = (except?: PopupKind) => {
    if (except !== 'workspace') setShowWorkspacePicker(false);
    if (except !== 'agent') setShowAgentPicker(false);
    if (except !== 'variant') setShowVariantPicker(false);
    if (except !== 'model') setShowModelPicker(false);
    if (except !== 'mcp') setShowMcpPicker(false);
    if (except !== 'permission') setShowPermissionModePicker(false);
    if (except !== 'context') setShowContextPopup(false);
    if (except !== 'providerLimit') setShowProviderLimitPopup(false);
    if (except !== 'busy') setShowBusyMenu(false);
  };
  const anyComposerPopupOpen = () =>
    showWorkspacePicker() ||
    showAgentPicker() ||
    showVariantPicker() ||
    showModelPicker() ||
    showMcpPicker() ||
    showPermissionModePicker() ||
    showContextPopup() ||
    showProviderLimitPopup() ||
    showBusyMenu();

  createEffect(() => {
    const pending = pendingWorkspacePath();
    if (pending && state.editorContext.workspacePath === pending) setPendingWorkspacePath(null);
  });

  const [isFocused, setIsFocused] = createSignal(false);
  const [historyIndex, setHistoryIndex] = createSignal<number | null>(null);
  const [historyDraft, setHistoryDraft] = createSignal('');
  const [loadingOlderMessageHistory, setLoadingOlderMessageHistory] = createSignal(false);
  const [caretPosition, setCaretPosition] = createSignal(0);
  // Guards async paste follow-ups against landing in a torn-down composer.
  let composerDisposed = false;
  const pendingPasteTransactions: PasteTransaction[] = [];
  const pasteTransactionsByEvent = new Map<ClipboardEvent, PasteTransaction>();
  const pendingImageStores = new Set<string>();
  onCleanup(() => {
    composerDisposed = true;
    pendingPasteTransactions.length = 0;
    pasteTransactionsByEvent.clear();
    pendingImageStores.clear();
  });
  const [completionIndex, setCompletionIndex] = createSignal(0);
  const [fileSearchResults, setFileSearchResults] = createSignal<DroppedFile[]>([]);
  const [sessionSearchResults, setSessionSearchResults] = createSignal<Session[]>([]);
  const [sessionReferences, setSessionReferences] = createSignal<Record<string, Session>>({});
  const [showFileSearchHint, setShowFileSearchHint] = createSignal(false);
  const [suppressCompletion, setSuppressCompletion] = createSignal(false);
  const [toolbarCompactMode, setToolbarCompactMode] = createSignal<ToolbarCompactMode>('full');
  const [sendComposerMinHeight, setSendComposerMinHeight] = createSignal(0);
  let latestFileSearchRequestId = 0;
  let latestFileSearchQuery = '';
  let fileSearchTimer: ReturnType<typeof setTimeout> | null = null;
  let sessionSearchTimer: ReturnType<typeof setTimeout> | null = null;
  let sessionSearchAbortController: AbortController | undefined;
  const pendingSessionReferenceIds = new Set<string>();
  const toolbarFitter = createToolbarFitter({
    getToolbar: () => toolbarRef,
    getLeftGroup: () => toolbarLeftRef,
    getRightGroup: () => toolbarRightRef,
    setMode: setToolbarCompactMode,
  });
  let heldComposerSessionId: string | null = null;
  let heldComposerMessageCount = 0;

  function holdComposerHeightUntilMessageAppend(sessionId: string | null) {
    if (!sessionId || !inputFrameRef) return;
    heldComposerSessionId = sessionId;
    heldComposerMessageCount = state.messages.length;
    setSendComposerMinHeight(inputFrameRef.getBoundingClientRect().height);
  }

  function releaseHeldComposerHeight() {
    heldComposerSessionId = null;
    heldComposerMessageCount = 0;
    setSendComposerMinHeight(0);
  }

  createEffect(() => {
    if (sendComposerMinHeight() <= 0) return;
    const heldSessionId = heldComposerSessionId;
    if (!heldSessionId) return;
    const activeSessionId = state.activeSessionId;
    const messageCount = state.messages.length;
    if (activeSessionId !== heldSessionId || messageCount > heldComposerMessageCount) {
      releaseHeldComposerHeight();
    }
  });

  function captureComposerSnapshot(): ComposerSnapshot {
    return {
      text: inputText(),
      caret: caretPosition(),
      files: state.droppedFiles.map((file) => ({ ...file })),
      images: state.clipboardImages.map((image) => ({ ...image })),
      pdfs: state.nativePdfs.map((pdf) => ({ ...pdf })),
    };
  }

  const composerHistory = createComposerHistory();
  let applyingComposerHistory = false;
  composerHistory.reset(untrack(captureComposerSnapshot));

  function applyComposerHistoryAction(action: ComposerHistoryAction) {
    const snapshot = action === 'undo' ? composerHistory.undo() : composerHistory.redo();
    if (!snapshot) return;

    const removedFilePaths = state.droppedFiles
      .filter((file) => !snapshot.files.some((item) => item.path === file.path))
      .map((file) => file.path);

    applyingComposerHistory = true;
    try {
      batch(() => {
        setHistoryIndex(null);
        setHistoryDraft('');
        setInputText(snapshot.text);
        setCaretPosition(snapshot.caret);
        replaceContextFiles(snapshot.files);
        replaceClipboardImages(snapshot.images);
        replaceNativePdfs(snapshot.pdfs ?? []);
        setCompletionIndex(0);
        setSuppressCompletion(false);
      });
    } finally {
      applyingComposerHistory = false;
    }

    for (const path of removedFilePaths) {
      postMessage({ type: 'files/remove', payload: { path } });
    }
  }

  const explicitContextForActiveFile = () =>
    hasExplicitContextForPath(composerFiles(), composerActiveFile()?.path);
  const hasContext = () =>
    !!composerActiveFile() ||
    !!composerSelection() ||
    !!composerTerminalSelection() ||
    !!state.attachedDiagnostics;

  const currentModel = createMemo(() => {
    const editing = composerEditingMessage();
    const editSelection = editing ? editSelectedModel() || editing.model : null;
    const selected =
      editSelection ||
      resolveSelectedModel(state.selectedModel, state.providers, state.providerDefaults, {
        allowHidden: true,
      });
    if (selected) {
      const provider = state.providers.find((item) => item.id === selected.providerID);
      const model = provider?.models[selected.modelID];
      return {
        providerID: selected.providerID,
        modelID: selected.modelID,
        variant: selected.variant || null,
        providerName: provider?.name || selected.providerID,
        modelName: model
          ? getModelDisplayName(selected.providerID, selected.modelID, model.name)
          : selected.modelID,
        contextLimit: model?.limit?.context || null,
      };
    }

    const latestAuto = getLatestAssistantMessageInfo(state.messages);
    if (latestAuto) {
      const provider = state.providers.find((item) => item.id === latestAuto.providerID);
      const model = provider?.models[latestAuto.modelID];
      return {
        providerID: latestAuto.providerID,
        modelID: latestAuto.modelID,
        variant: latestAuto.variant || null,
        providerName: provider?.name || latestAuto.providerID,
        modelName: model
          ? getModelDisplayName(latestAuto.providerID, latestAuto.modelID, model.name)
          : latestAuto.modelID,
        contextLimit: model?.limit?.context || null,
      };
    }

    for (const provider of state.providers) {
      const defaultModelID = state.providerDefaults[provider.id];
      if (defaultModelID && provider.models[defaultModelID]) {
        const model = provider.models[defaultModelID];
        return {
          providerID: provider.id,
          modelID: model.id,
          variant: null,
          providerName: provider.name,
          modelName: getModelDisplayName(provider.id, model.id, model.name),
          contextLimit: model.limit?.context || null,
        };
      }
    }

    const firstProvider = state.providers[0];
    if (firstProvider) {
      const firstModel = Object.values(firstProvider.models)[0];
      if (firstModel) {
        return {
          providerID: firstProvider.id,
          modelID: firstModel.id,
          variant: null,
          providerName: firstProvider.name,
          modelName: getModelDisplayName(firstProvider.id, firstModel.id, firstModel.name),
          contextLimit: firstModel.limit?.context || null,
        };
      }
    }

    return {
      providerID: null as string | null,
      modelID: null as string | null,
      variant: null as string | null,
      providerName: '',
      modelName: '',
      contextLimit: null as number | null,
    };
  });

  const hasMentions = () =>
    visibleFiles().length > 0 ||
    visibleClipboardImages().length > 0 ||
    visibleNativePdfs().length > 0;

  function rememberSessionReference(session: Session) {
    setSessionReferences((current) =>
      current[session.id] === session ? current : { ...current, [session.id]: session }
    );
  }

  createEffect(() => {
    const ids = getSessionReferenceIds(inputText());
    const references = sessionReferences();
    const workspacePath = state.editorContext.workspacePath;
    for (const id of ids) {
      if (references[id]) continue;
      const loaded = state.sessions.find((session) => session.id === id);
      if (loaded) {
        rememberSessionReference(loaded);
        continue;
      }
      if (pendingSessionReferenceIds.has(id)) continue;
      pendingSessionReferenceIds.add(id);
      void client.session
        .get(id)
        .then((session) => {
          if (session.parentID || session.time.archived) return;
          if (workspacePath && !isSamePath(session.directory, workspacePath)) return;
          if (!getSessionReferenceIds(inputText()).includes(id)) return;
          rememberSessionReference(session);
        })
        .catch(() => {})
        .finally(() => pendingSessionReferenceIds.delete(id));
    }
  });

  const inlineChips = createMemo((): RichComposerChip[] => {
    const chips: RichComposerChip[] = [];
    const text = inputText();

    for (const file of composerFiles()) {
      const label = getLeafPathName(file.relativePath || file.path);
      const marker = `@${file.relativePath || file.path}`;
      if (text.includes(marker)) {
        const lineRange = formatContextLineRanges(file.lineRanges);
        const title = lineRange
          ? `${file.relativePath || file.path} ${lineRange}`
          : file.relativePath || file.path;
        chips.push({
          id: `file:${file.path}`,
          type: 'mention-file',
          label,
          path: file.relativePath || file.path,
          title,
          detail: lineRange || undefined,
          icon: file.type === 'directory' ? 'folder' : 'file',
          textMarker: marker,
        });
      }
    }

    for (const image of composerClipboardImages()) {
      const marker = `[${image.filename}]`;
      if (text.includes(marker)) {
        chips.push({
          id: `img:${image.id}`,
          type: 'image',
          label: image.filename,
          path: image.filename,
          icon: 'image',
          previewImage: { url: image.url, alt: image.filename },
          textMarker: marker,
        });
      }
    }

    for (const agent of state.allAgents) {
      const marker = `@${agent.name}`;
      if (text.includes(marker)) {
        chips.push({
          id: `agent:${agent.name}`,
          type: 'mention-agent',
          label: agent.name,
          icon: 'agent',
          textMarker: marker,
        });
      }
    }

    for (const session of Object.values(sessionReferences())) {
      const marker = `session:${session.id}`;
      if (text.includes(marker)) {
        const title = normalizeSessionTitle(session.title) || 'Untitled';
        chips.push({
          id: `session:${session.id}`,
          type: 'mention-session',
          label: title,
          title,
          icon: 'session',
          textMarker: marker,
        });
      }
    }

    const externalLinks = new Set(
      splitExternalLinkText(text)
        .filter((segment) => segment.type === 'external-link')
        .map((segment) => segment.href)
    );
    for (const href of externalLinks) {
      chips.push({
        id: `external-link:${href}`,
        type: 'external-link',
        label: href,
        title: href,
        icon: 'external-link',
        textMarker: href,
      });
    }

    return chips;
  });

  const inlineChipIds = createMemo(() => new Set(inlineChips().map((c) => c.id)));

  const visibleFiles = createMemo(() =>
    composerFiles()
      .filter((f) => !inlineChipIds().has(`file:${f.path}`))
      .map((file) => ({
        ...file,
        attachmentSequence: file.attachmentSequence ?? getContextFileAttachmentSequence(file.path),
      }))
  );
  const visibleClipboardImages = createMemo(() =>
    composerClipboardImages()
      .filter((img) => !inlineChipIds().has(`img:${img.id}`))
      .map((image) => ({
        ...image,
        attachmentSequence:
          image.attachmentSequence ?? getClipboardImageAttachmentSequence(image.id),
      }))
  );
  const visibleNativePdfs = createMemo(() =>
    composerNativePdfs().map((pdf) => ({
      ...pdf,
      attachmentSequence: pdf.attachmentSequence ?? getNativePdfAttachmentSequence(pdf.id),
    }))
  );

  const [previewImageId, setPreviewImageId] = createSignal<string | null>(null);
  const previewImageIndex = createMemo(() => {
    const id = previewImageId();
    if (!id) return -1;
    return composerClipboardImages().findIndex((image) => image.id === id);
  });
  const previewImage = (): PreviewImage | null => {
    const image = composerClipboardImages()[previewImageIndex()];
    if (!image) return null;
    return { url: image.url, alt: image.filename, title: image.filename, mime: image.mime };
  };
  const stepImagePreview = (delta: number) => {
    const images = composerClipboardImages();
    const index = previewImageIndex();
    if (images.length <= 1 || index < 0) return;
    setPreviewImageId(images[(index + delta + images.length) % images.length]!.id);
  };
  createImagePreviewEffect(
    () => previewImage() !== null,
    () => setPreviewImageId(null),
    {
      canNavigate: () => composerClipboardImages().length > 1,
      onPrevious: () => stepImagePreview(-1),
      onNext: () => stepImagePreview(1),
    }
  );

  const activeContext = createMemo(() => {
    const file = composerActiveFile();
    const selectedLines = getSelectionRangesFromEditorContext(composerSelection());
    if (!file) return null;
    if (explicitContextForActiveFile() && selectedLines.length === 0) return null;
    const displayPath = getLeafPathName(file.relativePath || file.path);
    const lineRange = formatContextLineRanges(selectedLines);
    return {
      filename: displayPath,
      lineRange,
    };
  });
  const activeContextTitle = createMemo(() => {
    const context = activeContext();
    if (!context) return null;
    const label = context.lineRange ? `${context.filename} ${context.lineRange}` : context.filename;
    return `${label}${
      activeContextEnabled(composerSessionId())
        ? ' · Click to disable current document context'
        : ' · Current document context is disabled. Click to enable it again'
    }`;
  });

  const mentionAgents = createMemo(() =>
    state.allAgents
      .filter((agent) => agent.mode === 'subagent' || agent.mode === 'all')
      .toSorted((a, b) => a.name.localeCompare(b.name))
  );

  const mentionCompletionSource = createMemo(() =>
    createMentionCompletionSource({
      agents: mentionAgents(),
      files: fileSearchResults(),
    })
  );

  const skillCommands = createMemo(() =>
    state.commands.filter((command) => command.source === 'skill')
  );
  const isComposerBusy = createMemo(() => !props.newSession && isActiveSessionWorking());
  const [composerBusyDisplayHold, setComposerBusyDisplayHold] = createSignal(
    !props.newSession && isActiveSessionWorking()
  );
  let composerBusyDisplayTimer: ReturnType<typeof setTimeout> | 0 = 0;
  const clearComposerBusyDisplayTimer = () => {
    if (!composerBusyDisplayTimer) return;
    clearTimeout(composerBusyDisplayTimer);
    composerBusyDisplayTimer = 0;
  };

  createEffect(() => {
    const busy = isComposerBusy();
    clearComposerBusyDisplayTimer();
    if (busy) {
      setComposerBusyDisplayHold(true);
      return;
    }
    if (!composerBusyDisplayHold()) return;
    composerBusyDisplayTimer = setTimeout(() => {
      composerBusyDisplayTimer = 0;
      if (!isComposerBusy()) setComposerBusyDisplayHold(false);
    }, COMPOSER_BUSY_DISPLAY_SETTLE_DELAY_MS);
  });
  onCleanup(clearComposerBusyDisplayTimer);
  const isComposerDisplayBusy = createMemo(() => isComposerBusy() || composerBusyDisplayHold());

  const slashCommands = createMemo(() =>
    getSlashCommands({
      isBusy: isComposerBusy(),
      canUndo: !!composerSessionId() && state.messages.some((m) => m.info.role === 'assistant'),
      canRedo:
        !!composerSessionId() &&
        !!state.sessions.find((session) => session.id === composerSessionId())?.revert,
      canInit: !composerSessionId() || state.messages.length === 0,
      onConnectProvider: openProviderSetup,
      onOpenSessions: () => setShowSessionPicker(true),
      onOpenModels: () => setShowModelPicker(true),
      onOpenMcps: () => setShowMcpPicker(true),
      onOpenFiles: () => postMessage({ type: 'files/pick' }),
      onAttachDiagnostics: attachCurrentDiagnostics,
      onOpenSettings: () =>
        postMessage({ type: 'vscode/open-settings', payload: { query: 'Varro' } }),
      onExportSession: () => {
        const sessionId = composerSessionId();
        if (!sessionId) return;
        postMessage({ type: 'session/export', payload: { sessionId } });
      },
      onGenerateStats: (includeAllTime) => {
        postMessage({ type: 'usage/report', payload: { includeAllTime } });
      },
      customCommands: state.commands,
    })
  );

  const activeCompletion = createMemo(() => {
    const fallbackCursor = caretPosition();
    return getActiveCompletion(inputText(), fallbackCursor);
  });

  createEffect(() => {
    const completion = activeCompletion();
    if (completion?.type !== 'mention') {
      if (fileSearchTimer) {
        clearTimeout(fileSearchTimer);
        fileSearchTimer = null;
      }
      latestFileSearchQuery = '';
      setFileSearchResults([]);
      setShowFileSearchHint(false);
      return;
    }

    const rawQuery = completion.query.trim();

    setShowFileSearchHint(rawQuery.length === 0);

    if (!rawQuery) {
      if (fileSearchTimer) {
        clearTimeout(fileSearchTimer);
        fileSearchTimer = null;
      }
      latestFileSearchQuery = '';
      setFileSearchResults([]);
      return;
    }

    if (!shouldRequestMentionFileSearch(latestFileSearchQuery, rawQuery)) return;

    latestFileSearchRequestId += 1;
    const requestId = latestFileSearchRequestId;
    latestFileSearchQuery = rawQuery;
    if (fileSearchTimer) clearTimeout(fileSearchTimer);
    fileSearchTimer = setTimeout(() => {
      fileSearchTimer = null;
      postMessage({
        type: 'files/search',
        payload: { requestId, query: rawQuery, limit: 12 },
      });
    }, 120);
  });

  createEffect(() => {
    const completion = activeCompletion();
    sessionSearchAbortController?.abort();
    sessionSearchAbortController = undefined;
    if (sessionSearchTimer) {
      clearTimeout(sessionSearchTimer);
      sessionSearchTimer = null;
    }
    if (completion?.type !== 'session') {
      setSessionSearchResults([]);
      return;
    }

    const query = normalizeSessionLookupQuery(completion.query);
    const exactSessionId =
      /^sessions?:/i.test(completion.query.trim()) || /^ses_[a-z0-9]+$/i.test(query) ? query : null;
    const currentSessionId = composerSessionId();
    const workspacePath = state.editorContext.workspacePath;
    const localResults = state.sessions.filter((session) => {
      if (session.id === currentSessionId || session.parentID) return false;
      if (!query) return true;
      return (
        session.id.toLowerCase().includes(query) || session.title.toLowerCase().includes(query)
      );
    });
    setSessionSearchResults(localResults.slice(0, 30));

    sessionSearchTimer = setTimeout(
      () => {
        sessionSearchTimer = null;
        const controller = new AbortController();
        sessionSearchAbortController = controller;
        const listRequest = client.session
          .list({
            limit: 30,
            ...(query ? { search: query } : {}),
            roots: true,
            signal: controller.signal,
          })
          .catch(() => null);
        const exactRequest = exactSessionId
          ? client.session.get(exactSessionId).catch(() => null)
          : Promise.resolve(null);
        void Promise.all([listRequest, exactRequest]).then(([page, exactSession]) => {
          if (controller.signal.aborted) return;
          const sessions = page ? [...(Array.isArray(page) ? page : page.items)] : [];
          if (
            exactSession &&
            !exactSession.parentID &&
            !exactSession.time.archived &&
            (!workspacePath || isSamePath(exactSession.directory, workspacePath))
          ) {
            sessions.unshift(exactSession);
          }
          const seen = new Set<string>();
          const results = sessions.filter((session) => {
            if (session.id === currentSessionId || seen.has(session.id)) return false;
            seen.add(session.id);
            return true;
          });
          if (results.length > 0 || page) setSessionSearchResults(results.slice(0, 30));
        });
      },
      query ? 120 : 0
    );
  });

  onCleanup(() => {
    if (sessionSearchTimer) clearTimeout(sessionSearchTimer);
    sessionSearchAbortController?.abort();
  });

  const mentionCompletions = createMemo(() => {
    const completion = activeCompletion();
    if (completion?.type !== 'mention') return [];

    return getMentionCompletionItems({
      rawQuery: completion.query.trim(),
      source: mentionCompletionSource(),
      meta: { showFileSearchHint: showFileSearchHint() },
    });
  });

  const sessionCompletions = createMemo(() => {
    if (activeCompletion()?.type !== 'session') return [];
    return getSessionCompletionItems(sessionSearchResults());
  });

  const slashCompletions = createMemo(() => {
    const completion = activeCompletion();
    if (completion?.type !== 'slash') return [];

    const query = completion.query.toLowerCase();
    if (query.startsWith(`${SKILLS_COMMAND_NAME} `)) {
      const skillQuery = query.slice(SKILLS_COMMAND_NAME.length + 1).trim();
      return skillCommands()
        .filter((command) => {
          if (!skillQuery) return true;
          return (
            command.name.toLowerCase().includes(skillQuery) ||
            (command.description || command.template).toLowerCase().includes(skillQuery) ||
            (command.hints || []).some((hint) => hint.toLowerCase().includes(skillQuery))
          );
        })
        .map((command) => ({
          name: command.name,
          aliases: [],
          description: command.description || command.template,
          acceptsArguments: true,
          action: () => {},
          key: `skill:${command.name}`,
          type: 'slash' as const,
        }));
    }

    return slashCommands()
      .filter((command) => command.source !== 'skill')
      .filter((command) => {
        if (!query) return true;
        return (
          command.name.includes(query) ||
          command.aliases.some((alias) => alias.includes(query)) ||
          command.description.toLowerCase().includes(query)
        );
      })
      .map((command) => ({
        ...command,
        key: `slash:${command.name}`,
        type: 'slash' as const,
      }));
  });

  const composerCompletions = createMemo(() => {
    const completion = activeCompletion();
    if (!completion) return [];
    if (completion.type === 'slash') return slashCompletions();
    return completion.type === 'session' ? sessionCompletions() : mentionCompletions();
  });

  const completionHeader = createMemo(() => {
    const completion = activeCompletion();
    if (completion?.type === 'session') return undefined;
    if (showFileSearchHint()) return 'Type to search workspace files';
    if (
      completion?.type === 'slash' &&
      completion.query.toLowerCase().startsWith(`${SKILLS_COMMAND_NAME} `)
    ) {
      return 'Skills';
    }
    return undefined;
  });

  const showCompletionMenu = () => {
    if (suppressCompletion()) return false;
    const completion = activeCompletion();
    if (!completion) return false;
    return (
      composerCompletions().length > 0 ||
      (completion.type === 'mention' && showFileSearchHint()) ||
      completion.type === 'session'
    );
  };

  const showMentionCompletionMenu = createMemo(
    () =>
      isFocused() &&
      (activeCompletion()?.type === 'mention' || activeCompletion()?.type === 'session') &&
      showCompletionMenu()
  );

  const showFloatingInputPopover = createMemo(
    () =>
      showModelPicker() ||
      showMcpPicker() ||
      showAgentPicker() ||
      showVariantPicker() ||
      showPermissionModePicker() ||
      showBusyMenu() ||
      showContextPopup() ||
      showProviderLimitPopup() ||
      (isFocused() && showCompletionMenu())
  );

  createEffect(() => {
    const length = composerCompletions().length;
    if (length === 0) {
      setCompletionIndex(0);
      return;
    }
    setCompletionIndex((current) => Math.max(0, Math.min(current, length - 1)));
  });

  function handleKeydown(e: KeyboardEvent) {
    const historyAction = getComposerHistoryAction(e);
    if (historyAction) {
      // Always swallow the shortcut so native contenteditable undo never
      // fires against the programmatically managed editor DOM.
      e.preventDefault();
      if (!e.isComposing) applyComposerHistoryAction(historyAction);
      return;
    }

    const showingCompletions =
      isFocused() && composerCompletions().length > 0 && !suppressCompletion();

    if (showAgentPicker() && !e.altKey && !e.ctrlKey && !e.metaKey) {
      const agents = state.agents;
      if (agents.length === 0) {
        if (e.key === 'Escape') {
          e.preventDefault();
          setShowAgentPicker(false);
        }
        return;
      }
      if (e.key === 'ArrowDown') {
        e.preventDefault();
        setAgentFocusIndex((i) => (i + 1) % agents.length);
        return;
      }
      if (e.key === 'ArrowUp') {
        e.preventDefault();
        setAgentFocusIndex((i) => (i <= 0 ? agents.length - 1 : i - 1));
        return;
      }
      if (e.key === 'Enter') {
        e.preventDefault();
        const agent = agents[agentFocusIndex()];
        if (agent) {
          setSelectedAgent(agent.name, { sessionId: composerSessionId() });
          setShowAgentPicker(false);
        }
        return;
      }
      if (e.key === 'Escape') {
        e.preventDefault();
        setShowAgentPicker(false);
        setShowWorkspacePicker(false);
        return;
      }
    }

    if (showingCompletions && !e.altKey && !e.ctrlKey && !e.metaKey && !e.isComposing) {
      if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
        e.preventDefault();
        moveCompletionSelection(e.key === 'ArrowDown' ? 1 : -1);
        return;
      }

      if (e.key === 'Tab') {
        e.preventDefault();
        void applyActiveCompletion();
        return;
      }

      if (e.key === 'Escape') {
        e.preventDefault();
        setCompletionIndex(0);
        if (activeCompletion()?.type === 'slash') {
          setInputText('');
        } else {
          setSuppressCompletion(true);
        }
        return;
      }
    }

    if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) {
      if (showingCompletions) {
        e.preventDefault();
        const items = composerCompletions();
        const item = items[Math.min(completionIndex(), items.length - 1)];
        void applyActiveCompletion(item?.type === 'slash' && !item.acceptsArguments);
        setSuppressCompletion(true);
        return;
      }
    }

    if (!e.altKey && !e.ctrlKey && !e.metaKey && !e.shiftKey && !e.isComposing) {
      if (e.key === 'ArrowUp' || e.key === 'ArrowDown') {
        if (navigateMessageHistory(e.key === 'ArrowUp' ? -1 : 1)) {
          e.preventDefault();
          return;
        }
      }

      if (e.key === 'Escape') {
        if (anyComposerPopupOpen()) {
          e.preventDefault();
          closePopups();
          return;
        }
        if (composerEditingMessage()) {
          e.preventDefault();
          cancelMessageEdit();
          return;
        }
      }
    }

    if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) {
      e.preventDefault();
      if (!canSend()) return;
      if (
        (e.ctrlKey || e.metaKey) &&
        isComposerBusy() &&
        !hasPendingApproval() &&
        !composerEditingMessage()
      ) {
        handleSend('steer');
      } else {
        handleSend();
      }
    }
  }

  function handlePopupEscape(e: KeyboardEvent) {
    if (
      e.defaultPrevented ||
      e.key !== 'Escape' ||
      e.altKey ||
      e.ctrlKey ||
      e.metaKey ||
      e.shiftKey ||
      e.isComposing ||
      !anyComposerPopupOpen()
    ) {
      return;
    }

    e.preventDefault();
    e.stopPropagation();
    Object.assign(e, { varroHandled: true });
    closePopups();
  }

  function moveCompletionSelection(direction: 1 | -1) {
    const items = composerCompletions();
    if (items.length === 0) return;
    setCompletionIndex((current) => {
      const next = current + direction;
      if (next < 0) return items.length - 1;
      if (next >= items.length) return 0;
      return next;
    });
  }

  async function applyActiveCompletion(confirm = false) {
    const completion = activeCompletion();
    const items = composerCompletions();
    const item = items[Math.min(completionIndex(), items.length - 1)];
    const completionSelection = getCompletionSelection(completion, item, confirm);
    if (!completionSelection) return;

    if (completionSelection.type === 'run-slash') {
      await runSlashCommand(completionSelection.value);
      return;
    }

    if (completionSelection.type === 'set-slash') {
      setComposerValue(completionSelection.value);
      return;
    }

    if (completionSelection.file) addContextFile(completionSelection.file);
    if (completionSelection.session) rememberSessionReference(completionSelection.session);
    if (completion?.type !== 'mention' && completion?.type !== 'session') return;
    applyCompletionValue(completion, completionSelection.value);
  }

  function applyCompletionValue(
    completion: Extract<ReturnType<typeof getActiveCompletion>, { type: 'mention' | 'session' }>,
    value: string
  ) {
    const text = inputText();
    const trailingSpace = getMentionInsertionTrailingSpace(value, text[completion.end]);
    const nextValue = `${text.slice(0, completion.start)}${value}${trailingSpace}${text.slice(completion.end)}`;
    const nextCursor = completion.start + value.length + trailingSpace.length;
    batch(() => {
      setInputText(nextValue);
      setCaretPosition(nextCursor);
      setCompletionIndex(0);
      setFileSearchResults([]);
      setSessionSearchResults([]);
    });
    latestFileSearchQuery = '';

    queueMicrotask(() => {
      if (richEditorRef) {
        richEditorRef.focus();
      }
    });
  }

  async function runSlashCommand(raw: string) {
    const parsed = getLeadingSlashCommand(raw);
    if (!parsed) return false;

    const { name, args } = parsed;
    if (name === SKILLS_COMMAND_NAME) {
      setComposerValue(`/${SKILLS_COMMAND_NAME} `);
      return true;
    }
    if ((name === 'abort' || name === 'stop') && !args) {
      requestAbortSession();
      return true;
    }
    const runBuiltInSlashCommand = () => {
      if ((name === 'undo' || name === 'revert') && !args) {
        return undoSession();
      }
      if (name === 'redo' && !args) {
        return redoSession();
      }
      if (name === 'review' && !args) {
        return reviewSession();
      }
      if ((name === 'compact' || name === 'summarize') && !args) {
        return compactSession();
      }
      if (name === 'fork' && !args) {
        return forkActiveSession();
      }
      if (name === 'init' && !args) {
        return initSession();
      }
      return null;
    };

    const builtInCommand = runBuiltInSlashCommand();
    const fallbackCommand =
      builtInCommand === null
        ? slashCommands().find((item) => item.name === name || item.aliases.includes(name))
        : null;
    setHistoryIndex(null);
    setHistoryDraft('');
    setInputText('');
    resetPastedImageIndex();
    setCompletionIndex(0);
    if (builtInCommand) {
      await builtInCommand;
      return true;
    }
    if (!fallbackCommand) return false;
    await fallbackCommand.action(args);
    return true;
  }

  async function handleSend(mode?: 'queue' | 'steer' | 'after-stop') {
    const text = inputText();
    if (isAbortSlashCommand(text)) {
      requestAbortSession();
      return;
    }
    const sendSessionId = composerSessionId();
    const queuedEdit = queuedMessageEdit();
    const pendingApproval = hasPendingApproval();
    if (
      pendingApproval &&
      (mode === 'steer' || mode === 'after-stop' || composerEditingMessage())
    ) {
      return;
    }
    const shouldQueue = mode === 'queue' || pendingApproval;
    const sendableText = getSendableInputText(text);
    const hasSendableImages = hasSendableClipboardImages();
    if (
      !sendableText.trim() &&
      state.droppedFiles.length === 0 &&
      !hasSendableImages &&
      state.nativePdfs.length === 0 &&
      !state.terminalSelection &&
      !state.attachedDiagnostics
    )
      return;

    collapseExpandedDiffOverlays();

    const queuedAttachments = getQueuedAttachmentSnapshot({
      droppedFiles: state.droppedFiles,
      clipboardImages: state.clipboardImages,
      nativePdfs: state.nativePdfs,
      terminalSelection: state.terminalSelection,
      attachedDiagnostics: state.attachedDiagnostics,
    });

    if (props.newSession) props.onBeforeSend?.();

    const hasQueuedAttachments =
      queuedAttachments.droppedFiles?.length ||
      queuedAttachments.clipboardImages?.length ||
      queuedAttachments.nativePdfs?.length ||
      queuedAttachments.terminalSelection ||
      queuedAttachments.attachedDiagnostics;

    const editing = composerEditingMessage();
    if (editing) {
      const model = currentModel();
      const selectedModel =
        model.providerID && model.modelID
          ? {
              providerID: model.providerID,
              modelID: model.modelID,
              ...(effectiveVariant() ? { variant: effectiveVariant()! } : {}),
            }
          : editing.model || undefined;
      const submittedEdit = captureEditDraftBackup();
      const previousDraft = getMessageEditDraftBackup();
      const hasEditableAttachments =
        state.droppedFiles.length > 0 ||
        hasSendableImages ||
        !!state.terminalSelection ||
        !!state.attachedDiagnostics;
      if (!sendableText.trim() && !hasEditableAttachments) return;
      const editTargetExists = state.messages.some(
        (entry) => entry.info.role === 'user' && entry.info.id === editing.messageId
      );
      setHistoryIndex(null);
      setHistoryDraft('');
      setCompletionIndex(0);
      setInputText('');
      const clearedInputVersion = inputTextMutationVersion();
      resetPastedImageIndex();
      let sent = false;
      let optimisticPublished = false;
      if (editTargetExists) {
        clearUsageLimitsForSessionTree(composerSessionId());
        sent = await editMessage(editing.messageId, text, {
          allowEmptyText: hasEditableAttachments,
          queuedAttachments,
          selectedModel,
          onOptimisticPublish: () => {
            optimisticPublished = true;
            resetMessageEditState();
          },
        });
      } else {
        clearUsageLimitsForSessionTree(composerSessionId());
        sent = await sendMessage(text);
      }
      if (sent) {
        if (selectedModel) {
          setSelectedModel(selectedModel, {
            sessionId: editing.sessionId,
            persistGlobal: true,
            rememberVariant: selectedModel.variant ?? null,
          });
        }
        if (!optimisticPublished) resetMessageEditState();
      } else if (
        composerSessionId() === sendSessionId &&
        inputTextMutationVersion() === clearedInputVersion &&
        inputText() === ''
      ) {
        if (optimisticPublished) {
          startEditingMessage(
            editing.messageId,
            editing.sessionId,
            text,
            submittedEdit,
            selectedModel || null
          );
          if (previousDraft) setMessageEditDraftBackup(previousDraft);
        }
        setInputText(text);
      }
      return;
    }

    if (!shouldQueue && !hasQueuedAttachments) {
      const ranSlashCommand = await runSlashCommand(text);
      if (ranSlashCommand) {
        if (queuedEdit) removeQueuedMessage(queuedEdit.id);
        setQueuedMessageEdit(null);
        return;
      }
    }

    if (
      mode !== 'steer' &&
      mode !== 'after-stop' &&
      (shouldQueue || isComposerBusy() || queuedEdit?.sessionId === composerSessionId()) &&
      composerSessionId() &&
      (sendableText.trim() || hasQueuedAttachments)
    ) {
      requestMessageListScrollToBottom();
      const sessionId = composerSessionId()!;
      const queuedMessagePaused =
        queuedEdit && state.queuedMessages.find((item) => item.id === queuedEdit.id)?.paused;
      const message = {
        id: createAttachmentID(),
        sessionId,
        text: sendableText,
        ...(state.selectedAgent ? { agent: state.selectedAgent } : {}),
        ...(queuedMessagePaused ? { paused: true } : {}),
        droppedFiles: queuedAttachments.droppedFiles,
        clipboardImages: queuedAttachments.clipboardImages,
        nativePdfs: queuedAttachments.nativePdfs,
        terminalSelection: queuedAttachments.terminalSelection,
        attachedDiagnostics: queuedAttachments.attachedDiagnostics,
      };
      const replaced =
        queuedEdit?.sessionId === sessionId && replaceQueuedMessage(queuedEdit.id, message);
      if (!replaced) enqueueMessage(message);
      setQueuedMessageEdit(null);
      setHistoryIndex(null);
      setHistoryDraft('');
      setCompletionIndex(0);
      setInputText('');
      clearContextFiles();
      setState('terminalSelection', null);
      setState('attachedDiagnostics', null);
      clearClipboardImages();
      clearNativePdfs();
      resetPastedImageIndex();
      postMessage({ type: 'files/clear' });
      postMessage({ type: 'terminal-selection/clear' });
      return;
    }

    setHistoryIndex(null);
    setHistoryDraft('');
    setCompletionIndex(0);
    holdComposerHeightUntilMessageAppend(sendSessionId);
    setInputText('');
    const clearedInputVersion = inputTextMutationVersion();
    resetPastedImageIndex();
    clearUsageLimitsForSessionTree(composerSessionId());
    let sent = false;
    try {
      sent = await sendMessage(
        text,
        mode === 'steer'
          ? { delivery: 'steer' }
          : {
              noReply: false,
              ...(props.newSession ? { queuedAttachments } : {}),
            }
      );
    } catch {
      sent = false;
    }
    if (sent) {
      if (queuedEdit) removeQueuedMessage(queuedEdit.id);
      setQueuedMessageEdit(null);
    }
    if (!sent) releaseHeldComposerHeight();
    if (
      !sent &&
      composerSessionId() === sendSessionId &&
      inputTextMutationVersion() === clearedInputVersion &&
      inputText() === ''
    ) {
      setInputText(text);
      setErrorRetry(() => {
        setErrorRetry(null);
        void handleSend();
      });
    }
  }

  async function handleStopAndSend() {
    if (hasPendingApproval()) return;
    try {
      await abortSession();
    } catch {
      return;
    }
    await handleSend('after-stop');
    setShowBusyMenu(false);
  }

  async function dispatchQueuedMessage(item: (typeof state.queuedMessages)[number], retry = false) {
    if (isSessionAwaitingInput(item.sessionId)) return;
    if (dispatchingQueuedMessageId()) return;
    if (!retry && state.queuedMessages.find((queued) => queued.id === item.id)?.paused) return;
    if (failedQueuedMessageIds().has(item.id) && !retry) return;
    setQueuedMessageFailed(item.id, false);
    setDispatchingQueuedMessageId(item.id);
    let sent = false;
    try {
      sent = await sendMessage(item.text, {
        ...(item.agent ? { agent: item.agent } : {}),
        queuedAttachments: {
          droppedFiles: item.droppedFiles,
          clipboardImages: item.clipboardImages,
          nativePdfs: item.nativePdfs,
          terminalSelection: item.terminalSelection,
          ...(item.attachedDiagnostics ? { attachedDiagnostics: item.attachedDiagnostics } : {}),
        },
        preserveComposer: true,
        targetSessionId: item.sessionId,
      });
    } catch {
      sent = false;
    }
    if (sent) {
      removeQueuedMessage(item.id);
    } else if (state.queuedMessages.some((queued) => queued.id === item.id)) {
      setQueuedMessageFailed(item.id, true);
    }
    setDispatchingQueuedMessageId(null);
  }

  function findNextQueuedMessageForDispatch() {
    const steeringIds = steeringQueuedMessageIds();
    const failedSteerIds = failedSteerQueuedMessageIds();
    const failedIds = failedQueuedMessageIds();
    const editingSessionId = queuedMessageEdit()?.sessionId;
    const steeringSessionIds = new Set(
      state.queuedMessages.filter((item) => steeringIds.has(item.id)).map((item) => item.sessionId)
    );
    const blockedSessionIds = new Set<string>();

    for (const item of state.queuedMessages) {
      if (item.paused || steeringIds.has(item.id) || failedSteerIds.has(item.id)) continue;
      if (blockedSessionIds.has(item.sessionId)) continue;
      if (failedIds.has(item.id)) {
        blockedSessionIds.add(item.sessionId);
        continue;
      }
      if (
        steeringSessionIds.has(item.sessionId) ||
        editingSessionId === item.sessionId ||
        isSessionAwaitingInput(item.sessionId) ||
        (item.sessionId === state.activeSessionId
          ? isActiveSessionWorking()
          : isSessionTreeStatusWorking(item.sessionId))
      ) {
        blockedSessionIds.add(item.sessionId);
        continue;
      }
      return item;
    }

    return undefined;
  }

  let queueDispatchTimer: ReturnType<typeof setTimeout> | 0 = 0;
  createEffect(() => {
    const initialized = connectionInitialized();
    const dispatchingId = dispatchingQueuedMessageId();
    const next = findNextQueuedMessageForDispatch();
    if (queueDispatchTimer) {
      clearTimeout(queueDispatchTimer);
      queueDispatchTimer = 0;
    }
    if (!initialized || dispatchingId || !next) return;
    queueDispatchTimer = setTimeout(() => {
      queueDispatchTimer = 0;
      if (!connectionInitialized()) return;
      if (dispatchingQueuedMessageId()) return;
      const nextQueued = findNextQueuedMessageForDispatch();
      if (!nextQueued) return;
      void dispatchQueuedMessage(nextQueued);
    }, 250);
  });
  let queueDispatchDisposed = false;
  const dispatchAfterAuthoritativeIdle = (sessionId: string) => {
    queueMicrotask(() => {
      if (queueDispatchDisposed || !connectionInitialized() || dispatchingQueuedMessageId()) return;
      const next = findNextQueuedMessageForDispatch();
      if (!next) return;
      const completedRootId = getSessionTreeRootId(sessionId) || sessionId;
      const queuedRootId = getSessionTreeRootId(next.sessionId) || next.sessionId;
      if (completedRootId !== queuedRootId) return;
      void dispatchQueuedMessage(next);
    });
  };
  const queuedSteerAdmissionCleanups = [
    serverEvents.on('session.status', (event) => {
      const properties = event.properties;
      if (properties?.status?.type !== 'idle' || typeof properties.sessionID !== 'string') return;
      dispatchAfterAuthoritativeIdle(properties.sessionID);
    }),
    serverEvents.on('session.idle', (event) => {
      const sessionId = event.properties?.sessionID;
      if (typeof sessionId === 'string') dispatchAfterAuthoritativeIdle(sessionId);
    }),
    serverEvents.on('session.next.prompted', (event) => {
      const properties = event.properties;
      if (properties?.delivery !== 'steer') return;
      acceptQueuedSteer(properties.sessionID, getPromptEventText(properties.prompt));
    }),
    serverEvents.on('session.next.prompt.admitted', (event) => {
      const properties = event.properties;
      if (properties?.delivery !== 'steer') return;
      acceptQueuedSteer(properties.sessionID, getPromptEventText(properties.prompt));
    }),
  ];
  onCleanup(() => {
    queueDispatchDisposed = true;
    if (queueDispatchTimer) clearTimeout(queueDispatchTimer);
    if (fileSearchTimer) clearTimeout(fileSearchTimer);
    for (const cleanup of queuedSteerAdmissionCleanups) cleanup();
  });

  function setComposerValue(value: string) {
    batch(() => {
      setInputText(value);
      setCaretPosition(value.length);
      if (value.trim().length === 0 && state.clipboardImages.length === 0) resetPastedImageIndex();
      setCompletionIndex(0);
    });
    queueMicrotask(() => {
      if (richEditorRef) {
        richEditorRef.focus();
      }
    });
  }

  /**
   * Applies an edit/restore snapshot as one unit. The image cap can discard
   * attachments the snapshot's text still references, so the markers for those
   * are blanked here rather than left pointing at nothing.
   */
  function applyComposerEditState(
    context: MessageEditContext,
    text: string,
    mergeWholeFileIntoActiveContext = false
  ) {
    const droppedImages = applyEditContext(context, mergeWholeFileIntoActiveContext);
    setComposerValue(stripClipboardImagePlaceholders(text, droppedImages));
  }

  function cancelQueuedMessageEdit() {
    if (!queuedMessageEdit()) return;
    batch(() => {
      setQueuedMessageEdit(null);
      setHistoryIndex(null);
      setHistoryDraft('');
      setCompletionIndex(0);
      setSuppressCompletion(false);
      clearContextFiles();
      setState('terminalSelection', null);
      setState('attachedDiagnostics', null);
      clearClipboardImages();
      clearNativePdfs();
      resetPastedImageIndex();
      setComposerValue('');
    });
    postMessage({ type: 'files/clear' });
    postMessage({ type: 'terminal-selection/clear' });
  }

  function editQueuedMessage(item: QueuedMessageItem) {
    const queued = state.queuedMessages.find((message) => message.id === item.id);
    if (
      !queued ||
      queued.sessionId !== composerSessionId() ||
      !canEditQueuedMessage() ||
      dispatchingQueuedMessageId() === queued.id ||
      steeringQueuedMessageIds().has(queued.id)
    ) {
      return;
    }

    batch(() => {
      setHistoryIndex(null);
      setHistoryDraft('');
      setCompletionIndex(0);
      setSuppressCompletion(false);
      applyComposerEditState(
        {
          files: queued.droppedFiles ?? [],
          images: queued.clipboardImages ?? [],
          pdfs: queued.nativePdfs ?? [],
          terminalSelection: queued.terminalSelection ?? null,
        },
        queued.text
      );
      setState('attachedDiagnostics', queued.attachedDiagnostics ?? null);
      setQueuedMessageEdit({ id: queued.id, sessionId: queued.sessionId });
    });
  }

  const messageHistory = createMemo(() => {
    const sessionId = composerSessionId();
    if (!sessionId) return [];
    const entries = [
      ...getSessionHistoryPrompts(sessionId),
      ...state.messages.filter((entry) => entry.info.sessionID === sessionId),
    ];
    const seen = new Set<string>();
    return entries
      .map((entry) => {
        if (entry.info.role !== 'user' || seen.has(entry.info.id)) return null;
        seen.add(entry.info.id);
        return getUserMessageHistoryText(entry.parts);
      })
      .filter((text): text is string => !!text);
  });

  async function navigateToOlderMessageHistory(
    sessionId: string,
    previousLength: number,
    previousIndex: number | null,
    previousText: string
  ) {
    if (loadingOlderMessageHistory()) return;
    setLoadingOlderMessageHistory(true);
    try {
      const loaded = await loadOlderSessionPrompts(sessionId);
      if (
        !loaded ||
        composerSessionId() !== sessionId ||
        historyIndex() !== previousIndex ||
        inputText() !== previousText
      ) {
        return;
      }

      const history = messageHistory();
      const added = history.length - previousLength;
      if (added <= 0) return;
      const nextIndex = previousIndex === null ? history.length - 1 : added - 1;
      setHistoryIndex(nextIndex);
      setComposerValue(history[nextIndex]!);
    } finally {
      setLoadingOlderMessageHistory(false);
    }
  }

  function navigateMessageHistory(direction: -1 | 1) {
    const history = messageHistory();
    const text = inputText();
    const plan = planMessageHistoryNavigation({
      history,
      currentIndex: historyIndex(),
      inputText: text,
      sessionId: composerSessionId(),
      direction,
    });

    if (plan.kind === 'ignore') return false;

    if (plan.kind === 'stash-draft') {
      setHistoryDraft(text);
      return false;
    }

    if (plan.kind === 'load-older') {
      if (plan.stashDraft) setHistoryDraft(text);
      void navigateToOlderMessageHistory(
        plan.sessionId,
        plan.previousLength,
        plan.previousIndex,
        text
      );
      return true;
    }

    if (plan.kind === 'restore-draft') {
      setHistoryIndex(null);
      setComposerValue(historyDraft());
      return true;
    }

    if (plan.stashDraft) setHistoryDraft(text);
    setHistoryIndex(plan.index);
    setComposerValue(history[plan.index]!);
    return true;
  }

  async function handleDrop(e: DragEvent) {
    if (isQueuedMessageDrag(e)) return;
    e.preventDefault();
    e.stopPropagation();
    setIsDraggingOver(false);

    const dataTransfer = e.dataTransfer;
    if (!dataTransfer) return;

    // Snapshot File objects now - DataTransfer is invalidated after the drop
    // event returns, so FileReader fallback later wouldn't see them otherwise.
    const droppedFiles = Array.from(dataTransfer.files || []);
    const pdfFiles = droppedFiles.filter(isPdfFile);
    if (pdfFiles.length > 0) {
      await attachNativePdfFiles(pdfFiles);
    }
    const remainingFiles = droppedFiles.filter((file) => !isPdfFile(file));
    const preferFileContent = isRemoteExtensionHost() && remainingFiles.length > 0;

    const pdfPaths = new Set<string>();
    for (const file of pdfFiles) {
      const path = (file as File & { path?: string }).path;
      if (path) pdfPaths.add(path);
    }
    const paths = (
      await collectDroppedPaths(dataTransfer, {
        includeFilePaths: !preferFileContent,
        preferFileContent,
      })
    ).filter((path) => !pdfPaths.has(path));
    if (paths.length > 0) {
      postMessage({ type: 'files/drop', payload: { paths } });
      return;
    }
    if (preferFileContent) {
      await sendDroppedContent(remainingFiles);
      return;
    }

    // Async fallback: try reading items one by one via getAsString
    const uriList = await readItemByType(dataTransfer, 'text/uri-list');
    if (uriList) {
      const uris = parseDroppedText(uriList);
      if (uris.length > 0) {
        postMessage({ type: 'files/drop', payload: { paths: uris } });
        return;
      }
    }

    // Try any vscode-specific type
    for (const type of Array.from(dataTransfer.types || [])) {
      if (type.startsWith('application/vnd.code.')) {
        const data = await readItemByType(dataTransfer, type);
        const uris = parseDroppedText(data);
        if (uris.length > 0) {
          postMessage({ type: 'files/drop', payload: { paths: uris } });
          return;
        }
      }
    }

    const plainText = await readItemByType(dataTransfer, 'text/plain');
    if (plainText) {
      const uris = parseDroppedText(plainText);
      if (uris.length > 0) {
        postMessage({ type: 'files/drop', payload: { paths: uris } });
        return;
      }
    }

    // Final fallback: no paths extractable (e.g. Finder drop on Electron 32+,
    // where File.path is stripped). Read the file bytes and ship the content.
    await sendDroppedContent(remainingFiles);
  }

  function updatePasteTransactionOwners(
    sessionId: string | null,
    previousMutationVersion: number,
    previousValue: string
  ) {
    for (const transaction of pendingPasteTransactions) {
      if (
        transaction.sessionId !== sessionId ||
        transaction.mutationVersion !== previousMutationVersion ||
        transaction.value !== previousValue
      ) {
        continue;
      }
      transaction.mutationVersion = inputTextMutationVersion();
      transaction.value = inputText();
    }
  }

  function commitPasteTransaction(transaction: PasteTransaction) {
    const mentions = transaction.mentions!;
    const contextFiles = [...transaction.contextFiles, ...mentions.files];
    const withdrawPastedMention =
      !!transaction.insertion &&
      mentions.mentionCount > 0 &&
      mentions.resolvedCount === mentions.mentionCount &&
      getPromptTextWithoutContextReferences(transaction.pastedText).length === 0;
    const previousMutationVersion = transaction.mutationVersion;
    const previousValue = transaction.value;
    const committedImageIds: string[] = [];
    const imageFilenames: string[] = [];
    const availableSlots = Math.max(0, MAX_CLIPBOARD_IMAGES - state.clipboardImages.length);
    const usedFilenames = new Set(state.clipboardImages.map((image) => image.filename));
    let imageIndex = nextPastedImageIndex();

    applyingComposerHistory = true;
    try {
      batch(() => {
        for (const file of contextFiles) addContextFile(file);
        for (const image of transaction.images!) {
          if (!image) continue;
          if (imageFilenames.length >= availableSlots) {
            transaction.imageRejections.add('limit');
            continue;
          }

          let filename = getPastedImageFilename(imageIndex);
          while (usedFilenames.has(filename)) {
            imageIndex += 1;
            filename = getPastedImageFilename(imageIndex);
          }

          const id = createAttachmentID();
          if (!addClipboardImage({ id, ...image, filename })) {
            transaction.imageRejections.add('duplicate');
            continue;
          }
          committedImageIds.push(id);
          imageFilenames.push(filename);
          usedFilenames.add(filename);
          imageIndex += 1;
        }
        if (imageFilenames.length > 0) setNextPastedImageIndex(imageIndex);

        const next = applyPasteTransactionText(
          captureComposerSnapshot(),
          transaction,
          withdrawPastedMention,
          imageFilenames
        );
        setInputText(next.text);
        setCaretPosition(next.caret);
      });

      const committedFiles = state.droppedFiles.filter((file) =>
        contextFiles.some((candidate) => isSamePath(candidate.path, file.path))
      );
      const committedImages = state.clipboardImages.filter((image) =>
        committedImageIds.includes(image.id)
      );
      const rewrite = (snapshot: ComposerSnapshot) => {
        const next = applyPasteTransactionText(
          snapshot,
          transaction,
          withdrawPastedMention,
          imageFilenames
        );
        return {
          ...next,
          files: mergeTransactionFiles(next.files, committedFiles),
          images: mergeTransactionImages(next.images, committedImages),
        };
      };
      if (transaction.historyEntry === null) {
        composerHistory.record(captureComposerSnapshot());
      } else {
        composerHistory.rewriteFrom(transaction.historyEntry, rewrite);
      }
    } finally {
      applyingComposerHistory = false;
    }
    notifyPastedImageRejections(transaction.imageRejections);

    const textDelta = inputText().length - previousValue.length;
    if (textDelta !== 0) {
      for (const pending of pendingPasteTransactions) {
        if (pending === transaction || pending.start < transaction.end) continue;
        pending.start += textDelta;
        pending.end += textDelta;
      }
    }
    updatePasteTransactionOwners(transaction.sessionId, previousMutationVersion, previousValue);
  }

  function drainPasteTransactions() {
    while (pendingPasteTransactions.length > 0) {
      const transaction = pendingPasteTransactions[0]!;
      if (
        transaction.insertion === undefined ||
        transaction.images === undefined ||
        transaction.mentions === undefined
      ) {
        return;
      }
      pendingPasteTransactions.shift();
      pasteTransactionsByEvent.delete(transaction.event);
      if (
        composerDisposed ||
        composerSessionId() !== transaction.sessionId ||
        inputTextMutationVersion() !== transaction.mutationVersion ||
        inputText() !== transaction.value
      ) {
        continue;
      }
      commitPasteTransaction(transaction);
    }
  }

  function handlePaste(e: ClipboardEvent) {
    const clipboardData = e.clipboardData;
    if (!clipboardData) return;

    const pastedText = clipboardData.getData('text/plain');
    const pastedContextFiles = getPastedContextFiles(pastedText, state.editorContext.workspacePath);
    const pastedPromptText = getPromptTextWithoutContextReferences(pastedText);
    const pasteHandledAsContextOnly =
      pastedContextFiles.length > 0 && pastedPromptText.length === 0;
    if (pastedContextFiles.length > 0) {
      (e as ClipboardEvent & { __varroPasteText?: string }).__varroPasteText = pastedPromptText;
    }

    const imageItems = Array.from(clipboardData.items).filter(
      (item) => item.kind === 'file' && item.type.startsWith('image/')
    );
    const pdfFiles = Array.from(clipboardData.items).flatMap((item) => {
      if (item.kind !== 'file') return [];
      const file = item.getAsFile();
      return file && isPdfFile(file) ? [file] : [];
    });
    if (pdfFiles.length > 0) {
      if (!pastedText) e.preventDefault();
      void attachNativePdfFiles(pdfFiles);
    }
    if (imageItems.length === 0) {
      for (const file of pastedContextFiles) addContextFile(file);
      if (pasteHandledAsContextOnly) {
        e.preventDefault();
        resolvePastedMentions(pastedText, null);
      }
      return;
    }

    if (!currentModelSupportsVision()) {
      showSessionActionFeedback(
        'Image attached; use a vision-capable model or vision subagent to send it',
        'warning'
      );
    }

    if (!pastedText || pasteHandledAsContextOnly) e.preventDefault();
    const transaction: PasteTransaction = {
      event: e,
      sessionId: composerSessionId(),
      mutationVersion: inputTextMutationVersion(),
      value: inputText(),
      pastedText,
      contextFiles: pastedContextFiles,
      insertion: undefined,
      start: caretPosition(),
      end: caretPosition(),
      historyEntry: null,
      images: undefined,
      imageRejections: new Set(),
      mentions: undefined,
    };
    pendingPasteTransactions.push(transaction);
    pasteTransactionsByEvent.set(e, transaction);

    const imageFiles: File[] = [];
    for (const item of imageItems) {
      if (imageFiles.length >= MAX_CLIPBOARD_IMAGES) {
        transaction.imageRejections.add('limit');
        continue;
      }
      const file = item.getAsFile();
      if (!file) {
        transaction.imageRejections.add('unreadable');
        continue;
      }
      if (file.size > MAX_CLIPBOARD_IMAGE_SIZE) {
        transaction.imageRejections.add('oversized');
        continue;
      }
      imageFiles.push(file);
    }
    void Promise.all(
      imageFiles.map(async (file) => {
        try {
          return {
            url: await readFileAsDataUrl(file),
            mime: file.type || 'image/png',
            size: file.size,
          };
        } catch (err) {
          logError('chat-input:readPastedImage', err);
          transaction.imageRejections.add('unreadable');
          return null;
        }
      })
    ).then((images) => {
      transaction.images = images;
      drainPasteTransactions();
    });
    void resolvePastedMentionContextFiles(pastedText)
      .then((mentions) => {
        transaction.mentions = mentions;
      })
      .catch((err) => {
        logError('chat-input:resolvePastedMentions', err);
        transaction.mentions = { mentionCount: 0, resolvedCount: 0, files: [] };
      })
      .then(drainPasteTransactions);
  }

  function handlePasteInsertion(e: ClipboardEvent, insertion: RichComposerPasteInsertion | null) {
    const transaction = pasteTransactionsByEvent.get(e);
    if (transaction) {
      const previousMutationVersion = transaction.mutationVersion;
      const previousValue = transaction.value;
      transaction.insertion = insertion;
      if (insertion) {
        transaction.start = insertion.start;
        transaction.end = insertion.end;
        updatePasteTransactionOwners(transaction.sessionId, previousMutationVersion, previousValue);
        transaction.historyEntry = composerHistory.record(captureComposerSnapshot());
      }
      drainPasteTransactions();
      return;
    }
    if (!insertion) return;
    const pastedText = e.clipboardData?.getData('text/plain') ?? '';
    if (!pastedText) return;

    resolvePastedMentions(pastedText, insertion);
  }

  function resolvePastedMentions(pastedText: string, insertion: RichComposerPasteInsertion | null) {
    const owner = {
      sessionId: composerSessionId(),
      mutationVersion: inputTextMutationVersion(),
      value: insertion?.value ?? inputText(),
    };
    const ownsActiveComposer = () =>
      !composerDisposed &&
      composerSessionId() === owner.sessionId &&
      inputTextMutationVersion() === owner.mutationVersion &&
      inputText() === owner.value;

    void resolvePastedMentionContextFiles(pastedText)
      .then((mentions) => {
        if (!ownsActiveComposer()) return;
        for (const file of mentions.files) {
          addContextFile(file);
        }
        if (!insertion) return;
        if (mentions.mentionCount === 0 || mentions.resolvedCount < mentions.mentionCount) return;
        if (getPromptTextWithoutContextReferences(pastedText).length > 0) return;
        if (!ownsActiveComposer()) return;
        batch(() => {
          withdrawPastedText(insertion, setInputText, setCaretPosition);
        });
      })
      .catch((err) => {
        logError('chat-input:resolvePastedMentions', err);
      });
  }

  onMount(() => {
    const disposeBridge = onMessage((msg: ExtensionMessage) => {
      if (msg.type === 'pdfs/picked') {
        const rejected = msg.payload.filter((pdf) => !addNativePdf(pdf));
        if (rejected.length > 0) {
          showSessionActionFeedback('PDFs must total 20 MiB or less', 'warning');
        }
        return;
      }
      if (msg.type === 'pdfs/stored') {
        setNativePdfContextFile(msg.payload.id, msg.payload.contextFile);
        return;
      }
      if (msg.type === 'images/stored') {
        pendingImageStores.delete(msg.payload.id);
        if (!setClipboardImageContextFile(msg.payload.id, msg.payload.contextFile)) {
          postMessage({
            type: 'images/release',
            payload: { paths: [msg.payload.contextFile.path], deferred: false },
          });
        }
        return;
      }
      if (msg.type !== 'files/search-results') return;
      if (msg.payload.requestId !== latestFileSearchRequestId) return;
      if (msg.payload.query !== latestFileSearchQuery) return;
      setFileSearchResults(msg.payload.files);
    });

    const handleWindowClick = (e: MouseEvent) => {
      const target = e.target as Node | null;
      const clickedInsideInteractiveArea =
        !!target && (containerRef?.contains(target) || modelPopoverRef?.contains(target));

      if (!clickedInsideInteractiveArea) {
        setShowAgentPicker(false);
        setShowModelPicker(false);
        setShowMcpPicker(false);
        setShowVariantPicker(false);
        setShowPermissionModePicker(false);
        setShowBusyMenu(false);
        setShowContextPopup(false);
        setShowProviderLimitPopup(false);
        setCompletionIndex(0);
        return;
      }

      if (
        showPermissionModePicker() &&
        clickedOutside(target, permissionPickerRef, permissionPopoverRef)
      ) {
        setShowPermissionModePicker(false);
      }
      if (showAgentPicker() && clickedOutside(target, agentPickerRef, agentPopoverRef)) {
        setShowAgentPicker(false);
      }
      if (
        showWorkspacePicker() &&
        clickedOutside(target, workspacePickerRef, workspacePopoverRef)
      ) {
        setShowWorkspacePicker(false);
      }
      if (showModelPicker() && clickedOutside(target, modelPickerRef, modelPopoverRef)) {
        setShowModelPicker(false);
      }
      if (showMcpPicker() && clickedOutside(target, mcpPickerRef, mcpPopoverRef)) {
        setShowMcpPicker(false);
      }
      if (showVariantPicker() && clickedOutside(target, variantPickerRef, variantPopoverRef)) {
        setShowVariantPicker(false);
      }
      if (showBusyMenu() && clickedOutside(target, busyToggleRef, busyMenuRef)) {
        setShowBusyMenu(false);
      }
      if (showContextPopup() && clickedOutside(target, contextButtonRef, contextPopupRef)) {
        setShowContextPopup(false);
      }
      if (
        showProviderLimitPopup() &&
        clickedOutside(target, providerLimitButtonRef, providerLimitPopupRef)
      ) {
        setShowProviderLimitPopup(false);
      }
    };

    const beginDropTarget = (e: DragEvent) => {
      if (isQueuedMessageDrag(e)) return;
      e.preventDefault();
      if (e.dataTransfer) e.dataTransfer.dropEffect = 'copy';
      setIsDraggingOver(true);
    };

    const handleWindowDragOver = (e: DragEvent) => {
      // Always accept drops so the browser fires the drop event.
      // VS Code explorer drags may not expose MIME types during dragover.
      beginDropTarget(e);
    };

    const handleWindowDrop = async (e: DragEvent) => {
      if (isQueuedMessageDrag(e)) return;
      e.preventDefault();
      setIsDraggingOver(false);
      await handleDrop(e);
    };

    const handleWindowDragLeave = (e: DragEvent) => {
      if (isQueuedMessageDrag(e)) return;
      if (e.relatedTarget) return;
      setIsDraggingOver(false);
    };

    window.addEventListener('keydown', handlePopupEscape, true);
    window.addEventListener('click', handleWindowClick, true);
    document.addEventListener('dragenter', beginDropTarget, true);
    document.addEventListener('dragover', handleWindowDragOver, true);
    document.addEventListener('drop', handleWindowDrop, true);
    document.addEventListener('dragleave', handleWindowDragLeave, true);

    onCleanup(() => {
      disposeBridge();
      window.removeEventListener('keydown', handlePopupEscape, true);
      window.removeEventListener('click', handleWindowClick, true);
      document.removeEventListener('dragenter', beginDropTarget, true);
      document.removeEventListener('dragover', handleWindowDragOver, true);
      document.removeEventListener('drop', handleWindowDrop, true);
      document.removeEventListener('dragleave', handleWindowDragLeave, true);
    });
  });

  onMount(() => {
    if (!toolbarRef) return;
    let lastObservedToolbarWidth = toolbarRef.clientWidth;
    const observer = new ResizeObserver((entries) => {
      const entry = entries.find((candidate) => candidate.target === toolbarRef);
      const width = entry?.borderBoxSize?.[0]?.inlineSize ?? entry?.contentRect.width;
      if (width !== undefined && Math.abs(width - lastObservedToolbarWidth) <= 0.5) return;
      if (width !== undefined) lastObservedToolbarWidth = width;
      if (
        showAgentPicker() ||
        showVariantPicker() ||
        showModelPicker() ||
        showMcpPicker() ||
        showPermissionModePicker()
      )
        return;
      if (showBusyMenu() || showContextPopup() || showProviderLimitPopup()) return;
      toolbarFitter.schedule();
    });
    observer.observe(toolbarRef);

    onCleanup(() => {
      observer.disconnect();
      toolbarFitter.cancel();
    });
  });

  createEffect(() => {
    void composerSessionId();
    setHistoryIndex(null);
    setHistoryDraft('');
    setCompletionIndex(0);
    composerHistory.reset(untrack(captureComposerSnapshot));
  });

  createEffect(() => {
    const snapshot = captureComposerSnapshot();
    if (applyingComposerHistory) return;
    composerHistory.record(snapshot);
  });

  createEffect(() => {
    if (inputText().trim().length === 0 && state.clipboardImages.length === 0) {
      resetPastedImageIndex();
    }
  });

  createEffect(() => {
    const focusKey = composerFocusKey();
    if (focusKey === 0) return;

    queueMicrotask(() => {
      if (richEditorRef) {
        richEditorRef.focus();
        setCaretPosition(inputText().length);
        setIsFocused(true);
      }
    });
  });

  // Message editing reuses this composer: entering edit mode stashes the
  // current draft, loads the message text/context, and focuses the editor.
  let activeEditMessageId: string | null = null;

  createEffect(() => {
    const editing = composerEditingMessage();
    if (!editing) {
      activeEditMessageId = null;
      setEditSelectedModel(null);
      return;
    }
    if (editing.messageId === activeEditMessageId) return;
    if (activeEditMessageId === null && !getMessageEditDraftBackup()) {
      setMessageEditDraftBackup(untrack(captureEditDraftBackup));
    }
    activeEditMessageId = editing.messageId;
    setEditSelectedModel(editing.model ? { ...editing.model } : null);
    applyComposerEditState(editing.context, editing.text, activeContextEnabled(editing.sessionId));
    queueMicrotask(() => {
      if (richEditorRef) {
        richEditorRef.focus();
        setIsFocused(true);
      }
    });
  });

  function cancelMessageEdit() {
    if (!untrack(editingMessage)) return;
    const draft = getMessageEditDraftBackup();
    resetMessageEditState();
    if (draft) {
      applyComposerEditState(draft, draft.text);
    } else {
      setComposerValue('');
    }
  }

  createEffect(() => {
    const editing = composerEditingMessage();
    if (editing && composerSessionId() !== editing.sessionId) {
      cancelMessageEdit();
    }
  });

  function currentModelSupportsVision() {
    const current = currentModel();
    if (!current.providerID || !current.modelID) return true;
    return modelSupportsVision(current.providerID, current.modelID, state.providers);
  }

  function canDelegateCurrentImages(text = inputText()) {
    const sessionId = composerSessionId();
    const sessionPromptTexts = sessionId
      ? state.messages.flatMap((entry) =>
          entry.info.sessionID === sessionId && entry.info.role === 'user'
            ? entry.parts.flatMap((part) => (part.type === 'text' ? [part.text] : []))
            : []
        )
      : [];
    return canDelegateVision([text, ...sessionPromptTexts], state.allAgents, state.providers);
  }

  function currentPromptCanHandleImages(text = inputText()) {
    return (
      currentModelSupportsVision() ||
      (currentModelSupportsTools() && canDelegateCurrentImages(text))
    );
  }

  function currentModelSupportsPdf() {
    const current = currentModel();
    if (!current.providerID || !current.modelID) return false;
    return modelSupportsPdf(current.providerID, current.modelID, state.providers);
  }

  function currentModelSupportsTools() {
    const current = currentModel();
    if (!current.providerID || !current.modelID) return false;
    return modelSupportsTools(current.providerID, current.modelID, state.providers);
  }

  const hasPendingPdfFallback = () =>
    !currentModelSupportsPdf() && state.nativePdfs.some((pdf) => !pdf.contextFile);

  function hasSendableClipboardImages() {
    return currentPromptCanHandleImages() && state.clipboardImages.length > 0;
  }

  function getSendableInputText(text = inputText()) {
    return getPromptTextForClipboardImages(
      text,
      state.clipboardImages,
      currentPromptCanHandleImages(text)
    );
  }

  const hasPendingDelegatedImages = () =>
    !currentModelSupportsVision() &&
    currentModelSupportsTools() &&
    canDelegateCurrentImages() &&
    state.clipboardImages.some((image) => !image.contextFile);

  createEffect(() => {
    if (currentModelSupportsVision() || !currentModelSupportsTools()) return;
    if (!canDelegateCurrentImages()) return;
    for (const image of composerClipboardImages()) {
      if (image.contextFile || pendingImageStores.has(image.id)) continue;
      pendingImageStores.add(image.id);
      postMessage({
        type: 'images/store',
        payload: {
          id: image.id,
          name: image.filename,
          content: image.url.slice(image.url.indexOf(',') + 1),
          size: image.size,
        },
      });
    }
  });

  const hasPendingApproval = () => composerHasActiveQuestion() || composerHasActivePermission();
  const canSend = () =>
    isAbortSlashCommand(inputText()) ||
    (!pendingWorkspacePath() &&
      !hasPendingPdfFallback() &&
      !hasPendingDelegatedImages() &&
      (!hasPendingApproval() || !composerEditingMessage()) &&
      (getSendableInputText().trim().length > 0 ||
        state.droppedFiles.length > 0 ||
        hasSendableClipboardImages() ||
        state.nativePdfs.length > 0 ||
        !!state.terminalSelection ||
        !!state.attachedDiagnostics));
  const isBusyWithoutInterruption = createMemo(
    () => isComposerBusy() && !composerHasActiveQuestion() && !composerHasActivePermission()
  );
  const isDisplayBusyWithoutInterruption = createMemo(
    () => isComposerDisplayBusy() && !composerHasActiveQuestion() && !composerHasActivePermission()
  );
  const showBusySendControls = createMemo(
    () =>
      (isBusyWithoutInterruption() || hasPendingApproval()) &&
      canSend() &&
      !composerEditingMessage()
  );
  const showBusySendOptions = createMemo(() => isBusyWithoutInterruption());

  const clipboardImagesNeedVision = () =>
    composerClipboardImages().length > 0 && !currentPromptCanHandleImages();
  const currentSessionMessageEntries = createMemo(() =>
    getMessageEntriesForSession(state.messages, composerSessionId())
  );

  const contextUsage = createMemo(() => {
    if (!composerSessionId()) return null;

    const best = getLatestAssistantMessageInfoWithTokens(currentSessionMessageEntries(), {
      includeSubagents: true,
    });
    if (best) {
      const ctx = getContextWindow(best, state.providers);
      if (ctx) return ctx;
    }

    const limit = currentModel().contextLimit;
    if (!limit) return null;
    return { used: 0, limit, percent: 0 };
  });

  const contextBreakdown = createMemo(() => {
    const inputTokens = getLatestAssistantMessageInfoWithTokens(currentSessionMessageEntries(), {
      includeSubagents: true,
    })?.tokens.input;
    return estimateContextBreakdown(currentSessionMessageEntries(), inputTokens ?? 0);
  });
  const nestedContextBreakdown = createMemo(() => {
    const sessionId = composerSessionId();
    if (!sessionId) return [];
    const rootId = getSessionTreeRootId(sessionId) || sessionId;
    const sessionIds = new Set(getSessionTreeIds(rootId));
    const complete = completeTokenBreakdown();
    if (complete?.rootId === rootId && complete.nestedBreakdown.length > 0) {
      return complete.nestedBreakdown;
    }
    return estimateNestedContextBreakdown(
      [...sessionIds].map((id) => getMessageEntriesForSession(state.messages, id))
    );
  });

  const localSessionTokenBreakdown = createMemo(() => {
    const sessionId = composerSessionId();
    if (!sessionId) {
      return getSessionTreeTokenBreakdown([], [], [], '');
    }
    const rootId = getSessionTreeRootId(sessionId) || sessionId;
    return getSessionTreeTokenBreakdown(
      state.messages,
      state.sessions,
      getSessionTreeIds(rootId),
      rootId
    );
  });

  const sessionTokenBreakdown = createMemo(() => {
    const sessionId = composerSessionId();
    const rootId = sessionId ? getSessionTreeRootId(sessionId) || sessionId : null;
    return mergeCompleteTokenBreakdown(
      localSessionTokenBreakdown(),
      completeTokenBreakdown(),
      rootId
    );
  });

  const sessionCost = createMemo(() => {
    const sessionId = composerSessionId();
    if (!sessionId) return null;
    const rootId = getSessionTreeRootId(sessionId) || sessionId;
    return getSessionCost(
      getMessageEntriesForSession(state.messages, rootId),
      state.sessions.find((session) => session.id === rootId)
    );
  });

  let tokenBreakdownRequestId = 0;
  onCleanup(() => tokenBreakdownRequestId++);
  async function loadCompleteTokenBreakdown() {
    const sessionId = composerSessionId();
    if (!sessionId) return;
    const rootId = getSessionTreeRootId(sessionId) || sessionId;
    const requestId = ++tokenBreakdownRequestId;
    try {
      const summary = await client.varro.session.diffSummary(rootId);
      if (
        requestId !== tokenBreakdownRequestId ||
        (getSessionTreeRootId(composerSessionId()) || composerSessionId()) !== rootId ||
        !summary.tokenBreakdown
      ) {
        return;
      }
      setCompleteTokenBreakdown({
        rootId,
        breakdown: summary.tokenBreakdown,
        nestedBreakdown: summary.nestedContextBreakdown ?? [],
      });
    } catch {}
  }

  function toggleContextPopup() {
    const next = !showContextPopup();
    closePopups(next ? 'context' : undefined);
    setShowContextPopup(next);
    if (next) void loadCompleteTokenBreakdown();
  }

  const activeUsageLimit = createMemo(() => {
    const activeSessionId = composerSessionId();
    for (const sessionId of getSessionTreeIdsForSession(activeSessionId)) {
      void state.sessionUsageLimits[sessionId];
    }
    return getActiveUsageLimitNotice(activeSessionId);
  });
  const currentProviderLimit = createMemo(() => {
    const current = currentModel();
    if (!current.providerID) return null;
    return getProviderLimit(current.providerID, current.modelID);
  });
  const currentCompactProviderLimit = createMemo(() => {
    const current = currentModel();
    return filterCompactProviderLimitForModel(
      currentProviderLimit(),
      current.modelID,
      current.modelName
    );
  });
  const showCurrentProviderLimit = createMemo(() =>
    hasProviderLimitWindowWithinThreshold(currentCompactProviderLimit(), 100)
  );

  const currentProviderLimitTitle = createMemo(() =>
    showCurrentProviderLimit() ? formatProviderLimitTitle(currentCompactProviderLimit()) : null
  );
  const currentProviderLimitBadges = createMemo(() =>
    showCurrentProviderLimit() ? getProviderLimitCompactBadges(currentCompactProviderLimit()) : []
  );
  const mcpStatuses = createMemo(() => Object.values(state.mcpStatus));
  const connectedMcpCount = createMemo(
    () => mcpStatuses().filter((status) => status.status === 'connected').length
  );
  const showMcpControl = createMemo(() => {
    const statuses = mcpStatuses();
    return statuses.length > 0;
  });
  createEffect(() => {
    if (!showCurrentProviderLimit() && showProviderLimitPopup()) {
      setShowProviderLimitPopup(false);
    }
  });
  const visibleUsageLimit = createMemo(() => {
    const notice = activeUsageLimit();
    const hasActiveAssistantContext = getLatestAssistantMessageInfo(state.messages) !== null;
    return notice &&
      shouldDisplayUsageLimitNotice(notice) &&
      isUsageLimitNoticeVisibleForModel(notice, currentModel(), hasActiveAssistantContext)
      ? notice
      : null;
  });
  const activeUsageLimitPresentation = createMemo(() => {
    const notice = visibleUsageLimit();
    return notice ? getUsageLimitPresentation(notice) : null;
  });
  const activeUsageLimitAction = createMemo(() =>
    getSafeUsageLimitAction(visibleUsageLimit()?.action)
  );
  const activeRalphManagerSessionId = createMemo(() =>
    ralphStore.isRalphSession(composerSessionId())
      ? composerSessionId()
      : ralphStore.findManagerSessionIdForChild(composerSessionId())
  );
  const activeRalphRun = createMemo(() => ralphStore.getRun(activeRalphManagerSessionId()));

  const availableVariants = createMemo(() => {
    const model = currentModel();
    return getVariantsForModel(model.providerID, model.modelID, state.providers);
  });

  const effectiveVariant = createMemo(() => {
    if (composerEditingMessage()) return currentModel().variant;

    const variants = availableVariants();
    if (variants.length === 0) return null;
    if (currentModel().variant && variants.includes(currentModel().variant!)) {
      return currentModel().variant;
    }

    const rememberedVariant = getStoredVariantForModel(
      currentModel().providerID,
      currentModel().modelID
    );
    if (rememberedVariant === null) return null;
    if (rememberedVariant && variants.includes(rememberedVariant)) return rememberedVariant;

    return null;
  });

  const toolbarFitDependencies = createMemo(() => ({
    agents: state.agents.length,
    selectedAgent: state.selectedAgent,
    modelProvider: currentModel().providerID,
    modelId: currentModel().modelID,
    modelName: currentModel().modelName,
    providerLimit: currentProviderLimitBadges()
      .map((badge) => badge.label)
      .join('|'),
    variant: effectiveVariant(),
    hasContextUsage: !!contextUsage(),
    loading: isComposerBusy(),
    hasQuestion: composerHasActiveQuestion(),
    hasPermission: composerHasActivePermission(),
    showBusySendControls: showBusySendControls(),
    showAgentPicker: showAgentPicker(),
    showVariantPicker: showVariantPicker(),
    showModelPicker: showModelPicker(),
    showMcpPicker: showMcpPicker(),
    showPermissionModePicker: showPermissionModePicker(),
    showBusyMenu: showBusyMenu(),
    showContextPopup: showContextPopup(),
    showProviderLimitPopup: showProviderLimitPopup(),
  }));

  const activePermissionMode = createMemo(() => getPermissionModeForSession(composerSessionId()));
  const [resolvedAutoApproveJudgeModel, setResolvedAutoApproveJudgeModel] =
    createSignal<Awaited<ReturnType<typeof client.varro.resolveJudgeModel>>>(null);
  const autoPermissionActivity = createMemo(() => {
    const sessionId = composerSessionId();
    if (!sessionId) return undefined;
    const sessionIds = getSessionTreeIdsForSession(sessionId);
    const rootSessionId = getSessionTreeRootId(sessionId) || sessionId;
    const latestPromptCreatedAt = state.messages.reduce(
      (latest, entry) =>
        entry.info.role === 'user' && entry.info.sessionID === rootSessionId
          ? Math.max(latest, entry.info.time.created)
          : latest,
      Number.NEGATIVE_INFINITY
    );
    return sessionIds
      .flatMap((id) => state.sessionAutoPermissionActivity[id] ?? [])
      .filter((activity) => activity.createdAt >= latestPromptCreatedAt)
      .toSorted((a, b) => a.createdAt - b.createdAt);
  });
  const autoApproveJudgeModel = createMemo(() => {
    const route = resolvedAutoApproveJudgeModel();
    if (!route) return null;
    const provider = state.providers.find((item) => item.id === route.providerID);
    const model = provider
      ? Object.values(provider.models).find((item) => item.id === route.modelID)
      : null;
    return {
      providerName: provider?.name || route.providerID,
      modelName: model?.name || route.modelID,
    };
  });
  let judgeModelRequestId = 0;
  createEffect(() => {
    if (activePermissionMode() !== 'auto') return;
    const current = currentModel();
    const fallback =
      current.providerID && current.modelID
        ? {
            providerID: current.providerID,
            modelID: current.modelID,
            ...(effectiveVariant() ? { variant: effectiveVariant()! } : {}),
          }
        : undefined;
    void state.providerRefreshPending;
    const requestId = ++judgeModelRequestId;
    void client.varro
      .resolveJudgeModel(fallback)
      .then((model) => {
        if (requestId === judgeModelRequestId) setResolvedAutoApproveJudgeModel(model);
      })
      .catch(() => {});
  });
  onCleanup(() => judgeModelRequestId++);

  function syncActiveRalphModel(nextModel: RalphSelectedModel) {
    const managerSessionId = activeRalphManagerSessionId();
    if (!managerSessionId) return;
    ralphStore.updateRunModel(managerSessionId, nextModel);
  }

  async function handleSelectedModelChange(
    nextModel: RalphSelectedModel,
    rememberVariant?: string | null
  ) {
    if (composerEditingMessage()) {
      setEditSelectedModel(nextModel);
      return;
    }

    const activeRun = activeRalphRun();
    const activeRunWasRunning = activeRun?.status === 'running';
    const previousRalphModel = activeRun?.config.model ?? null;
    const currentSelection = {
      providerID: state.selectedModel?.providerID,
      modelID: state.selectedModel?.modelID,
      variant: state.selectedModel?.variant,
    };

    setSelectedModel(nextModel, {
      sessionId: composerSessionId(),
      persistGlobal: true,
      ...(rememberVariant !== undefined ? { rememberVariant } : {}),
    });
    syncActiveRalphModel(nextModel);

    const usageLimit = activeUsageLimit();
    const visibleLimit = visibleUsageLimit();
    const activeSessionId = composerSessionId();
    const providerModelChanged =
      currentSelection.providerID !== nextModel.providerID ||
      currentSelection.modelID !== nextModel.modelID;
    const ralphModelChanged =
      previousRalphModel?.providerID !== nextModel.providerID ||
      previousRalphModel?.modelID !== nextModel.modelID ||
      previousRalphModel?.variant !== nextModel.variant;
    const switchedAwayFromLimitedProvider =
      !!usageLimit && !!usageLimit.providerID && usageLimit.providerID !== nextModel.providerID;
    const switchedAwayFromLimitedModel =
      !!usageLimit &&
      !!usageLimit.modelID &&
      usageLimit.providerID === nextModel.providerID &&
      usageLimit.modelID !== nextModel.modelID;
    const shouldClearUsageLimit =
      !!usageLimit &&
      (!!visibleLimit ||
        switchedAwayFromLimitedProvider ||
        switchedAwayFromLimitedModel ||
        (!usageLimit.providerID && !usageLimit.modelID && providerModelChanged));

    if (
      (!providerModelChanged && !ralphModelChanged) ||
      !activeSessionId ||
      !shouldClearUsageLimit
    ) {
      return;
    }

    const treeSessionIds = getSessionTreeIdsForSession(activeSessionId);
    const retryingSessionIds = treeSessionIds.filter(
      (sessionId) => state.sessionStatus[sessionId]?.type === 'retry'
    );
    const shouldResumeActiveSession =
      retryingSessionIds.includes(activeSessionId) && (activeRunWasRunning || !activeRun);

    if (retryingSessionIds.length > 0) {
      try {
        await abortSession();
      } catch {
        return;
      }
    }

    if (activeRunWasRunning && retryingSessionIds.includes(activeSessionId)) {
      ralphRunner.pause(activeRun.config.managerSessionId);
    }

    if (retryingSessionIds.length > 0) {
      setState('sessionStatus', (current) => ({
        ...current,
        ...Object.fromEntries(retryingSessionIds.map((sessionId) => [sessionId, { type: 'idle' }])),
      }));
    }

    for (const sessionId of treeSessionIds) {
      setSessionUsageLimit(sessionId, null);
    }

    if (shouldResumeActiveSession) {
      try {
        await continueInterruptedSession(activeSessionId);
      } catch {}
    }
  }

  async function handleUsageLimitContinue() {
    const sessionId = composerSessionId();
    if (!sessionId) return;
    closePopups();
    clearUsageLimitsForSessionTree(sessionId);
    await sendMessage('Continue', { noReply: false });
  }

  const queuedForSession = createMemo(() =>
    composerSessionId()
      ? state.queuedMessages.filter((item) => item.sessionId === composerSessionId())
      : []
  );

  const selectedAgentLabel = () => {
    const name = state.selectedAgent;
    if (!name) return 'Agent';
    const agent = state.agents.find((a) => a.name === name);
    const label = formatAgentLabel(agent?.name || name);
    return isToolbarControlCompacted(toolbarCompactMode(), 'agent')
      ? formatAgentInitial(label)
      : label;
  };

  const selectedVariantLabel = () => {
    const variant = effectiveVariant();
    if (!variant) {
      return isToolbarControlCompacted(toolbarCompactMode(), 'reasoning') ? 'D' : 'Default';
    }
    return isToolbarControlCompacted(toolbarCompactMode(), 'reasoning')
      ? formatVariantInitial(variant)
      : formatVariantLabel(variant);
  };

  const modelCanEllipsize = () =>
    !['full', 'compact-stop', 'compact-agent', 'compact-reasoning'].includes(toolbarCompactMode());
  const isToolbarControlVisible = (control: ToolbarControl) =>
    !isToolbarControlHidden(toolbarCompactMode(), control);
  const showStopButton = createMemo(
    () => isDisplayBusyWithoutInterruption() && isToolbarControlVisible('stop') && !canSend()
  );
  const showSendControl = createMemo(
    () => isToolbarControlVisible('send') && (!isDisplayBusyWithoutInterruption() || canSend())
  );

  createEffect(() => {
    const deps = toolbarFitDependencies();
    if (
      deps.showAgentPicker ||
      deps.showVariantPicker ||
      deps.showModelPicker ||
      deps.showMcpPicker ||
      deps.showPermissionModePicker
    )
      return;
    if (deps.showBusyMenu || deps.showContextPopup || deps.showProviderLimitPopup) return;

    toolbarFitter.schedule({ contentChanged: true });
  });

  return (
    <div
      class={`interactive-input-part ${composerEditingMessage() ? ' editing-message' : ''} ${showModelPicker() || showMcpPicker() ? 'model-picker-open' : ''} ${showMentionCompletionMenu() ? 'mention-completion-open' : ''}`}
    >
      <Show when={isDraggingOver()}>
        <DropOverlay />
      </Show>

      <Show
        when={
          !hasExpandedDiffOverlay() && queuedForSession().length > 0 && !composerEditingMessage()
        }
      >
        <QueuedMessages
          items={queuedForSession()}
          dispatchingItemId={dispatchingQueuedMessageId()}
          failedDispatchItemIds={failedQueuedMessageIds()}
          steeringItemIds={steeringQueuedMessageIds()}
          failedSteerItemIds={failedSteerQueuedMessageIds()}
          editingItemId={queuedMessageEdit()?.id}
          canEdit={canEditQueuedMessage()}
          canSendImmediately={!hasPendingApproval()}
          onRetryDispatch={(item) => void dispatchQueuedMessage(item, true)}
          onSendAsSteer={(item) => {
            if (!hasPendingApproval()) void sendQueuedAsSteer(item);
          }}
          onSetPaused={(item, paused, allRows) => setQueuedMessagePaused(item.id, paused, allRows)}
          onReorder={reorderQueuedMessage}
          onEdit={editQueuedMessage}
          onCancelEdit={cancelQueuedMessageEdit}
          onRemove={removeQueuedMessage}
        />
      </Show>

      <Show
        when={
          !hasExpandedDiffOverlay() &&
          !props.newSession &&
          state.todos.length > 0 &&
          !composerEditingMessage()
        }
      >
        <TodoList />
      </Show>

      <Show when={!hasExpandedDiffOverlay() && !props.newSession && !composerEditingMessage()}>
        <ChangedFilesList />
      </Show>

      <Show when={!hasExpandedDiffOverlay() && composerEditingMessage()}>
        <div class="composer-edit-banner">
          <svg
            class="composer-edit-banner-icon"
            viewBox="0 0 16 16"
            fill="currentColor"
            width="12"
            height="12"
            aria-hidden="true"
          >
            <path d="M13.23 1q-.36 0-.7.15a1.8 1.8 0 0 0-.58.39L3.52 9.97a.5.5 0 0 0-.13.22l-1.37 4.18a.5.5 0 0 0 .63.63l4.18-1.37a.5.5 0 0 0 .22-.13l8.43-8.43q.25-.25.39-.58a1.81 1.81 0 0 0-.39-1.98L14.51 1.54a1.8 1.8 0 0 0-.58-.39 1.8 1.8 0 0 0-.7-.15zm-.32 1.07a.8.8 0 0 1 .64 0q.15.06.26.18l.97.97a.81.81 0 0 1 0 1.16l-.97.97-2.13-2.13.97-.97a.8.8 0 0 1 .26-.18zM10.97 4.93l2.13 2.13-6.6 6.6-2.85.94.94-2.86z" />
          </svg>
          <span class="composer-edit-banner-label">Editing message</span>
          <button
            type="button"
            class="composer-edit-banner-cancel"
            title="Cancel editing (Esc)"
            onClick={() => cancelMessageEdit()}
          >
            Cancel
          </button>
        </div>
      </Show>

      <Show when={!hasExpandedDiffOverlay() && visibleUsageLimit()}>
        <UsageLimitBanner
          title={activeUsageLimitPresentation()!.title}
          message={visibleUsageLimit()!.action?.message.trim() || visibleUsageLimit()!.message}
          meta={describeUsageLimit(
            activeUsageLimitPresentation()!.summary,
            visibleUsageLimit()!.retryAt,
            visibleUsageLimit()!.attempt
          )}
          primaryActionLabel="Continue"
          onPrimaryAction={() => void handleUsageLimitContinue()}
          externalAction={activeUsageLimitAction()}
          onExternalAction={(link) =>
            postMessage({ type: 'vscode/open-external', payload: { url: link } })
          }
          showStopRetrying={
            (isComposerBusy() ||
              visibleUsageLimit()!.source === 'status' ||
              (visibleUsageLimit()!.attempt !== null && visibleUsageLimit()!.retryAt !== null)) &&
            !composerHasActiveQuestion() &&
            !composerHasActivePermission()
          }
          onStopRetrying={requestAbortSession}
          onSwitchProvider={() => {
            closePopups();
            setShowModelPicker(true);
          }}
        />
      </Show>

      <div
        ref={(el) => {
          containerRef = el;
        }}
        class={`chat-input-shell ${showFloatingInputPopover() ? 'showing-floating-popover' : ''}`}
      >
        <Show when={showModelPicker()}>
          <Suspense>
            <LazyModelPicker
              onSelect={(sel) => {
                if (sel.providerID && sel.modelID) {
                  const rememberedVariant = getStoredVariantForModel(sel.providerID, sel.modelID);
                  const matchedVariant = sel.variant || rememberedVariant || undefined;
                  void handleSelectedModelChange({
                    providerID: sel.providerID,
                    modelID: sel.modelID,
                    variant: matchedVariant,
                  });
                }
              }}
              onClose={() => setShowModelPicker(false)}
              popoverRef={(el) => (modelPopoverRef = el)}
            />
          </Suspense>
        </Show>

        <Show when={showMcpPicker()}>
          <Suspense>
            <LazyMcpPicker
              sessionId={composerSessionId()}
              onChange={(names) => void applySessionMcps(names, composerSessionId())}
              onClose={() => setShowMcpPicker(false)}
              popoverRef={(el) => (mcpPopoverRef = el)}
            />
          </Suspense>
        </Show>

        <div
          ref={(el) => {
            inputFrameRef = el;
          }}
          class={`chat-input-container ${isFocused() ? 'focused' : ''} ${showModelPicker() || showMcpPicker() ? 'showing-model-picker' : ''} ${showAgentPicker() || showVariantPicker() || showMcpPicker() || showBusyMenu() || (isFocused() && showCompletionMenu()) ? 'showing-context-popup' : ''}`}
          style={{
            'min-height': sendComposerMinHeight() ? `${sendComposerMinHeight()}px` : undefined,
          }}
          onDragEnter={(e) => {
            if (isQueuedMessageDrag(e)) return;
            e.preventDefault();
            e.stopPropagation();
            if (e.dataTransfer) e.dataTransfer.dropEffect = 'copy';
            setIsDraggingOver(true);
          }}
          onDragOver={(e) => {
            if (isQueuedMessageDrag(e)) return;
            e.preventDefault();
            e.stopPropagation();
            if (e.dataTransfer) e.dataTransfer.dropEffect = 'copy';
            setIsDraggingOver(true);
          }}
          onDragLeave={(e) => {
            if (isQueuedMessageDrag(e)) return;
            if (e.currentTarget.contains(e.relatedTarget as Node | null)) return;
            setIsDraggingOver(false);
          }}
          onDrop={handleDrop}
        >
          <Show when={hasContext() || hasMentions()}>
            <AttachmentStrip
              activeContext={activeContext()}
              activeContextEnabled={activeContextEnabled(composerSessionId())}
              activeContextTitle={activeContextTitle()}
              terminalSelection={composerTerminalSelection()}
              diagnostics={
                state.attachedDiagnostics
                  ? {
                      count: state.attachedDiagnostics.diagnostics.length,
                      total: state.attachedDiagnostics.total,
                    }
                  : null
              }
              files={visibleFiles()}
              clipboardImages={visibleClipboardImages()}
              nativePdfs={visibleNativePdfs()}
              nativePdfsSupported={currentModelSupportsPdf()}
              clipboardImagesNeedVision={clipboardImagesNeedVision()}
              onToggleActiveContext={() => toggleCurrentDocumentEnabled(composerSessionId())}
              onClearTerminalSelection={() => postMessage({ type: 'terminal-selection/clear' })}
              onClearDiagnostics={() => setState('attachedDiagnostics', null)}
              onRemoveFile={(path) => {
                removeContextFile(path);
                postMessage({ type: 'files/remove', payload: { path } });
              }}
              onRemoveClipboardImage={removeClipboardImage}
              onRemoveNativePdf={removeNativePdf}
              onOpenFile={openContextFileInEditor}
              onPreviewImage={(image) => setPreviewImageId(image.id)}
            />
          </Show>

          <RichComposerArea
            editorRef={(el) => {
              richEditorRef = el;
            }}
            placeholder={
              composerEditingMessage()
                ? 'Edit your message'
                : composerHasActiveQuestion() || composerHasActivePermission()
                  ? 'Respond to the prompt above to continue...'
                  : isComposerDisplayBusy()
                    ? 'Queue a follow-up or steer'
                    : 'Describe what to build'
            }
            value={inputText()}
            cursorOffset={caretPosition()}
            chips={inlineChips()}
            isFocused={isFocused()}
            showCompletionMenu={showCompletionMenu()}
            completionItems={composerCompletions()}
            completionSelectedIndex={completionIndex()}
            completionHeader={completionHeader()}
            onInput={(text, cursorOffset) => {
              batch(() => {
                setHistoryIndex(null);
                setHistoryDraft('');
                setInputText(text);
                setCaretPosition(cursorOffset);
                setCompletionIndex(0);
                setSuppressCompletion(false);
              });
            }}
            onKeyDown={handleKeydown}
            onHistory={applyComposerHistoryAction}
            onPaste={handlePaste}
            onPasteInsertion={handlePasteInsertion}
            onFocus={() => {
              setIsFocused(true);
            }}
            onBlur={() => setIsFocused(false)}
            onClick={(cursorOffset, selectionEnd) => {
              if (cursorOffset === selectionEnd) setCaretPosition(cursorOffset);
              setShowAgentPicker(false);
              setShowModelPicker(false);
              setShowMcpPicker(false);
              setShowVariantPicker(false);
              setShowPermissionModePicker(false);
              setShowBusyMenu(false);
            }}
            onKeyUp={(cursorOffset, selectionEnd) => {
              if (cursorOffset === selectionEnd) setCaretPosition(cursorOffset);
            }}
            onSelect={(cursorOffset, selectionEnd) => {
              if (cursorOffset === selectionEnd) setCaretPosition(cursorOffset);
            }}
            onRemoveChip={(chipId) => {
              if (chipId.startsWith('file:')) {
                const path = chipId.slice(5);
                removeContextFile(path);
                postMessage({ type: 'files/remove', payload: { path } });
              } else if (chipId.startsWith('img:')) {
                const id = chipId.slice(4);
                removeClipboardImageWithCleanup(id);
              }
            }}
            onChipClick={(chipId) => {
              if (chipId.startsWith('file:')) {
                const path = chipId.slice(5);
                const file = composerFiles().find((f) => f.path === path);
                if (file) openContextFileInEditor(file);
              } else if (chipId.startsWith('img:')) {
                const id = chipId.slice(4);
                if (composerClipboardImages().some((image) => image.id === id)) {
                  setPreviewImageId(id);
                }
              }
            }}
            onSelectCompletion={(item) => {
              const completion = activeCompletion();
              const completionSelection = getCompletionSelection(completion, item, true);
              if (!completionSelection) return;

              if (completionSelection.type === 'run-slash') {
                void runSlashCommand(completionSelection.value);
                return;
              }

              if (completionSelection.type === 'set-slash') {
                setComposerValue(completionSelection.value);
                return;
              }

              if (completionSelection.file) addContextFile(completionSelection.file);
              if (completionSelection.session)
                rememberSessionReference(completionSelection.session);
              if (completion?.type !== 'mention' && completion?.type !== 'session') return;
              applyCompletionValue(completion, completionSelection.value);
            }}
          />

          <div class="chat-input-toolbar-divider" aria-hidden="true" />

          <ChatInputMainToolbar
            toolbarRef={(el) => {
              toolbarRef = el;
            }}
            toolbarLeftRef={(el) => {
              toolbarLeftRef = el;
            }}
            toolbarRightRef={(el) => {
              toolbarRightRef = el;
            }}
            compactTight={toolbarCompactMode() === 'tight'}
            showLeftPopupState={showWorkspacePicker() || showAgentPicker() || showVariantPicker()}
            workspaceFolders={state.editorContext.workspaceFolders ?? []}
            selectedWorkspacePath={state.editorContext.workspacePath}
            showWorkspacePicker={showWorkspacePicker()}
            workspaceButtonRef={(el) => {
              workspacePickerRef = el;
            }}
            workspacePopoverRef={(el) => {
              workspacePopoverRef = el;
            }}
            onToggleWorkspacePicker={() => {
              const next = !showWorkspacePicker();
              closePopups(next ? 'workspace' : undefined);
              setShowWorkspacePicker(next);
            }}
            onSelectWorkspace={(path) => {
              setPendingWorkspacePath(path);
              setShowWorkspacePicker(false);
              postMessage({ type: 'workspace/select', payload: { path } });
            }}
            showPermissionControl={true}
            permissionButtonRef={(el) => {
              permissionPickerRef = el;
            }}
            permissionPopoverRef={(el) => {
              permissionPopoverRef = el;
            }}
            permissionMode={activePermissionMode()}
            autoPermissionActivity={autoPermissionActivity()}
            autoApproveJudgeModel={autoApproveJudgeModel()}
            showPermissionPicker={showPermissionModePicker()}
            onTogglePermissionPicker={() => {
              const next = !showPermissionModePicker();
              closePopups(next ? 'permission' : undefined);
              setShowPermissionModePicker(next);
            }}
            onSelectPermissionMode={(mode) => {
              void updatePermissionModeForSession(mode, composerSessionId());
              setShowPermissionModePicker(false);
            }}
            agents={state.agents}
            selectedAgent={state.selectedAgent}
            selectedAgentLabel={selectedAgentLabel() ?? ''}
            agentFocusIndex={agentFocusIndex()}
            showAgentPicker={showAgentPicker()}
            showAgentControl={isToolbarControlVisible('agent')}
            agentButtonRef={(el) => {
              agentPickerRef = el;
            }}
            agentPopoverRef={(el) => {
              agentPopoverRef = el;
            }}
            getAgentLabel={(agent) => formatAgentLabel(agent.name)}
            getAgentDetail={(agent) => agent.description || getAgentBadgeLine(agent)}
            onToggleAgentPicker={() => {
              const next = !showAgentPicker();
              closePopups(next ? 'agent' : undefined);
              setShowAgentPicker(next);
              if (next) setAgentFocusIndex(0);
            }}
            onSelectAgent={(agent) => {
              setSelectedAgent(agent.name, { sessionId: composerSessionId() });
              setShowAgentPicker(false);
            }}
            onAgentFocusIndex={setAgentFocusIndex}
            modelButtonRef={(el) => {
              modelPickerRef = el;
            }}
            currentModel={currentModel()}
            modelCanEllipsize={modelCanEllipsize()}
            onToggleModelPicker={() => {
              const next = !showModelPicker();
              closePopups(next ? 'model' : undefined);
              setShowModelPicker(next);
            }}
            providerLimitBadges={currentProviderLimitBadges()}
            providerLimitTitle={currentProviderLimitTitle()}
            providerLimit={showCurrentProviderLimit() ? currentProviderLimit() : null}
            showProviderLimitPopup={showCurrentProviderLimit() && showProviderLimitPopup()}
            providerLimitButtonRef={(el) => {
              providerLimitButtonRef = el;
            }}
            providerLimitPopupRef={(el) => {
              providerLimitPopupRef = el;
            }}
            onToggleProviderLimitPopup={() => {
              if (!showCurrentProviderLimit()) return;
              const next = !showProviderLimitPopup();
              closePopups(next ? 'providerLimit' : undefined);
              setShowProviderLimitPopup(next);
            }}
            onCloseProviderLimitPopup={() => setShowProviderLimitPopup(false)}
            availableVariants={availableVariants()}
            selectedVariant={effectiveVariant() ?? null}
            selectedVariantLabel={selectedVariantLabel() ?? ''}
            showVariantPicker={showVariantPicker()}
            showReasoningControl={isToolbarControlVisible('reasoning')}
            variantButtonRef={(el) => {
              variantPickerRef = el;
            }}
            variantPopoverRef={(el) => {
              variantPopoverRef = el;
            }}
            getVariantLabel={formatVariantLabel}
            onToggleVariantPicker={() => {
              const next = !showVariantPicker();
              closePopups(next ? 'variant' : undefined);
              setShowVariantPicker(next);
            }}
            onSelectVariant={(variant) => {
              const m = currentModel();
              void handleSelectedModelChange(
                {
                  providerID: m.providerID!,
                  modelID: m.modelID!,
                  ...(variant ? { variant } : {}),
                },
                variant
              );
              setShowVariantPicker(false);
            }}
            contextUsage={contextUsage()}
            contextBreakdown={contextBreakdown()}
            nestedContextBreakdown={nestedContextBreakdown()}
            showContextControl={!!contextUsage()}
            contextButtonRef={(el) => {
              contextButtonRef = el;
            }}
            contextPopupRef={(el) => {
              contextPopupRef = el;
            }}
            showContextPopup={showContextPopup()}
            sessionTokens={sessionTokenBreakdown().session}
            sessionCost={sessionCost()}
            subagentTokens={sessionTokenBreakdown().subagents}
            subagentCount={sessionTokenBreakdown().subagentCount}
            contextCompactDisabled={isComposerBusy() || isSessionCompacting()}
            onToggleContextPopup={toggleContextPopup}
            onCloseContextPopup={() => setShowContextPopup(false)}
            onCompactSession={() => {
              void compactSession();
            }}
            showAttachmentsControl={isToolbarControlVisible('attachments')}
            onAttach={() => postMessage({ type: 'files/pick' })}
            showStopButton={showStopButton()}
            onStop={requestAbortSession}
            showSendControl={showSendControl()}
            showBusySendControls={showBusySendControls()}
            showBusySendOptions={showBusySendOptions()}
            canSend={canSend()}
            busyToggleRef={(el) => {
              busyToggleRef = el;
            }}
            showBusyMenu={showBusyMenu()}
            onSend={() => handleSend()}
            onToggleBusyMenu={() => {
              const next = !showBusyMenu();
              closePopups(next ? 'busy' : undefined);
              setShowBusyMenu(next);
            }}
            busyMenuRef={(el) => {
              busyMenuRef = el;
            }}
            onQueue={() => {
              handleSend('queue');
              setShowBusyMenu(false);
            }}
            onSteer={() => {
              handleSend('steer');
              setShowBusyMenu(false);
            }}
            onStopAndSend={() => void handleStopAndSend()}
          />
        </div>

        <ChatInputMetaToolbar
          compactTight={toolbarCompactMode() === 'tight'}
          inputFrameRef={inputFrameRef}
          showMcpControl={!composerEditingMessage() && showMcpControl()}
          connectedMcpCount={connectedMcpCount()}
          mcpButtonRef={(el) => {
            mcpPickerRef = el;
          }}
          onToggleMcps={() => {
            const next = !showMcpPicker();
            closePopups(next ? 'mcp' : undefined);
            setShowMcpPicker(next);
          }}
          showPermissionControl={!composerEditingMessage()}
          permissionButtonRef={(el) => {
            permissionPickerRef = el;
          }}
          permissionPopoverRef={(el) => {
            permissionPopoverRef = el;
          }}
          permissionMode={activePermissionMode()}
          autoPermissionActivity={autoPermissionActivity()}
          autoApproveJudgeModel={autoApproveJudgeModel()}
          showPermissionPicker={showPermissionModePicker()}
          onTogglePermissionPicker={() => {
            const next = !showPermissionModePicker();
            closePopups(next ? 'permission' : undefined);
            setShowPermissionModePicker(next);
          }}
          onSelectPermissionMode={(mode) => {
            void updatePermissionModeForSession(mode, composerSessionId());
            setShowPermissionModePicker(false);
          }}
          agents={state.agents}
          selectedAgent={state.selectedAgent}
          selectedAgentLabel={selectedAgentLabel() ?? ''}
          agentFocusIndex={agentFocusIndex()}
          showAgentPicker={showAgentPicker()}
          showAgentControl={isToolbarControlVisible('agent')}
          agentButtonRef={(el) => {
            agentPickerRef = el;
          }}
          agentPopoverRef={(el) => {
            agentPopoverRef = el;
          }}
          getAgentLabel={(agent) => formatAgentLabel(agent.name)}
          getAgentDetail={(agent) => agent.description || getAgentBadgeLine(agent)}
          onToggleAgentPicker={() => {
            const next = !showAgentPicker();
            closePopups(next ? 'agent' : undefined);
            setShowAgentPicker(next);
            if (next) setAgentFocusIndex(0);
          }}
          onSelectAgent={(agent) => {
            setSelectedAgent(agent.name, { sessionId: composerSessionId() });
            setShowAgentPicker(false);
          }}
          onAgentFocusIndex={setAgentFocusIndex}
          modelButtonRef={(el) => {
            modelPickerRef = el;
          }}
          currentModel={currentModel()}
          modelCanEllipsize={modelCanEllipsize()}
          onToggleModelPicker={() => {
            const next = !showModelPicker();
            closePopups(next ? 'model' : undefined);
            setShowModelPicker(next);
          }}
          providerLimitBadges={composerEditingMessage() ? [] : currentProviderLimitBadges()}
          providerLimitTitle={currentProviderLimitTitle()}
          providerLimit={showCurrentProviderLimit() ? currentProviderLimit() : null}
          showProviderLimitPopup={showCurrentProviderLimit() && showProviderLimitPopup()}
          providerLimitButtonRef={(el) => {
            providerLimitButtonRef = el;
          }}
          providerLimitPopupRef={(el) => {
            providerLimitPopupRef = el;
          }}
          onToggleProviderLimitPopup={() => {
            if (!showCurrentProviderLimit()) return;
            const next = !showProviderLimitPopup();
            closePopups(next ? 'providerLimit' : undefined);
            setShowProviderLimitPopup(next);
          }}
          onCloseProviderLimitPopup={() => setShowProviderLimitPopup(false)}
          availableVariants={availableVariants()}
          selectedVariant={effectiveVariant() ?? null}
          selectedVariantLabel={selectedVariantLabel() ?? ''}
          showVariantPicker={showVariantPicker()}
          showReasoningControl={isToolbarControlVisible('reasoning')}
          variantButtonRef={(el) => {
            variantPickerRef = el;
          }}
          variantPopoverRef={(el) => {
            variantPopoverRef = el;
          }}
          getVariantLabel={formatVariantLabel}
          onToggleVariantPicker={() => {
            const next = !showVariantPicker();
            closePopups(next ? 'variant' : undefined);
            setShowVariantPicker(next);
          }}
          onSelectVariant={(variant) => {
            const m = currentModel();
            void handleSelectedModelChange(
              {
                providerID: m.providerID!,
                modelID: m.modelID!,
                ...(variant ? { variant } : {}),
              },
              variant
            );
            setShowVariantPicker(false);
          }}
          contextUsage={contextUsage()}
          contextBreakdown={contextBreakdown()}
          nestedContextBreakdown={nestedContextBreakdown()}
          showContextControl={!!contextUsage() && !composerEditingMessage()}
          contextButtonRef={(el) => {
            contextButtonRef = el;
          }}
          contextPopupRef={(el) => {
            contextPopupRef = el;
          }}
          showContextPopup={showContextPopup()}
          sessionTokens={sessionTokenBreakdown().session}
          sessionCost={sessionCost()}
          subagentTokens={sessionTokenBreakdown().subagents}
          subagentCount={sessionTokenBreakdown().subagentCount}
          contextCompactDisabled={isComposerBusy() || isSessionCompacting()}
          onToggleContextPopup={toggleContextPopup}
          onCloseContextPopup={() => setShowContextPopup(false)}
          onCompactSession={() => {
            void compactSession();
          }}
          showAttachmentsControl={isToolbarControlVisible('attachments')}
          onAttach={() => postMessage({ type: 'files/pick' })}
          showStopButton={showStopButton()}
          onStop={requestAbortSession}
          showSendControl={showSendControl()}
          showBusySendControls={showBusySendControls()}
          showBusySendOptions={showBusySendOptions()}
          canSend={canSend()}
          busyToggleRef={(el) => {
            busyToggleRef = el;
          }}
          showBusyMenu={showBusyMenu()}
          onSend={() => handleSend()}
          onToggleBusyMenu={() => {
            const next = !showBusyMenu();
            closePopups(next ? 'busy' : undefined);
            setShowBusyMenu(next);
          }}
          busyMenuRef={(el) => {
            busyMenuRef = el;
          }}
          onQueue={() => {
            handleSend('queue');
            setShowBusyMenu(false);
          }}
          onSteer={() => {
            handleSend('steer');
            setShowBusyMenu(false);
          }}
          onStopAndSend={() => void handleStopAndSend()}
        />
      </div>

      <Show when={previewImage()}>
        <ImagePreviewOverlay
          image={previewImage()}
          onClose={() => setPreviewImageId(null)}
          onPrevious={() => stepImagePreview(-1)}
          onNext={() => stepImagePreview(1)}
          showNavigation={composerClipboardImages().length > 1}
          position={previewImageIndex() + 1}
          total={composerClipboardImages().length}
        />
      </Show>
    </div>
  );
}

function describeUsageLimit(summary: string, retryAt: number | null, attempt: number | null) {
  const parts = [summary];
  if (retryAt) {
    const seconds = Math.max(1, Math.ceil((retryAt - Date.now()) / 1000));
    parts.push(`retry in ${seconds}s`);
  }
  if (attempt) {
    parts.push(`attempt #${attempt}`);
  }
  return parts.join(' · ');
}

function getPastedImageFilename(index: number) {
  return `Image ${index}`;
}

/**
 * Removes the exact span the paste inserted, identified by its recorded offset
 * rather than by searching for its text - a composer that already contained the
 * same mention would otherwise lose the wrong copy. Any edit since the paste
 * (the value no longer matches the snapshot) leaves the text untouched.
 */
function withdrawPastedText(
  insertion: RichComposerPasteInsertion,
  setValue: (value: string) => void,
  setCaret: (caret: number) => void
) {
  if (!insertion.text || inputText() !== insertion.value) return;
  if (insertion.value.slice(insertion.start, insertion.end) !== insertion.text) return;
  setValue(insertion.value.slice(0, insertion.start) + insertion.value.slice(insertion.end));
  setCaret(insertion.start);
}

function clickedOutside(target: Node | null, trigger?: HTMLElement, popup?: HTMLElement) {
  if (!target) return true;
  if (trigger?.contains(target)) return false;
  if (popup?.contains(target)) return false;
  return true;
}

function createAttachmentID() {
  if (typeof crypto !== 'undefined' && 'randomUUID' in crypto) {
    return crypto.randomUUID();
  }
  return `img-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
}
