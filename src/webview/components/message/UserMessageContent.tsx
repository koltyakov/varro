import { For, Show, createEffect, createMemo, createSignal } from 'solid-js';
import {
  formatDisplayPath,
  getLeafPathName,
  isAbsolutePath,
  normalizePath,
} from '../../lib/path-display';
import { postMessage } from '../../lib/bridge';
import type { MessageEditContext } from '../../lib/message-edit-state';
import { state } from '../../lib/state';
import type { FilePart, Part, TextPart } from '../../types';
import {
  formatContextLineRanges,
  formatSelectionReference,
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
  | { type: 'terminal-selection'; terminalName: string; text?: string }
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

type InlineRenderableAttachment =
  | { type: 'message-attachment'; attachment: MessageAttachment }
  | { type: 'image-file'; part: FilePart; index: number };

type InlineTextSegment =
  | { type: 'text'; content: string }
  | { type: 'attachment'; attachment: InlineRenderableAttachment };

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
        let terminalText = '';

        if (lines[index + 1]?.trim().startsWith('```')) {
          index += 2;
          while (index < lines.length) {
            if (lines[index].trim() === '```') break;
            terminalText += `${terminalText ? '\n' : ''}${lines[index]}`;
            index += 1;
          }
        }
        attachments.push({
          type: 'terminal-selection',
          terminalName: terminalMatch[1],
          text: terminalText || undefined,
        });
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

  // Inline @file mentions belong to the prompt body, even when the line ends
  // with a slash-style path like "test @e2e/tests/review.spec.ts".
  if (hasEmbeddedMentionReference(line)) {
    return null;
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

function hasEmbeddedMentionReference(line: string): boolean {
  const match = line.match(/(^|[\s(])@([^\s@)]+?\/?)(?=$|[\s),.:;!?])/);
  return (match?.index ?? -1) > 0;
}

export function getUserMessageEditText(parts: Part[]): string {
  const texts: string[] = [];

  for (const part of parts) {
    if (part.type !== 'text') continue;
    const text = (part as TextPart).text;
    if (!text) continue;

    // Skip context parts the composer re-adds automatically on send.
    const trimmed = text.trim();
    if (
      trimmed.startsWith('[Working directory:') ||
      trimmed.startsWith('[Active file:') ||
      trimmed.startsWith('[Selection from ')
    ) {
      continue;
    }

    texts.push(text);
  }

  return texts.join('\n');
}

export function getUserMessageEditContext(parts: Part[]): MessageEditContext {
  const parsed = parseUserMessageContent(parts);
  const files = parsed.attachments.flatMap((attachment) => {
    if (attachment.type === 'terminal-selection') return [];

    const path = attachment.type === 'file-selection' ? attachment.filename : attachment.path;
    return [
      {
        path,
        relativePath: path,
        type:
          attachment.type === 'file-reference' && attachment.isDirectory
            ? ('directory' as const)
            : ('file' as const),
        lineRanges: attachment.type === 'file-selection' ? attachment.lineRanges : undefined,
      },
    ];
  });
  const images = parsed.fileParts
    .filter((part) => part.mime.startsWith('image/'))
    .map((part, index) => ({
      id: part.id || `edited-image-${index + 1}`,
      url: part.url,
      mime: part.mime,
      filename: part.filename || `image-${index + 1}`,
      size: 0,
    }));
  const terminalAttachment = parsed.attachments.find(
    (attachment) => attachment.type === 'terminal-selection' && attachment.text
  );

  return {
    files,
    images,
    terminalSelection:
      terminalAttachment?.type === 'terminal-selection' && terminalAttachment.text
        ? { terminalName: terminalAttachment.terminalName, text: terminalAttachment.text }
        : null,
  };
}

export function hasUserMessageEditableContent(parts: Part[]): boolean {
  if (getUserMessageEditText(parts).trim().length > 0) return true;

  const context = getUserMessageEditContext(parts);
  return (
    context.files.length > 0 || context.images.length > 0 || context.terminalSelection !== null
  );
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
  const [activeImageIndex, setActiveImageIndex] = createSignal(0);
  const [previewIndex, setPreviewIndex] = createSignal<number | null>(null);

  createEffect(() => {
    const maxIndex = imageParts().length - 1;
    setActiveImageIndex((index) => {
      if (maxIndex < 0) return 0;
      return Math.min(index, maxIndex);
    });
    setPreviewIndex((index) => {
      if (index === null) return null;
      if (maxIndex < 0) return null;
      return Math.min(index, maxIndex);
    });
  });

  const previewPosition = () => {
    const index = previewIndex();
    return index === null ? undefined : index + 1;
  };
  const previewPart = () => {
    const index = previewIndex();
    if (index === null) return null;
    return imageParts()[index] ?? null;
  };
  const previewImage = (): PreviewImage | null => {
    const part = previewPart();
    if (!part) return null;

    const name = getImageDisplayName(part);
    return {
      url: part.url,
      alt: name,
      title: name,
      mime: part.mime,
    };
  };
  const openImagePreview = (index: number) => {
    if (!imageParts()[index]) return;
    setActiveImageIndex(index);
    setPreviewIndex(index);
  };
  const stepPreview = (delta: number) => {
    const count = imageParts().length;
    if (count <= 1) return;
    setPreviewIndex((index) => {
      if (index === null) return index;
      const nextIndex = (index + delta + count) % count;
      setActiveImageIndex(nextIndex);
      return nextIndex;
    });
  };

  createImagePreviewEffect(
    () => previewIndex() !== null,
    () => setPreviewIndex(null),
    {
      canNavigate: () => imageParts().length > 1,
      onPrevious: () => stepPreview(-1),
      onNext: () => stepPreview(1),
    }
  );

  const hasContent = () =>
    parsed().messageTexts.length > 0 ||
    parsed().fileParts.length > 0 ||
    parsed().attachments.length > 0;
  const hasTrailingAttachmentContent = () =>
    otherFileParts().length > 0 || parsed().messageTexts.length > 0 || imageParts().length > 0;
  const handleCopy = (event: ClipboardEvent) => {
    if (!event.clipboardData) return;

    const currentTarget = event.currentTarget;
    if (!(currentTarget instanceof HTMLElement)) return;

    const selection = window.getSelection();
    if (!selection || selection.rangeCount === 0) return;

    const range = selection.getRangeAt(0);
    if (range.collapsed) return;

    const commonAncestor = range.commonAncestorContainer;
    if (commonAncestor !== currentTarget && !currentTarget.contains(commonAncestor)) return;

    const copiedText = normalizeCopiedSelectionText(
      extractCopiedSelectionText(currentTarget, range)
    );
    if (!copiedText) return;

    event.clipboardData.setData('text/plain', copiedText);
    event.preventDefault();
  };

  return (
    <div
      class={`rendered-markdown${imageParts().length > 0 ? ' user-message-content-has-image' : ''}`}
      onCopy={handleCopy}
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
            {(text) => (
              <UserMessageTextContent
                text={text}
                attachments={indexedAttachments()}
                imageParts={imageParts()}
                onOpenImagePreview={openImagePreview}
              />
            )}
          </For>
        </div>
      </Show>
      <Show when={!hasContent()}>
        <p class="user-message-empty">(no content)</p>
      </Show>
      <Show when={imageParts().length > 0}>
        <Show
          when={imageParts().length > 1}
          fallback={
            <UserMessageImage part={imageParts()[0]!} onOpenPreview={() => openImagePreview(0)} />
          }
        >
          <UserImageCarousel
            imageParts={imageParts()}
            activeIndex={activeImageIndex()}
            onActiveIndexChange={setActiveImageIndex}
            onOpenPreview={openImagePreview}
          />
        </Show>
      </Show>
      <ImagePreviewOverlay
        image={previewImage()}
        onClose={() => setPreviewIndex(null)}
        onPrevious={() => stepPreview(-1)}
        onNext={() => stepPreview(1)}
        showNavigation={imageParts().length > 1}
        position={previewPosition()}
        total={imageParts().length}
      />
    </div>
  );
}

function UserMessageTextContent(props: {
  text: string;
  attachments: IndexedMessageAttachment[];
  imageParts: FilePart[];
  onOpenImagePreview: (index: number) => void;
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
              <InlineAttachmentText
                content={segment.content}
                attachments={props.attachments}
                imageParts={props.imageParts}
                onOpenImagePreview={props.onOpenImagePreview}
              />
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
  imageParts: FilePart[];
  onOpenImagePreview: (index: number) => void;
}) {
  const segments = createMemo(() =>
    buildInlineTextSegments(props.content, props.attachments, props.imageParts)
  );

  return (
    <For each={segments()}>
      {(segment) => {
        if (segment.type !== 'attachment') return segment.content;
        if (segment.attachment.type === 'image-file') {
          const imageAttachment = segment.attachment;
          return (
            <InlineImageAttachmentChip
              part={imageAttachment.part}
              onClick={() => props.onOpenImagePreview(imageAttachment.index)}
            />
          );
        }

        return <InlineMessageAttachmentChip attachment={segment.attachment.attachment} />;
      }}
    </For>
  );
}

function UserImageCarousel(props: {
  imageParts: FilePart[];
  activeIndex: number;
  onActiveIndexChange: (index: number) => void;
  onOpenPreview: (index: number) => void;
}) {
  const total = () => props.imageParts.length;
  const currentPart = () => props.imageParts[props.activeIndex];
  const currentDisplayName = () => getImageDisplayName(currentPart());

  const step = (delta: number) => {
    const count = total();
    if (count <= 1) return;
    props.onActiveIndexChange((props.activeIndex + delta + count) % count);
  };

  return (
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
                  onClick={() => props.onOpenPreview(props.activeIndex)}
                >
                  <img src={part().url} alt={currentDisplayName()} class="chat-image-img" />
                </button>
                <figcaption class="chat-image-caption message-image-carousel-caption-row">
                  <span class="message-image-carousel-caption" title={currentDisplayName()}>
                    <span class="message-image-carousel-count">
                      {props.activeIndex + 1} / {total()}
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
  const trimmed = text.trim();
  if (trimmed.startsWith('[')) return false;
  if (trimmed.includes('\n')) return false;
  if (trimmed.length <= 1 || trimmed.length > 300) return false;

  const normalizedInput = trimmed.replace(/\\/g, '/');
  const hasTrailingSlash = normalizedInput.endsWith('/');
  const normalized = normalizePath(trimmed);
  if (/\s\/|\/\s/.test(normalized)) return false;
  if (isAbsolutePath(normalized)) return true;
  if (trimmed.includes(' ') && !normalized.endsWith('/') && !/\.\w{1,12}$/.test(trimmed)) {
    return false;
  }
  if (hasTrailingSlash) {
    return normalizedInput.includes('/') || /^[A-Za-z0-9_.-]+\/$/.test(normalizedInput);
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

function buildInlineTextSegments(
  content: string,
  attachments: IndexedMessageAttachment[],
  imageParts: FilePart[]
): InlineTextSegment[] {
  const attachmentByMarker = new Map<string, InlineRenderableAttachment>();

  for (const attachment of attachments) {
    if (!attachment.marker) continue;
    attachmentByMarker.set(attachment.marker, {
      type: 'message-attachment',
      attachment: attachment.attachment,
    });
  }

  for (const [index, part] of imageParts.entries()) {
    const marker = getInlineImageMarker(part);
    if (!marker) continue;
    attachmentByMarker.set(marker, { type: 'image-file', part, index });
  }

  const markers = Array.from(attachmentByMarker.keys())
    .filter((marker) => content.includes(marker))
    .toSorted((a, b) => b.length - a.length);
  if (markers.length === 0) {
    return [{ type: 'text' as const, content }];
  }

  const pattern = new RegExp(`(${markers.map((marker) => escapeRegex(marker)).join('|')})`, 'g');
  const segments: InlineTextSegment[] = [];

  for (const part of content.split(pattern)) {
    if (!part) continue;
    const attachment = attachmentByMarker.get(part);
    if (attachment) {
      segments.push({ type: 'attachment', attachment });
      continue;
    }
    segments.push({ type: 'text', content: part });
  }

  return segments;
}

function escapeRegex(value: string) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function getInlineImageMarker(part: FilePart): string | null {
  return part.filename ? `[${part.filename}]` : null;
}

function getInlineImageLabel(part: FilePart): string {
  return getImageDisplayName(part);
}

function getImageDisplayName(part: FilePart | null | undefined): string {
  if (!part) return '(image)';
  if (part.source?.path) {
    return formatDisplayPath(part.source.path, state.editorContext.workspacePath);
  }
  if (part.filename) {
    return formatDisplayPath(part.filename, state.editorContext.workspacePath);
  }
  return '(image)';
}

function UserMessageImage(props: { part: FilePart; onOpenPreview: () => void }) {
  const displayName = () => getImageDisplayName(props.part);

  return (
    <figure class="chat-image-figure">
      <button
        type="button"
        class="chat-image-preview-trigger"
        aria-label={`Open image preview: ${displayName()}`}
        title="Open image preview"
        onClick={props.onOpenPreview}
      >
        <img src={props.part.url} alt={displayName()} class="chat-image-img" />
      </button>
      <figcaption class="chat-image-caption">
        {displayName()} <span class="chat-image-mime">· {props.part.mime}</span>
      </figcaption>
    </figure>
  );
}

function InlineImageAttachmentChip(props: { part: FilePart; onClick: () => void }) {
  const label = () => getInlineImageLabel(props.part);
  const title = () => `${label()}${props.part.mime ? ` · ${props.part.mime}` : ''}`;
  const copyMarker = () => getInlineImageMarker(props.part) ?? label();

  return (
    <button
      type="button"
      class="inline-chip inline-chip-clickable"
      data-copy-marker={copyMarker()}
      title={title()}
      aria-label={`Open image preview: ${label()}`}
      onClick={props.onClick}
    >
      <svg class="inline-chip-icon" viewBox="0 0 16 16" fill="currentColor" width="11" height="11">
        <path d="M14.5 2h-13a.5.5 0 00-.5.5v11a.5.5 0 00.5.5h13a.5.5 0 00.5-.5v-11a.5.5 0 00-.5-.5zM2 3h12v7.3l-2.6-2.6a.5.5 0 00-.7 0L7.5 11 5.9 9.4a.5.5 0 00-.7 0L2 12.6V3zm3.5 4a1.5 1.5 0 100-3 1.5 1.5 0 000 3z" />
      </svg>
      <span class="inline-chip-label">{label()}</span>
    </button>
  );
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
  const copyMarker = () => getInlineAttachmentCopyMarker(attachment());

  const handleClick = () => openAttachment(attachment());

  return (
    <button
      type="button"
      class="inline-chip inline-chip-clickable"
      data-copy-marker={copyMarker()}
      title={getAttachmentTitle(attachment())}
      onClick={handleClick}
    >
      <Show
        when={isFolder()}
        fallback={<DocumentIcon class="inline-chip-icon" width="11" height="11" />}
      >
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
    return <DocumentIcon class="chip-icon" width="12" height="12" />;
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
          data-copy-marker={getStandaloneAttachmentCopyText(attachment())}
          title={getAttachmentTitle(attachment())}
          onClick={handleClick}
        >
          {iconSvg()}
          <span class="chip-label">{getAttachmentLabel(attachment())}</span>
          {detail()}
        </button>
      }
    >
      <span
        class="message-attachment-chip"
        data-copy-marker={getStandaloneAttachmentCopyText(attachment())}
        title={getAttachmentTitle(attachment())}
      >
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

function getInlineAttachmentCopyMarker(attachment: MessageAttachment): string {
  return getAttachmentTextMarker(attachment) ?? getStandaloneAttachmentCopyText(attachment);
}

function getStandaloneAttachmentCopyText(attachment: MessageAttachment): string {
  switch (attachment.type) {
    case 'file-selection':
      return formatSelectionReference(attachment.filename, attachment.lineRanges);
    case 'terminal-selection':
      return `[Selection from terminal ${attachment.terminalName}]`;
    case 'file-reference':
      return attachment.path;
  }
}

const BLOCK_COPY_TAGS = new Set([
  'BLOCKQUOTE',
  'BR',
  'DIV',
  'FIGCAPTION',
  'FIGURE',
  'LI',
  'OL',
  'P',
  'PRE',
  'TABLE',
  'TBODY',
  'TD',
  'TH',
  'THEAD',
  'TR',
  'UL',
]);

function extractCopiedSelectionText(node: Node, range: Range): string {
  if (!rangeIntersectsNode(range, node)) return '';

  if (node.nodeType === Node.TEXT_NODE) {
    return extractSelectedTextNode(node as Text, range);
  }

  if (node.nodeType !== Node.ELEMENT_NODE) return '';

  const element = node as HTMLElement;
  if (element.tagName === 'BR') return '\n';

  const copyMarker = element.dataset.copyMarker;
  if (copyMarker) return copyMarker;

  let result = '';
  for (const child of Array.from(element.childNodes)) {
    const childText = extractCopiedSelectionText(child, range);
    if (!childText) continue;
    result += childText;
    if (
      child.nodeType === Node.ELEMENT_NODE &&
      BLOCK_COPY_TAGS.has((child as HTMLElement).tagName) &&
      !result.endsWith('\n')
    ) {
      result += '\n';
    }
  }

  return result;
}

function extractSelectedTextNode(node: Text, range: Range): string {
  const text = node.data;
  let start = 0;
  let end = text.length;

  if (range.startContainer === node) {
    start = Math.max(0, Math.min(text.length, range.startOffset));
  }
  if (range.endContainer === node) {
    end = Math.max(start, Math.min(text.length, range.endOffset));
  }

  return text.slice(start, end);
}

function rangeIntersectsNode(range: Range, node: Node): boolean {
  if (typeof range.intersectsNode === 'function') {
    return range.intersectsNode(node);
  }

  const nodeRange = document.createRange();
  try {
    nodeRange.selectNode(node);
  } catch {
    nodeRange.selectNodeContents(node);
  }

  return (
    range.compareBoundaryPoints(Range.END_TO_START, nodeRange) < 0 &&
    range.compareBoundaryPoints(Range.START_TO_END, nodeRange) > 0
  );
}

function normalizeCopiedSelectionText(text: string): string {
  return text
    .replace(/\u00a0/g, ' ')
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n[ \t]+/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .replace(/\n+$/g, '');
}
