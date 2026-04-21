import { Show, For, createEffect, createMemo, createSignal, onCleanup, onMount } from 'solid-js';
import {
  state,
  inputText,
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
  MAX_CLIPBOARD_IMAGES,
  showModelPicker,
  setShowModelPicker,
  setShowSessionPicker,
  setShowSettings,
  composerFocusKey,
  removeClipboardImage,
  addContextFile,
  removeContextFile,
  showThinking,
  toggleThinking,
  enqueueMessage,
  removeQueuedMessage,
  getPermissionModeForSession,
  error,
  requestMessageListScrollToBottom,
} from '../lib/state';
import { onMessage, postMessage } from '../lib/bridge';
import {
  sendMessage,
  abortSession,
  createSession,
  compactSession,
  undoSession,
  reviewSession,
  updatePermissionModeForSession,
} from '../hooks/useOpenCode';
import { ModelPicker, getVariantsForModel } from './ModelPicker';
import { formatAgentInitial, formatAgentLabel, formatVariantInitial, formatVariantLabel } from '../lib/format';
import {
  isAssistantMessage,
  getContextWindow,
  sumAssistantTokens,
  formatNumber,
} from '../lib/message-metrics';
import { getLeafPathName, getDroppedFileLabel } from '../lib/path-display';
import { TodoList } from './TodoList';
import type { Agent, Part, TextPart } from '../types';
import type { DroppedFile, ExtensionMessage, PermissionMode } from '../../shared/protocol';

export function ChatInput() {
  // oxlint-disable-next-line no-unassigned-vars
  let textareaRef: HTMLTextAreaElement | undefined;
  // oxlint-disable-next-line no-unassigned-vars
  let containerRef: HTMLDivElement | undefined;
  // oxlint-disable-next-line no-unassigned-vars
  let permissionPickerRef: HTMLButtonElement | undefined;
  // oxlint-disable-next-line no-unassigned-vars
  let permissionPopoverRef: HTMLDivElement | undefined;
  // oxlint-disable-next-line no-unassigned-vars
  let agentPickerRef: HTMLButtonElement | undefined;
  // oxlint-disable-next-line no-unassigned-vars
  let agentPopoverRef: HTMLDivElement | undefined;
  // oxlint-disable-next-line no-unassigned-vars
  let modelPickerRef: HTMLButtonElement | undefined;
  // oxlint-disable-next-line no-unassigned-vars
  let toolbarRef: HTMLDivElement | undefined;
  // oxlint-disable-next-line no-unassigned-vars
  let toolbarLeftRef: HTMLDivElement | undefined;
  // oxlint-disable-next-line no-unassigned-vars
  let toolbarRightRef: HTMLDivElement | undefined;
  // oxlint-disable-next-line no-unassigned-vars
  let variantPickerRef: HTMLButtonElement | undefined;
  // oxlint-disable-next-line no-unassigned-vars
  let variantPopoverRef: HTMLDivElement | undefined;
  // oxlint-disable-next-line no-unassigned-vars
  let contextButtonRef: HTMLButtonElement | undefined;
  // oxlint-disable-next-line no-unassigned-vars
  let contextPopupRef: HTMLDivElement | undefined;
  // oxlint-disable-next-line no-unassigned-vars
  let busyMenuRef: HTMLDivElement | undefined;
  // oxlint-disable-next-line no-unassigned-vars
  let busyToggleRef: HTMLButtonElement | undefined;
  const [isDraggingOver, setIsDraggingOver] = createSignal(false);
  const [showAgentPicker, setShowAgentPicker] = createSignal(false);
  const [agentFocusIndex, setAgentFocusIndex] = createSignal(0);
  const [showBusyMenu, setShowBusyMenu] = createSignal(false);
  const [showVariantPicker, setShowVariantPicker] = createSignal(false);
  const [showPermissionModePicker, setShowPermissionModePicker] = createSignal(false);
  const [showContextPopup, setShowContextPopup] = createSignal(false);

  type PopupKind = 'agent' | 'variant' | 'model' | 'permission' | 'context' | 'busy';
  const closePopups = (except?: PopupKind) => {
    if (except !== 'agent') setShowAgentPicker(false);
    if (except !== 'variant') setShowVariantPicker(false);
    if (except !== 'model') setShowModelPicker(false);
    if (except !== 'permission') setShowPermissionModePicker(false);
    if (except !== 'context') setShowContextPopup(false);
    if (except !== 'busy') setShowBusyMenu(false);
  };

  const [isFocused, setIsFocused] = createSignal(false);
  const [historyIndex, setHistoryIndex] = createSignal<number | null>(null);
  const [historyDraft, setHistoryDraft] = createSignal('');
  const [caretPosition, setCaretPosition] = createSignal(0);
  const [completionIndex, setCompletionIndex] = createSignal(0);
  const [fileSearchResults, setFileSearchResults] = createSignal<DroppedFile[]>([]);
  const [fileSearchQuery, setFileSearchQuery] = createSignal('');
  const [suppressCompletion, setSuppressCompletion] = createSignal(false);
  const [toolbarCompactMode, setToolbarCompactMode] = createSignal<
    'full' | 'compact-agent-stop' | 'compact-reasoning' | 'truncate-model' | 'tight'
  >('full');
  let latestFileSearchRequestId = 0;
  let toolbarFitRaf = 0;
  let toolbarFitRequestId = 0;

  const toolbarCompactModes = [
    'full',
    'compact-agent-stop',
    'compact-reasoning',
    'truncate-model',
    'tight',
  ] as const;

  const files = () => state.droppedFiles;
  const clipboardImages = () => state.clipboardImages;
  const selection = () => state.editorContext.selection;
  const terminalSelection = () => state.terminalSelection;
  const activeFile = () => state.editorContext.activeFile;
  const hasContext = () => !!activeFile() || !!selection() || !!terminalSelection();

  const hasMentions = () => files().length > 0 || clipboardImages().length > 0;

  const activeContext = () => {
    const file = activeFile();
    const selectedLines = selection();
    if (!file) return null;
    const displayPath = getLeafPathName(file.relativePath || file.path);
    const lineRange = selectedLines
      ? selectedLines.startLine === selectedLines.endLine
        ? `L${selectedLines.startLine}`
        : `L${selectedLines.startLine}-${selectedLines.endLine}`
      : null;
    return {
      filename: displayPath,
      lineRange,
    };
  };

  const mentionAgents = createMemo(() =>
    state.allAgents
      .filter((agent) => agent.mode === 'subagent' || agent.mode === 'all')
      .toSorted((a, b) => a.name.localeCompare(b.name))
  );

  const slashCommands = createMemo(() =>
    getSlashCommands({
      isBusy: isLoading(),
      canUndo: !!state.activeSessionId && state.messages.some((m) => m.info.role === 'assistant'),
      onOpenSessions: () => setShowSessionPicker(true),
      onOpenModels: () => setShowModelPicker(true),
      onOpenFiles: () => postMessage({ type: 'files/pick' }),
      onOpenSettings: () => setShowSettings(true),
    })
  );

  const activeCompletion = createMemo(() =>
    getActiveCompletion(inputText(), textareaRef?.selectionStart ?? caretPosition())
  );

  createEffect(() => {
    const completion = activeCompletion();
    if (completion?.type !== 'mention') {
      setFileSearchResults([]);
      setFileSearchQuery('');
      return;
    }

    if (!completion.query.trim()) {
      setFileSearchResults([]);
      setFileSearchQuery('');
      return;
    }

    latestFileSearchRequestId += 1;
    setFileSearchQuery(completion.query);
    postMessage({
      type: 'files/search',
      payload: { requestId: latestFileSearchRequestId, query: completion.query, limit: 12 },
    });
  });

  const mentionCompletions = createMemo(() => {
    const completion = activeCompletion();
    if (completion?.type !== 'mention') return [];

    const rawQuery = completion.query.trim();
    const query = rawQuery.toLowerCase();
    const fileLike = looksLikeFileMentionQuery(rawQuery);
    const exactAgentMatch = mentionAgents().some((agent) => agent.name.toLowerCase() === query);
    const exactFileMatch = fileSearchResults().some(
      (file) => normalizeMentionPath(file.relativePath) === normalizeMentionPath(rawQuery)
    );
    if (query && (exactAgentMatch || exactFileMatch)) return [];

    const agents = (fileLike ? [] : mentionAgents())
      .filter((agent) => {
        if (!query) return true;
        return (
          agent.name.toLowerCase().includes(query) ||
          agent.description?.toLowerCase().includes(query)
        );
      })
      .map((agent) => ({
        key: `agent:${agent.name}`,
        type: 'agent' as const,
        label: `@${agent.name}`,
        detail: agent.description || getAgentBadgeLine(agent),
        value: `@${agent.name} `,
      }));

    const completionFiles = (rawQuery ? fileSearchResults() : []).map((file) => ({
      key: `file:${file.path}`,
      type: 'file' as const,
      label: `@${file.relativePath}`,
      detail: file.type === 'directory' ? 'Folder' : 'Workspace file',
      value:
        file.type === 'directory'
          ? `@${formatMentionPath(file.relativePath)}/`
          : `@${formatMentionPath(file.relativePath)}`,
      file,
    }));

    return [...completionFiles, ...agents].slice(0, 10);
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
          setSelectedAgent(agent.name);
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
        applyActiveCompletion();
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
        const completion = activeCompletion();
        const selected =
          composerCompletions()[Math.min(completionIndex(), composerCompletions().length - 1)];

        if (completion?.type === 'slash' && selected && 'name' in selected) {
          e.preventDefault();
          runSlashCommand(`/${selected.name}`);
          return;
        }

        e.preventDefault();
        applyActiveCompletion();
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

  function applyActiveCompletion() {
    const completion = activeCompletion();
    if (!completion) return;

    const items = composerCompletions();
    const item = items[Math.min(completionIndex(), items.length - 1)];
    if (!item) return;

    if (completion.type === 'slash') {
      if (!('name' in item)) return;
      setComposerValue(`/${item.name}`);
      return;
    }

    if (!('value' in item)) return;

    if ('file' in item && item.type === 'file') {
      addContextFile(item.file as DroppedFile);
    }

    applyMentionValue(completion, item.value);
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
    setFileSearchQuery('');

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
    const [name] = normalized.split(/\s+/, 1);
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
    command.action();
  }

  async function handleSend(mode?: 'queue' | 'steer') {
    const text = inputText();
    if (!text.trim() && state.droppedFiles.length === 0 && state.clipboardImages.length === 0)
      return;

    requestMessageListScrollToBottom();

    if (
      mode !== 'steer' &&
      isLoading() &&
      !hasActiveQuestion() &&
      !hasActivePermission() &&
      state.activeSessionId &&
      text.trim() &&
      state.droppedFiles.length === 0 &&
      state.clipboardImages.length === 0
    ) {
      enqueueMessage({
        id: createAttachmentID(),
        sessionId: state.activeSessionId,
        text,
      });
      setHistoryIndex(null);
      setHistoryDraft('');
      setCompletionIndex(0);
      setInputText('');
      resetPastedImageIndex();
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

  async function sendQueuedAsSteer(id: string, text: string) {
    removeQueuedMessage(id);
    await sendMessage(text, { noReply: true });
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
      void sendMessage(next.text);
    }, 250);
  });
  onCleanup(() => {
    if (queueDispatchTimer) clearTimeout(queueDispatchTimer);
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
    const nextMode = toolbarCompactModes[Math.min(modeIndex, toolbarCompactModes.length - 1)];
    setToolbarCompactMode(nextMode);
    queueMicrotask(() => {
      if (requestId !== toolbarFitRequestId) return;
      if (!isToolbarOverflowing() || modeIndex >= toolbarCompactModes.length - 1) return;
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
      }
    }
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
    let nextIndex = nextPastedImageIndex();

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

    replaceComposerSelection(
      filenames.map((filename) => `[${filename}]`).join(' '),
      true
    );
  }

  onMount(() => {
    const disposeBridge = onMessage((msg: ExtensionMessage) => {
      if (msg.type !== 'files/search-results') return;
      if (msg.payload.requestId !== latestFileSearchRequestId) return;
      if (msg.payload.query !== fileSearchQuery()) return;
      setFileSearchResults(msg.payload.files);
    });

    const clickedOutside = (
      target: Node | null,
      trigger?: HTMLElement,
      popup?: HTMLElement
    ) => {
      if (!target) return true;
      if (trigger?.contains(target)) return false;
      if (popup?.contains(target)) return false;
      return true;
    };

    const handleWindowClick = (e: MouseEvent) => {
      const target = e.target as Node | null;

      if (!containerRef?.contains(target)) {
        setShowAgentPicker(false);
        setShowModelPicker(false);
        setShowVariantPicker(false);
        setShowPermissionModePicker(false);
        setShowBusyMenu(false);
        setShowContextPopup(false);
        setCompletionIndex(0);
        return;
      }

      if (showPermissionModePicker() && clickedOutside(target, permissionPickerRef, permissionPopoverRef)) {
        setShowPermissionModePicker(false);
      }
      if (showAgentPicker() && clickedOutside(target, agentPickerRef, agentPopoverRef)) {
        setShowAgentPicker(false);
      }
      if (showModelPicker() && clickedOutside(target, modelPickerRef)) {
        setShowModelPicker(false);
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
      if (showAgentPicker() || showVariantPicker() || showModelPicker() || showPermissionModePicker())
        return;
      if (showBusyMenu() || showContextPopup()) return;
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

  const canSend = () =>
    !hasActiveQuestion() &&
    !hasActivePermission() &&
    (inputText().trim().length > 0 ||
      state.droppedFiles.length > 0 ||
      state.clipboardImages.length > 0);

  const currentModel = () => {
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
  };

  const assistantMessages = createMemo(() =>
    state.messages.map((entry) => entry.info).filter(isAssistantMessage)
  );

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

  const availableVariants = createMemo(() => {
    const model = currentModel();
    return getVariantsForModel(model.providerID, model.modelID, state.providers).filter(
      (v) => v !== 'none'
    );
  });

  const effectiveVariant = createMemo(() => {
    const variants = availableVariants();
    if (variants.length === 0) return null;
    return currentModel().variant && variants.includes(currentModel().variant!)
      ? currentModel().variant
      : variants[0];
  });

  const activePermissionMode = createMemo(() => getPermissionModeForSession(state.activeSessionId));

  const queuedForSession = createMemo(() =>
    state.activeSessionId
      ? state.queuedMessages.filter((item) => item.sessionId === state.activeSessionId)
      : []
  );

  const selectedAgentLabel = () => {
    const name = state.selectedAgent;
    const compactMode = toolbarCompactMode();
    const compactAgent = compactMode !== 'full';
    if (!name) return compactAgent ? 'A' : 'Agent';
    const agent = state.agents.find((a) => a.name === name);
    const label = formatAgentLabel(agent?.name || name);
    return compactAgent ? formatAgentInitial(label) : label;
  };

  const selectedVariantLabel = () => {
    const variant = effectiveVariant();
    if (!variant) return '';
    const compactMode = toolbarCompactMode();
    return compactMode === 'compact-reasoning' ||
      compactMode === 'truncate-model' ||
      compactMode === 'tight'
      ? formatVariantInitial(variant)
      : formatVariantLabel(variant);
  };

  const modelCanEllipsize = () => {
    const compactMode = toolbarCompactMode();
    return compactMode === 'truncate-model' || compactMode === 'tight';
  };

  createEffect(() => {
    void state.agents.length;
    void state.selectedAgent;
    void currentModel().providerName;
    void currentModel().modelName;
    void effectiveVariant();
    void !!contextUsage();
    void isLoading();
    void hasActiveQuestion();
    void hasActivePermission();
    void canSend();

    if (showAgentPicker() || showVariantPicker() || showModelPicker() || showPermissionModePicker())
      return;
    if (showBusyMenu() || showContextPopup()) return;

    scheduleToolbarFit();
  });

  return (
    <div class="interactive-input-part">
      <Show when={showModelPicker()}>
        <ModelPicker
          onSelect={(sel) => {
            if (sel.providerID && sel.modelID) {
              setSelectedModel({
                providerID: sel.providerID,
                modelID: sel.modelID,
                variant: sel.variant,
              });
            }
          }}
          onClose={() => setShowModelPicker(false)}
        />
      </Show>

      <Show when={isDraggingOver()}>
        <div class="chat-drop-overlay" aria-hidden="true" />
      </Show>

      <Show when={queuedForSession().length > 0}>
        <div class="chat-queue-container" role="list" aria-label="Queued messages">
          <For each={queuedForSession()}>
            {(item) => (
              <div class="chat-queue-item" role="listitem" title={item.text}>
                <span class="chat-queue-icon" aria-hidden="true">
                  <svg
                    width="11"
                    height="11"
                    viewBox="0 0 16 16"
                    fill="none"
                    stroke="currentColor"
                    stroke-width="1.5"
                    stroke-linecap="round"
                    stroke-linejoin="round"
                  >
                    <path d="M3 4h10M3 8h10M3 12h6" />
                  </svg>
                </span>
                <span class="chat-queue-label">{item.text}</span>
                <button
                  class="chat-queue-action"
                  onClick={() => sendQueuedAsSteer(item.id, item.text)}
                  title="Send now as Steer"
                  aria-label="Send as Steer"
                >
                  <svg
                    width="11"
                    height="11"
                    viewBox="0 0 16 16"
                    fill="none"
                    stroke="currentColor"
                    stroke-width="1.75"
                    stroke-linecap="round"
                    stroke-linejoin="round"
                  >
                    <path d="M8 13V3M4 7l4-4 4 4" />
                  </svg>
                  <span class="chat-queue-action-label">Steer</span>
                </button>
                <button
                  class="chat-queue-remove"
                  onClick={() => removeQueuedMessage(item.id)}
                  title="Remove from queue"
                  aria-label="Remove from queue"
                >
                  <svg width="10" height="10" viewBox="0 0 16 16" fill="currentColor">
                    <path d="M3.72 3.72a.75.75 0 011.06 0L8 6.94l3.22-3.22a.75.75 0 111.06 1.06L9.06 8l3.22 3.22a.75.75 0 11-1.06 1.06L8 9.06l-3.22 3.22a.75.75 0 01-1.06-1.06L6.94 8 3.72 4.78a.75.75 0 010-1.06z" />
                  </svg>
                </button>
              </div>
            )}
          </For>
        </div>
      </Show>

      <Show when={state.todos.length > 0}>
        <TodoList />
      </Show>

      <div
        ref={containerRef}
        class={`chat-input-container ${isFocused() ? 'focused' : ''} ${showContextPopup() || showAgentPicker() || showVariantPicker() || showPermissionModePicker() || showBusyMenu() || (isFocused() && composerCompletions().length > 0 && !suppressCompletion()) ? 'showing-context-popup' : ''}`}
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
          <div class="chat-attachments-container">
            <Show when={activeContext()}>
              <AttachmentChip
                label={activeContext()!.filename}
                detail={activeContext()!.lineRange}
                title={
                  activeContext()!.lineRange
                    ? `${activeContext()!.filename} ${activeContext()!.lineRange}`
                    : activeContext()!.filename
                }
              />
            </Show>
            <Show when={terminalSelection()}>
              <AttachmentChip
                label={terminalSelection()!.terminalName}
                detail="terminal"
                icon="terminal"
                title={`Terminal: ${terminalSelection()!.terminalName}`}
                onRemove={() => postMessage({ type: 'terminal-selection/clear' })}
              />
            </Show>
            <For each={files()}>
              {(file) => (
                <AttachmentChip
                  label={getDroppedFileLabel(file)}
                  icon={file.type === 'directory' ? 'folder' : 'file'}
                  title={file.relativePath || file.path}
                  onRemove={() => {
                    removeContextFile(file.path);
                    postMessage({ type: 'files/remove', payload: { path: file.path } });
                  }}
                />
              )}
            </For>
            <For each={clipboardImages()}>
              {(image) => (
                <AttachmentChip
                  label={image.filename}
                  icon="image"
                  title={image.filename}
                  onRemove={() => removeClipboardImage(image.id)}
                />
              )}
            </For>
          </div>
        </Show>

        <div class="chat-editor-container">
          <textarea
            ref={textareaRef!}
            style={{
              'min-height': '36px',
              width: '100%',
              resize: 'none',
              background: 'transparent',
              padding: '0 0 0 6px',
              'font-size': '13px',
              'line-height': '1.45',
              color: 'var(--color-vscode-input-fg)',
              outline: 'none',
              'font-family': 'inherit',
              border: 'none',
            }}
            rows={1}
            placeholder={
              hasActiveQuestion() || hasActivePermission()
                ? 'Respond to the prompt above to continue...'
                : isLoading()
                  ? 'Queue a follow-up or steer with \u2303Enter...'
                  : 'Describe what to build'
            }
            value={inputText()}
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
              setShowVariantPicker(false);
              setShowPermissionModePicker(false);
              setShowBusyMenu(false);
            }}
            onKeyUp={(e) => setCaretPosition(e.currentTarget.selectionStart || 0)}
            onSelect={(e) => setCaretPosition(e.currentTarget.selectionStart || 0)}
          />

          <Show when={isFocused() && composerCompletions().length > 0 && !suppressCompletion()}>
            <CompletionMenu
              items={composerCompletions()}
              selectedIndex={completionIndex()}
              onSelect={(item) => {
                const completion = activeCompletion();
                if (!completion) return;
                if (completion.type === 'slash') {
                  if (!('name' in item)) return;
                  setComposerValue(`/${item.name}`);
                  return;
                }
                if (!('value' in item)) return;
                applyMentionValue(completion, item.value);
              }}
            />
          </Show>
        </div>

        <div
          ref={toolbarRef}
          class={`chat-input-toolbars ${toolbarCompactMode() === 'tight' ? 'compact-tight' : ''}`}
        >
          <div
            ref={toolbarLeftRef}
            class={`toolbar-left${showContextPopup() || showAgentPicker() || showVariantPicker() || showPermissionModePicker() ? ' showing-context-popup' : ''}`}
          >
            <div style={{ position: 'relative' }}>
              <button
                ref={permissionPickerRef!}
                class="toolbar-picker icon-only"
                onClick={() => {
                  const next = !showPermissionModePicker();
                  closePopups(next ? 'permission' : undefined);
                  setShowPermissionModePicker(next);
                }}
                title={
                  activePermissionMode() === 'full'
                    ? 'Full access permissions'
                    : 'Default permissions'
                }
                aria-label={
                  activePermissionMode() === 'full'
                    ? 'Full access permissions'
                    : 'Default permissions'
                }
              >
                <PermissionModeIcon mode={activePermissionMode()} />
              </button>
              <Show when={showPermissionModePicker()}>
                <div
                  ref={permissionPopoverRef!}
                  class="toolbar-popover"
                  onClick={(e) => e.stopPropagation()}
                >
                  <div class="toolbar-popover-header">Permissions</div>
                  <For each={PERMISSION_MODE_OPTIONS}>
                    {(option) => (
                      <button
                        class={`toolbar-popover-item ${activePermissionMode() === option.mode ? 'selected' : ''}`}
                        onClick={() => {
                          void updatePermissionModeForSession(option.mode);
                          setShowPermissionModePicker(false);
                        }}
                      >
                        <PermissionModeIcon mode={option.mode} />
                        <span class="min-w-0 flex-1">{option.label}</span>
                      </button>
                    )}
                  </For>
                </div>
              </Show>
            </div>

            <Show when={state.agents.length > 0}>
              <div style={{ position: 'relative' }}>
                <button
                  ref={agentPickerRef!}
                  class="toolbar-picker"
                  onClick={() => {
                    const next = !showAgentPicker();
                    closePopups(next ? 'agent' : undefined);
                    setShowAgentPicker(next);
                    if (next) setAgentFocusIndex(0);
                  }}
                  title="Select agent"
                >
                  <span class="toolbar-picker-label">{selectedAgentLabel()}</span>
                  <svg
                    class="codicon-chevron"
                    width="10"
                    height="10"
                    viewBox="0 0 16 16"
                    fill="none"
                    stroke="currentColor"
                    stroke-width="1.5"
                    stroke-linecap="round"
                    stroke-linejoin="round"
                  >
                    <path d="M4 6l4 4 4-4" />
                  </svg>
                </button>
                <Show when={showAgentPicker()}>
                  <div
                    ref={agentPopoverRef!}
                    class="toolbar-popover agent-popover"
                    onClick={(e) => e.stopPropagation()}
                  >
                    <div class="toolbar-popover-header">Agent</div>
                    <For each={state.agents}>
                      {(agent, index) => (
                        <button
                          class={`toolbar-popover-item ${state.selectedAgent === agent.name ? 'selected' : ''} ${agentFocusIndex() === index() ? 'keyboard-focus' : ''}`}
                          onClick={() => {
                            setSelectedAgent(agent.name);
                            setShowAgentPicker(false);
                          }}
                          onMouseEnter={() => setAgentFocusIndex(index())}
                        >
                          <span class="min-w-0 flex-1">
                            <span class="block truncate">{formatAgentLabel(agent.name)}</span>
                            <span class="block truncate text-[10px] text-vscode-muted/80">
                              {agent.description || getAgentBadgeLine(agent)}
                            </span>
                          </span>
                        </button>
                      )}
                    </For>
                  </div>
                </Show>
              </div>
            </Show>

            <button
              ref={modelPickerRef!}
              class={`toolbar-picker model-picker-btn ${modelCanEllipsize() ? 'model-ellipsis' : ''}`}
              onClick={() => {
                const next = !showModelPicker();
                closePopups(next ? 'model' : undefined);
                setShowModelPicker(next);
              }}
              title={
                currentModel().modelName
                  ? `${currentModel().providerName} / ${currentModel().modelName}`
                  : 'Choose model'
              }
            >
              <Show
                when={currentModel().modelName}
                fallback={<span class="toolbar-picker-label model-name">Model</span>}
              >
                <span class="toolbar-picker-label model-name">{currentModel().modelName}</span>
              </Show>
              <svg
                class="codicon-chevron"
                width="10"
                height="10"
                viewBox="0 0 16 16"
                fill="none"
                stroke="currentColor"
                stroke-width="1.5"
                stroke-linecap="round"
                stroke-linejoin="round"
              >
                <path d="M4 6l4 4 4-4" />
              </svg>
            </button>

            <Show when={availableVariants().length > 0}>
              <div style={{ position: 'relative' }}>
                <button
                  ref={variantPickerRef!}
                  class="toolbar-picker"
                  onClick={() => {
                    const next = !showVariantPicker();
                    closePopups(next ? 'variant' : undefined);
                    setShowVariantPicker(next);
                  }}
                  title="Thinking level"
                >
                  <span class="toolbar-picker-label">{selectedVariantLabel()}</span>
                  <svg
                    class="codicon-chevron"
                    width="10"
                    height="10"
                    viewBox="0 0 16 16"
                    fill="none"
                    stroke="currentColor"
                    stroke-width="1.5"
                    stroke-linecap="round"
                    stroke-linejoin="round"
                  >
                    <path d="M4 6l4 4 4-4" />
                  </svg>
                </button>
                <Show when={showVariantPicker()}>
                  <div
                    ref={variantPopoverRef!}
                    class="toolbar-popover"
                    onClick={(e) => e.stopPropagation()}
                  >
                    <div class="toolbar-popover-header">Reasoning</div>
                    <For each={availableVariants()}>
                      {(v) => (
                        <button
                          class={`toolbar-popover-item ${effectiveVariant() === v ? 'selected' : ''}`}
                          onClick={() => {
                            const m = currentModel();
                            setSelectedModel({
                              providerID: m.providerID!,
                              modelID: m.modelID!,
                              variant: v,
                            });
                            setShowVariantPicker(false);
                          }}
                        >
                          {formatVariantLabel(v)}
                        </button>
                      )}
                    </For>
                  </div>
                </Show>
              </div>
            </Show>

            <Show when={contextUsage()}>
              <div style={{ position: 'relative' }}>
                <button
                  ref={contextButtonRef!}
                  class={`chat-context-usage ${contextUsage()!.percent >= 75 ? (contextUsage()!.percent >= 90 ? 'error' : 'warning') : ''}`}
                  onClick={() => {
                    const next = !showContextPopup();
                    closePopups(next ? 'context' : undefined);
                    setShowContextPopup(next);
                  }}
                  title="Context usage"
                >
                  <svg class="circular-progress" viewBox="0 0 36 36">
                    <circle class="progress-bg" cx="18" cy="18" r="14" />
                    <circle
                      class="progress-arc"
                      cx="18"
                      cy="18"
                      r="14"
                      stroke-dasharray="87.96"
                      stroke-dashoffset={`${87.96 - (contextUsage()!.percent / 100) * 87.96}`}
                    />
                  </svg>
                </button>
                <Show when={showContextPopup()}>
                  <ContextPopup
                    ref={contextPopupRef!}
                    usage={contextUsage()!}
                    tokens={sessionTokens()}
                    model={currentModel()}
                    onClose={() => setShowContextPopup(false)}
                  />
                </Show>
              </div>
            </Show>
          </div>

          <div ref={toolbarRightRef} class="toolbar-right">
            <Show when={isLoading() && !hasActiveQuestion() && !hasActivePermission()}>
              <button
                class={`toolbar-picker stop-button ${toolbarCompactMode() === 'full' ? '' : 'compact'}`}
                onClick={() => abortSession()}
                title="Stop"
                aria-label="Stop"
              >
                <svg width="10" height="10" viewBox="0 0 16 16" fill="currentColor">
                  <rect x="3" y="3" width="10" height="10" rx="1.5" />
                </svg>
                <Show when={toolbarCompactMode() === 'full'}>
                  <span class="toolbar-picker-label">Stop</span>
                </Show>
              </button>
            </Show>

            <div style={{ position: 'relative' }}>
              <Show
                when={isLoading() && !hasActiveQuestion() && !hasActivePermission() && canSend()}
                fallback={
                  <button
                    class={`chat-send-button ${canSend() ? 'enabled' : 'disabled'}`}
                    onClick={() => canSend() && handleSend()}
                    disabled={!canSend()}
                    title="Send (Enter)"
                  >
                    <svg width="14" height="14" viewBox="0 0 16 16" fill="currentColor">
                      <path d="M8 2.5L3.5 7H6v6.5h4V7h2.5L8 2.5z" />
                    </svg>
                  </button>
                }
              >
                <div class="send-button-group">
                  <button
                    class="chat-send-button enabled send-main"
                    onClick={() => handleSend()}
                    title="Add to queue (Enter)"
                  >
                    <svg width="14" height="14" viewBox="0 0 16 16" fill="currentColor">
                      <path d="M8 2.5L3.5 7H6v6.5h4V7h2.5L8 2.5z" />
                    </svg>
                  </button>
                  <button
                    ref={busyToggleRef!}
                    class="send-mode-chevron"
                    onClick={() => {
                      const next = !showBusyMenu();
                      closePopups(next ? 'busy' : undefined);
                      setShowBusyMenu(next);
                    }}
                    title="More send options"
                  >
                    <svg
                      width="8"
                      height="8"
                      viewBox="0 0 16 16"
                      fill="none"
                      stroke="currentColor"
                      stroke-width="2"
                      stroke-linecap="round"
                      stroke-linejoin="round"
                    >
                      <path d="M4 10l4-4 4 4" />
                    </svg>
                  </button>
                </div>
              </Show>

              <Show
                when={
                  showBusyMenu() &&
                  canSend() &&
                  isLoading() &&
                  !hasActiveQuestion() &&
                  !hasActivePermission()
                }
              >
                <div
                  ref={busyMenuRef!}
                  class="toolbar-popover busy-menu"
                  onClick={(e) => e.stopPropagation()}
                >
                  <button
                    class="toolbar-popover-item"
                    onClick={() => {
                      handleSend();
                      setShowBusyMenu(false);
                    }}
                  >
                    <span class="busy-menu-icon">
                      <svg
                        width="11"
                        height="11"
                        viewBox="0 0 16 16"
                        fill="none"
                        stroke="currentColor"
                        stroke-width="1.5"
                        stroke-linecap="round"
                        stroke-linejoin="round"
                      >
                        <path d="M8 3v10M3 8h10" />
                      </svg>
                    </span>
                    <span class="busy-menu-label">Add to Queue</span>
                    <span class="busy-menu-hint">Enter</span>
                  </button>
                  <button
                    class="toolbar-popover-item"
                    onClick={() => {
                      handleSend('steer');
                      setShowBusyMenu(false);
                    }}
                  >
                    <span class="busy-menu-icon">
                      <svg
                        width="11"
                        height="11"
                        viewBox="0 0 16 16"
                        fill="none"
                        stroke="currentColor"
                        stroke-width="1.5"
                        stroke-linecap="round"
                        stroke-linejoin="round"
                      >
                        <path d="M8 2l1.8 4.8H15l-4 3.4 1.6 5L8 12l-4.6 3.2 1.6-5-4-3.4h5.2z" />
                      </svg>
                    </span>
                    <span class="busy-menu-label">Steer with Message</span>
                    <span class="busy-menu-hint">{'\u2303'}Enter</span>
                  </button>
                  <button
                    class="toolbar-popover-item"
                    onClick={() => {
                      abortSession();
                      handleSend();
                      setShowBusyMenu(false);
                    }}
                  >
                    <span class="busy-menu-icon" style={{ color: 'var(--color-vscode-error)' }}>
                      <svg
                        width="11"
                        height="11"
                        viewBox="0 0 16 16"
                        fill="none"
                        stroke="currentColor"
                        stroke-width="1.5"
                        stroke-linecap="round"
                        stroke-linejoin="round"
                      >
                        <path d="M2 3l12 10M14 3L2 13" />
                      </svg>
                    </span>
                    <span class="busy-menu-label">Stop and Send</span>
                  </button>
                </div>
              </Show>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

function ContextPopup(props: {
  ref?: HTMLDivElement | ((el: HTMLDivElement) => void);
  usage: { used: number; limit: number; percent: number };
  tokens: {
    total: number;
    input: number;
    output: number;
    reasoning: number;
    cacheRead: number;
    cacheWrite: number;
  };
  model: { providerName: string; modelName: string };
  onClose: () => void;
}) {
  const rows = () => {
    const t = props.tokens;
    const items: Array<{ label: string; value: number; color?: string }> = [
      { label: 'Input', value: t.input },
      { label: 'Output', value: t.output },
    ];
    if (t.reasoning > 0) items.push({ label: 'Reasoning', value: t.reasoning });
    if (t.cacheRead > 0) items.push({ label: 'Cache read', value: t.cacheRead });
    if (t.cacheWrite > 0) items.push({ label: 'Cache write', value: t.cacheWrite });
    return items;
  };

  return (
    <div ref={props.ref} class="context-popup" onClick={(e) => e.stopPropagation()}>
      <div class="context-popup-header">
        <span class="context-popup-title">Context Window</span>
        <span class="context-popup-pct">{Math.round(props.usage.percent)}%</span>
      </div>

      <div class="context-popup-bar">
        <div
          class={`context-popup-bar-fill ${props.usage.percent >= 90 ? 'error' : props.usage.percent >= 75 ? 'warning' : ''}`}
          style={{ width: `${Math.min(props.usage.percent, 100)}%` }}
        />
      </div>

      <div class="context-popup-stat">
        <span>{formatNumber(props.usage.used)}</span>
        <span class="context-popup-sep">/</span>
        <span>{formatNumber(props.usage.limit)}</span>
        <span class="context-popup-unit">tokens</span>
      </div>

      <Show when={props.tokens.total > 0}>
        <div class="context-popup-section">Session Tokens</div>
        <div class="context-popup-rows">
          <For each={rows()}>
            {(row) => (
              <div class="context-popup-row">
                <span class="context-popup-row-label">{row.label}</span>
                <span class="context-popup-row-value">{formatNumber(row.value)}</span>
              </div>
            )}
          </For>
          <div class="context-popup-row context-popup-row-total">
            <span class="context-popup-row-label">Total</span>
            <span class="context-popup-row-value">{formatNumber(props.tokens.total)}</span>
          </div>
        </div>
      </Show>

      <Show when={props.model.modelName}>
        <div class="context-popup-model">
          {props.model.providerName} / {props.model.modelName}
        </div>
      </Show>
    </div>
  );
}

type SlashCommand = {
  name: string;
  aliases: string[];
  description: string;
  action: () => void;
};

type CompletionItem =
  | (SlashCommand & { key: string; type: 'slash' })
  | { key: string; type: 'agent' | 'file'; label: string; detail: string; value: string };

function CompletionMenu(props: {
  items: CompletionItem[];
  selectedIndex: number;
  onSelect: (item: CompletionItem) => void;
}) {
  // oxlint-disable-next-line no-unassigned-vars
  let menuRef: HTMLDivElement | undefined;
  const itemRefs = new Map<number, HTMLButtonElement>();

  createEffect(() => {
    const items = props.items;
    const activeIndices = new Set(items.map((_, i) => i));
    for (const key of itemRefs.keys()) {
      if (!activeIndices.has(key)) itemRefs.delete(key);
    }
  });

  createEffect(() => {
    const idx = props.selectedIndex;
    const el = itemRefs.get(idx);
    if (!el || !menuRef) return;
    const elTop = el.offsetTop;
    const elBottom = elTop + el.offsetHeight;
    const viewTop = menuRef.scrollTop;
    const viewBottom = viewTop + menuRef.clientHeight;
    if (elTop < viewTop) {
      menuRef.scrollTop = elTop;
    } else if (elBottom > viewBottom) {
      menuRef.scrollTop = elBottom - menuRef.clientHeight;
    }
  });

  return (
    <div class="composer-completion-menu" ref={menuRef}>
      <For each={props.items}>
        {(item, index) => {
          const isSlash = item.type === 'slash';
          const title = 'name' in item ? `/${item.name}` : item.label;
          const detail = 'description' in item ? item.description : item.detail;
          return (
            <button
              ref={(el) => itemRefs.set(index(), el)}
              class={`composer-completion-item ${props.selectedIndex === index() ? 'selected' : ''}`}
              onMouseDown={(e) => e.preventDefault()}
              onClick={() => props.onSelect(item)}
            >
              <Show when={!isSlash}>
                <span class="composer-completion-icon">
                  <Show
                    when={item.type === 'agent'}
                    fallback={
                      <svg width="14" height="14" viewBox="0 0 16 16" fill="currentColor">
                        <path d="M9.5 1.1l3.4 3.5.1.4v10c0 .6-.4 1-1 1H4c-.6 0-1-.4-1-1V2c0-.6.4-1 1-1h5.1l.4.1z" />
                      </svg>
                    }
                  >
                    <svg width="14" height="14" viewBox="0 0 16 16" fill="currentColor">
                      <path d="M2.5 1h3.4l.6.5.5.5H14l.5.5v10l-.5.5H2l-.5-.5v-11L2.5 1zm0 1v3h4l.5.5.5.5h4v-3H8.5L8 2.5l-.5-.5H2.5zm0 10h11V6h-4l-.5-.5L8.5 5h-6v7z" />
                    </svg>
                  </Show>
                </span>
              </Show>
              <span class="composer-completion-title">{title}</span>
              <span class="composer-completion-detail">{detail}</span>
            </button>
          );
        }}
      </For>
    </div>
  );
}

function AttachmentChip(props: {
  label: string;
  detail?: string | null;
  icon?: 'file' | 'folder' | 'image' | 'terminal';
  onRemove?: () => void;
  title?: string;
}) {
  return (
    <span class="chat-attachment-chip" title={props.title}>
      <Show when={props.onRemove}>
        <button class="chip-remove" onClick={() => props.onRemove?.()}>
          <svg width="10" height="10" viewBox="0 0 16 16" fill="currentColor">
            <path d="M3.72 3.72a.75.75 0 011.06 0L8 6.94l3.22-3.22a.75.75 0 111.06 1.06L9.06 8l3.22 3.22a.75.75 0 11-1.06 1.06L8 9.06l-3.22 3.22a.75.75 0 01-1.06-1.06L6.94 8 3.72 4.78a.75.75 0 010-1.06z" />
          </svg>
        </button>
      </Show>
      <Show when={props.icon === 'image'}>
        <svg class="chip-icon" viewBox="0 0 16 16" fill="currentColor" width="12" height="12">
          <path d="M14.5 2h-13a.5.5 0 00-.5.5v11a.5.5 0 00.5.5h13a.5.5 0 00.5-.5v-11a.5.5 0 00-.5-.5zM2 3h12v7.3l-2.6-2.6a.5.5 0 00-.7 0L7.5 11 5.9 9.4a.5.5 0 00-.7 0L2 12.6V3zm3.5 4a1.5 1.5 0 100-3 1.5 1.5 0 000 3z" />
        </svg>
      </Show>
      <Show when={props.icon === 'folder'}>
        <svg class="chip-icon" viewBox="0 0 16 16" fill="currentColor" width="12" height="12">
          <path d="M1.75 3A1.75 1.75 0 000 4.75v6.5C0 12.22.78 13 1.75 13h12.5c.97 0 1.75-.78 1.75-1.75V5.75C16 4.78 15.22 4 14.25 4H8.41L6.7 2.29A1 1 0 005.99 2H1.75z" />
        </svg>
      </Show>
      <Show when={props.icon === 'terminal'}>
        <svg class="chip-icon" viewBox="0 0 16 16" fill="currentColor" width="12" height="12">
          <path d="M1.75 2h12.5c.97 0 1.75.78 1.75 1.75v8.5c0 .97-.78 1.75-1.75 1.75H1.75A1.75 1.75 0 010 12.25v-8.5C0 2.78.78 2 1.75 2zm0 1a.75.75 0 00-.75.75v8.5c0 .41.34.75.75.75h12.5a.75.75 0 00.75-.75v-8.5a.75.75 0 00-.75-.75H1.75zm2.03 2.22a.75.75 0 011.06 0L6.56 6.94 4.84 8.66a.75.75 0 11-1.06-1.06L4.44 7 3.78 6.28a.75.75 0 010-1.06zM8 8.25h4a.75.75 0 010 1.5H8a.75.75 0 010-1.5z" />
        </svg>
      </Show>
      <Show when={props.icon !== 'image' && props.icon !== 'folder' && props.icon !== 'terminal'}>
        <svg class="chip-icon" viewBox="0 0 16 16" fill="currentColor" width="12" height="12">
          <path d="M9.5 1.1l3.4 3.5.1.4v10c0 .6-.4 1-1 1H4c-.6 0-1-.4-1-1V2c0-.6.4-1 1-1h5.1l.4.1z" />
        </svg>
      </Show>
      <span class="chip-label">{props.label}</span>
      <Show when={props.detail}>
        <span class="chip-detail">{props.detail}</span>
      </Show>
    </span>
  );
}

const PERMISSION_MODE_OPTIONS: Array<{ mode: PermissionMode; label: string }> = [
  { mode: 'default', label: 'Default' },
  { mode: 'full', label: 'Full access' },
];

function PermissionModeIcon(props: { mode: PermissionMode }) {
  return (
    <span class={`permission-mode-icon ${props.mode}`} aria-hidden="true">
      <Show
        when={props.mode === 'full'}
        fallback={
          <svg viewBox="0 0 16 16" fill="currentColor" width="14" height="14">
            <path d="M8 1L2.5 3v4c0 3.4 2.3 6.5 5.5 7.5 3.2-1 5.5-4.1 5.5-7.5V3L8 1zm4 6c0 2.8-1.8 5.2-4 6.2C5.8 12.2 4 9.8 4 7V4l4-1.5L12 4v3z" />
          </svg>
        }
      >
        <svg viewBox="0 0 16 16" fill="currentColor" width="14" height="14">
          <path d="M8 1L2.5 3v4c0 3.4 2.3 6.5 5.5 7.5 3.2-1 5.5-4.1 5.5-7.5V3L8 1z" />
        </svg>
      </Show>
    </span>
  );
}

function getSlashCommands(props: {
  isBusy: boolean;
  canUndo: boolean;
  onOpenSessions: () => void;
  onOpenModels: () => void;
  onOpenFiles: () => void;
  onOpenSettings: () => void;
}): SlashCommand[] {
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
      action: props.onOpenSessions,
    },
    {
      name: 'models',
      aliases: [],
      description: 'Open the model picker',
      action: props.onOpenModels,
    },
    {
      name: 'attach',
      aliases: ['files'],
      description: 'Pick files or folders to attach',
      action: props.onOpenFiles,
    },
    {
      name: 'settings',
      aliases: [],
      description: 'Open model visibility settings',
      action: props.onOpenSettings,
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

  commands.push({
    name: 'review',
    aliases: [],
    description: 'Review current code changes',
    action: () => {
      reviewSession();
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

  return commands;
}

function getActiveCompletion(text: string, cursor: number) {
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

function looksLikeFileMentionQuery(query: string) {
  return /[./\\]/.test(query);
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

function parseDroppedText(value: string): string[] {
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

function shouldPadInlineInsertion(value: string | undefined) {
  return !!value && !/\s/.test(value);
}

function getPastedImageFilename(index: number) {
  return index <= 1 ? 'Image' : `Image ${index}`;
}

function createAttachmentID() {
  if (typeof crypto !== 'undefined' && 'randomUUID' in crypto) {
    return crypto.randomUUID();
  }
  return `img-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
}

function extensionForMime(mime: string) {
  switch (mime) {
    case 'image/jpeg':
      return 'jpg';
    case 'image/gif':
      return 'gif';
    case 'image/webp':
      return 'webp';
    default:
      return 'png';
  }
}
