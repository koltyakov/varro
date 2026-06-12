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
import { Portal } from 'solid-js/web';
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
  showThinking,
  toggleThinking,
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
  getSessionTreeIds,
  getStoredVariantForModel,
  setSessionUsageLimit,
  isSessionCompacting,
  providerLimitPollIntervalSeconds,
  replaceClipboardImages,
  replaceContextFiles,
} from '../lib/state';
import { onMessage, postMessage } from '../lib/bridge';
import { startNewChatDraft } from '../lib/new-chat-draft';
import { client } from '../lib/client';
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
  runSlashCommandByName,
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
import {
  isAssistantMessage,
  getContextWindow,
  getAssistantTotalTokens,
  type TokenUsage,
} from '../lib/message-metrics';
import { getPromptTextForClipboardImages } from '../lib/clipboard-images';
import { modelSupportsVision } from '../lib/model-capabilities';
import {
  getClipboardImageAttachmentSequence,
  getContextFileAttachmentSequence,
} from '../lib/attachment-order';
import {
  getLeafPathName,
  getWorkspaceRelativePath,
  isAbsolutePath,
  normalizePath,
} from '../lib/path-display';
import {
  formatContextLineRanges,
  getSelectionRangesFromEditorContext,
  hasExplicitContextForPath,
  mergeContextFile,
  parseSelectionReference,
} from '../../shared/context-files';
import { getQueuedAttachmentSnapshot } from '../hooks/session/session-send';
import {
  createComposerHistory,
  getComposerHistoryAction,
  type ComposerHistoryAction,
  type ComposerSnapshot,
} from '../lib/composer-history';
import { TodoList } from './TodoList';
import { ImagePreviewOverlay, createImagePreviewEffect, type PreviewImage } from './ImagePreview';
import { AttachmentStrip } from './chat-input/AttachmentStrip';
import { ChatInputMainToolbar, ChatInputMetaToolbar } from './chat-input/ChatInputToolbar';
import { RichComposerArea, type RichComposerChip } from './chat-input/RichComposerArea';
import { DropOverlay } from './chat-input/DropOverlay';
import { QueuedMessages } from './chat-input/QueuedMessages';
import { UsageLimitBanner } from './chat-input/UsageLimitBanner';
import type {
  CompletionItem,
  MentionCompletionItem,
  SlashCommand,
} from './chat-input/CompletionMenu';
import type { Agent, AssistantMessage, Command, Message, Part, TextPart } from '../types';
import type { DroppedFile, ExtensionMessage, ProviderLimitStatus } from '../../shared/protocol';
import { DISABLED_PROVIDER_LIMIT_POLL_INTERVAL_SECONDS } from '../../shared/provider-limit-config';
import { createUsageLimitProviderLimit } from '../lib/usage-limit';

type ToolbarControl =
  | 'permission'
  | 'attachments'
  | 'send'
  | 'reasoning'
  | 'agent'
  | 'stop'
  | 'context';
type ToolbarCompactMode =
  | 'full'
  | 'compact-provider-limit'
  | 'compact-stop'
  | 'compact-agent'
  | 'compact-reasoning'
  | 'truncate-model'
  | 'hide-permission'
  | 'hide-attachments'
  | 'hide-send'
  | 'hide-reasoning'
  | 'hide-agent'
  | 'hide-stop'
  | 'hide-context'
  | 'tight';

type MentionCompletionMeta = {
  showFileSearchHint: boolean;
};

type AgentMentionCompletionItem = Extract<MentionCompletionItem, { type: 'agent' }>;
type FileMentionCompletionItem = Extract<MentionCompletionItem, { type: 'file' }>;

type MentionAgentEntry = {
  item: AgentMentionCompletionItem;
  normalizedName: string;
  normalizedDescription: string;
};

type MentionFileEntry = {
  item: FileMentionCompletionItem;
  normalizedPath: string;
};

type MentionCompletionSource = {
  agentEntries: MentionAgentEntry[];
  fileEntries: MentionFileEntry[];
  exactAgentNames: ReadonlySet<string>;
  exactFilePaths: ReadonlySet<string>;
};

type MessageInfoEntry = { info: Message };

export function getLatestAssistantMessageInfo(
  messages: readonly MessageInfoEntry[]
): AssistantMessage | null {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const info = messages[index]?.info;
    if (!info || !isAssistantMessage(info)) continue;
    if (info.mode === 'subagent') continue;
    return info;
  }
  return null;
}

export function getLatestAssistantMessageInfoWithTokens(
  messages: readonly MessageInfoEntry[]
): AssistantMessage | null {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const info = messages[index]?.info;
    if (!info || !isAssistantMessage(info)) continue;
    if (info.mode === 'subagent') continue;
    if ((info.tokens.input || 0) + (info.tokens.output || 0) > 0) return info;
  }
  return null;
}

export function sumAssistantTokensFromMessageEntries(
  messages: readonly MessageInfoEntry[]
): TokenUsage {
  const result: TokenUsage = {
    total: 0,
    input: 0,
    output: 0,
    reasoning: 0,
    cacheRead: 0,
    cacheWrite: 0,
  };

  for (const entry of messages) {
    const info = entry.info;
    if (!isAssistantMessage(info)) continue;
    result.total += getAssistantTotalTokens(info);
    result.input += info.tokens.input || 0;
    result.output += info.tokens.output || 0;
    result.reasoning += info.tokens.reasoning || 0;
    result.cacheRead += info.tokens.cache?.read || 0;
    result.cacheWrite += info.tokens.cache?.write || 0;
  }

  return result;
}

type CompletionSelection =
  | { type: 'set-slash'; value: string }
  | { type: 'run-slash'; value: string }
  | { type: 'apply-mention'; value: string; file?: DroppedFile };

const SKILLS_COMMAND_NAME = 'skills';

const TOOLBAR_HIDE_ORDER: ToolbarControl[] = [
  'permission',
  'attachments',
  'send',
  'reasoning',
  'agent',
  'stop',
  'context',
];

const TOOLBAR_COMPACT_MODES: ToolbarCompactMode[] = [
  'full',
  'compact-provider-limit',
  'compact-stop',
  'compact-agent',
  'compact-reasoning',
  'truncate-model',
  'hide-permission',
  'hide-attachments',
  'hide-send',
  'hide-reasoning',
  'hide-agent',
  'hide-stop',
  'hide-context',
  'tight',
];

export function isToolbarControlHidden(mode: ToolbarCompactMode, control: ToolbarControl) {
  const hiddenControlCount =
    mode === 'hide-permission'
      ? 1
      : mode === 'hide-attachments'
        ? 2
        : mode === 'hide-send'
          ? 3
          : mode === 'hide-reasoning'
            ? 4
            : mode === 'hide-agent'
              ? 5
              : mode === 'hide-stop'
                ? 6
                : mode === 'hide-context' || mode === 'tight'
                  ? 7
                  : 0;
  const hiddenControlIndex = TOOLBAR_HIDE_ORDER.indexOf(control);
  return hiddenControlIndex !== -1 && hiddenControlIndex < hiddenControlCount;
}

export function isToolbarControlCompacted(
  mode: ToolbarCompactMode,
  control: 'agent' | 'reasoning' | 'stop'
) {
  if (control === 'agent')
    return !['full', 'compact-provider-limit', 'compact-stop'].includes(mode);
  if (control === 'reasoning')
    return !['full', 'compact-provider-limit', 'compact-stop', 'compact-agent'].includes(mode);
  return [
    'compact-provider-limit',
    'compact-stop',
    'compact-agent',
    'compact-reasoning',
    'truncate-model',
    'hide-permission',
    'hide-attachments',
    'hide-send',
    'hide-reasoning',
    'hide-agent',
    'hide-stop',
    'hide-context',
    'tight',
  ].includes(mode);
}

function filterCompactProviderLimitForModel(
  limit: ProviderLimitStatus | null | undefined,
  modelID: string | null | undefined,
  modelName: string | null | undefined
): ProviderLimitStatus | null {
  if (!limit || limit.status !== 'available') return limit ?? null;

  const isSparkModel = isCodexSparkModelLabel(modelID) || isCodexSparkModelLabel(modelName);
  const windows = limit.windows.filter((window) => {
    const isSparkWindow = window.id.toLowerCase().includes('spark');
    return isSparkModel ? isSparkWindow : !isSparkWindow;
  });

  return {
    ...limit,
    windows,
  };
}

function isCodexSparkModelLabel(value: string | null | undefined) {
  const normalized = value?.toLowerCase() ?? '';
  return normalized.includes('codex') && normalized.includes('spark');
}

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

async function sendQueuedAsSteer(item: (typeof state.queuedMessages)[number]) {
  removeQueuedMessage(item.id);
  await sendMessage(item.text, {
    noReply: true,
    queuedAttachments: {
      droppedFiles: item.droppedFiles,
      clipboardImages: item.clipboardImages,
      terminalSelection: item.terminalSelection,
    },
    preserveComposer: true,
  });
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
      if (!sendableText.trim()) return;
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
        await editMessage(editing.messageId, text);
      } else {
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
    await sendMessage(text, { noReply: mode === 'steer' });
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
    const hasQueued = state.queuedMessages.some((item) => item.sessionId === sessionId);
    if (queueDispatchTimer) {
      clearTimeout(queueDispatchTimer);
      queueDispatchTimer = 0;
    }
    if (!sessionId || loading || activeQuestion || activePermission || !hasQueued) return;
    queueDispatchTimer = setTimeout(() => {
      queueDispatchTimer = 0;
      if (isComposerBusy() || hasActiveQuestion() || hasActivePermission()) return;
      const sid = state.activeSessionId;
      if (!sid) return;
      const next = state.queuedMessages.find((item) => item.sessionId === sid);
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
  onCleanup(() => {
    if (queueDispatchTimer) clearTimeout(queueDispatchTimer);
    if (fileSearchTimer) clearTimeout(fileSearchTimer);
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
    setComposerValue(history[nextIndex]);
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
    const nextMode = TOOLBAR_COMPACT_MODES[Math.min(modeIndex, TOOLBAR_COMPACT_MODES.length - 1)];
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
      } catch {}
    }

    if (payloads.length === 0) return;
    postMessage({ type: 'files/drop-content', payload: { files: payloads } });
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
  const showBusySendControls = createMemo(
    () => isBusyWithoutInterruption() && canSend() && !editingMessage()
  );

  const clipboardImagesDisabled = () =>
    composerClipboardImages().length > 0 && !currentModelSupportsVision();

  const contextUsage = createMemo(() => {
    const best = getLatestAssistantMessageInfoWithTokens(state.messages);
    if (!best) return null;
    const ctx = getContextWindow(best, state.providers);
    if (!ctx) return null;
    return ctx;
  });

  const sessionTokens = createMemo(() => sumAssistantTokensFromMessageEntries(state.messages));

  const activeUsageLimit = createMemo(() => getActiveUsageLimitNotice(state.activeSessionId));
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

    const treeSessionIds = getSessionTreeIds(activeSessionId);
    const retryingSessionIds = treeSessionIds.filter(
      (sessionId) => state.sessionStatus[sessionId]?.type === 'retry'
    );

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
          if (activeRunWasRunning && retryingSessionIds.includes(activeSessionId)) {
            continueInterruptedSession(activeSessionId).catch(() => {});
          }
        });
    }
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
    () => isBusyWithoutInterruption() && isToolbarControlVisible('stop') && !canSend()
  );
  const showSendControl = createMemo(
    () => isToolbarControlVisible('send') && (!isBusyWithoutInterruption() || canSend())
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
          onSendAsSteer={sendQueuedAsSteer}
          onRemove={removeQueuedMessage}
        />
      </Show>

      <Show when={state.todos.length > 0 && !showModelPicker() && !editingMessage()}>
        <TodoList />
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
                  : isComposerBusy()
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
            selectedAgentLabel={selectedAgentLabel()}
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
            selectedVariant={effectiveVariant()}
            selectedVariantLabel={selectedVariantLabel()}
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
          selectedAgentLabel={selectedAgentLabel()}
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
          selectedVariant={effectiveVariant()}
          selectedVariantLabel={selectedVariantLabel()}
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
        <Portal>
          <ImagePreviewOverlay
            image={previewImage()}
            onClose={() => setPreviewImageId(null)}
            onPrevious={() => stepImagePreview(-1)}
            onNext={() => stepImagePreview(1)}
            showNavigation={composerClipboardImages().length > 1}
            position={previewImageIndex() + 1}
            total={composerClipboardImages().length}
          />
        </Portal>
      </Show>
    </div>
  );
}

function getPastedContextFiles(text: string, workspacePath: string | null): DroppedFile[] {
  if (!text.trim()) return [];

  const lines = text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);

  const files = new Map<string, DroppedFile>();

  for (const line of lines) {
    const selectionRef = parseSelectionReference(line);
    if (selectionRef) {
      const file = createDroppedFileFromReference(selectionRef.path, workspacePath, false);
      if (!file) continue;
      addOrMergePastedContextFile(files, { ...file, lineRanges: selectionRef.lineRanges });
      continue;
    }

    const activeFileMatch = line.match(/^\[Active file: (.+?)\]$/);
    if (activeFileMatch) {
      const file = createDroppedFileFromReference(activeFileMatch[1], workspacePath, false);
      if (file) addOrMergePastedContextFile(files, file);
    }
  }

  return Array.from(files.values());
}

async function addPastedMentionContextFiles(text: string) {
  if (!text.trim()) return;

  const lines = text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);

  const files = new Map<string, DroppedFile>();

  for (const line of lines) {
    for (const mention of extractPastedFileMentions(line)) {
      const file = await resolveDroppedFileReference(mention.path, mention.isDirectory);
      if (file) addOrMergePastedContextFile(files, file);
    }
  }

  for (const file of files.values()) {
    addContextFile(file);
  }
}

function getPromptTextWithoutContextReferences(text: string) {
  return text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => {
      if (!line) return false;
      if (parseSelectionReference(line)) return false;
      if (/^\[Active file: .+\]$/.test(line)) return false;
      return (
        extractPastedFileMentions(line).length === 0 ||
        line.replace(/(^|[\s(])@([^\s@]+?\/?)(?=$|[\s),.:;!?])/g, '$1').trim().length > 0
      );
    })
    .join('\n')
    .trim();
}

function extractPastedFileMentions(line: string): Array<{ path: string; isDirectory: boolean }> {
  const matches = line.matchAll(/(^|[\s(])@([^\s@)]+?\/?)(?=$|[\s),:;!?])/g);
  const mentions: Array<{ path: string; isDirectory: boolean }> = [];

  for (const match of matches) {
    const rawPath = match[2]?.trim();
    const isDirectory = rawPath?.endsWith('/') ?? false;
    if (!rawPath || !isLikelyFileMentionPath(rawPath, isDirectory)) continue;
    mentions.push({
      path: rawPath.replace(/\/+$/, ''),
      isDirectory,
    });
  }

  return mentions;
}

function isLikelyFileMentionPath(value: string, isDirectory = false) {
  const normalized = normalizePath(value.replace(/^\.\//, ''));
  if (!normalized) return false;
  if (normalized === '.' || normalized === '..') return false;
  if (isDirectory) return true;
  if (normalized.includes('/')) return true;
  return /\.[A-Za-z0-9_-]{1,16}$/.test(normalized);
}

async function resolveDroppedFileReference(
  referencePath: string,
  isDirectory: boolean
): Promise<DroppedFile | null> {
  const normalizedReference = normalizePath(referencePath);
  if (!normalizedReference) return null;

  const resolved = await client.varro.resolveWorkspacePath(normalizedReference);
  if (!resolved) return null;
  if (isDirectory && resolved.type !== 'directory') return null;

  return resolved;
}

function createDroppedFileFromReference(
  referencePath: string,
  workspacePath: string | null,
  isDirectory: boolean
): DroppedFile | null {
  const normalizedReference = normalizePath(referencePath);
  if (!normalizedReference) return null;

  const relativePath = isAbsolutePath(normalizedReference)
    ? (getWorkspaceRelativePath(normalizedReference, workspacePath) ?? normalizedReference)
    : normalizedReference;
  const absolutePath = isAbsolutePath(normalizedReference)
    ? normalizedReference
    : workspacePath
      ? `${normalizePath(workspacePath).replace(/\/+$/, '')}/${normalizedReference.replace(/^\.\//, '')}`
      : normalizedReference;

  return {
    path: absolutePath,
    relativePath,
    type: isDirectory ? 'directory' : 'file',
  };
}

function addOrMergePastedContextFile(files: Map<string, DroppedFile>, file: DroppedFile) {
  const current = files.get(file.path);
  if (!current) {
    files.set(file.path, file);
    return;
  }

  files.set(file.path, mergeContextFile(current, file));
}

export function getSlashCommands(props: {
  isBusy: boolean;
  canUndo: boolean;
  canRedo: boolean;
  canInit: boolean;
  onConnectProvider: () => void;
  onOpenSessions: () => void;
  onOpenModels: () => void;
  onOpenMcps: () => void;
  onOpenFiles: () => void;
  onOpenSettings: () => void;
  onExportSession: () => void;
  customCommands: Command[];
}): SlashCommand[] {
  const reservedBuiltInNames = new Set([
    'new',
    'agents',
    'models',
    'mcp',
    'connect',
    'attach',
    'files',
    'settings',
    'export',
    'thinking',
    'reasoning',
    'compact',
    'summarize',
    'init',
    'undo',
    'revert',
    'redo',
    'review',
    'abort',
    'stop',
    'ralph',
  ]);

  const commands: SlashCommand[] = [
    {
      name: SKILLS_COMMAND_NAME,
      aliases: [],
      description: 'Browse available skills',
      action: () => {},
    },
    {
      name: 'new',
      aliases: ['clear'],
      description: 'Start a new chat session',
      action: () => {
        startNewChatDraft();
      },
    },
    {
      name: 'sessions',
      aliases: ['resume'],
      description: 'Open the session list',
      action: () => props.onOpenSessions(),
    },
    {
      name: 'models',
      aliases: [],
      description: 'Open the model picker',
      action: () => props.onOpenModels(),
    },
    {
      name: 'mcps',
      aliases: ['mcp'],
      description: 'Open the MCP picker for this session',
      action: () => props.onOpenMcps(),
    },
    {
      name: 'connect',
      aliases: [],
      description: 'Open provider login in the terminal',
      action: () => props.onConnectProvider(),
    },
    {
      name: 'attach',
      aliases: ['files'],
      description: 'Pick files or folders to attach',
      action: () => props.onOpenFiles(),
    },
    {
      name: 'settings',
      aliases: [],
      description: 'Open VS Code settings for Varro',
      action: () => props.onOpenSettings(),
    },
    {
      name: 'export',
      aliases: [],
      description: 'Export the current session',
      action: () => {
        props.onExportSession();
      },
    },
    {
      name: 'thinking',
      aliases: ['reasoning'],
      description: showThinking() ? 'Hide thinking blocks' : 'Show thinking blocks',
      action: () => {
        toggleThinking();
      },
    },
    {
      name: 'compact',
      aliases: ['summarize'],
      description: 'Compact conversation context',
      action: () => {
        compactSession();
      },
    },
  ];

  if (props.canInit) {
    commands.push({
      name: 'init',
      aliases: [],
      description: 'Analyze the project and create AGENTS.md',
      action: () => {
        initSession();
      },
    });
  }

  /*
   * Keep these registrations handy, but do not expose `/undo`, `/revert`, or
   * `/redo` in slash-command completion for now. Direct submission still works
   * through the built-in handling in `handleSubmit`.
   *
   * if (props.canUndo) {
   *   commands.push({
   *     name: 'undo',
   *     aliases: ['revert'],
   *     description: 'Undo the last assistant response',
   *     action: () => {
   *       undoSession();
   *     },
   *   });
   * }
   *
   * if (props.canRedo) {
   *   commands.push({
   *     name: 'redo',
   *     aliases: [],
   *     description: 'Redo the last undone response',
   *     action: () => {
   *       redoSession();
   *     },
   *   });
   * }
   */

  commands.push({
    name: 'review',
    aliases: [],
    description: 'Review current code changes',
    action: () => {
      reviewSession();
    },
  });

  commands.push({
    name: 'ralph',
    aliases: [],
    description: 'Start a Ralph loop on a plan document',
    action: () => {
      ralphStore.setShowRalphForm(true);
    },
  });

  if (props.isBusy) {
    commands.push({
      name: 'abort',
      aliases: ['stop'],
      description: 'Stop the current run',
      action: () => {
        abortSession();
      },
    });
  }

  for (const command of props.customCommands) {
    if (command.source === 'skill') continue;
    if (reservedBuiltInNames.has(command.name)) continue;
    commands.push({
      name: command.name,
      aliases: [],
      description: command.description || command.template,
      source: command.source,
      action: (args) => {
        void runSlashCommandByName(command.name, args);
      },
    });
  }

  return commands.toSorted((a, b) => a.name.localeCompare(b.name));
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

export function getActiveCompletion(text: string, cursor: number) {
  if (cursor < 0 || cursor > text.length) return null;

  const prefix = text.slice(0, cursor);
  const slashMatch = prefix.match(/^\/([^\s]*)$/);
  if (slashMatch) {
    return {
      type: 'slash' as const,
      query: slashMatch[1] || '',
      start: 0,
      end: cursor,
    };
  }

  const skillMatch = prefix.match(new RegExp(`^/${SKILLS_COMMAND_NAME}(?:\\s+([^\\s]*))?$`, 'i'));
  if (skillMatch) {
    return {
      type: 'slash' as const,
      query: prefix.slice(1),
      start: 0,
      end: cursor,
    };
  }

  const tokenStart = Math.max(prefix.lastIndexOf(' '), prefix.lastIndexOf('\n')) + 1;
  const token = prefix.slice(tokenStart);
  if (!token.startsWith('@')) return null;

  return {
    type: 'mention' as const,
    query: token.slice(1),
    start: tokenStart,
    end: cursor,
  };
}

export function getLeadingSlashCommand(text: string) {
  const trimmed = text.trim();
  const match = trimmed.match(/^\/([^\s]+)(?:\s+(.*))?$/);
  if (!match) return null;

  return {
    name: match[1].toLowerCase(),
    args: match[2]?.trim() || '',
  };
}

export function getCompletionSelection(
  completion: ReturnType<typeof getActiveCompletion> | null,
  item: CompletionItem | undefined,
  confirm = false
): CompletionSelection | null {
  if (!completion || !item) return null;

  if (completion.type === 'slash') {
    if (!('name' in item)) return null;
    if (completion.query.toLowerCase().startsWith(`${SKILLS_COMMAND_NAME} `)) {
      return {
        type: 'set-slash',
        value: `/${item.name}`,
      };
    }
    if (item.name === SKILLS_COMMAND_NAME) {
      return { type: 'set-slash', value: `/${SKILLS_COMMAND_NAME} ` };
    }
    return {
      type: confirm ? 'run-slash' : 'set-slash',
      value: `/${item.name}`,
    };
  }

  if (!('value' in item)) return null;

  const file = item.type === 'file' ? item.file : undefined;

  return {
    type: 'apply-mention',
    value: item.value,
    file,
  };
}

function getAgentBadgeLine(agent: Agent) {
  const badges: string[] = [];
  badges.push(agent.mode === 'subagent' ? 'Subagent' : 'Primary');
  if (agent.permission.edit === 'allow') badges.push('Can edit');
  else if (agent.permission.edit === 'ask') badges.push('Edits ask');
  else badges.push('No edits');

  const bashMode = agent.permission.bash['*'] || 'allow';
  if (bashMode === 'deny') badges.push('No bash');
  else if (bashMode === 'ask') badges.push('Bash asks');
  else badges.push('Bash allowed');

  return badges.join(' · ');
}

export function getMentionCompletionItems({
  rawQuery,
  agents,
  files,
  source,
  meta,
}: {
  rawQuery: string;
  agents?: Agent[];
  files?: DroppedFile[];
  source?: MentionCompletionSource;
  meta?: MentionCompletionMeta;
}): MentionCompletionItem[] {
  const mentionSource =
    source ?? createMentionCompletionSource({ agents: agents ?? [], files: files ?? [] });
  const query = rawQuery.toLowerCase();
  const exactAgentMatch = mentionSource.exactAgentNames.has(query);
  const exactFileMatch = mentionSource.exactFilePaths.has(normalizeMentionPath(rawQuery));
  if (query && (exactAgentMatch || exactFileMatch)) return [];

  const agentItems = mentionSource.agentEntries
    .filter((agent) => {
      if (!query) return true;
      return agent.normalizedName.includes(query) || agent.normalizedDescription.includes(query);
    })
    .map((agent) => agent.item);

  const fileItems = (rawQuery ? mentionSource.fileEntries : []).map((file) => file.item);

  if (!rawQuery && !meta?.showFileSearchHint) {
    return agentItems.slice(0, 10);
  }

  return [...fileItems, ...agentItems].slice(0, 10);
}

function createMentionCompletionSource({
  agents,
  files,
}: {
  agents: Agent[];
  files: DroppedFile[];
}): MentionCompletionSource {
  const exactAgentNames = new Set<string>();
  const exactFilePaths = new Set<string>();

  const agentEntries = agents.map((agent) => {
    const normalizedName = agent.name.toLowerCase();
    exactAgentNames.add(normalizedName);

    return {
      item: {
        key: `agent:${agent.name}`,
        type: 'agent',
        label: `@${agent.name}`,
        detail: agent.description || getAgentBadgeLine(agent),
        value: `@${agent.name} `,
      },
      normalizedName,
      normalizedDescription: agent.description?.toLowerCase() || '',
    } satisfies MentionAgentEntry;
  });

  const fileEntries = files.map((file) => {
    const normalizedPath = normalizeMentionPath(file.relativePath);
    exactFilePaths.add(normalizedPath);

    return {
      item: {
        key: `file:${file.path}`,
        type: 'file',
        label: `@${file.relativePath}`,
        detail: file.type === 'directory' ? 'Folder' : 'Workspace file',
        value:
          file.type === 'directory'
            ? `@${formatMentionPath(file.relativePath)}/`
            : `@${formatMentionPath(file.relativePath)} `,
        file,
      },
      normalizedPath,
    } satisfies MentionFileEntry;
  });

  return {
    agentEntries,
    fileEntries,
    exactAgentNames,
    exactFilePaths,
  };
}

export function shouldRequestMentionFileSearch(previousQuery: string, nextQuery: string) {
  return previousQuery !== nextQuery;
}

function normalizeMentionPath(value: string) {
  return value.replace(/^@/, '').replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase();
}

function formatMentionPath(value: string) {
  return value.replace(/^@/, '').replace(/\\/g, '/').replace(/\/+$/, '');
}

function getUserMessageHistoryText(parts: Part[]) {
  const text = parts
    .filter((part): part is TextPart => part.type === 'text')
    .filter((part) => !part.synthetic && !part.ignored)
    .map((part) => part.text.trim())
    .filter(
      (value) =>
        value.length > 0 &&
        !value.startsWith('[Working directory:') &&
        !value.startsWith('[Selection from') &&
        !value.startsWith('[Active file:')
    )
    .join('\n\n')
    .trim();

  return text.length > 0 ? text : null;
}

async function collectDroppedPaths(dataTransfer: DataTransfer | null): Promise<string[]> {
  if (!dataTransfer) return [];

  const paths = new Set<string>();

  const knownTypes = [
    'CodeEditors',
    'CodeFiles',
    'text/uri-list',
    'ResourceURLs',
    'application/vnd.code.uri-list',
    'text/plain',
  ];
  const allTypes = Array.from(dataTransfer.types || []);
  for (const t of allTypes) {
    if (t.startsWith('application/vnd.code.') || !knownTypes.includes(t)) {
      knownTypes.push(t);
    }
  }

  for (const path of collectVSCodeDroppedPaths(dataTransfer)) {
    paths.add(path);
  }

  for (const type of knownTypes) {
    try {
      const data = dataTransfer.getData(type);
      for (const path of parseDroppedText(data)) {
        paths.add(path);
      }
    } catch {}
  }

  for (const file of Array.from(dataTransfer.files)) {
    const path = (file as File & { path?: string }).path;
    if (path) paths.add(path);
  }

  for (const item of Array.from(dataTransfer.items)) {
    const file = item.getAsFile() as (File & { path?: string }) | null;
    if (file?.path) paths.add(file.path);
  }

  if (paths.size === 0) {
    // Fall back to async string reading from ALL DataTransferItems
    const stringItems = Array.from(dataTransfer.items).filter((item) => item.kind === 'string');

    const itemText = await Promise.all(stringItems.map(readDroppedItem));

    for (const value of itemText) {
      for (const path of parseDroppedText(value)) {
        paths.add(path);
      }
    }
  }

  return Array.from(paths);
}

function collectVSCodeDroppedPaths(dataTransfer: DataTransfer): string[] {
  const paths = new Set<string>();

  for (const path of parseCodeEditorsDrop(dataTransfer.getData('CodeEditors'))) {
    paths.add(path);
  }

  for (const path of parseCodeFilesDrop(dataTransfer.getData('CodeFiles'))) {
    paths.add(path);
  }

  for (const path of parseResourceListDrop(dataTransfer.getData('ResourceURLs'))) {
    paths.add(path);
  }

  for (const path of parseUriListDrop(dataTransfer.getData('application/vnd.code.uri-list'))) {
    paths.add(path);
  }

  return Array.from(paths);
}

function parseCodeEditorsDrop(value: string): string[] {
  if (!value) return [];

  try {
    const parsed = JSON.parse(value) as unknown[];
    const paths = new Set<string>();
    for (const item of parsed) {
      if (!item) continue;
      if (typeof item === 'string') {
        const decoded = decodeDroppedCandidate(item);
        if (decoded) paths.add(decoded);
        continue;
      }
      if (typeof item !== 'object') continue;
      const resource = 'resource' in item ? (item.resource as string | undefined) : undefined;
      const uri = resource ? decodeDroppedCandidate(resource) : null;
      if (uri) paths.add(uri);
    }
    return Array.from(paths);
  } catch {
    return [];
  }
}

function parseCodeFilesDrop(value: string): string[] {
  if (!value) return [];

  try {
    const parsed = JSON.parse(value) as unknown[];
    const paths = new Set<string>();
    for (const item of parsed) {
      if (typeof item !== 'string') continue;
      const decoded = decodeDroppedCandidate(item);
      if (decoded) paths.add(decoded);
    }
    return Array.from(paths);
  } catch {
    return [];
  }
}

function parseResourceListDrop(value: string): string[] {
  if (!value) return [];

  try {
    const parsed = JSON.parse(value) as unknown[];
    const paths = new Set<string>();
    for (const item of parsed) {
      if (typeof item !== 'string') continue;
      const decoded = decodeDroppedCandidate(item);
      if (decoded) paths.add(decoded);
    }
    return Array.from(paths);
  } catch {
    return parseUriListDrop(value);
  }
}

function parseUriListDrop(value: string): string[] {
  if (!value) return [];
  const paths = new Set<string>();
  for (const entry of value.split(/\r?\n/)) {
    const decoded = decodeDroppedCandidate(entry.trim());
    if (decoded) paths.add(decoded);
  }
  return Array.from(paths);
}

function readItemByType(dataTransfer: DataTransfer, type: string): Promise<string> {
  return new Promise((resolve) => {
    const item = Array.from(dataTransfer.items).find((i) => i.type === type && i.kind === 'string');
    if (!item) {
      resolve(dataTransfer.getData(type) || '');
      return;
    }
    item.getAsString((value) => resolve(value || ''));
  });
}

function readDroppedItem(item: DataTransferItem): Promise<string> {
  return new Promise((resolve) => {
    item.getAsString((value) => resolve(value || ''));
  });
}

export function parseDroppedText(value: string): string[] {
  if (!value) return [];
  const paths = new Set<string>();

  for (const line of value.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const decoded = decodeDroppedCandidate(trimmed);
    if (decoded) paths.add(decoded);
  }

  for (const candidate of extractPathsFromStructuredDrop(value)) {
    paths.add(candidate);
  }

  return Array.from(paths);
}

function decodeDroppedCandidate(value: string): string | null {
  return decodeDroppedPath(value) || decodeWorkspaceRelativePath(value);
}

function decodeDroppedPath(value: string): string | null {
  const trimmed = value.trim();
  if (!trimmed) return null;
  if (trimmed.startsWith('/')) return trimmed;
  if (/^[A-Za-z]:[\\/]/.test(trimmed)) return trimmed;

  try {
    const url = new URL(trimmed);
    let pathname = decodeURIComponent(url.pathname);

    if (url.protocol === 'vscode-file:') {
      pathname = pathname.replace(/^\/vscode-app(?=\/|$)/, '');
    }

    if (
      url.protocol === 'vscode-resource:' &&
      url.hostname === 'file' &&
      pathname.startsWith('///')
    ) {
      pathname = pathname.slice(2);
    }

    if (url.protocol === 'file:' && url.hostname && !/^\/[A-Za-z]:\//.test(pathname)) {
      pathname = `//${url.hostname}${pathname}`;
    }

    return normalizeDroppedPath(pathname);
  } catch {
    return null;
  }
}

function normalizeDroppedPath(pathname: string): string | null {
  if (!pathname) return null;
  if (/^\/[A-Za-z]:\//.test(pathname)) return pathname.slice(1);
  if (/^[A-Za-z]:[\\/]/.test(pathname)) return pathname;
  return pathname.startsWith('/') || pathname.startsWith('//') ? pathname : null;
}

function decodeWorkspaceRelativePath(value: string): string | null {
  const trimmed = value.trim();
  if (!trimmed) return null;
  if (/^[a-z][a-z0-9+.-]*:/i.test(trimmed)) return null;
  if (trimmed.startsWith('/') || trimmed.startsWith('//')) return null;
  if (/^[A-Za-z]:[\\/]/.test(trimmed)) return null;
  if (/\s/.test(trimmed)) return null;

  const normalized = trimmed.replace(/\\/g, '/').replace(/^\.\//, '').replace(/\/+$/, '');
  if (!normalized || normalized === '.' || normalized === '..') return null;

  const looksPathLike =
    trimmed.startsWith('./') ||
    trimmed.startsWith('../') ||
    trimmed.includes('/') ||
    trimmed.includes('\\') ||
    trimmed.startsWith('.') ||
    /^[^/\\]+\.[^/\\]+$/.test(trimmed);

  return looksPathLike ? normalized : null;
}

function extractPathsFromStructuredDrop(value: string): string[] {
  const trimmed = value.trim();
  if (!trimmed || !/^[[{"]/.test(trimmed)) return [];

  try {
    const parsed = JSON.parse(trimmed);
    const paths = new Set<string>();
    collectStructuredDropPaths(parsed, paths);
    return Array.from(paths);
  } catch {
    return [];
  }
}

function collectStructuredDropPaths(value: unknown, paths: Set<string>, keyHint = '') {
  if (typeof value === 'string') {
    const looksPathLike =
      !keyHint ||
      /(path|uri|url|resource)/i.test(keyHint) ||
      value.startsWith('/') ||
      value.startsWith('./') ||
      value.startsWith('../') ||
      /^[A-Za-z]:[\\/]/.test(value) ||
      value.includes('/') ||
      value.includes('\\') ||
      /^[^/\\]+\.[^/\\]+$/.test(value) ||
      /^[a-z][a-z0-9+.-]*:/i.test(value);

    if (!looksPathLike) return;

    for (const candidate of value.split(/\r?\n/)) {
      const decoded = decodeDroppedCandidate(candidate);
      if (decoded) paths.add(decoded);
    }
    return;
  }

  if (Array.isArray(value)) {
    for (const item of value) {
      collectStructuredDropPaths(item, paths, keyHint);
    }
    return;
  }

  if (!value || typeof value !== 'object') return;

  for (const [key, entry] of Object.entries(value)) {
    collectStructuredDropPaths(entry, paths, key);
  }
}

function readFileAsDataUrl(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.addEventListener('load', () => resolve(String(reader.result || '')));
    reader.addEventListener('error', () =>
      reject(reader.error || new Error('Failed to read clipboard image'))
    );
    reader.readAsDataURL(file);
  });
}

function readFileAsBase64(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.addEventListener('load', () => {
      const result = reader.result;
      if (typeof result !== 'string') {
        reject(new Error('Unexpected FileReader result'));
        return;
      }
      const comma = result.indexOf(',');
      resolve(comma >= 0 ? result.slice(comma + 1) : '');
    });
    reader.addEventListener('error', () => reject(reader.error || new Error('FileReader failed')));
    reader.readAsDataURL(file);
  });
}

export function shouldPadInlineInsertion(value: string | undefined) {
  return !!value && !/\s/.test(value);
}

export function getInlineInsertionSuffix(text: string, selectionEnd: number) {
  return selectionEnd >= text.length || shouldPadInlineInsertion(text[selectionEnd]) ? ' ' : '';
}

export function getMentionInsertionTrailingSpace(value: string, after: string | undefined) {
  if (value.endsWith(' ') || value.endsWith('\n')) return '';
  return !after || (after !== ' ' && after !== '\n') ? ' ' : '';
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
