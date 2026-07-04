import {
  Show,
  batch,
  createEffect,
  createMemo,
  createSignal,
  onCleanup,
  onMount,
  untrack,
} from 'solid-js';
import {
  state,
  inputText,
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
  clearClipboardImages,
  MAX_CLIPBOARD_IMAGES,
  showModelPicker,
  setShowModelPicker,
  setPersistentShowSessionPicker as setShowSessionPicker,
  composerFocusKey,
  removeClipboardImage,
  addContextFile,
  clearContextFiles,
  removeContextFile,
  enqueueMessage,
  removeQueuedMessage,
  getPermissionModeForSession,
  error,
  requestMessageListScrollToBottom,
  getCurrentDocumentEnabled,
  getProviderLimit,
  providerLimitThresholdPercent,
  toggleCurrentDocumentEnabled,
  getActiveUsageLimitNotice,
  isActiveSessionWorking,
  getSessionTreeRootId,
  getSessionTreeIds,
  getStoredVariantForModel,
  setSessionUsageLimit,
  isSessionCompacting,
  providerLimitPollIntervalSeconds,
  replaceClipboardImages,
  replaceContextFiles,
} from '../lib/state';
import { onMessage, postMessage } from '../lib/bridge';
import { serverEvents } from '../lib/client';
import { openProviderSetup } from '../lib/provider-setup';
import {
  applySessionMcps,
  sendMessage,
  abortSession,
  continueInterruptedSession,
  compactSession,
  editMessage,
  initSession,
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
  type MessageEditContext,
} from '../lib/message-edit-state';
import { ModelPicker, getVariantsForModel } from './ModelPicker';
import { McpPicker } from './McpPicker';
import { ralphStore } from '../lib/stores/ralph-store';
import type { RalphSelectedModel } from '../../shared/ralph';
import {
  formatAgentInitial,
  formatAgentLabel,
  formatProviderLimitTitle,
  formatVariantInitial,
  formatVariantLabel,
  getProviderLimitCompactBadges,
  hasProviderLimitWindowWithinThreshold,
  getPrimaryProviderLimitWindow,
} from '../lib/format';
import { getPreferredVariant } from '../lib/model-variants';
import { getContextWindow } from '../lib/message-metrics';
import { getPromptTextForClipboardImages } from '../lib/clipboard-images';
import { modelSupportsVision } from '../lib/model-capabilities';
import {
  getClipboardImageAttachmentSequence,
  getContextFileAttachmentSequence,
} from '../lib/attachment-order';
import { getLeafPathName } from '../lib/path-display';
import {
  formatContextLineRanges,
  getSelectionRangesFromEditorContext,
  hasExplicitContextForPath,
} from '../../shared/context-files';
import { getQueuedAttachmentSnapshot } from '../hooks/session/session-send';
import {
  createComposerHistory,
  getComposerHistoryAction,
  type ComposerHistoryAction,
  type ComposerSnapshot,
} from '../lib/composer-history';
import { TodoList } from './TodoList';
import { ChangedFilesList } from './ChangedFilesList';
import { ImagePreviewOverlay, createImagePreviewEffect, type PreviewImage } from './ImagePreview';
import { AttachmentStrip } from './chat-input/AttachmentStrip';
import { ChatInputMainToolbar, ChatInputMetaToolbar } from './chat-input/ChatInputToolbar';
import { RichComposerArea, type RichComposerChip } from './chat-input/RichComposerArea';
import { DropOverlay } from './chat-input/DropOverlay';
import { QueuedMessages } from './chat-input/QueuedMessages';
import { UsageLimitBanner } from './chat-input/UsageLimitBanner';
import type { DroppedFile, ExtensionMessage } from '../../shared/protocol';
import { DISABLED_PROVIDER_LIMIT_POLL_INTERVAL_SECONDS } from '../../shared/provider-limit-config';
import { createUsageLimitProviderLimit } from '../lib/usage-limit';
import {
  getLatestAssistantMessageInfo,
  getLatestAssistantMessageInfoWithTokens,
  getMessageEntriesForSession,
  getUserMessageHistoryText,
  sumAssistantTokensFromMessageEntries,
} from './chat-input/message-usage';
import {
  TOOLBAR_COMPACT_MODES,
  filterCompactProviderLimitForModel,
  isToolbarControlCompacted,
  isToolbarControlHidden,
  type ToolbarCompactMode,
  type ToolbarControl,
} from './chat-input/toolbar-compact';
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
  addPastedMentionContextFiles,
  getPastedContextFiles,
  getPromptTextWithoutContextReferences,
} from './chat-input/pasted-context';
import {
  acceptQueuedSteer,
  failedSteerQueuedMessageIds,
  getPromptEventText,
  sendQueuedAsSteer,
  steeringQueuedMessageIds,
} from './chat-input/queued-steer';

const COMPOSER_BUSY_DISPLAY_SETTLE_DELAY_MS = 700;

function composerFiles() {
  return state.droppedFiles;
}

function composerClipboardImages() {
  return state.clipboardImages;
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

function activeContextEnabled() {
  return getCurrentDocumentEnabled(state.activeSessionId);
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
    terminalSelection: state.terminalSelection ? { ...state.terminalSelection } : null,
  };
}

function applyEditContext(context: MessageEditContext) {
  replaceContextFiles(context.files);
  replaceClipboardImages(context.images);
  setState(
    'terminalSelection',
    context.terminalSelection ? { ...context.terminalSelection } : null
  );
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

async function sendDroppedContent(droppedFiles: File[]) {
  if (droppedFiles.length === 0) return;
  const MAX_BYTES = 25 * 1024 * 1024;
  const MAX_FILES = 20;

  const payloads: Array<{ name: string; content: string; size: number }> = [];
  for (const file of droppedFiles.slice(0, MAX_FILES)) {
    if (file.size > MAX_BYTES) continue;
    try {
      const base64 = await readFileAsBase64(file);
      payloads.push({ name: file.name, content: base64, size: file.size });
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

  if (payloads.length === 0) return;
  postMessage({ type: 'files/drop-content', payload: { files: payloads } });
}

export function ChatInput() {
  let richEditorRef: HTMLDivElement | undefined;
  let containerRef: HTMLDivElement | undefined;
  let inputFrameRef: HTMLDivElement | undefined;
  let permissionPickerRef: HTMLButtonElement | undefined;
  let permissionPopoverRef: HTMLDivElement | undefined;
  let agentPickerRef: HTMLButtonElement | undefined;
  let agentPopoverRef: HTMLDivElement | undefined;
  let modelPickerRef: HTMLButtonElement | undefined;
  let modelPopoverRef: HTMLDivElement | undefined;
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
  const [agentFocusIndex, setAgentFocusIndex] = createSignal(0);
  const [showBusyMenu, setShowBusyMenu] = createSignal(false);
  const [showVariantPicker, setShowVariantPicker] = createSignal(false);
  const [showPermissionModePicker, setShowPermissionModePicker] = createSignal(false);
  const [showContextPopup, setShowContextPopup] = createSignal(false);
  const [showProviderLimitPopup, setShowProviderLimitPopup] = createSignal(false);
  const [showMcpPicker, setShowMcpPicker] = createSignal(false);

  type PopupKind =
    | 'agent'
    | 'variant'
    | 'model'
    | 'permission'
    | 'context'
    | 'providerLimit'
    | 'busy'
    | 'mcp';
  const closePopups = (except?: PopupKind) => {
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
    showAgentPicker() ||
    showVariantPicker() ||
    showModelPicker() ||
    showMcpPicker() ||
    showPermissionModePicker() ||
    showContextPopup() ||
    showProviderLimitPopup() ||
    showBusyMenu();

  const [isFocused, setIsFocused] = createSignal(false);
  const [historyIndex, setHistoryIndex] = createSignal<number | null>(null);
  const [historyDraft, setHistoryDraft] = createSignal('');
  const [caretPosition, setCaretPosition] = createSignal(0);
  const [completionIndex, setCompletionIndex] = createSignal(0);
  const [fileSearchResults, setFileSearchResults] = createSignal<DroppedFile[]>([]);
  const [showFileSearchHint, setShowFileSearchHint] = createSignal(false);
  const [suppressCompletion, setSuppressCompletion] = createSignal(false);
  const [toolbarCompactMode, setToolbarCompactMode] = createSignal<ToolbarCompactMode>('full');
  let latestFileSearchRequestId = 0;
  let latestFileSearchQuery = '';
  let fileSearchTimer: ReturnType<typeof setTimeout> | null = null;
  let toolbarFitRaf = 0;
  let toolbarFitRequestId = 0;

  function captureComposerSnapshot(): ComposerSnapshot {
    return {
      text: inputText(),
      caret: caretPosition(),
      files: state.droppedFiles.map((file) => ({ ...file })),
      images: state.clipboardImages.map((image) => ({ ...image })),
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
    !!composerActiveFile() || !!composerSelection() || !!composerTerminalSelection();

  const currentModel = createMemo(() => {
    const selected = resolveSelectedModel(
      state.selectedModel,
      state.providers,
      state.providerDefaults
    );
    if (selected) {
      const provider = state.providers.find((item) => item.id === selected.providerID);
      const model = provider?.models[selected.modelID];
      return {
        providerID: selected.providerID,
        modelID: selected.modelID,
        variant: selected.variant || null,
        providerName: provider?.name || selected.providerID,
        modelName: model?.name || selected.modelID,
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
        modelName: model?.name || latestAuto.modelID,
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
          modelName: model.name,
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
          modelName: firstModel.name,
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

  const hasMentions = () => visibleFiles().length > 0 || visibleClipboardImages().length > 0;
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
          icon: 'image',
          disabled: !currentModelSupportsVision(),
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
      activeContextEnabled()
        ? ' · Click to disable current document context'
        : ' · Current document context is disabled. Click to enable it again'
    }`;
  });

  const mentionAgents = createMemo(() =>
    state.allAgents
      .filter((agent) => agent.mode === 'subagent' || agent.mode === 'all')
      .sort((a, b) => a.name.localeCompare(b.name))
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
  const isComposerBusy = createMemo(() => isActiveSessionWorking());
  const [composerBusyDisplayHold, setComposerBusyDisplayHold] =
    createSignal(isActiveSessionWorking());
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
      canUndo: !!state.activeSessionId && state.messages.some((m) => m.info.role === 'assistant'),
      canRedo:
        !!state.activeSessionId &&
        !!state.sessions.find((session) => session.id === state.activeSessionId)?.revert,
      canInit: !state.activeSessionId || state.messages.length === 0,
      onConnectProvider: openProviderSetup,
      onOpenSessions: () => setShowSessionPicker(true),
      onOpenModels: () => setShowModelPicker(true),
      onOpenMcps: () => setShowMcpPicker(true),
      onOpenFiles: () => postMessage({ type: 'files/pick' }),
      onOpenSettings: () =>
        postMessage({ type: 'vscode/open-settings', payload: { query: 'Varro' } }),
      onExportSession: () => {
        if (!state.activeSessionId) return;
        postMessage({ type: 'session/export', payload: { sessionId: state.activeSessionId } });
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

  const mentionCompletions = createMemo(() => {
    const completion = activeCompletion();
    if (completion?.type !== 'mention') return [];

    return getMentionCompletionItems({
      rawQuery: completion.query.trim(),
      source: mentionCompletionSource(),
      meta: { showFileSearchHint: showFileSearchHint() },
    });
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
    return completion.type === 'slash' ? slashCompletions() : mentionCompletions();
  });

  const completionHeader = createMemo(() => {
    if (showFileSearchHint()) return 'Type to search workspace files';
    const completion = activeCompletion();
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
      composerCompletions().length > 0 || (completion.type === 'mention' && showFileSearchHint())
    );
  };

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

    const showingCompletions = composerCompletions().length > 0 && !suppressCompletion();

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
          setSelectedAgent(agent.name, { sessionId: state.activeSessionId });
          setShowAgentPicker(false);
        }
        return;
      }
      if (e.key === 'Escape') {
        e.preventDefault();
        setShowAgentPicker(false);
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
        void applyActiveCompletion(true);
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
        if (editingMessage()) {
          e.preventDefault();
          cancelMessageEdit();
          return;
        }
        if (isBusyWithoutInterruption()) {
          e.preventDefault();
          void abortSession();
          return;
        }
      }
    }

    if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) {
      e.preventDefault();
      if ((e.ctrlKey || e.metaKey) && isComposerBusy() && !editingMessage()) {
        handleSend('steer');
      } else {
        handleSend();
      }
    }
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
    if (completion?.type !== 'mention') return;
    applyMentionValue(completion, completionSelection.value);
  }

  function applyMentionValue(
    completion: Extract<ReturnType<typeof getActiveCompletion>, { type: 'mention' }>,
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
      if ((name === 'abort' || name === 'stop') && !args) {
        return abortSession();
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
    const sendableText = getSendableInputText(text);
    const hasSendableImages = hasSendableClipboardImages();
    if (
      !sendableText.trim() &&
      state.droppedFiles.length === 0 &&
      !hasSendableImages &&
      !state.terminalSelection
    )
      return;

    const queuedAttachments = getQueuedAttachmentSnapshot({
      droppedFiles: state.droppedFiles,
      clipboardImages: state.clipboardImages,
      terminalSelection: state.terminalSelection,
    });

    const hasQueuedAttachments =
      queuedAttachments.droppedFiles?.length ||
      queuedAttachments.clipboardImages?.length ||
      queuedAttachments.terminalSelection;

    const editing = editingMessage();
    if (editing) {
      const hasEditableAttachments =
        state.droppedFiles.length > 0 || hasSendableImages || !!state.terminalSelection;
      if (!sendableText.trim() && !hasEditableAttachments) return;
      const editTargetExists = state.messages.some(
        (entry) => entry.info.role === 'user' && entry.info.id === editing.messageId
      );
      setHistoryIndex(null);
      setHistoryDraft('');
      setCompletionIndex(0);
      const prevError = error();
      setInputText('');
      resetPastedImageIndex();
      resetMessageEditState();
      if (editTargetExists) {
        clearUsageLimitsForSessionTree(state.activeSessionId);
        await editMessage(editing.messageId, text, { allowEmptyText: hasEditableAttachments });
      } else {
        clearUsageLimitsForSessionTree(state.activeSessionId);
        await sendMessage(text);
      }
      if (error() && error() !== prevError) {
        setInputText(text);
      }
      return;
    }

    if (mode !== 'queue' && !hasQueuedAttachments) {
      const ranSlashCommand = await runSlashCommand(text);
      if (ranSlashCommand) return;
    }

    if (
      mode !== 'steer' &&
      mode !== 'after-stop' &&
      isComposerBusy() &&
      !hasActiveQuestion() &&
      !hasActivePermission() &&
      state.activeSessionId &&
      (sendableText.trim() || hasQueuedAttachments)
    ) {
      requestMessageListScrollToBottom();
      enqueueMessage({
        id: createAttachmentID(),
        sessionId: state.activeSessionId,
        text: sendableText,
        droppedFiles: queuedAttachments.droppedFiles,
        clipboardImages: queuedAttachments.clipboardImages,
        terminalSelection: queuedAttachments.terminalSelection,
      });
      setHistoryIndex(null);
      setHistoryDraft('');
      setCompletionIndex(0);
      setInputText('');
      clearContextFiles();
      setState('terminalSelection', null);
      clearClipboardImages();
      resetPastedImageIndex();
      postMessage({ type: 'files/clear' });
      postMessage({ type: 'terminal-selection/clear' });
      return;
    }

    setHistoryIndex(null);
    setHistoryDraft('');
    setCompletionIndex(0);
    const prevError = error();
    setInputText('');
    resetPastedImageIndex();
    clearUsageLimitsForSessionTree(state.activeSessionId);
    await sendMessage(text, mode === 'steer' ? { delivery: 'steer' } : { noReply: false });
    if (error() && error() !== prevError) {
      setInputText(text);
    }
  }

  let queueDispatchTimer: ReturnType<typeof setTimeout> | 0 = 0;
  createEffect(() => {
    const sessionId = state.activeSessionId;
    const loading = isComposerBusy();
    const activeQuestion = hasActiveQuestion();
    const activePermission = hasActivePermission();
    const steeringIds = steeringQueuedMessageIds();
    const failedSteerIds = failedSteerQueuedMessageIds();
    const hasSteeringQueued = state.queuedMessages.some(
      (item) => item.sessionId === sessionId && steeringIds.has(item.id)
    );
    const hasQueued = state.queuedMessages.some(
      (item) =>
        item.sessionId === sessionId && !steeringIds.has(item.id) && !failedSteerIds.has(item.id)
    );
    if (queueDispatchTimer) {
      clearTimeout(queueDispatchTimer);
      queueDispatchTimer = 0;
    }
    if (
      !sessionId ||
      loading ||
      activeQuestion ||
      activePermission ||
      hasSteeringQueued ||
      !hasQueued
    )
      return;
    queueDispatchTimer = setTimeout(() => {
      queueDispatchTimer = 0;
      if (isComposerBusy() || hasActiveQuestion() || hasActivePermission()) return;
      const sid = state.activeSessionId;
      if (!sid) return;
      const currentSteeringIds = steeringQueuedMessageIds();
      const currentFailedSteerIds = failedSteerQueuedMessageIds();
      if (
        state.queuedMessages.some(
          (item) => item.sessionId === sid && currentSteeringIds.has(item.id)
        )
      )
        return;
      const next = state.queuedMessages.find(
        (item) =>
          item.sessionId === sid &&
          !currentSteeringIds.has(item.id) &&
          !currentFailedSteerIds.has(item.id)
      );
      if (!next) return;
      removeQueuedMessage(next.id);
      void sendMessage(next.text, {
        queuedAttachments: {
          droppedFiles: next.droppedFiles,
          clipboardImages: next.clipboardImages,
          terminalSelection: next.terminalSelection,
        },
        preserveComposer: true,
      });
    }, 250);
  });
  const queuedSteerAdmissionCleanups = [
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

  function replaceComposerSelection(value: string, padWithSpaces = false) {
    const text = inputText();
    const selectionStart = caretPosition();
    const selectionEnd = selectionStart;
    const prefix = padWithSpaces && shouldPadInlineInsertion(text[selectionStart - 1]) ? ' ' : '';
    const suffix = padWithSpaces ? getInlineInsertionSuffix(text, selectionEnd) : '';
    const insertedValue = `${prefix}${value}${suffix}`;
    const nextValue = `${text.slice(0, selectionStart)}${insertedValue}${text.slice(selectionEnd)}`;
    const nextCaret = selectionStart + insertedValue.length;

    batch(() => {
      setHistoryIndex(null);
      setHistoryDraft('');
      setInputText(nextValue);
      setCaretPosition(nextCaret);
      setCompletionIndex(0);
      setSuppressCompletion(false);
    });

    queueMicrotask(() => {
      if (richEditorRef) {
        richEditorRef.focus();
      }
    });
  }

  const messageHistory = createMemo(() =>
    state.messages
      .filter((entry) => entry.info.role === 'user')
      .map((entry) => getUserMessageHistoryText(entry.parts))
      .filter((text): text is string => !!text)
  );

  function navigateMessageHistory(direction: -1 | 1) {
    const history = messageHistory();
    if (history.length === 0) return false;

    const currentIndex = historyIndex();
    if (currentIndex === null && inputText().length > 0) return false;

    if (currentIndex === null) {
      setHistoryDraft(inputText());
    }

    const nextIndex =
      currentIndex === null
        ? direction === -1
          ? history.length - 1
          : null
        : currentIndex + direction;

    if (nextIndex === null) return false;

    if (nextIndex < 0) {
      return false;
    }

    if (nextIndex >= history.length) {
      setHistoryIndex(null);
      setComposerValue(historyDraft());
      return true;
    }

    setHistoryIndex(nextIndex);
    setComposerValue(history[nextIndex]!);
    return true;
  }

  function getToolbarGap() {
    if (!toolbarRef) return 0;
    const styles = window.getComputedStyle(toolbarRef);
    const rawGap = styles.columnGap || styles.gap || '0';
    const gap = Number.parseFloat(rawGap);
    return Number.isFinite(gap) ? gap : 0;
  }

  function isToolbarOverflowing() {
    if (!toolbarRef || !toolbarLeftRef || !toolbarRightRef) return false;
    const leftWidth = toolbarLeftRef.scrollWidth;
    const rightWidth = toolbarRightRef.getBoundingClientRect().width;
    return leftWidth + rightWidth + getToolbarGap() > toolbarRef.clientWidth + 1;
  }

  function fitToolbar(modeIndex: number, requestId: number) {
    if (requestId !== toolbarFitRequestId) return;
    const nextMode = TOOLBAR_COMPACT_MODES[Math.min(modeIndex, TOOLBAR_COMPACT_MODES.length - 1)]!;
    setToolbarCompactMode(nextMode);
    queueMicrotask(() => {
      if (requestId !== toolbarFitRequestId) return;
      if (!isToolbarOverflowing() || modeIndex >= TOOLBAR_COMPACT_MODES.length - 1) return;
      fitToolbar(modeIndex + 1, requestId);
    });
  }

  function scheduleToolbarFit() {
    if (toolbarFitRaf) cancelAnimationFrame(toolbarFitRaf);
    const requestId = ++toolbarFitRequestId;
    toolbarFitRaf = requestAnimationFrame(() => {
      toolbarFitRaf = 0;
      fitToolbar(0, requestId);
    });
  }

  async function handleDrop(e: DragEvent) {
    e.preventDefault();
    e.stopPropagation();
    setIsDraggingOver(false);

    const dataTransfer = e.dataTransfer;
    if (!dataTransfer) return;

    // Snapshot File objects now - DataTransfer is invalidated after the drop
    // event returns, so FileReader fallback later wouldn't see them otherwise.
    const droppedFiles = Array.from(dataTransfer.files || []);

    const paths = await collectDroppedPaths(dataTransfer);
    if (paths.length > 0) {
      postMessage({ type: 'files/drop', payload: { paths } });
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
    await sendDroppedContent(droppedFiles);
  }

  async function handlePaste(e: ClipboardEvent) {
    const clipboardData = e.clipboardData;
    if (!clipboardData) return;

    const pastedText = clipboardData.getData('text/plain');
    const pastedContextFiles = getPastedContextFiles(pastedText, state.editorContext.workspacePath);
    const pastedPromptText = getPromptTextWithoutContextReferences(pastedText);
    const pasteHandledAsContextOnly =
      pastedContextFiles.length > 0 && pastedPromptText.length === 0;
    if (pastedContextFiles.length > 0) {
      for (const file of pastedContextFiles) {
        addContextFile(file);
      }
      (e as ClipboardEvent & { __varroPasteText?: string }).__varroPasteText = pastedPromptText;
      if (pasteHandledAsContextOnly) {
        e.preventDefault();
      }
    }

    void addPastedMentionContextFiles(pastedText);

    const imageItems = Array.from(clipboardData.items).filter(
      (item) => item.kind === 'file' && item.type.startsWith('image/')
    );

    if (imageItems.length === 0) return;

    e.preventDefault();

    const availableSlots = Math.max(0, MAX_CLIPBOARD_IMAGES - state.clipboardImages.length);
    if (availableSlots === 0) return;

    const attachableItems = imageItems.slice(0, availableSlots);
    const nextIndex = nextPastedImageIndex();
    let acceptedImageCount = 0;
    const insertedPlaceholders: string[] = [];

    for (const [index, item] of attachableItems.entries()) {
      const file = item.getAsFile();
      if (!file) continue;

      const filename = getPastedImageFilename(nextIndex + index);
      const url = await readFileAsDataUrl(file);
      const didAddImage = addClipboardImage({
        id: createAttachmentID(),
        url,
        mime: file.type || 'image/png',
        filename,
        size: file.size,
        contentKey: url,
      });

      if (!didAddImage) continue;

      acceptedImageCount += 1;
      insertedPlaceholders.push(filename);
    }

    setNextPastedImageIndex(nextIndex + acceptedImageCount);

    if (insertedPlaceholders.length === 0 || inputText().trim().length === 0) return;

    replaceComposerSelection(
      insertedPlaceholders.map((filename) => `[${filename}]`).join(' '),
      true
    );
  }

  onMount(() => {
    const disposeBridge = onMessage((msg: ExtensionMessage) => {
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
      if (showModelPicker() && clickedOutside(target, modelPickerRef, modelPopoverRef)) {
        setShowModelPicker(false);
      }
      if (showMcpPicker() && target && !mcpPopoverRef?.contains(target)) {
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
      e.preventDefault();
      setIsDraggingOver(false);
      await handleDrop(e);
    };

    const handleWindowDragLeave = (e: DragEvent) => {
      if (e.relatedTarget) return;
      setIsDraggingOver(false);
    };

    window.addEventListener('click', handleWindowClick, true);
    document.addEventListener('dragenter', beginDropTarget, true);
    document.addEventListener('dragover', handleWindowDragOver, true);
    document.addEventListener('drop', handleWindowDrop, true);
    document.addEventListener('dragleave', handleWindowDragLeave, true);

    onCleanup(() => {
      disposeBridge();
      window.removeEventListener('click', handleWindowClick, true);
      document.removeEventListener('dragenter', beginDropTarget, true);
      document.removeEventListener('dragover', handleWindowDragOver, true);
      document.removeEventListener('drop', handleWindowDrop, true);
      document.removeEventListener('dragleave', handleWindowDragLeave, true);
    });
  });

  onMount(() => {
    if (!toolbarRef) return;
    const observer = new ResizeObserver(() => {
      if (
        showAgentPicker() ||
        showVariantPicker() ||
        showModelPicker() ||
        showMcpPicker() ||
        showPermissionModePicker()
      )
        return;
      if (showBusyMenu() || showContextPopup() || showProviderLimitPopup()) return;
      scheduleToolbarFit();
    });
    observer.observe(toolbarRef);

    onCleanup(() => {
      observer.disconnect();
      toolbarFitRequestId += 1;
      if (toolbarFitRaf) cancelAnimationFrame(toolbarFitRaf);
    });
  });

  createEffect(() => {
    void state.activeSessionId;
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
    const editing = editingMessage();
    if (!editing) {
      activeEditMessageId = null;
      return;
    }
    if (editing.messageId === activeEditMessageId) return;
    if (activeEditMessageId === null && !getMessageEditDraftBackup()) {
      setMessageEditDraftBackup(untrack(captureEditDraftBackup));
    }
    activeEditMessageId = editing.messageId;
    applyEditContext(editing.context);
    setComposerValue(editing.text);
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
      applyEditContext(draft);
      setComposerValue(draft.text);
    } else {
      setComposerValue('');
    }
  }

  createEffect(() => {
    const editing = editingMessage();
    if (editing && state.activeSessionId !== editing.sessionId) {
      cancelMessageEdit();
    }
  });

  function currentModelSupportsVision() {
    const current = currentModel();
    if (!current.providerID || !current.modelID) return true;
    return modelSupportsVision(current.providerID, current.modelID, state.providers);
  }

  function hasSendableClipboardImages() {
    return currentModelSupportsVision() && state.clipboardImages.length > 0;
  }

  function getSendableInputText(text = inputText()) {
    return getPromptTextForClipboardImages(
      text,
      state.clipboardImages,
      currentModelSupportsVision()
    );
  }

  const canSend = () =>
    !hasActiveQuestion() &&
    !hasActivePermission() &&
    (getSendableInputText().trim().length > 0 ||
      state.droppedFiles.length > 0 ||
      hasSendableClipboardImages() ||
      !!state.terminalSelection);
  const isBusyWithoutInterruption = createMemo(
    () => isComposerBusy() && !hasActiveQuestion() && !hasActivePermission()
  );
  const isDisplayBusyWithoutInterruption = createMemo(
    () => isComposerDisplayBusy() && !hasActiveQuestion() && !hasActivePermission()
  );
  const showBusySendControls = createMemo(
    () => isBusyWithoutInterruption() && canSend() && !editingMessage()
  );

  const clipboardImagesDisabled = () =>
    composerClipboardImages().length > 0 && !currentModelSupportsVision();

  const currentSessionMessageEntries = createMemo(() =>
    getMessageEntriesForSession(state.messages, state.activeSessionId)
  );

  const contextUsage = createMemo(() => {
    const best = getLatestAssistantMessageInfoWithTokens(currentSessionMessageEntries(), {
      includeSubagents: true,
    });
    if (!best) return null;
    const ctx = getContextWindow(best, state.providers);
    if (!ctx) return null;
    return ctx;
  });

  const sessionTokens = createMemo(() =>
    sumAssistantTokensFromMessageEntries(currentSessionMessageEntries())
  );

  const activeUsageLimit = createMemo(() => {
    const activeSessionId = state.activeSessionId;
    for (const sessionId of getSessionTreeIdsForSession(activeSessionId)) {
      void state.sessionUsageLimits[sessionId];
    }
    return getActiveUsageLimitNotice(activeSessionId);
  });
  const showProviderLimits = createMemo(
    () => providerLimitPollIntervalSeconds() !== DISABLED_PROVIDER_LIMIT_POLL_INTERVAL_SECONDS
  );
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
  const showCurrentProviderLimit = createMemo(
    () =>
      showProviderLimits() &&
      hasProviderLimitWindowWithinThreshold(
        currentCompactProviderLimit(),
        providerLimitThresholdPercent()
      )
  );

  const currentProviderLimitTitle = createMemo(() =>
    showCurrentProviderLimit() ? formatProviderLimitTitle(currentCompactProviderLimit()) : null
  );
  const currentProviderLimitBadges = createMemo(() =>
    showCurrentProviderLimit() ? getProviderLimitCompactBadges(currentCompactProviderLimit()) : []
  );
  createEffect(() => {
    if (!showCurrentProviderLimit() && showProviderLimitPopup()) {
      setShowProviderLimitPopup(false);
    }
  });
  const visibleUsageLimit = createMemo(() => {
    const notice = activeUsageLimit();
    if (!notice) return null;

    const current = currentModel();
    const hasActiveAssistantContext = getLatestAssistantMessageInfo(state.messages) !== null;
    if (!notice.providerID && !notice.modelID) return notice;
    if (hasActiveAssistantContext && notice.source === 'status') return notice;
    if (notice.providerID && notice.providerID !== current.providerID) return null;
    if (notice.modelID && notice.modelID !== current.modelID) return null;
    return notice;
  });
  const activeUsageLimitWindow = createMemo(() =>
    getPrimaryProviderLimitWindow(createUsageLimitProviderLimit(visibleUsageLimit()))
  );
  const activeRalphManagerSessionId = createMemo(() =>
    ralphStore.isRalphSession(state.activeSessionId)
      ? state.activeSessionId
      : ralphStore.findManagerSessionIdForChild(state.activeSessionId)
  );
  const activeRalphRun = createMemo(() => ralphStore.getRun(activeRalphManagerSessionId()));

  const availableVariants = createMemo(() => {
    const model = currentModel();
    return getVariantsForModel(model.providerID, model.modelID, state.providers);
  });

  const effectiveVariant = createMemo(() => {
    const variants = availableVariants();
    if (variants.length === 0) return null;
    if (currentModel().variant && variants.includes(currentModel().variant!)) {
      return currentModel().variant;
    }

    const rememberedVariant = getStoredVariantForModel(
      currentModel().providerID,
      currentModel().modelID
    );
    if (rememberedVariant && variants.includes(rememberedVariant)) return rememberedVariant;

    return (
      getPreferredVariant(currentModel().providerID, currentModel().modelID, state.providers) ||
      variants[0]
    );
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
    hasQuestion: hasActiveQuestion(),
    hasPermission: hasActivePermission(),
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

  const activePermissionMode = createMemo(() => getPermissionModeForSession(state.activeSessionId));

  function syncActiveRalphModel(nextModel: RalphSelectedModel) {
    const managerSessionId = activeRalphManagerSessionId();
    if (!managerSessionId) return;
    ralphStore.updateRunModel(managerSessionId, nextModel);
  }

  async function handleSelectedModelChange(nextModel: RalphSelectedModel) {
    const activeRun = activeRalphRun();
    const activeRunWasRunning = activeRun?.status === 'running';
    const previousRalphModel = activeRun?.config.model ?? null;
    const currentSelection = {
      providerID: state.selectedModel?.providerID,
      modelID: state.selectedModel?.modelID,
      variant: state.selectedModel?.variant,
    };

    setSelectedModel(nextModel, { sessionId: state.activeSessionId });
    syncActiveRalphModel(nextModel);

    const usageLimit = activeUsageLimit();
    const visibleLimit = visibleUsageLimit();
    const activeSessionId = state.activeSessionId;
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

    if (activeRunWasRunning && retryingSessionIds.includes(activeSessionId)) {
      ralphStore.setStatus(activeRun.config.managerSessionId, 'paused');
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

    if (retryingSessionIds.length > 0) {
      abortSession()
        .catch(() => {})
        .finally(() => {
          if (shouldResumeActiveSession) {
            continueInterruptedSession(activeSessionId).catch(() => {});
          }
        });
    }
  }

  async function handleUsageLimitContinue() {
    if (!state.activeSessionId) return;
    closePopups();
    clearUsageLimitsForSessionTree(state.activeSessionId);
    await sendMessage('Continue', { noReply: false });
  }

  const queuedForSession = createMemo(() =>
    state.activeSessionId
      ? state.queuedMessages.filter((item) => item.sessionId === state.activeSessionId)
      : []
  );

  const showInputTopGradient = createMemo(
    () =>
      queuedForSession().length === 0 &&
      state.todos.length === 0 &&
      !visibleUsageLimit() &&
      !showModelPicker() &&
      !showContextPopup() &&
      !showAgentPicker() &&
      !showVariantPicker() &&
      !showMcpPicker() &&
      !showPermissionModePicker() &&
      !showBusyMenu() &&
      !(isFocused() && showCompletionMenu())
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
    if (!variant) return '';
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

    scheduleToolbarFit();
  });

  return (
    <div
      class={`interactive-input-part ${showInputTopGradient() ? 'input-top-gradient' : ''}${editingMessage() ? ' editing-message' : ''}`}
    >
      <Show when={isDraggingOver()}>
        <DropOverlay />
      </Show>

      <Show when={queuedForSession().length > 0 && !editingMessage()}>
        <QueuedMessages
          items={queuedForSession()}
          steeringItemIds={steeringQueuedMessageIds()}
          failedSteerItemIds={failedSteerQueuedMessageIds()}
          onSendAsSteer={sendQueuedAsSteer}
          onRemove={removeQueuedMessage}
        />
      </Show>

      <Show when={state.todos.length > 0 && !showModelPicker() && !editingMessage()}>
        <TodoList />
      </Show>

      <Show when={!showModelPicker() && !editingMessage()}>
        <ChangedFilesList />
      </Show>

      <Show when={editingMessage()}>
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

      <Show when={visibleUsageLimit()}>
        <UsageLimitBanner
          message={visibleUsageLimit()!.message}
          meta={describeUsageLimit(activeUsageLimitWindow(), visibleUsageLimit()?.attempt ?? null)}
          primaryActionLabel="Continue"
          onPrimaryAction={() => void handleUsageLimitContinue()}
          showStopRetrying={isComposerBusy() && !hasActiveQuestion() && !hasActivePermission()}
          onStopRetrying={() => abortSession()}
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
          <ModelPicker
            onSelect={(sel) => {
              if (sel.providerID && sel.modelID) {
                const matchedVariant =
                  sel.variant ||
                  getStoredVariantForModel(sel.providerID, sel.modelID) ||
                  getPreferredVariant(sel.providerID, sel.modelID, state.providers) ||
                  undefined;
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
        </Show>

        <Show when={showMcpPicker()}>
          <McpPicker
            sessionId={state.activeSessionId}
            onChange={(names) => void applySessionMcps(names)}
            onClose={() => setShowMcpPicker(false)}
            popoverRef={(el) => (mcpPopoverRef = el)}
          />
        </Show>

        <div
          ref={(el) => {
            inputFrameRef = el;
          }}
          class={`chat-input-container ${isFocused() ? 'focused' : ''} ${showModelPicker() || showMcpPicker() ? 'showing-model-picker' : ''} ${showAgentPicker() || showVariantPicker() || showMcpPicker() || showBusyMenu() || (isFocused() && showCompletionMenu()) ? 'showing-context-popup' : ''}`}
          onDragEnter={(e) => {
            e.preventDefault();
            e.stopPropagation();
            if (e.dataTransfer) e.dataTransfer.dropEffect = 'copy';
            setIsDraggingOver(true);
          }}
          onDragOver={(e) => {
            e.preventDefault();
            e.stopPropagation();
            if (e.dataTransfer) e.dataTransfer.dropEffect = 'copy';
            setIsDraggingOver(true);
          }}
          onDragLeave={(e) => {
            if (e.currentTarget.contains(e.relatedTarget as Node | null)) return;
            setIsDraggingOver(false);
          }}
          onDrop={handleDrop}
        >
          <Show when={hasContext() || hasMentions()}>
            <AttachmentStrip
              activeContext={activeContext()}
              activeContextEnabled={activeContextEnabled()}
              activeContextTitle={activeContextTitle()}
              terminalSelection={composerTerminalSelection()}
              files={visibleFiles()}
              clipboardImages={visibleClipboardImages()}
              clipboardImagesDisabled={clipboardImagesDisabled()}
              onToggleActiveContext={() => toggleCurrentDocumentEnabled(state.activeSessionId)}
              onClearTerminalSelection={() => postMessage({ type: 'terminal-selection/clear' })}
              onRemoveFile={(path) => {
                removeContextFile(path);
                postMessage({ type: 'files/remove', payload: { path } });
              }}
              onRemoveClipboardImage={removeClipboardImage}
              onOpenFile={openContextFileInEditor}
              onPreviewImage={(image) => setPreviewImageId(image.id)}
            />
          </Show>

          <RichComposerArea
            editorRef={(el) => {
              richEditorRef = el;
            }}
            placeholder={
              editingMessage()
                ? 'Edit your message'
                : hasActiveQuestion() || hasActivePermission()
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
              setHistoryIndex(null);
              setHistoryDraft('');
              setInputText(text);
              setCaretPosition(cursorOffset);
              setCompletionIndex(0);
              setSuppressCompletion(false);
            }}
            onKeyDown={handleKeydown}
            onHistory={applyComposerHistoryAction}
            onPaste={handlePaste}
            onFocus={() => {
              setIsFocused(true);
            }}
            onBlur={() => setIsFocused(false)}
            onClick={(cursorOffset) => {
              setCaretPosition(cursorOffset);
              setShowAgentPicker(false);
              setShowModelPicker(false);
              setShowMcpPicker(false);
              setShowVariantPicker(false);
              setShowPermissionModePicker(false);
              setShowBusyMenu(false);
            }}
            onKeyUp={(cursorOffset) => setCaretPosition(cursorOffset)}
            onSelect={(cursorOffset) => setCaretPosition(cursorOffset)}
            onRemoveChip={(chipId) => {
              if (chipId.startsWith('file:')) {
                const path = chipId.slice(5);
                removeContextFile(path);
                postMessage({ type: 'files/remove', payload: { path } });
              } else if (chipId.startsWith('img:')) {
                const id = chipId.slice(4);
                removeClipboardImage(id);
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
              if (completion?.type !== 'mention') return;
              applyMentionValue(completion, completionSelection.value);
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
            showLeftPopupState={showAgentPicker() || showVariantPicker()}
            showPermissionControl={true}
            permissionButtonRef={(el) => {
              permissionPickerRef = el;
            }}
            permissionPopoverRef={(el) => {
              permissionPopoverRef = el;
            }}
            permissionMode={activePermissionMode()}
            showPermissionPicker={showPermissionModePicker()}
            onTogglePermissionPicker={() => {
              const next = !showPermissionModePicker();
              closePopups(next ? 'permission' : undefined);
              setShowPermissionModePicker(next);
            }}
            onSelectPermissionMode={(mode) => {
              void updatePermissionModeForSession(mode);
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
              setSelectedAgent(agent.name, { sessionId: state.activeSessionId });
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
              void handleSelectedModelChange({
                providerID: m.providerID!,
                modelID: m.modelID!,
                variant,
              });
              setShowVariantPicker(false);
            }}
            contextUsage={contextUsage()}
            showContextControl={!!contextUsage()}
            contextButtonRef={(el) => {
              contextButtonRef = el;
            }}
            contextPopupRef={(el) => {
              contextPopupRef = el;
            }}
            showContextPopup={showContextPopup()}
            sessionTokens={sessionTokens()}
            contextCompactDisabled={isComposerBusy() || isSessionCompacting()}
            onToggleContextPopup={() => {
              const next = !showContextPopup();
              closePopups(next ? 'context' : undefined);
              setShowContextPopup(next);
            }}
            onCloseContextPopup={() => setShowContextPopup(false)}
            onCompactSession={() => {
              void compactSession();
            }}
            showAttachmentsControl={isToolbarControlVisible('attachments')}
            onAttach={() => postMessage({ type: 'files/pick' })}
            showStopButton={showStopButton()}
            onStop={() => abortSession()}
            showSendControl={showSendControl()}
            showBusySendControls={showBusySendControls()}
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
            onStopAndSend={async () => {
              await abortSession();
              await handleSend('after-stop');
              setShowBusyMenu(false);
            }}
          />
        </div>

        <ChatInputMetaToolbar
          compactTight={toolbarCompactMode() === 'tight'}
          inputFrameRef={inputFrameRef}
          showPermissionControl={!editingMessage()}
          permissionButtonRef={(el) => {
            permissionPickerRef = el;
          }}
          permissionPopoverRef={(el) => {
            permissionPopoverRef = el;
          }}
          permissionMode={activePermissionMode()}
          showPermissionPicker={showPermissionModePicker()}
          onTogglePermissionPicker={() => {
            const next = !showPermissionModePicker();
            closePopups(next ? 'permission' : undefined);
            setShowPermissionModePicker(next);
          }}
          onSelectPermissionMode={(mode) => {
            void updatePermissionModeForSession(mode);
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
            setSelectedAgent(agent.name, { sessionId: state.activeSessionId });
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
          providerLimitBadges={editingMessage() ? [] : currentProviderLimitBadges()}
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
            void handleSelectedModelChange({
              providerID: m.providerID!,
              modelID: m.modelID!,
              variant,
            });
            setShowVariantPicker(false);
          }}
          contextUsage={contextUsage()}
          showContextControl={!!contextUsage() && !editingMessage()}
          contextButtonRef={(el) => {
            contextButtonRef = el;
          }}
          contextPopupRef={(el) => {
            contextPopupRef = el;
          }}
          showContextPopup={showContextPopup()}
          sessionTokens={sessionTokens()}
          contextCompactDisabled={isComposerBusy() || isSessionCompacting()}
          onToggleContextPopup={() => {
            const next = !showContextPopup();
            closePopups(next ? 'context' : undefined);
            setShowContextPopup(next);
          }}
          onCloseContextPopup={() => setShowContextPopup(false)}
          onCompactSession={() => {
            void compactSession();
          }}
          showAttachmentsControl={isToolbarControlVisible('attachments')}
          onAttach={() => postMessage({ type: 'files/pick' })}
          showStopButton={showStopButton()}
          onStop={() => abortSession()}
          showSendControl={showSendControl()}
          showBusySendControls={showBusySendControls()}
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
          onStopAndSend={() => {
            abortSession();
            handleSend();
            setShowBusyMenu(false);
          }}
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

function describeUsageLimit(
  window: ReturnType<typeof getPrimaryProviderLimitWindow>,
  attempt: number | null
) {
  const parts: string[] = [];
  if (window?.label) {
    parts.push(`${window.label.toLowerCase()} exhausted`);
  }
  if (window?.resetAt) {
    const seconds = Math.max(1, Math.ceil((window.resetAt - Date.now()) / 1000));
    parts.push(`retry in ${seconds}s`);
  }
  if (attempt) {
    parts.push(`attempt #${attempt}`);
  }
  return parts.join(' · ');
}

function getPastedImageFilename(index: number) {
  return index <= 1 ? 'Image' : `Image ${index}`;
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
