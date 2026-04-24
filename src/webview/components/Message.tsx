import { For, Show, createEffect, createMemo, createResource, createSignal } from 'solid-js';
import { client } from '../lib/client';
import { getAssistantDiffRequest, isAssistantMessage } from '../lib/message-metrics';
import { retryMessage } from '../hooks/useOpenCode';
import type {
  AssistantMessage,
  CompactionPart,
  FileDiff,
  FilePart,
  Message as MessageType,
  Part,
  TextPart,
  ToolPart,
} from '../types';
import { DiffView } from './DiffView';
import { MessagePart } from './MessagePart';
import { isLoading, state } from '../lib/state';
import {
  formatDisplayPath,
  getLeafPathName,
  isAbsolutePath,
  normalizePath,
} from '../lib/path-display';
import { postMessage } from '../lib/bridge';
import { getToolFileChange } from '../lib/tool-file-change';
import { collapseLeadingDuplicateFileEvents } from '../lib/message-event-collapse';
import {
  formatContextLineRanges,
  getFirstContextLine,
  parseSelectionReference,
} from '../../shared/context-files';
import {
  getFinalAssistantTextPartId,
  isFileEditPart,
  isWorkspaceDirectoryText,
  shouldShowAssistantPartInHighlightedCard,
  shouldShowAssistantPartInline,
} from '../lib/part-utils';

export type AssistantFileEditStackGroup = 'start' | 'middle' | 'end';

export function getAssistantContainerVariant(params: {
  isUser: boolean;
  visibleDiffCount: number;
  fileEditStackGroup?: AssistantFileEditStackGroup | null;
  isSubagent: boolean;
  hasStructuredAssistantParts: boolean;
  layoutParts: Part[];
  highlightFinalAnswer: boolean;
  hasError: boolean;
}): 'bare' | 'plain' | false {
  if (params.isUser) return false;
  if (params.visibleDiffCount > 0) return false;
  if (params.fileEditStackGroup) return false;
  if (params.hasError) return 'plain';
  if (!params.highlightFinalAnswer) {
    return 'plain';
  }

  const parts = params.layoutParts;
  if (parts.length === 0) return false;
  const textPartCount = parts.filter((part) => part.type === 'text').length;
  const hasReasoningPart = parts.some((part) => part.type === 'reasoning');

  if (params.highlightFinalAnswer && textPartCount >= 1 && hasReasoningPart) {
    return 'plain';
  }

  if (parts.length !== 1) {
    if (
      !params.highlightFinalAnswer &&
      textPartCount >= 1 &&
      (params.hasStructuredAssistantParts || params.isSubagent)
    ) {
      return 'plain';
    }
    if (
      params.highlightFinalAnswer &&
      textPartCount > 1 &&
      (params.hasStructuredAssistantParts || params.isSubagent)
    ) {
      return 'plain';
    }
    return false;
  }

  const part = parts[0];
  if (part.type === 'reasoning') return 'bare';
  return part.type === 'tool' && !isFileEditPart(part) ? 'bare' : false;
}

export function Message(props: {
  info: MessageType;
  parts: Part[];
  isLastAssistant?: boolean;
  highlightFinalAnswer?: boolean;
  highlightPlanningAnswer?: boolean;
  previousTrailingFileEventSignature?: string | null;
  fileEditStackGroup?: AssistantFileEditStackGroup | null;
  streamingPartId?: string | null;
  streamingText?: string;
}) {
  const isUser = () => props.info.role === 'user';
  const assistant = () => (isAssistantMessage(props.info) ? props.info : null);
  const assistantErrorMessage = createMemo(() => {
    const error = assistant()?.error;
    const message = error?.data?.message?.trim();
    if (message) return message;
    const name = error?.name?.trim();
    return name || null;
  });
  const isSubagent = () => assistant()?.mode === 'subagent';
  const isLatestAssistant = () => {
    const latestAssistant = [...state.messages]
      .toReversed()
      .find((entry) => entry.info.role === 'assistant');
    return latestAssistant?.info.id === assistant()?.id;
  };
  const normalizedParts = createMemo(() =>
    assistant()
      ? collapseLeadingDuplicateFileEvents(
          props.parts,
          props.previousTrailingFileEventSignature ?? null
        )
      : props.parts
  );
  const getEffectivePartText = (part: Part) =>
    part.type === 'text' && part.id === props.streamingPartId
      ? props.streamingText || part.text
      : part.type === 'text'
        ? part.text
        : null;
  const visibleAssistantParts = createMemo(() =>
    assistant()
      ? normalizedParts().filter((part) => {
          if (part.type === 'text') {
            const effectiveText = getEffectivePartText(part) || '';
            return effectiveText.trim().length > 0 && !isWorkspaceDirectoryText(effectiveText);
          }
          return shouldShowAssistantPartInline(part);
        })
      : normalizedParts()
  );
  const layoutAssistantParts = createMemo(() =>
    assistant() ? deduplicateFileEdits(visibleAssistantParts()) : []
  );
  const diffRequest = createMemo(() => {
    if (assistantErrorMessage()) return null;
    const request = getAssistantDiffRequest(props.info, props.isLastAssistant ?? false);
    return request ? `${request.sessionID}\u0000${request.messageID}` : null;
  });

  const [diffs] = createResource(diffRequest, async (requestKey) => {
    const [sessionID, messageID] = requestKey.split('\u0000');
    return client.session.diff(sessionID, messageID).catch(() => [] as FileDiff[]);
  });
  const visibleDiffs = createMemo(() => (diffRequest() ? diffs() || [] : []));
  const compactionDivider = createMemo<CompactionPart | null>(() => {
    const parts = normalizedParts();
    const compactions = parts.filter((p): p is CompactionPart => p.type === 'compaction');
    if (compactions.length === 0) return null;
    const hasOtherVisibleContent = parts.some((p) => {
      if (p.type === 'compaction') return false;
      if (p.type === 'text') return (getEffectivePartText(p) || '').trim().length > 0;
      if (p.type === 'file') return true;
      return false;
    });
    return hasOtherVisibleContent ? null : compactions[compactions.length - 1];
  });
  const shouldRender = () =>
    !!compactionDivider() ||
    isUser() ||
    !!assistantErrorMessage() ||
    visibleAssistantParts().length > 0 ||
    visibleDiffs().length > 0;
  const hasStructuredAssistantParts = () =>
    assistant()
      ? visibleAssistantParts().some((part) => part.type !== 'text' && part.type !== 'file')
      : false;
  const hasVisibleReasoningPart = () =>
    assistant() ? visibleAssistantParts().some((part) => part.type === 'reasoning') : false;
  const assistantContainerVariant = () => {
    if (props.highlightFinalAnswer && hasVisibleReasoningPart()) {
      return 'plain';
    }

    return getAssistantContainerVariant({
      isUser: isUser(),
      visibleDiffCount: visibleDiffs().length,
      fileEditStackGroup: props.fileEditStackGroup,
      isSubagent: isSubagent(),
      hasStructuredAssistantParts: hasStructuredAssistantParts(),
      layoutParts: layoutAssistantParts(),
      highlightFinalAnswer: !!props.highlightFinalAnswer,
      hasError: !!assistantErrorMessage(),
    });
  };
  const streamedTextForPart = (part: Part) =>
    part.type === 'text' && part.id === props.streamingPartId
      ? props.streamingText || part.text
      : null;
  const assistantContainerClass = () => {
    const variant = assistantContainerVariant();
    if (variant === 'bare') return 'assistant-turn-content assistant-turn-content-bare';
    if (variant === 'plain') return 'assistant-turn-content assistant-turn-content-plain';
    return `assistant-turn-content${props.highlightFinalAnswer ? ' assistant-turn-content-highlighted' : ''}${props.highlightPlanningAnswer ? ' assistant-turn-content-planning' : ''}`;
  };
  const isWrapperlessAssistant = () => assistantContainerVariant() === 'plain';

  return (
    <Show when={shouldRender()}>
      <Show
        when={!compactionDivider()}
        fallback={<CompactionDivider part={compactionDivider()!} />}
      >
        <div
          class={`chat-turn ${isUser() ? 'chat-turn-user' : 'chat-turn-assistant'}${isWrapperlessAssistant() ? ' chat-turn-assistant-plain' : ''}`}
        >
          <div
            class={`value chat-turn-content ${
              isUser() ? 'chat-turn-card user-message-card' : assistantContainerClass()
            } ${isSubagent() ? 'chat-turn-subagent' : ''} ${
              props.fileEditStackGroup
                ? `assistant-turn-file-edit-group-${props.fileEditStackGroup}`
                : ''
            }`}
          >
            <Show when={isUser()}>
              <UserMessageContent parts={normalizedParts()} />
            </Show>
            <Show when={!isUser() && assistant()}>
              <AssistantMessageContent
                info={assistant()!}
                parts={visibleAssistantParts()}
                errorMessage={assistantErrorMessage()}
                onRetry={
                  isLatestAssistant()
                    ? () => void retryMessage(assistant()!.id, assistant()!.sessionID)
                    : undefined
                }
                highlightFinalAnswer={props.highlightFinalAnswer}
                highlightPlanningAnswer={props.highlightPlanningAnswer}
                suppressHighlightedCardMetaParts={
                  !!props.highlightFinalAnswer && assistantContainerVariant() !== 'plain'
                }
                streamedTextForPart={streamedTextForPart}
              />
            </Show>
            <Show when={assistant() && visibleDiffs().length > 0}>
              <DiffSummary diffs={visibleDiffs()} />
            </Show>
          </div>
        </div>
      </Show>
    </Show>
  );
}

function CompactionDivider(props: { part: CompactionPart }) {
  const label = () => {
    const kind = props.part.auto ? 'auto' : 'manual';
    return props.part.overflow
      ? `Context compacted (${kind}, after overflow)`
      : `Context compacted (${kind})`;
  };
  return (
    <div class="message-compaction-divider">
      <span class="message-compaction-label">{label()}</span>
    </div>
  );
}

type MessageAttachment =
  | {
      type: 'file-selection';
      filename: string;
      lineRanges: Array<{ startLine: number; endLine: number }>;
    }
  | { type: 'terminal-selection'; terminalName: string }
  | { type: 'file-reference'; path: string; isDirectory: boolean };

type UserMessageSegment =
  | { type: 'text'; content: string }
  | { type: 'code'; content: string; language?: string };

export type ParsedUserMessageContent = {
  messageTexts: string[];
  attachments: MessageAttachment[];
  fileParts: FilePart[];
};

const USER_CODE_FENCE_RE = /```([^\n`]*)\n([\s\S]*?)```/g;

function trimFenceBoundaryNewlines(content: string, side: 'start' | 'end') {
  return side === 'start' ? content.replace(/^\n+/, '') : content.replace(/\n+$/, '');
}

function parseUserMessageSegments(text: string): UserMessageSegment[] {
  const normalized = text.replace(/\r\n?/g, '\n');
  const segments: UserMessageSegment[] = [];
  let lastIndex = 0;

  for (const match of normalized.matchAll(USER_CODE_FENCE_RE)) {
    const index = match.index ?? 0;
    if (index > lastIndex) {
      const content = trimFenceBoundaryNewlines(normalized.slice(lastIndex, index), 'end');
      if (content.length > 0) {
        segments.push({ type: 'text', content });
      }
    }

    segments.push({
      type: 'code',
      content: match[2],
      language: match[1].trim() || undefined,
    });
    lastIndex = index + match[0].length;
  }

  if (lastIndex < normalized.length) {
    const content = trimFenceBoundaryNewlines(normalized.slice(lastIndex), 'start');
    if (content.length > 0) {
      segments.push({ type: 'text', content });
    }
  }

  if (segments.length === 0) {
    segments.push({ type: 'text', content: normalized });
  }

  return segments;
}

export function parseUserMessageContent(parts: Part[]): ParsedUserMessageContent {
  const messageTexts: string[] = [];
  const attachments: MessageAttachment[] = [];
  const fileParts: FilePart[] = [];

  for (const part of parts) {
    if (part.type === 'file') {
      fileParts.push(part as FilePart);
      continue;
    }

    if (part.type !== 'text') continue;
    const text = (part as TextPart).text;
    if (!text) continue;

    if (text.startsWith('[Working directory:')) continue;

    if (text.startsWith('[Selection from ') && !text.startsWith('[Selection from terminal')) {
      const selectionRef = parseSelectionReference(text);
      if (selectionRef) {
        attachments.push({
          type: 'file-selection',
          filename: selectionRef.path,
          lineRanges: selectionRef.lineRanges,
        });
        continue;
      }
    }

    if (text.startsWith('[Selection from terminal')) {
      const match = text.match(/^\[Selection from terminal (.+?)\]/);
      if (match) {
        attachments.push({
          type: 'terminal-selection',
          terminalName: match[1],
        });
        continue;
      }
    }

    if (text.startsWith('[Active file:')) {
      const match = text.match(/^\[Active file: (.+?)\]/);
      if (match) {
        attachments.push({
          type: 'file-reference',
          path: match[1],
          isDirectory: false,
        });
        continue;
      }
    }

    if (isStandaloneFileReference(text)) {
      attachments.push({
        type: 'file-reference',
        path: text,
        isDirectory: text.endsWith('/'),
      });
      continue;
    }

    messageTexts.push(text);
  }

  return { messageTexts, attachments, fileParts };
}

export function getUserMessagePreviewText(parts: Part[]): string {
  const parsed = parseUserMessageContent(parts);
  const firstText = parsed.messageTexts
    .map((text) => text.replace(/\s+/g, ' ').trim())
    .find((text) => text.length > 0);
  if (firstText) return firstText;

  const firstAttachment = parsed.attachments[0];
  if (firstAttachment) {
    switch (firstAttachment.type) {
      case 'file-selection':
        return `Selection: ${getLeafPathName(firstAttachment.filename)}`;
      case 'terminal-selection':
        return `Terminal: ${firstAttachment.terminalName}`;
      case 'file-reference':
        return `${firstAttachment.isDirectory ? 'Folder' : 'File'}: ${getLeafPathName(firstAttachment.path)}`;
    }
  }

  const firstFilePart = parsed.fileParts[0];
  if (firstFilePart) {
    return firstFilePart.filename ? `Attachment: ${firstFilePart.filename}` : 'Attachment';
  }

  return '(no content)';
}

function UserMessageContent(props: { parts: Part[] }) {
  const parsed = createMemo(() => parseUserMessageContent(props.parts));

  const imageParts = createMemo(() =>
    parsed().fileParts.filter((part) => part.mime.startsWith('image/'))
  );
  const otherFileParts = createMemo(() =>
    parsed().fileParts.filter((part) => !part.mime.startsWith('image/'))
  );

  const hasContent = () =>
    parsed().messageTexts.length > 0 ||
    parsed().fileParts.length > 0 ||
    parsed().attachments.length > 0;

  return (
    <div class="rendered-markdown">
      <Show when={parsed().messageTexts.length > 0}>
        <div class="user-message-text-scroll">
          <For each={parsed().messageTexts}>{(text) => <UserMessageTextContent text={text} />}</For>
        </div>
      </Show>
      <Show when={!hasContent()}>
        <p class="user-message-empty">(no content)</p>
      </Show>
      <Show when={parsed().attachments.length > 0}>
        <div class="message-attachments">
          <For each={parsed().attachments}>
            {(att) => <MessageAttachmentChip attachment={att} />}
          </For>
        </div>
      </Show>
      <Show
        when={imageParts().length > 1}
        fallback={<For each={imageParts()}>{(part) => <MessagePart part={part} />}</For>}
      >
        <UserImageCarousel imageParts={imageParts()} />
      </Show>
      <For each={otherFileParts()}>{(part) => <MessagePart part={part} />}</For>
    </div>
  );
}

function UserMessageTextContent(props: { text: string }) {
  const segments = createMemo(() => parseUserMessageSegments(props.text));

  return (
    <For each={segments()}>
      {(segment) =>
        segment.type === 'code' ? (
          <div
            class="interactive-result-code-block user-message-code-block"
            data-lang={segment.language}
          >
            <Show when={segment.language}>
              <div class="code-block-header">
                <span class="code-block-lang">{segment.language}</span>
              </div>
            </Show>
            <pre class="code-block">
              <code>{segment.content}</code>
            </pre>
          </div>
        ) : (
          <Show when={segment.content.length > 0}>
            <p class="user-message-text">{segment.content}</p>
          </Show>
        )
      }
    </For>
  );
}

function UserImageCarousel(props: { imageParts: FilePart[] }) {
  const [activeIndex, setActiveIndex] = createSignal(0);
  const total = () => props.imageParts.length;
  const currentPart = () => props.imageParts[activeIndex()];
  const currentDisplayName = () => {
    const part = currentPart();
    if (!part) return '(file)';
    if (part.source?.path) {
      return formatDisplayPath(part.source.path, state.editorContext.workspacePath);
    }
    if (part.filename) {
      return formatDisplayPath(part.filename, state.editorContext.workspacePath);
    }
    return '(file)';
  };

  createEffect(() => {
    const maxIndex = total() - 1;
    setActiveIndex((index) => {
      if (maxIndex < 0) return 0;
      return Math.min(index, maxIndex);
    });
  });

  const step = (delta: number) => {
    const count = total();
    if (count <= 1) return;
    setActiveIndex((index) => (index + delta + count) % count);
  };

  return (
    <div class="message-image-carousel">
      <div class="message-image-carousel-frame">
        <div class="message-image-carousel-slide">
          <Show when={currentPart()}>
            {(part) => (
              <figure class="chat-image-figure message-image-carousel-figure">
                <img src={part().url} alt={currentDisplayName()} class="chat-image-img" />
                <figcaption class="chat-image-caption message-image-carousel-caption-row">
                  <span class="message-image-carousel-caption" title={currentDisplayName()}>
                    <span class="message-image-carousel-count">
                      {activeIndex() + 1} / {total()}
                    </span>
                    <span class="message-image-carousel-separator">&middot;</span>
                    {currentDisplayName()} <span class="chat-image-mime">· {part().mime}</span>
                  </span>
                  <div class="message-image-carousel-controls">
                    <button
                      type="button"
                      class="message-image-carousel-nav"
                      onClick={() => step(-1)}
                      aria-label="Previous image"
                      title="Previous image"
                    >
                      <svg
                        viewBox="0 0 16 16"
                        fill="none"
                        stroke="currentColor"
                        stroke-width="1.5"
                        width="14"
                        height="14"
                      >
                        <path d="M10 3 5 8l5 5" stroke-linecap="round" stroke-linejoin="round" />
                      </svg>
                    </button>
                    <button
                      type="button"
                      class="message-image-carousel-nav"
                      onClick={() => step(1)}
                      aria-label="Next image"
                      title="Next image"
                    >
                      <svg
                        viewBox="0 0 16 16"
                        fill="none"
                        stroke="currentColor"
                        stroke-width="1.5"
                        width="14"
                        height="14"
                      >
                        <path d="m6 3 5 5-5 5" stroke-linecap="round" stroke-linejoin="round" />
                      </svg>
                    </button>
                  </div>
                </figcaption>
              </figure>
            )}
          </Show>
        </div>
      </div>
    </div>
  );
}

function isStandaloneFileReference(text: string): boolean {
  const t = text.trim();
  if (t.startsWith('[')) return false;
  if (t.includes('\n')) return false;
  if (t.includes(' ')) return false;
  if (t.length <= 1 || t.length > 300) return false;
  return t.includes('/') || /^\w[\w.-]*\.\w{1,12}$/.test(t);
}

function MessageAttachmentChip(props: { attachment: MessageAttachment }) {
  const att = () => props.attachment;
  const isFolder = () =>
    att().type === 'file-reference' &&
    (att() as Extract<MessageAttachment, { type: 'file-reference' }>).isDirectory;
  const isTerminal = () => att().type === 'terminal-selection';

  const handleClick = () => {
    const a = att();
    if (a.type === 'terminal-selection') return;
    const filePath = normalizePath(a.type === 'file-reference' ? a.path : a.filename);
    const wp = state.editorContext.workspacePath;
    const absolutePath = isAbsolutePath(filePath)
      ? filePath
      : wp
        ? `${normalizePath(wp).replace(/\/+$/, '')}/${filePath.replace(/^\.\//, '')}`
        : filePath;
    const line = a.type === 'file-selection' ? getFirstContextLine(a.lineRanges) : undefined;
    postMessage({
      type: 'vscode/open',
      payload: {
        path: absolutePath,
        line,
        kind: a.type === 'file-reference' && a.isDirectory ? 'directory' : 'file',
      },
    });
  };

  const iconSvg = () => {
    if (isFolder()) {
      return (
        <svg class="chip-icon" viewBox="0 0 16 16" fill="currentColor" width="12" height="12">
          <path d="M1.75 3A1.75 1.75 0 000 4.75v6.5C0 12.22.78 13 1.75 13h12.5c.97 0 1.75-.78 1.75-1.75V5.75C16 4.78 15.22 4 14.25 4H8.41L6.7 2.29A1 1 0 005.99 2H1.75z" />
        </svg>
      );
    }
    if (isTerminal()) {
      return (
        <svg class="chip-icon" viewBox="0 0 16 16" fill="currentColor" width="12" height="12">
          <path d="M1.75 2h12.5c.97 0 1.75.78 1.75 1.75v8.5c0 .97-.78 1.75-1.75 1.75H1.75A1.75 1.75 0 010 12.25v-8.5C0 2.78.78 2 1.75 2zm0 1a.75.75 0 00-.75.75v8.5c0 .41.34.75.75.75h12.5a.75.75 0 00.75-.75v-8.5a.75.75 0 00-.75-.75H1.75zm2.03 2.22a.75.75 0 011.06 0L6.56 6.94 4.84 8.66a.75.75 0 11-1.06-1.06L4.44 7 3.78 6.28a.75.75 0 010-1.06zM8 8.25h4a.75.75 0 010 1.5H8a.75.75 0 010-1.5z" />
        </svg>
      );
    }
    return (
      <svg class="chip-icon" viewBox="0 0 16 16" fill="currentColor" width="12" height="12">
        <path d="M9.5 1.1l3.4 3.5.1.4v10c0 .6-.4 1-1 1H4c-.6 0-1-.4-1-1V2c0-.6.4-1 1-1h5.1l.4.1z" />
      </svg>
    );
  };

  const detail = () => {
    const a = att();
    if (a.type === 'file-selection') {
      return <span class="chip-detail">{formatContextLineRanges(a.lineRanges)}</span>;
    }
    if (a.type === 'terminal-selection') {
      return <span class="chip-detail">terminal</span>;
    }
    return null;
  };

  return (
    <Show
      when={isTerminal()}
      fallback={
        <button
          class="message-attachment-chip message-attachment-chip-clickable"
          title={getAttachmentTitle(att())}
          onClick={handleClick}
        >
          {iconSvg()}
          <span class="chip-label">{getAttachmentLabel(att())}</span>
          {detail()}
        </button>
      }
    >
      <span class="message-attachment-chip" title={getAttachmentTitle(att())}>
        {iconSvg()}
        <span class="chip-label">{getAttachmentLabel(att())}</span>
        {detail()}
      </span>
    </Show>
  );
}

function getAttachmentLabel(att: MessageAttachment): string {
  switch (att.type) {
    case 'file-selection':
      return getLeafPathName(att.filename);
    case 'terminal-selection':
      return att.terminalName;
    case 'file-reference':
      return getLeafPathName(att.path);
  }
}

function getAttachmentTitle(att: MessageAttachment): string {
  switch (att.type) {
    case 'file-selection':
      return `${att.filename}:${att.lineRanges.map((range) => `${range.startLine}-${range.endLine}`).join(',')}`;
    case 'terminal-selection':
      return `Terminal: ${att.terminalName}`;
    case 'file-reference':
      return att.path;
  }
}

function deduplicateFileEdits(parts: Part[]): Part[] {
  const result: Part[] = [];
  for (let i = 0; i < parts.length; i++) {
    if (!isFileEditPart(parts[i])) {
      result.push(parts[i]);
      continue;
    }
    const currentChange = getToolFileChange(
      (parts[i] as ToolPart).tool,
      (parts[i] as ToolPart).state
    );
    let last = i;
    while (
      last + 1 < parts.length &&
      isFileEditPart(parts[last + 1]) &&
      getToolFileChange((parts[last + 1] as ToolPart).tool, (parts[last + 1] as ToolPart).state)
        ?.dedupeKey === currentChange?.dedupeKey
    ) {
      last++;
    }
    result.push(parts[last]);
    i = last;
  }
  return result;
}

function AssistantMessageContent(props: {
  info: AssistantMessage;
  parts: Part[];
  errorMessage?: string | null;
  onRetry?: (() => void) | undefined;
  highlightFinalAnswer?: boolean;
  highlightPlanningAnswer?: boolean;
  suppressHighlightedCardMetaParts?: boolean;
  streamedTextForPart: (part: Part) => string | null;
}) {
  const dedupedParts = createMemo(() => deduplicateFileEdits(props.parts));
  const displayParts = createMemo(() =>
    props.suppressHighlightedCardMetaParts
      ? dedupedParts().filter((part) => {
          if (part.type === 'text') {
            const effectiveText = props.streamedTextForPart(part) || part.text;
            return shouldShowAssistantPartInHighlightedCard({ ...part, text: effectiveText });
          }
          return shouldShowAssistantPartInHighlightedCard(part);
        })
      : dedupedParts()
  );
  const finalTextPartId = createMemo(() =>
    getFinalAssistantTextPartId(displayParts(), !!props.highlightFinalAnswer)
  );
  const renderItems = createMemo(() => {
    const items: Array<
      { kind: 'part'; part: Part } | { kind: 'file-edit-stack'; parts: ToolPart[] }
    > = [];
    const parts = displayParts();

    for (let i = 0; i < parts.length; i++) {
      const part = parts[i];

      if (isFileEditPart(part)) {
        const fileEditParts: ToolPart[] = [part as ToolPart];
        while (i + 1 < parts.length && isFileEditPart(parts[i + 1])) {
          fileEditParts.push(parts[++i] as ToolPart);
        }
        items.push({ kind: 'file-edit-stack', parts: fileEditParts });
        continue;
      }

      items.push({ kind: 'part', part });
    }

    return items;
  });

  return (
    <div class="assistant-message-flow">
      <For each={renderItems()}>
        {(item) =>
          item.kind === 'file-edit-stack' ? (
            <div class="assistant-message-flow-item">
              <div class="assistant-file-edit-stack">
                <For each={item.parts}>
                  {(part) => (
                    <MessagePart
                      part={part}
                      messageInfo={props.info}
                      streamedText={props.streamedTextForPart(part)}
                    />
                  )}
                </For>
              </div>
            </div>
          ) : (
            <div
              class={getAssistantFlowItemClass(
                item.part,
                finalTextPartId(),
                !!props.highlightPlanningAnswer
              )}
            >
              <MessagePart
                part={item.part}
                messageInfo={props.info}
                streamedText={props.streamedTextForPart(item.part)}
              />
            </div>
          )
        }
      </For>
      <Show when={props.errorMessage}>
        <div class="assistant-message-flow-item assistant-message-flow-item-error rendered-markdown">
          <p>{props.errorMessage!}</p>
          <Show when={props.onRetry}>
            <div class="assistant-message-flow-item-error-actions">
              <button
                type="button"
                class="assistant-dialog-summary-action assistant-dialog-summary-action-implement assistant-message-flow-item-error-action"
                disabled={isLoading()}
                onClick={() => props.onRetry?.()}
              >
                Retry
              </button>
            </div>
          </Show>
        </div>
      </Show>
    </div>
  );
}

function getAssistantFlowItemClass(
  part: Part,
  finalTextPartId: string | null,
  highlightPlanningAnswer: boolean
) {
  const className = 'assistant-message-flow-item';
  if (part.type !== 'text' || part.id !== finalTextPartId) return className;

  return `${className} assistant-message-flow-item-final${highlightPlanningAnswer ? ' assistant-message-flow-item-final-planning' : ''}`;
}

function DiffSummary(props: { diffs: FileDiff[] }) {
  const [expanded, setExpanded] = createSignal(false);
  const summary = createMemo(() =>
    props.diffs.reduce((acc, d) => ({ add: acc.add + d.additions, del: acc.del + d.deletions }), {
      add: 0,
      del: 0,
    })
  );

  return (
    <div class="diff-summary">
      <button
        onClick={() => setExpanded((v) => !v)}
        class="diff-summary-btn"
        aria-expanded={expanded()}
      >
        <svg
          class={`transition-transform ${expanded() ? 'rotate-90' : ''}`}
          width="10"
          height="10"
          viewBox="0 0 16 16"
          fill="none"
          stroke="currentColor"
          stroke-width="1.5"
          stroke-linecap="round"
          stroke-linejoin="round"
        >
          <path d="M6 4l4 4-4 4" />
        </svg>
        <span>
          {props.diffs.length} file{props.diffs.length !== 1 ? 's' : ''} changed ·{' '}
          <span class="diff-lines-added">+{summary().add}</span>{' '}
          <span class="diff-lines-removed">-{summary().del}</span>
        </span>
      </button>
      <Show when={expanded()}>
        <div class="diff-summary-content animate-fade-in">
          <DiffView diffs={props.diffs} />
        </div>
      </Show>
    </div>
  );
}
