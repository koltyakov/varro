import { For, Show, createEffect, createMemo, createSignal } from 'solid-js';
import {
  formatDisplayPath,
  getLeafPathName,
  isAbsolutePath,
  normalizePath,
} from '../../lib/path-display';
import { postMessage } from '../../lib/bridge';
import { state } from '../../lib/state';
import type { FilePart, Part, TextPart } from '../../types';
import {
  formatContextLineRanges,
  getFirstContextLine,
  parseSelectionReference,
} from '../../../shared/context-files';
import { ImagePreviewOverlay, createImagePreviewEffect } from '../ImagePreview';
import type { PreviewImage } from '../ImagePreview';
import { renderCodeBlockHtml } from '../MarkdownRenderer';
import { MessagePart } from '../MessagePart';
import { DocumentIcon } from '../DocumentIcon';
import { FolderIcon } from '../FolderIcon';

export type MessageAttachment =
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

type IndexedMessageAttachment = {
  id: string;
  attachment: MessageAttachment;
  marker: string | null;
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

    const parsedText = parseUserMessageText(text);
    attachments.push(...parsedText.attachments);
    messageTexts.push(...parsedText.messageTexts);
  }

  return { messageTexts, attachments, fileParts };
}

function parseUserMessageText(text: string): {
  messageTexts: string[];
  attachments: MessageAttachment[];
} {
  const normalized = text.replace(/\r\n?/g, '\n');
  const lines = normalized.split('\n');
  const messageTexts: string[] = [];
  const attachments: MessageAttachment[] = [];
  const textBuffer: string[] = [];
  let inCodeFence = false;

  const flushTextBuffer = () => {
    const content = textBuffer.join('\n').replace(/^\n+/, '').replace(/\n+$/, '');
    textBuffer.length = 0;
    if (content.length > 0) {
      messageTexts.push(content);
    }
  };

  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    const trimmedLine = line.trim();

    if (!inCodeFence) {
      if (trimmedLine.startsWith('[Working directory:')) {
        flushTextBuffer();
        continue;
      }

      const terminalMatch = trimmedLine.match(/^\[Selection from terminal (.+?)\]/);
      if (terminalMatch) {
        flushTextBuffer();
        attachments.push({
          type: 'terminal-selection',
          terminalName: terminalMatch[1],
        });

        if (lines[index + 1]?.trim().startsWith('```')) {
          index += 2;
          while (index < lines.length) {
            if (lines[index].trim() === '```') break;
            index += 1;
          }
        }
        continue;
      }

      const attachment = parseUserMessageAttachmentLine(trimmedLine);
      if (attachment) {
        flushTextBuffer();
        attachments.push(attachment);
        continue;
      }
    }

    textBuffer.push(line);
    if (trimmedLine.startsWith('```')) {
      inCodeFence = !inCodeFence;
    }
  }

  flushTextBuffer();

  return { messageTexts, attachments };
}

function parseUserMessageAttachmentLine(line: string): MessageAttachment | null {
  if (!line) return null;

  if (line.startsWith('[Selection from ') && !line.startsWith('[Selection from terminal')) {
    const selectionRef = parseSelectionReference(line);
    if (selectionRef) {
      return {
        type: 'file-selection',
        filename: selectionRef.path,
        lineRanges: selectionRef.lineRanges,
      };
    }
  }

  if (line.startsWith('[Active file:')) {
    const match = line.match(/^\[Active file: (.+?)\]/);
    if (match) {
      return {
        type: 'file-reference',
        path: match[1],
        isDirectory: false,
      };
    }
  }

  if (isStandaloneFileReference(line)) {
    return {
      type: 'file-reference',
      path: line,
      isDirectory: line.endsWith('/'),
    };
  }

  return null;
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

export function UserMessageContent(props: { parts: Part[] }) {
  const parsed = createMemo(() => parseUserMessageContent(props.parts));
  const indexedAttachments = createMemo<IndexedMessageAttachment[]>(() =>
    parsed().attachments.map((attachment, index) => ({
      id: `attachment-${index}`,
      attachment,
      marker: getAttachmentTextMarker(attachment),
    }))
  );
  const inlineAttachmentIds = createMemo(() =>
    getInlineAttachmentIds(parsed().messageTexts, indexedAttachments())
  );
  const visibleAttachments = createMemo(() =>
    indexedAttachments().filter(({ id }) => !inlineAttachmentIds().has(id))
  );

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
  const hasTrailingAttachmentContent = () =>
    otherFileParts().length > 0 || parsed().messageTexts.length > 0 || imageParts().length > 0;

  return (
    <div
      class={`rendered-markdown${imageParts().length > 0 ? ' user-message-content-has-image' : ''}`}
    >
      <Show when={visibleAttachments().length > 0}>
        <div
          class={`message-attachments${hasTrailingAttachmentContent() ? ' message-attachments-leading' : ' message-attachments-standalone'}`}
        >
          <For each={visibleAttachments()}>
            {({ attachment }) => <MessageAttachmentChip attachment={attachment} />}
          </For>
        </div>
      </Show>
      <For each={otherFileParts()}>{(part) => <MessagePart part={part} />}</For>
      <Show when={parsed().messageTexts.length > 0}>
        <div class="user-message-text-scroll">
          <For each={parsed().messageTexts}>
            {(text) => <UserMessageTextContent text={text} attachments={indexedAttachments()} />}
          </For>
        </div>
      </Show>
      <Show when={!hasContent()}>
        <p class="user-message-empty">(no content)</p>
      </Show>
      <Show
        when={imageParts().length > 1}
        fallback={<For each={imageParts()}>{(part) => <MessagePart part={part} />}</For>}
      >
        <UserImageCarousel imageParts={imageParts()} />
      </Show>
    </div>
  );
}

function UserMessageTextContent(props: {
  text: string;
  attachments: IndexedMessageAttachment[];
}) {
  const segments = createMemo(() => parseUserMessageSegments(props.text));

  return (
    <For each={segments()}>
      {(segment) =>
        segment.type === 'code' ? (
          <div
            innerHTML={renderCodeBlockHtml({
              text: segment.content,
              lang: segment.language,
              className: 'user-message-code-block',
              showCopyButton: false,
            })}
          />
        ) : (
          <Show when={segment.content.length > 0}>
            <p class="user-message-text">
              <InlineAttachmentText content={segment.content} attachments={props.attachments} />
            </p>
          </Show>
        )
      }
    </For>
  );
}

function InlineAttachmentText(props: {
  content: string;
  attachments: IndexedMessageAttachment[];
}) {
  const segments = createMemo(() => buildInlineTextSegments(props.content, props.attachments));

  return (
    <For each={segments()}>
      {(segment) =>
        segment.type === 'attachment' ? (
          <InlineMessageAttachmentChip attachment={segment.attachment} />
        ) : (
          segment.content
        )
      }
    </For>
  );
}

function UserImageCarousel(props: { imageParts: FilePart[] }) {
  const [activeIndex, setActiveIndex] = createSignal(0);
  const [previewIndex, setPreviewIndex] = createSignal<number | null>(null);
  const total = () => props.imageParts.length;
  const currentPart = () => props.imageParts[activeIndex()];
  const previewPosition = () => {
    const index = previewIndex();
    return index === null ? undefined : index + 1;
  };
  const previewPart = () => {
    const index = previewIndex();
    if (index === null) return null;
    return props.imageParts[index] ?? null;
  };
  const previewImage = (): PreviewImage | null => {
    const part = previewPart();
    if (!part) return null;

    const name = part.source?.path
      ? formatDisplayPath(part.source.path, state.editorContext.workspacePath)
      : part.filename
        ? formatDisplayPath(part.filename, state.editorContext.workspacePath)
        : '(file)';

    return {
      url: part.url,
      alt: name,
      title: name,
      mime: part.mime,
    };
  };
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
    setPreviewIndex((index) => {
      if (index === null) return null;
      if (maxIndex < 0) return null;
      return Math.min(index, maxIndex);
    });
  });

  const step = (delta: number) => {
    const count = total();
    if (count <= 1) return;
    setActiveIndex((index) => (index + delta + count) % count);
  };
  const openPreview = () => {
    if (!currentPart()) return;
    setPreviewIndex(activeIndex());
  };
  const stepPreview = (delta: number) => {
    const count = total();
    if (count <= 1) return;
    setPreviewIndex((index) => {
      if (index === null) return index;
      const nextIndex = (index + delta + count) % count;
      setActiveIndex(nextIndex);
      return nextIndex;
    });
  };

  createImagePreviewEffect(
    () => previewIndex() !== null,
    () => setPreviewIndex(null),
    {
      canNavigate: () => total() > 1,
      onPrevious: () => stepPreview(-1),
      onNext: () => stepPreview(1),
    }
  );

  return (
    <>
      <div class="message-image-carousel">
        <div class="message-image-carousel-frame">
          <div class="message-image-carousel-slide">
            <Show when={currentPart()}>
              {(part) => (
                <figure class="chat-image-figure message-image-carousel-figure">
                  <button
                    type="button"
                    class="chat-image-preview-trigger message-image-carousel-preview-trigger"
                    aria-label={`Open image preview: ${currentDisplayName()}`}
                    title="Open image preview"
                    onClick={openPreview}
                  >
                    <img src={part().url} alt={currentDisplayName()} class="chat-image-img" />
                  </button>
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
      <ImagePreviewOverlay
        image={previewImage()}
        onClose={() => setPreviewIndex(null)}
        onPrevious={() => stepPreview(-1)}
        onNext={() => stepPreview(1)}
        showNavigation={total() > 1}
        position={previewPosition()}
        total={total()}
      />
    </>
  );
}

function isStandaloneFileReference(text: string): boolean {
  const trimmed = text.trim();
  if (trimmed.startsWith('[')) return false;
  if (trimmed.includes('\n')) return false;
  if (trimmed.length <= 1 || trimmed.length > 300) return false;

  const normalized = normalizePath(trimmed);
  if (/\s\/|\/\s/.test(normalized)) return false;
  if (isAbsolutePath(normalized)) return true;
  if (trimmed.includes(' ') && !normalized.endsWith('/') && !/\.\w{1,12}$/.test(trimmed)) {
    return false;
  }
  if (normalized.includes('/')) return true;
  if (trimmed.includes(' ')) return false;
  return /^\w[\w.-]*\.\w{1,12}$/.test(trimmed);
}

function getAttachmentTextMarker(attachment: MessageAttachment): string | null {
  switch (attachment.type) {
    case 'file-reference':
      return `@${attachment.path}`;
    case 'file-selection':
      return `@${attachment.filename}`;
    case 'terminal-selection':
      return null;
  }
}

function getInlineAttachmentIds(
  messageTexts: string[],
  attachments: IndexedMessageAttachment[]
): Set<string> {
  const attachmentByMarker = new Map<string, IndexedMessageAttachment>();

  for (const attachment of attachments) {
    if (!attachment.marker) continue;
    attachmentByMarker.set(attachment.marker, attachment);
  }

  const inlineIds = new Set<string>();
  for (const text of messageTexts) {
    for (const [marker, attachment] of attachmentByMarker) {
      if (text.includes(marker)) {
        inlineIds.add(attachment.id);
      }
    }
  }

  return inlineIds;
}

function buildInlineTextSegments(content: string, attachments: IndexedMessageAttachment[]) {
  const attachmentByMarker = new Map<string, IndexedMessageAttachment>();

  for (const attachment of attachments) {
    if (!attachment.marker) continue;
    attachmentByMarker.set(attachment.marker, attachment);
  }

  const markers = Array.from(attachmentByMarker.keys())
    .filter((marker) => content.includes(marker))
    .toSorted((a, b) => b.length - a.length);
  if (markers.length === 0) {
    return [{ type: 'text' as const, content }];
  }

  const pattern = new RegExp(`(${markers.map((marker) => escapeRegex(marker)).join('|')})`, 'g');
  const segments: Array<
    | { type: 'text'; content: string }
    | { type: 'attachment'; attachment: MessageAttachment }
  > = [];

  for (const part of content.split(pattern)) {
    if (!part) continue;
    const attachment = attachmentByMarker.get(part);
    if (attachment) {
      segments.push({ type: 'attachment', attachment: attachment.attachment });
      continue;
    }
    segments.push({ type: 'text', content: part });
  }

  return segments;
}

function escapeRegex(value: string) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function InlineMessageAttachmentChip(props: { attachment: MessageAttachment }) {
  const attachment = () => props.attachment;
  const isFolder = () =>
    attachment().type === 'file-reference' &&
    (attachment() as Extract<MessageAttachment, { type: 'file-reference' }>).isDirectory;
  const fileSelection = () =>
    attachment().type === 'file-selection'
      ? (attachment() as Extract<MessageAttachment, { type: 'file-selection' }>)
      : null;

  const handleClick = () => openAttachment(attachment());

  return (
    <button
      type="button"
      class="inline-chip inline-chip-clickable"
      title={getAttachmentTitle(attachment())}
      onClick={handleClick}
    >
      <Show when={isFolder()} fallback={<DocumentIcon class="inline-chip-icon" width="11" height="11" />}>
        <FolderIcon class="inline-chip-icon" width="11" height="11" />
      </Show>
      <span class="inline-chip-label">{getAttachmentLabel(attachment())}</span>
      <Show when={fileSelection()}>
        {(selection) => (
          <span class="inline-chip-detail">{formatContextLineRanges(selection().lineRanges)}</span>
        )}
      </Show>
    </button>
  );
}

function openAttachment(value: MessageAttachment) {
  if (value.type === 'terminal-selection') return;

  const filePath = normalizePath(value.type === 'file-reference' ? value.path : value.filename);
  const workspacePath = state.editorContext.workspacePath;
  const absolutePath = isAbsolutePath(filePath)
    ? filePath
    : workspacePath
      ? `${normalizePath(workspacePath).replace(/\/+$/, '')}/${filePath.replace(/^\.\//, '')}`
      : filePath;
  const line = value.type === 'file-selection' ? getFirstContextLine(value.lineRanges) : undefined;

  postMessage({
    type: 'vscode/open',
    payload: {
      path: absolutePath,
      line,
      kind: value.type === 'file-reference' && value.isDirectory ? 'directory' : 'file',
    },
  });
}

function MessageAttachmentChip(props: { attachment: MessageAttachment }) {
  const attachment = () => props.attachment;
  const isFolder = () =>
    attachment().type === 'file-reference' &&
    (attachment() as Extract<MessageAttachment, { type: 'file-reference' }>).isDirectory;
  const isTerminal = () => attachment().type === 'terminal-selection';

  const handleClick = () => openAttachment(attachment());

  const iconSvg = () => {
    if (isFolder()) {
      return <FolderIcon class="chip-icon" width="12" height="12" />;
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
    const value = attachment();
    if (value.type === 'file-selection') {
      return <span class="chip-detail">{formatContextLineRanges(value.lineRanges)}</span>;
    }
    if (value.type === 'terminal-selection') {
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
          title={getAttachmentTitle(attachment())}
          onClick={handleClick}
        >
          {iconSvg()}
          <span class="chip-label">{getAttachmentLabel(attachment())}</span>
          {detail()}
        </button>
      }
    >
      <span class="message-attachment-chip" title={getAttachmentTitle(attachment())}>
        {iconSvg()}
        <span class="chip-label">{getAttachmentLabel(attachment())}</span>
        {detail()}
      </span>
    </Show>
  );
}

function getAttachmentLabel(attachment: MessageAttachment): string {
  switch (attachment.type) {
    case 'file-selection':
      return getLeafPathName(attachment.filename);
    case 'terminal-selection':
      return attachment.terminalName;
    case 'file-reference':
      return getLeafPathName(attachment.path);
  }
}

function getAttachmentTitle(attachment: MessageAttachment): string {
  switch (attachment.type) {
    case 'file-selection':
      return `${attachment.filename}:${attachment.lineRanges.map((range) => `${range.startLine}-${range.endLine}`).join(',')}`;
    case 'terminal-selection':
      return `Terminal: ${attachment.terminalName}`;
    case 'file-reference':
      return attachment.path;
  }
}
