import { Show, createEffect, createMemo, createSignal, onCleanup, onMount } from 'solid-js';
import {
  state,
  inputText,
  setState,
  setInputText,
  nextPastedImageIndex,
  setNextPastedImageIndex,
  resetPastedImageIndex,
  isLoading,
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
  setShowSessionPicker,
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
  isSessionCompacting,
  providerLimitPollIntervalSeconds,
} from '../lib/state';
import { onMessage, postMessage } from '../lib/bridge';
import { openProviderSetup } from '../lib/provider-setup';
import {
  applySessionMcps,
  sendMessage,
  abortSession,
  createSession,
  compactSession,
  initSession,
  redoSession,
  undoSession,
  reviewSession,
  runSlashCommandByName,
  updatePermissionModeForSession,
} from '../hooks/useOpenCode';
import { ModelPicker, getVariantsForModel } from './ModelPicker';
import { McpPicker } from './McpPicker';
import { ralphStore } from '../lib/stores/ralph-store';
import {
  formatAgentInitial,
  formatAgentLabel,
  formatProviderLimitCompact,
  formatProviderLimitCompactPrefix,
  formatProviderLimitTitle,
  formatVariantInitial,
  formatVariantLabel,
  getProviderLimitTone,
  hasProviderLimitWindowWithinThreshold,
  getOrderedProviderLimitWindows,
  getPrimaryProviderLimitWindow,
  resolveProviderLimitWindow,
} from '../lib/format';
import { getMatchingVariant, getPreferredVariant } from '../lib/model-variants';
import { isAssistantMessage, getContextWindow, sumAssistantTokens } from '../lib/message-metrics';
import { getPromptTextForClipboardImages } from '../lib/clipboard-images';
import { modelSupportsVision } from '../lib/model-capabilities';
import { getLeafPathName } from '../lib/path-display';
import {
  formatContextLineRanges,
  getSelectionRangesFromEditorContext,
  hasExplicitContextForPath,
} from '../../shared/context-files';
import { getQueuedAttachmentSnapshot } from '../hooks/session/session-send';
import { TodoList } from './TodoList';
import { AttachmentStrip } from './chat-input/AttachmentStrip';
import { ChatInputToolbar } from './chat-input/ChatInputToolbar';
import { ComposerArea } from './chat-input/ComposerArea';
import { DropOverlay } from './chat-input/DropOverlay';
import { QueuedMessages } from './chat-input/QueuedMessages';
import { UsageLimitBanner } from './chat-input/UsageLimitBanner';
import type {
  CompletionItem,
  MentionCompletionItem,
  SlashCommand,
} from './chat-input/CompletionMenu';
import type { Agent, Command, Part, TextPart } from '../types';
import type { DroppedFile, ExtensionMessage } from '../../shared/protocol';
import { DISABLED_PROVIDER_LIMIT_POLL_INTERVAL_SECONDS } from '../../shared/provider-limit-config';
import { createUsageLimitProviderLimit } from '../lib/usage-limit';
import {
  getSelectedProviderLimitWindowCheckedAt,
  getSelectedProviderLimitWindowId,
  setSelectedProviderLimitWindowId,
} from '../lib/provider-limit-selection';

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

type CompletionSelection =
  | { type: 'set-slash'; value: string }
  | { type: 'run-slash'; value: string }
  | { type: 'apply-mention'; value: string; file?: DroppedFile };

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
  if (control === 'agent') return !['full', 'compact-stop'].includes(mode);
  if (control === 'reasoning') return !['full', 'compact-stop', 'compact-agent'].includes(mode);
  return [
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

export function ChatInput() {
  let textareaRef: HTMLTextAreaElement | undefined;
  let containerRef: HTMLDivElement | undefined;
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

  const files = () => state.droppedFiles;
  const clipboardImages = () => state.clipboardImages;
  const selection = () => state.editorContext.selection;
  const terminalSelection = () => state.terminalSelection;
  const activeFile = () => state.editorContext.activeFile;
  const explicitContextForActiveFile = () => hasExplicitContextForPath(files(), activeFile()?.path);
  const hasContext = () => !!activeFile() || !!selection() || !!terminalSelection();

  const hasMentions = () => files().length > 0 || clipboardImages().length > 0;
  const visibleFiles = () => files();
  const activeContextEnabled = () => getCurrentDocumentEnabled(state.activeSessionId);

  const activeContext = () => {
    const file = activeFile();
    const selectedLines = getSelectionRangesFromEditorContext(selection());
    if (!file) return null;
    if (explicitContextForActiveFile() && selectedLines.length === 0) return null;
    const displayPath = getLeafPathName(file.relativePath || file.path);
    const lineRange = formatContextLineRanges(selectedLines);
    return {
      filename: displayPath,
      lineRange,
    };
  };

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

  const slashCommands = createMemo(() =>
    getSlashCommands({
      isBusy: isLoading(),
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
    return getActiveCompletion(inputText(), textareaRef?.selectionStart ?? fallbackCursor);
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
    return slashCommands()
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

  const showCompletionMenu = () => {
    if (suppressCompletion()) return false;
    const completion = activeCompletion();
    if (!completion) return false;
    return (
      composerCompletions().length > 0 || (completion.type === 'mention' && showFileSearchHint())
    );
  };

  createEffect(() => {
    const length = composerCompletions().length;
    if (length === 0) {
      setCompletionIndex(0);
      return;
    }
    setCompletionIndex((current) => Math.max(0, Math.min(current, length - 1)));
  });

  function handleKeydown(e: KeyboardEvent) {
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

      const completion = activeCompletion();
      if (completion?.type === 'slash') {
        e.preventDefault();
        runSlashCommand(inputText());
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
    }

    if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) {
      e.preventDefault();
      if ((e.ctrlKey || e.metaKey) && isLoading()) {
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
    const nextValue = `${text.slice(0, completion.start)}${value}${text.slice(completion.end)}`;
    setInputText(nextValue);
    setCompletionIndex(0);
    setFileSearchResults([]);
    latestFileSearchQuery = '';

    queueMicrotask(() => {
      autoResize();
      if (!textareaRef) return;
      const nextCursor = completion.start + value.length;
      textareaRef.focus();
      textareaRef.setSelectionRange(nextCursor, nextCursor);
      setCaretPosition(nextCursor);
    });
  }

  async function runSlashCommand(raw: string) {
    const normalized = raw.trim().replace(/^\/+/, '');
    const [name, ...rest] = normalized.split(/\s+/);
    const args = rest.join(' ');
    const command = slashCommands().find(
      (item) => item.name === name || item.aliases.includes(name)
    );
    if (!command) {
      await handleSend();
      return;
    }

    setHistoryIndex(null);
    setHistoryDraft('');
    setInputText('');
    resetPastedImageIndex();
    setCompletionIndex(0);
    if (textareaRef) textareaRef.style.height = 'auto';
    await command.action(args);
  }

  async function handleSend(mode?: 'queue' | 'steer') {
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

    if (
      mode !== 'steer' &&
      isLoading() &&
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
      if (textareaRef) textareaRef.style.height = 'auto';
      return;
    }

    setHistoryIndex(null);
    setHistoryDraft('');
    setCompletionIndex(0);
    const prevError = error();
    setInputText('');
    resetPastedImageIndex();
    if (textareaRef) textareaRef.style.height = 'auto';
    await sendMessage(text, { noReply: mode === 'steer' });
    if (error() && error() !== prevError) {
      setInputText(text);
    }
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

  let queueDispatchTimer: ReturnType<typeof setTimeout> | 0 = 0;
  createEffect(() => {
    const sessionId = state.activeSessionId;
    const loading = isLoading();
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
      if (isLoading() || hasActiveQuestion() || hasActivePermission()) return;
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
    setInputText(value);
    if (value.trim().length === 0 && state.clipboardImages.length === 0) resetPastedImageIndex();
    setCompletionIndex(0);
    queueMicrotask(() => {
      autoResize();
      if (!textareaRef) return;
      textareaRef.focus();
      textareaRef.setSelectionRange(value.length, value.length);
      setCaretPosition(value.length);
    });
  }

  function replaceComposerSelection(value: string, padWithSpaces = false) {
    const text = inputText();
    const selectionStart = textareaRef?.selectionStart ?? caretPosition();
    const selectionEnd = textareaRef?.selectionEnd ?? selectionStart;
    const prefix = padWithSpaces && shouldPadInlineInsertion(text[selectionStart - 1]) ? ' ' : '';
    const suffix = padWithSpaces && shouldPadInlineInsertion(text[selectionEnd]) ? ' ' : '';
    const insertedValue = `${prefix}${value}${suffix}`;
    const nextValue = `${text.slice(0, selectionStart)}${insertedValue}${text.slice(selectionEnd)}`;
    const nextCaret = selectionStart + insertedValue.length;

    setHistoryIndex(null);
    setHistoryDraft('');
    setInputText(nextValue);
    setCompletionIndex(0);
    setSuppressCompletion(false);

    queueMicrotask(() => {
      autoResize();
      if (!textareaRef) return;
      textareaRef.focus();
      textareaRef.setSelectionRange(nextCaret, nextCaret);
      setCaretPosition(nextCaret);
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

  function autoResize() {
    if (!textareaRef) return;
    textareaRef.style.height = 'auto';
    textareaRef.style.height = Math.min(textareaRef.scrollHeight, 200) + 'px';
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

    const imageItems = Array.from(clipboardData.items).filter(
      (item) => item.kind === 'file' && item.type.startsWith('image/')
    );

    if (imageItems.length === 0) return;

    e.preventDefault();

    const availableSlots = Math.max(0, MAX_CLIPBOARD_IMAGES - state.clipboardImages.length);
    if (availableSlots === 0) return;

    const filenames: string[] = [];
    const attachableItems = imageItems.slice(0, availableSlots);
    const nextIndex = nextPastedImageIndex();

    for (const [index, item] of attachableItems.entries()) {
      const file = item.getAsFile();
      if (!file) continue;

      const filename = getPastedImageFilename(nextIndex + index);
      filenames.push(filename);

      const url = await readFileAsDataUrl(file);
      addClipboardImage({
        id: createAttachmentID(),
        url,
        mime: file.type || 'image/png',
        filename,
        size: file.size,
      });
    }

    setNextPastedImageIndex(nextIndex + attachableItems.length);

    if (filenames.length === 0 || inputText().trim().length === 0) return;

    replaceComposerSelection(filenames.map((filename) => `[${filename}]`).join(' '), true);
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
      if (!textareaRef) return;
      const cursor = textareaRef.value.length;
      textareaRef.focus();
      textareaRef.setSelectionRange(cursor, cursor);
      setCaretPosition(cursor);
      setIsFocused(true);
    });
  });

  const assistantMessages = createMemo(() =>
    state.messages.map((entry) => entry.info).filter(isAssistantMessage)
  );

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

    const latestAuto = [...assistantMessages()].toReversed()[0];
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

    // Prefer a provider that has a configured default model
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

    // Fall back to first provider's first model
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
  const showBusySendControls = createMemo(
    () => isLoading() && !hasActiveQuestion() && !hasActivePermission() && canSend()
  );

  const clipboardImagesDisabled = () =>
    clipboardImages().length > 0 && !currentModelSupportsVision();

  const contextUsage = createMemo(() => {
    const assistants = assistantMessages();
    if (assistants.length === 0) return null;
    let best = null;
    for (let i = assistants.length - 1; i >= 0; i--) {
      const msg = assistants[i];
      const hasTokens = (msg.tokens.input || 0) + (msg.tokens.output || 0) > 0;
      if (hasTokens) {
        best = msg;
        break;
      }
    }
    if (!best) return null;
    const ctx = getContextWindow(best, state.providers);
    if (!ctx) return null;
    return ctx;
  });

  const sessionTokens = createMemo(() => sumAssistantTokens(assistantMessages()));

  const activeUsageLimit = createMemo(() => getActiveUsageLimitNotice(state.activeSessionId));
  const showProviderLimits = createMemo(
    () => providerLimitPollIntervalSeconds() !== DISABLED_PROVIDER_LIMIT_POLL_INTERVAL_SECONDS
  );
  const currentProviderLimit = createMemo(() => {
    const current = currentModel();
    if (!current.providerID) return null;
    return getProviderLimit(current.providerID, current.modelID);
  });
  const showCurrentProviderLimit = createMemo(
    () =>
      showProviderLimits() &&
      hasProviderLimitWindowWithinThreshold(currentProviderLimit(), providerLimitThresholdPercent())
  );

  const currentProviderLimitWindow = createMemo(() => {
    if (!showCurrentProviderLimit()) return null;
    const providerID = currentModel().providerID;
    const selectedId = providerID ? getSelectedProviderLimitWindowId(providerID) : null;
    const selectedCheckedAt = providerID
      ? getSelectedProviderLimitWindowCheckedAt(providerID)
      : null;
    return resolveProviderLimitWindow(currentProviderLimit(), selectedId, selectedCheckedAt);
  });

  const currentProviderLimitCompact = createMemo(() =>
    showCurrentProviderLimit()
      ? formatProviderLimitCompact(currentProviderLimit(), currentProviderLimitWindow())
      : null
  );
  const currentProviderLimitCompactPrefix = createMemo(() =>
    showCurrentProviderLimit()
      ? formatProviderLimitCompactPrefix(currentProviderLimit(), currentProviderLimitWindow())
      : null
  );
  const currentProviderLimitTitle = createMemo(() =>
    showCurrentProviderLimit() ? formatProviderLimitTitle(currentProviderLimit()) : null
  );
  const currentProviderLimitTone = createMemo(() =>
    showCurrentProviderLimit()
      ? getProviderLimitTone(currentProviderLimit(), currentProviderLimitWindow())
      : 'default'
  );
  createEffect(() => {
    if (!showCurrentProviderLimit() && showProviderLimitPopup()) {
      setShowProviderLimitPopup(false);
    }
  });
  const activeUsageLimitWindow = createMemo(() =>
    getPrimaryProviderLimitWindow(createUsageLimitProviderLimit(activeUsageLimit()))
  );

  const availableVariants = createMemo(() => {
    const model = currentModel();
    return getVariantsForModel(model.providerID, model.modelID, state.providers);
  });

  const effectiveVariant = createMemo(() => {
    const variants = availableVariants();
    if (variants.length === 0) return null;
    return currentModel().variant && variants.includes(currentModel().variant!)
      ? currentModel().variant
      : getPreferredVariant(currentModel().providerID, currentModel().modelID, state.providers) ||
          variants[0];
  });

  const toolbarFitDependencies = createMemo(() => ({
    agents: state.agents.length,
    selectedAgent: state.selectedAgent,
    modelProvider: currentModel().providerID,
    modelId: currentModel().modelID,
    modelName: currentModel().modelName,
    providerLimit: currentProviderLimitCompact(),
    variant: effectiveVariant(),
    hasContextUsage: !!contextUsage(),
    loading: isLoading(),
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

  const queuedForSession = createMemo(() =>
    state.activeSessionId
      ? state.queuedMessages.filter((item) => item.sessionId === state.activeSessionId)
      : []
  );

  const showInputTopGradient = createMemo(
    () =>
      queuedForSession().length === 0 &&
      state.todos.length === 0 &&
      !activeUsageLimit() &&
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
    <div class={`interactive-input-part ${showInputTopGradient() ? 'input-top-gradient' : ''}`}>
      <Show when={isDraggingOver()}>
        <DropOverlay />
      </Show>

      <Show when={queuedForSession().length > 0}>
        <QueuedMessages
          items={queuedForSession()}
          onSendAsSteer={sendQueuedAsSteer}
          onRemove={removeQueuedMessage}
        />
      </Show>

      <Show when={state.todos.length > 0 && !showModelPicker()}>
        <TodoList />
      </Show>

      <Show when={activeUsageLimit()}>
        <UsageLimitBanner
          message={activeUsageLimit()!.message}
          meta={describeUsageLimit(activeUsageLimitWindow(), activeUsageLimit()?.attempt ?? null)}
          showStopRetrying={isLoading() && !hasActiveQuestion() && !hasActivePermission()}
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
        class={`chat-input-container ${isFocused() ? 'focused' : ''} ${showModelPicker() || showMcpPicker() ? 'showing-model-picker' : ''} ${showContextPopup() || showProviderLimitPopup() || showAgentPicker() || showVariantPicker() || showMcpPicker() || showPermissionModePicker() || showBusyMenu() || (isFocused() && showCompletionMenu()) ? 'showing-context-popup' : ''}`}
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
        <Show when={showModelPicker()}>
          <ModelPicker
            onSelect={(sel) => {
              if (sel.providerID && sel.modelID) {
                const matchedVariant =
                  sel.variant ||
                  getMatchingVariant(
                    {
                      providerID: state.selectedModel?.providerID,
                      modelID: state.selectedModel?.modelID,
                      variant: state.selectedModel?.variant,
                    },
                    { providerID: sel.providerID, modelID: sel.modelID },
                    state.providers
                  ) ||
                  undefined;
                setSelectedModel(
                  {
                    providerID: sel.providerID,
                    modelID: sel.modelID,
                    variant: matchedVariant,
                  },
                  { sessionId: state.activeSessionId }
                );
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

        <Show when={hasContext() || hasMentions()}>
          <AttachmentStrip
            activeContext={activeContext()}
            activeContextEnabled={activeContextEnabled()}
            activeContextTitle={
              activeContext()
                ? `${
                    activeContext()!.lineRange
                      ? `${activeContext()!.filename} ${activeContext()!.lineRange}`
                      : activeContext()!.filename
                  }${
                    activeContextEnabled()
                      ? ' · Click to disable current document context'
                      : ' · Current document context is disabled. Click to enable it again'
                  }`
                : null
            }
            terminalSelection={terminalSelection()}
            files={visibleFiles()}
            clipboardImages={clipboardImages()}
            clipboardImagesDisabled={clipboardImagesDisabled()}
            onToggleActiveContext={() => toggleCurrentDocumentEnabled(state.activeSessionId)}
            onClearTerminalSelection={() => postMessage({ type: 'terminal-selection/clear' })}
            onRemoveFile={(path) => {
              removeContextFile(path);
              postMessage({ type: 'files/remove', payload: { path } });
            }}
            onRemoveClipboardImage={removeClipboardImage}
          />
        </Show>

        <ComposerArea
          textareaRef={(el) => {
            textareaRef = el;
          }}
          placeholder={
            hasActiveQuestion() || hasActivePermission()
              ? 'Respond to the prompt above to continue...'
              : isLoading()
                ? 'Queue a follow-up or steer with \u2303Enter...'
                : 'Describe what to build'
          }
          value={inputText()}
          isFocused={isFocused()}
          showCompletionMenu={showCompletionMenu()}
          completionItems={composerCompletions()}
          completionSelectedIndex={completionIndex()}
          completionHeader={showFileSearchHint() ? 'Type to search workspace files' : undefined}
          onInput={(e) => {
            setHistoryIndex(null);
            setHistoryDraft('');
            setInputText(e.currentTarget.value);
            setCaretPosition(e.currentTarget.selectionStart || 0);
            setCompletionIndex(0);
            setSuppressCompletion(false);
            autoResize();
          }}
          onKeyDown={handleKeydown}
          onPaste={handlePaste}
          onFocus={(e) => {
            setIsFocused(true);
            setCaretPosition(e.currentTarget.selectionStart || 0);
          }}
          onBlur={() => setIsFocused(false)}
          onClick={(e) => {
            setCaretPosition(e.currentTarget.selectionStart || 0);
            setShowAgentPicker(false);
            setShowModelPicker(false);
            setShowMcpPicker(false);
            setShowVariantPicker(false);
            setShowPermissionModePicker(false);
            setShowBusyMenu(false);
          }}
          onKeyUp={(e) => setCaretPosition(e.currentTarget.selectionStart || 0)}
          onSelect={(e) => setCaretPosition(e.currentTarget.selectionStart || 0)}
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

        <ChatInputToolbar
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
          showLeftPopupState={
            showContextPopup() ||
            showAgentPicker() ||
            showVariantPicker() ||
            showMcpPicker() ||
            showPermissionModePicker() ||
            showProviderLimitPopup()
          }
          showPermissionControl={isToolbarControlVisible('permission')}
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
          providerLimitPrefix={currentProviderLimitCompactPrefix()}
          providerLimitLabel={currentProviderLimitCompact()}
          providerLimitTone={currentProviderLimitTone()}
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
          onCycleProviderLimitWindow={() => {
            const limit = currentProviderLimit();
            const providerID = currentModel().providerID;
            if (!limit || !providerID) return;
            const windows = getOrderedProviderLimitWindows(limit);
            if (windows.length <= 1) return;
            const current = currentProviderLimitWindow();
            const currentIndex = current ? windows.findIndex((w) => w.id === current.id) : -1;
            const nextWindow = windows[(currentIndex + 1) % windows.length];
            if (nextWindow)
              setSelectedProviderLimitWindowId(providerID, nextWindow.id, limit.checkedAt);
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
            setSelectedModel(
              {
                providerID: m.providerID!,
                modelID: m.modelID!,
                variant,
              },
              { sessionId: state.activeSessionId }
            );
            setShowVariantPicker(false);
          }}
          contextUsage={contextUsage()}
          showContextControl={isToolbarControlVisible('context')}
          contextButtonRef={(el) => {
            contextButtonRef = el;
          }}
          contextPopupRef={(el) => {
            contextPopupRef = el;
          }}
          showContextPopup={showContextPopup()}
          sessionTokens={sessionTokens()}
          contextCompactDisabled={isLoading() || isSessionCompacting()}
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
          showStopButton={
            isLoading() &&
            !hasActiveQuestion() &&
            !hasActivePermission() &&
            isToolbarControlVisible('stop')
          }
          stopCompact={isToolbarControlCompacted(toolbarCompactMode(), 'stop')}
          onStop={() => abortSession()}
          showSendControl={isToolbarControlVisible('send')}
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
    </div>
  );
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
      name: 'new',
      aliases: ['clear'],
      description: 'Start a new chat session',
      action: () => {
        createSession();
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

  if (props.canUndo) {
    commands.push({
      name: 'undo',
      aliases: ['revert'],
      description: 'Undo the last assistant response',
      action: () => {
        undoSession();
      },
    });
  }

  if (props.canRedo) {
    commands.push({
      name: 'redo',
      aliases: [],
      description: 'Redo the last undone response',
      action: () => {
        redoSession();
      },
    });
  }

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
    if (reservedBuiltInNames.has(command.name)) continue;
    commands.push({
      name: command.name,
      aliases: [],
      description: command.description || command.template,
      action: (args) => {
        void runSlashCommandByName(command.name, args);
      },
    });
  }

  return commands;
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

export function getCompletionSelection(
  completion: ReturnType<typeof getActiveCompletion> | null,
  item: CompletionItem | undefined,
  confirm = false
): CompletionSelection | null {
  if (!completion || !item) return null;

  if (completion.type === 'slash') {
    if (!('name' in item)) return null;
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
