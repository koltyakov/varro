import { For, Show, createEffect, createMemo, createSignal, onCleanup } from 'solid-js';
import { Portal } from 'solid-js/web';
import {
  formatDisplayPath,
  getLeafPathName,
  isAbsolutePath,
  normalizePath,
} from '../../lib/path-display';
import { postMessage } from '../../lib/bridge';
import type { MessageEditContext } from '../../lib/message-edit-state';
import { splitSessionReferenceText, type SessionReference } from '../../lib/session-reference';
import { state } from '../../lib/state';
import { observeSettledResize } from '../../lib/settled-resize-observer';
import { selectSession } from '../../hooks/useOpenCode';
import type { AgentPart, FilePart, Part, TextPart } from '../../types';
import {
  formatContextLineRanges,
  formatSelectionReference,
  getFirstContextLine,
  mergeContextFile,
  parseSelectionReference,
} from '../../../shared/context-files';
import { AttachmentLabel } from '../AttachmentLabel';
import { ImagePreviewOverlay, createImagePreviewEffect } from '../ImagePreview';
import type { PreviewImage } from '../ImagePreview';
import { renderCodeBlockHtml } from '../MarkdownRenderer';
import { getPdfDataUrlSize } from '../../../shared/native-pdf';
import { FileTypeIcon } from '../FileTypeIcon';
import { FolderIcon } from '../FolderIcon';
import { ExternalLinkIcon } from '../ExternalLinkIcon';
import { isSafeExternalHref, splitExternalLinkText } from '../../lib/external-link';
import { formatAgentLabel } from '../../lib/format';
import { AgentChip } from './AgentChip';
import { InlineMessageImage } from '../InlineMessageImage';
import { MaterialChipIcon } from '../MaterialChipIcon';

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
  | { type: 'code'; content: string; language?: string }
  | { type: 'markup'; content: string; format: UserMessageMarkupFormat };

export type UserMessageMarkupFormat = {
  kind: 'xml' | 'svg';
  byteSize: number;
};

export type UserMessageMarkupSuffix = {
  prefix: string;
  content: string;
  format: UserMessageMarkupFormat;
};

export type ParsedUserMessageContent = {
  messageTexts: string[];
  attachments: MessageAttachment[];
  fileParts: FilePart[];
  agentParts: AgentPart[];
};

type IndexedMessageAttachment = {
  id: string;
  attachment: MessageAttachment;
  marker: string | null;
};

type DisplayMessageAttachment =
  | { type: 'message'; attachment: MessageAttachment }
  | { type: 'file-part'; part: FilePart };

type InlineRenderableAttachment =
  | { type: 'message-attachment'; attachment: MessageAttachment }
  | { type: 'image-file'; part: FilePart; index: number; marker?: string; label?: string }
  | { type: 'agent'; part: AgentPart; marker: string };

type InlineTextSegment =
  | { type: 'text'; content: string }
  | { type: 'attachment'; attachment: InlineRenderableAttachment }
  | { type: 'session'; reference: SessionReference }
  | { type: 'external-link'; href: string };

const USER_CODE_FENCE_RE = /```([^\n`]*)\n([\s\S]*?)```/g;
const VISION_DELEGATION_CONTEXT_RE =
  /^\[Image for @[^:\]\n]+: [^\]\n]+\]\nWhen calling the [^\n]+ subagent, include \{file:[^}\n]+\} in its task prompt\.$/;
function bindUserMessageOverflowFade(element: HTMLElement, trackText: () => string[]) {
  const update = () => {
    const hasMoreBelow = element.scrollTop + element.clientHeight < element.scrollHeight - 1;
    element.classList.toggle('has-more-below', hasMoreBelow);
  };

  element.addEventListener('scroll', update, { passive: true });
  const stopObservingResize = observeSettledResize(element, update);
  createEffect(() => {
    trackText();
    queueMicrotask(update);
  });
  onCleanup(() => {
    element.removeEventListener('scroll', update);
    stopObservingResize();
  });
}

function trimFenceBoundaryNewlines(content: string, side: 'start' | 'end') {
  return side === 'start' ? content.replace(/^\n+/, '') : content.replace(/\n+$/, '');
}

function parseUserMessageSegments(text: string): UserMessageSegment[] {
  const normalized = text.replace(/\r\n?/g, '\n');
  const markup = getUserMessageMarkupSuffix(normalized);
  if (markup) {
    const segments = markup.prefix ? parseUserMessageSegments(markup.prefix) : [];
    segments.push({ type: 'markup', content: markup.content, format: markup.format });
    return segments;
  }

  const segments: UserMessageSegment[] = [];
  let lastIndex = 0;

  for (const match of normalized.matchAll(USER_CODE_FENCE_RE)) {
    const index = match.index ?? 0;
    if (index > lastIndex) {
      const content = trimFenceBoundaryNewlines(
        trimFenceBoundaryNewlines(normalized.slice(lastIndex, index), 'start'),
        'end'
      );
      if (content.length > 0) {
        segments.push({ type: 'text', content });
      }
    }

    segments.push({
      type: 'code',
      content: match[2]!,
      language: match[1]!.trim() || undefined,
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

export function getUserMessageMarkupFormat(text: string): UserMessageMarkupFormat | null {
  const normalized = text.replace(/\r\n?/g, '\n');
  const trimmed = normalized.trim();
  if (!trimmed.startsWith('<') || !trimmed.endsWith('>')) return null;

  const parsed = new DOMParser().parseFromString(trimmed, 'application/xml');
  if (parsed.querySelector('parsererror')) return null;

  return {
    kind: parsed.documentElement.localName === 'svg' ? 'svg' : 'xml',
    byteSize: new TextEncoder().encode(trimmed).byteLength,
  };
}

export function formatUserMessageMarkupSize(byteSize: number) {
  if (byteSize < 1024) return `${byteSize} B`;
  const kilobytes = byteSize / 1024;
  return `${kilobytes.toFixed(kilobytes < 10 ? 1 : 0).replace(/\.0$/, '')} KB`;
}

export function getUserMessageMarkupSuffix(text: string): UserMessageMarkupSuffix | null {
  const normalized = text.replace(/\r\n?/g, '\n');
  const completeFormat = getUserMessageMarkupFormat(normalized);
  if (completeFormat) {
    return { prefix: '', content: normalized.trim(), format: completeFormat };
  }

  for (const match of normalized.matchAll(/^[ \t]*(?=<)/gm)) {
    const index = match.index ?? 0;
    if (index === 0) continue;

    const content = normalized.slice(index).trim();
    const format = getUserMessageMarkupFormat(content);
    if (!format) continue;

    return {
      prefix: normalized.slice(0, index).replace(/\n+$/, ''),
      content,
      format,
    };
  }

  return null;
}

export function parseUserMessageContent(parts: Part[]): ParsedUserMessageContent {
  const messageTexts: string[] = [];
  const attachments: MessageAttachment[] = [];
  const fileParts: FilePart[] = [];
  const agentParts: AgentPart[] = [];

  for (const part of parts) {
    if (part.type === 'file') {
      fileParts.push(part as FilePart);
      continue;
    }

    if (part.type === 'agent') {
      agentParts.push(part);
      continue;
    }

    if (part.type !== 'text') continue;
    const text = (part as TextPart).text;
    if (!text || isVisionDelegationContextText(text)) continue;

    const parsedText = parseUserMessageText(text);
    attachments.push(...parsedText.attachments);
    messageTexts.push(...parsedText.messageTexts);
  }

  return { messageTexts, attachments, fileParts, agentParts };
}

export function isWrapperlessUserMessageContent(parsed: ParsedUserMessageContent): boolean {
  const attachmentCount =
    parsed.attachments.length + parsed.fileParts.length + parsed.agentParts.length;
  if (attachmentCount === 0) return false;
  if (parsed.messageTexts.length === 0) return true;
  if (attachmentCount !== 1 || parsed.messageTexts.length !== 1) return false;

  const indexedAttachments = parsed.attachments.map((attachment, index) => ({
    id: `attachment-${index}`,
    attachment,
    marker: getAttachmentTextMarker(attachment),
  }));
  const segments = buildInlineTextSegments(
    parsed.messageTexts[0]!,
    indexedAttachments,
    parsed.fileParts.filter((part) => part.mime.startsWith('image/')),
    parsed.agentParts
  ).filter((segment) => segment.type !== 'text' || segment.content.trim().length > 0);

  return segments.length === 1 && segments[0]?.type === 'attachment';
}

function isVisionDelegationContextText(text: string): boolean {
  return VISION_DELEGATION_CONTEXT_RE.test(text.replace(/\r\n?/g, '\n').trim());
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
  const standaloneReference = isStandaloneFileReference(normalized.trim());
  let inCodeFence = false;

  const flushTextBuffer = () => {
    const content = textBuffer.join('\n').replace(/^\n+/, '').replace(/\n+$/, '');
    textBuffer.length = 0;
    if (content.length > 0) {
      messageTexts.push(content);
    }
  };

  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index]!;
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
            if (lines[index]!.trim() === '```') break;
            terminalText += `${terminalText ? '\n' : ''}${lines[index]!}`;
            index += 1;
          }
        }
        attachments.push({
          type: 'terminal-selection',
          terminalName: terminalMatch[1]!,
          text: terminalText || undefined,
        });
        continue;
      }

      const attachment = parseUserMessageAttachmentLine(
        trimmedLine,
        standaloneReference && trimmedLine === normalized.trim()
      );
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

function parseUserMessageAttachmentLine(
  line: string,
  allowStandaloneFileReference: boolean
): MessageAttachment | null {
  if (!line) return null;

  if (line.startsWith('[Selection from ') && !line.startsWith('[Selection from terminal')) {
    const selectionRef = parseSelectionReference(line);
    if (selectionRef) {
      return {
        type: 'file-selection',
        filename: selectionRef.path!,
        lineRanges: selectionRef.lineRanges,
      };
    }
  }

  if (line.startsWith('[Active file:')) {
    const match = line.match(/^\[Active file: (.+?)\]/);
    if (match) {
      return {
        type: 'file-reference',
        path: match[1]!,
        isDirectory: false,
      };
    }
  }

  if (line.startsWith('[Attached file:')) {
    const match = line.match(/^\[Attached file: (.+?)\]$/);
    if (match) {
      return {
        type: 'file-reference',
        path: match[1]!,
        isDirectory: false,
      };
    }
  }

  // Inline @file mentions belong to the prompt body, even when the line ends
  // with a slash-style path like "test @e2e/tests/review.spec.ts".
  if (hasEmbeddedMentionReference(line)) {
    return null;
  }

  if (allowStandaloneFileReference) {
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
      isVisionDelegationContextText(text) ||
      trimmed.startsWith('[Working directory:') ||
      trimmed.startsWith('[Active file:') ||
      trimmed.startsWith('[Attached file:') ||
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
  const filesByPath = new Map<string, MessageEditContext['files'][number]>();
  for (const attachment of parsed.attachments) {
    if (attachment.type === 'terminal-selection') continue;

    const path = attachment.type === 'file-selection' ? attachment.filename : attachment.path;
    const file: MessageEditContext['files'][number] = {
      path,
      relativePath: path,
      type: attachment.type === 'file-reference' && attachment.isDirectory ? 'directory' : 'file',
      lineRanges: attachment.type === 'file-selection' ? attachment.lineRanges : undefined,
    };
    const key = normalizePath(path);
    filesByPath.set(key, mergeContextFile(filesByPath.get(key), file));
  }
  const files = [...filesByPath.values()];
  const images = parsed.fileParts
    .filter((part) => part.mime.startsWith('image/'))
    .map((part, index) => ({
      id: part.id || `edited-image-${index + 1}`,
      url: part.url,
      mime: part.mime,
      filename: part.filename || `image-${index + 1}`,
      size: 0,
    }));
  const pdfs = parsed.fileParts
    .filter((part) => part.mime === 'application/pdf')
    .map((part, index) => ({
      id: part.id || `edited-pdf-${index + 1}`,
      url: part.url,
      mime: 'application/pdf' as const,
      filename: part.filename || `document-${index + 1}.pdf`,
      size: getPdfDataUrlSize(part.url) ?? 0,
    }));
  const terminalAttachment = parsed.attachments.find(
    (attachment) => attachment.type === 'terminal-selection' && attachment.text
  );

  return {
    files,
    images,
    ...(pdfs.length > 0 ? { pdfs } : {}),
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
    context.files.length > 0 ||
    context.images.length > 0 ||
    (context.pdfs?.length ?? 0) > 0 ||
    context.terminalSelection !== null
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
      case 'terminal-selection': {
        const lineCount = getTerminalLineCountLabel(firstAttachment.text);
        return `Terminal: ${firstAttachment.terminalName}${lineCount ? ` (${lineCount})` : ''}`;
      }
      case 'file-reference':
        return `${firstAttachment.isDirectory ? 'Folder' : 'File'}: ${getLeafPathName(firstAttachment.path)}`;
    }
  }

  const firstFilePart = parsed.fileParts[0];
  if (firstFilePart) {
    return firstFilePart.filename ? `Attachment: ${firstFilePart.filename}` : 'Attachment';
  }

  const firstAgentPart = parsed.agentParts[0];
  if (firstAgentPart) return `Agent: ${formatAgentLabel(firstAgentPart.name)}`;

  return '(no content)';
}

export function UserMessageContent(props: { parts: Part[] }) {
  const parsed = createMemo(() => parseUserMessageContent(props.parts));
  const agentParts = createMemo(() => getDisplayAgentParts(parsed()));
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
  const expandedTerminalAttachment = createMemo(() => {
    if (
      parsed().messageTexts.length !== 0 ||
      parsed().fileParts.some((part) => part.mime.startsWith('image/'))
    ) {
      return null;
    }
    const terminals = parsed().attachments.filter(
      (attachment) => attachment.type === 'terminal-selection' && attachment.text
    );
    return terminals.length === 1 && terminals[0]?.type === 'terminal-selection'
      ? terminals[0]
      : null;
  });
  const visibleAttachments = createMemo(() =>
    indexedAttachments().filter(
      ({ id, attachment }) =>
        !inlineAttachmentIds().has(id) && attachment !== expandedTerminalAttachment()
    )
  );
  const visibleAgentParts = createMemo(() =>
    agentParts().filter((part) => {
      const marker = part.source?.value || `@${part.name}`;
      return !parsed().messageTexts.some((text) => text.includes(marker));
    })
  );

  const imageParts = createMemo(() =>
    parsed().fileParts.filter((part) => part.mime.startsWith('image/'))
  );
  const otherFileParts = createMemo(() =>
    parsed().fileParts.filter((part) => !part.mime.startsWith('image/'))
  );
  const attachmentCount = createMemo(() => visibleAttachments().length + otherFileParts().length);
  const displayAttachments = createMemo<DisplayMessageAttachment[]>(() => [
    ...visibleAttachments().map(({ attachment }) => ({
      type: 'message' as const,
      attachment,
    })),
    ...otherFileParts().map((part) => ({ type: 'file-part' as const, part })),
  ]);
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
    parsed().attachments.length > 0 ||
    parsed().agentParts.length > 0;
  const hasTrailingAttachmentContent = () =>
    parsed().messageTexts.length > 0 ||
    imageParts().length > 0 ||
    visibleAgentParts().length > 0 ||
    !!expandedTerminalAttachment();
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
      <Show when={visibleAttachments().length > 0 || otherFileParts().length > 0}>
        <MessageAttachmentRail
          attachments={displayAttachments()}
          leading={hasTrailingAttachmentContent()}
          label={`${attachmentCount()} ${attachmentCount() === 1 ? 'attachment' : 'attachments'}`}
        />
      </Show>
      <Show when={visibleAgentParts().length > 0}>
        <div class="message-attachments message-attachments-leading">
          <For each={visibleAgentParts()}>{(part) => <AgentChip part={part} />}</For>
        </div>
      </Show>
      <Show when={expandedTerminalAttachment()}>
        {(attachment) => <TerminalMessageCodeBlock attachment={attachment()} />}
      </Show>
      <Show when={parsed().messageTexts.length > 0}>
        <div
          class="user-message-text-scroll"
          ref={(element) => bindUserMessageOverflowFade(element, () => parsed().messageTexts)}
        >
          <For each={parsed().messageTexts}>
            {(text) => (
              <UserMessageTextContent
                text={text}
                attachments={indexedAttachments()}
                imageParts={imageParts()}
                agentParts={agentParts()}
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

export function UserMessagePreviewContent(props: {
  parts: Part[];
  fallback: string;
  onOpenImagePreview?: (index: number) => void;
}) {
  const parsed = createMemo(() => parseUserMessageContent(props.parts));
  const text = createMemo(() => parsed().messageTexts.find((value) => value.trim().length > 0));
  const attachments = createMemo<IndexedMessageAttachment[]>(() =>
    parsed().attachments.map((attachment, index) => ({
      id: `attachment-${index}`,
      attachment,
      marker: getAttachmentTextMarker(attachment),
    }))
  );
  const imageParts = createMemo(() =>
    parsed().fileParts.filter((part) => part.mime.startsWith('image/'))
  );
  const agentParts = createMemo(() => getDisplayAgentParts(parsed()));

  return (
    <Show when={text()} fallback={props.fallback}>
      {(value) => (
        <UserMessageTextContent
          text={value()}
          attachments={attachments()}
          imageParts={imageParts()}
          agentParts={agentParts()}
          onOpenImagePreview={(index) => props.onOpenImagePreview?.(index)}
        />
      )}
    </Show>
  );
}

function getDisplayAgentParts(parsed: ParsedUserMessageContent): AgentPart[] {
  const parts = [...parsed.agentParts];
  const representedNames = new Set(parts.map((part) => part.name.toLowerCase()));
  const messageText = parsed.messageTexts.join('\n');

  for (const agent of state.allAgents) {
    if (representedNames.has(agent.name.toLowerCase())) continue;
    const marker = `@${agent.name}`;
    const match = new RegExp(`(^|[^\\w@])(${escapeRegex(marker)})(?=$|[^\\w-])`, 'i').exec(
      messageText
    );
    if (!match?.[2]) continue;
    parts.push({
      id: `display-agent-${agent.name}`,
      sessionID: '',
      messageID: '',
      type: 'agent',
      name: agent.name,
      source: { value: match[2], start: 0, end: 0 },
    });
  }

  return parts;
}

function UserMessageTextContent(props: {
  text: string;
  attachments: IndexedMessageAttachment[];
  imageParts: FilePart[];
  agentParts: AgentPart[];
  onOpenImagePreview: (index: number) => void;
}) {
  const segments = createMemo(() => parseUserMessageSegments(props.text));

  return (
    <For each={segments()}>
      {(segment) =>
        segment.type === 'code' ? (
          <UserMessageCodeBlock content={segment.content} language={segment.language} />
        ) : segment.type === 'markup' ? (
          <p class="user-message-text user-message-format-chip-row">
            <UserMessageMarkupChip content={segment.content} format={segment.format} />
          </p>
        ) : (
          <Show when={segment.content.length > 0}>
            <p class="user-message-text">
              <InlineAttachmentText
                content={segment.content}
                attachments={props.attachments}
                imageParts={props.imageParts}
                agentParts={props.agentParts}
                onOpenImagePreview={props.onOpenImagePreview}
              />
            </p>
          </Show>
        )
      }
    </For>
  );
}

function UserMessageMarkupChip(props: { content: string; format: UserMessageMarkupFormat }) {
  const label = () => props.format.kind.toUpperCase();
  const size = () => formatUserMessageMarkupSize(props.format.byteSize);
  const openInEditor = () => {
    postMessage({
      type: 'vscode/open-text',
      payload: {
        content: props.content,
        title: `${label()} user message`,
        language: 'xml',
      },
    });
  };

  return (
    <button
      type="button"
      class="inline-chip inline-chip-clickable user-message-format-chip"
      data-copy-marker={props.content}
      title={`Open ${label()} content - ${size()}`}
      onClick={openInEditor}
    >
      <span class="inline-chip-label">{label()}</span>
      <span class="inline-chip-detail">{size()}</span>
    </button>
  );
}

function UserMessageCodeBlock(props: { content: string; language?: string }) {
  const html = createMemo(() =>
    renderCodeBlockHtml({
      text: props.content,
      lang: props.language,
      className: 'user-message-code-block',
      showCopyButton: false,
    })
  );
  return <div innerHTML={html()} />;
}

function TerminalMessageCodeBlock(props: {
  attachment: Extract<MessageAttachment, { type: 'terminal-selection' }>;
}) {
  const html = createMemo(() =>
    renderCodeBlockHtml({
      text: props.attachment.text ?? '',
      lang: 'text',
      headerLabel: props.attachment.terminalName,
      headerDetail: getTerminalLineCountLabel(props.attachment.text) ?? undefined,
      className: 'user-message-code-block user-message-terminal-code-block',
      showCopyButton: false,
    })
  );
  return <div innerHTML={html()} />;
}

function InlineAttachmentText(props: {
  content: string;
  attachments: IndexedMessageAttachment[];
  imageParts: FilePart[];
  agentParts: AgentPart[];
  onOpenImagePreview: (index: number) => void;
}) {
  const segments = createMemo(() =>
    buildInlineTextSegments(props.content, props.attachments, props.imageParts, props.agentParts)
  );

  return (
    <For each={segments()}>
      {(segment) => {
        if (segment.type === 'text') return segment.content;
        if (segment.type === 'session') {
          return <SessionReferenceLink reference={segment.reference} />;
        }
        if (segment.type === 'external-link') {
          return <ExternalLink href={segment.href} />;
        }
        if (segment.attachment.type === 'agent') {
          return (
            <InlineAgentChip part={segment.attachment.part} marker={segment.attachment.marker} />
          );
        }
        if (segment.attachment.type === 'image-file') {
          const imageAttachment = segment.attachment;
          return (
            <InlineImageAttachmentChip
              part={imageAttachment.part}
              index={imageAttachment.index}
              marker={imageAttachment.marker}
              label={imageAttachment.label}
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
                  onClick={() => props.onOpenPreview(props.activeIndex)}
                >
                  <InlineMessageImage src={part().url} alt={currentDisplayName()} />
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
  if (/(?:^|\s)[a-z][a-z0-9+.-]*:\/\//i.test(trimmed)) return false;
  if (/\[\d+\/\d+\]/.test(trimmed)) return false;
  if (/["'{}[\],<>|]/.test(trimmed) || trimmed.includes('>')) return false;

  const normalizedInput = trimmed.replace(/\\/g, '/');
  if (/:\d+(?::\d+)?$/.test(normalizedInput)) return false;
  const hasTrailingSlash = normalizedInput.endsWith('/');
  const normalized = normalizePath(trimmed);
  const hasFileLikeExtension = /\.[^\s/.]{1,16}$/.test(normalized);
  if (/\s\/|\/\s/.test(normalized)) return false;
  if (isAbsolutePath(normalized)) {
    return hasTrailingSlash || hasFileLikeExtension;
  }
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
  imageParts: FilePart[],
  agentParts: AgentPart[]
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
    attachmentByMarker.set(marker, {
      type: 'image-file',
      part,
      index,
      marker,
      label: getInlineImageMarkerLabel(marker),
    });
  }

  for (const [index, part] of imageParts.entries()) {
    const marker = `[Image ${index + 1}]`;
    if (attachmentByMarker.has(marker)) continue;
    attachmentByMarker.set(marker, {
      type: 'image-file',
      part,
      index,
      marker,
      label: `Image ${index + 1}`,
    });
  }

  const firstImage = imageParts[0];
  if (firstImage && !attachmentByMarker.has('[Image]')) {
    attachmentByMarker.set('[Image]', {
      type: 'image-file',
      part: firstImage,
      index: 0,
      marker: '[Image]',
      label: 'Image 1',
    });
  }

  for (const part of agentParts) {
    const marker = part.source?.value || `@${part.name}`;
    if (!marker || attachmentByMarker.has(marker)) continue;
    attachmentByMarker.set(marker, { type: 'agent', part, marker });
  }

  const markers = Array.from(attachmentByMarker.keys())
    .filter((marker) => content.includes(marker))
    .toSorted((a, b) => b.length - a.length);
  const attachmentSegments: InlineTextSegment[] = [];
  if (markers.length === 0) {
    attachmentSegments.push({ type: 'text', content });
  } else {
    const pattern = new RegExp(`(${markers.map((marker) => escapeRegex(marker)).join('|')})`, 'g');
    for (const part of content.split(pattern)) {
      if (!part) continue;
      const attachment = attachmentByMarker.get(part);
      attachmentSegments.push(
        attachment ? { type: 'attachment', attachment } : { type: 'text', content: part }
      );
    }
  }

  const segments: InlineTextSegment[] = [];
  for (const segment of attachmentSegments) {
    if (segment.type === 'text') {
      for (const sessionSegment of splitSessionReferenceText(segment.content)) {
        if (sessionSegment.type === 'session') {
          segments.push(sessionSegment);
        } else {
          segments.push(...splitExternalLinkText(sessionSegment.content));
        }
      }
    } else {
      segments.push(segment);
    }
  }
  return segments;
}

function ExternalLink(props: { href: string }) {
  const openExternal = (event: MouseEvent) => {
    event.preventDefault();
    if (!isSafeExternalHref(props.href)) return;
    postMessage({ type: 'vscode/open-external', payload: { url: props.href } });
  };

  return (
    <a
      class="external-link"
      href={props.href}
      data-external="true"
      title={`Open ${props.href}`}
      onClick={openExternal}
    >
      <span class="link-leading-content">
        <ExternalLinkIcon />
        <span class="link-leading-label">{props.href.slice(0, 1)}</span>
      </span>
      {props.href.slice(1)}
    </a>
  );
}

function SessionReferenceLink(props: { reference: SessionReference }) {
  const firstWord = props.reference.title.match(/^\S+/)?.[0] ?? '';
  const openSession = (event: MouseEvent) => {
    event.preventDefault();
    void selectSession(props.reference.id);
  };

  return (
    <a
      class="session-reference-link"
      href={props.reference.href}
      data-copy-marker={props.reference.marker}
      data-session-id={props.reference.id}
      title={`Open session ${props.reference.id}`}
      onClick={openSession}
    >
      <span class="link-leading-content">
        <MaterialChipIcon kind="session" class="session-reference-icon" />
        <span class="link-leading-label">{firstWord}</span>
      </span>
      {props.reference.title.slice(firstWord.length)}
    </a>
  );
}

function escapeRegex(value: string) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function getInlineImageMarker(part: FilePart): string | null {
  const sourceMarker = part.source?.text.value;
  if (sourceMarker && getInlineImageMarkerLabel(sourceMarker)) return sourceMarker;
  return part.filename ? `[${part.filename}]` : null;
}

function getInlineImageMarkerLabel(marker: string): string | undefined {
  return marker.match(/^\[(Image(?: \d+)?)\]$/)?.[1];
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
        onClick={props.onOpenPreview}
      >
        <InlineMessageImage src={props.part.url} alt={displayName()} />
      </button>
    </figure>
  );
}

function InlineImageAttachmentChip(props: {
  part: FilePart;
  index: number;
  marker?: string;
  label?: string;
  onClick: () => void;
}) {
  const label = () =>
    props.label ??
    (props.index === 0 && props.part.filename === 'Image'
      ? 'Image 1'
      : getInlineImageLabel(props.part));
  const copyMarker = () => props.marker ?? getInlineImageMarker(props.part) ?? label();
  const path = () => props.part.source?.path || props.part.filename;
  const hasFormatIcon = () => /\.[^./]+$/.test(path() || '');

  return (
    <button
      type="button"
      class="inline-chip inline-chip-clickable"
      data-copy-marker={copyMarker()}
      aria-label={`Open image preview: ${label()}`}
      onClick={props.onClick}
    >
      <Show
        when={hasFormatIcon()}
        fallback={<MaterialChipIcon kind="image" class="inline-chip-icon" />}
      >
        <FileTypeIcon path={path()} class="inline-chip-icon" />
      </Show>
      <span class="inline-chip-label">{label()}</span>
    </button>
  );
}

function InlineAgentChip(props: { part: AgentPart; marker: string }) {
  return <AgentChip part={props.part} inline marker={props.marker} />;
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
  const filePath = () => getMessageAttachmentPath(attachment());

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
        fallback={<FileTypeIcon path={filePath()} class="inline-chip-icon" />}
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
  if (value.type === 'terminal-selection') {
    if (!value.text) return;
    postMessage({
      type: 'vscode/open-text',
      payload: {
        content: value.text,
        title: `${value.terminalName} terminal selection`,
        language: 'shellscript',
      },
    });
    return;
  }

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
  const isOpenable = () => {
    const value = attachment();
    return value.type !== 'terminal-selection' || Boolean(value.text);
  };

  const handleClick = () => openAttachment(attachment());

  const iconSvg = () => {
    if (isFolder()) {
      return <FolderIcon class="chip-icon" width="12" height="12" />;
    }
    if (isTerminal()) {
      return <MaterialChipIcon kind="terminal" class="chip-icon" />;
    }
    return <FileTypeIcon path={getMessageAttachmentPath(attachment())} class="chip-icon" />;
  };

  const detail = () => {
    const value = attachment();
    if (value.type === 'file-selection') {
      return <span class="chip-detail">{formatContextLineRanges(value.lineRanges)}</span>;
    }
    if (value.type === 'terminal-selection') {
      return <span class="chip-detail">{getTerminalLineCountLabel(value.text) ?? 'terminal'}</span>;
    }
    return null;
  };

  return (
    <Show
      when={!isOpenable()}
      fallback={
        <button
          class="chat-attachment-chip message-attachment-chip message-attachment-chip-clickable clickable"
          data-copy-marker={getStandaloneAttachmentCopyText(attachment())}
          title={getAttachmentTitle(attachment())}
          onClick={handleClick}
        >
          {iconSvg()}
          <AttachmentLabel
            label={getAttachmentLabel(attachment())}
            preserveExtension={!isFolder() && !isTerminal()}
          />
          {detail()}
        </button>
      }
    >
      <span
        class="chat-attachment-chip message-attachment-chip"
        data-copy-marker={getStandaloneAttachmentCopyText(attachment())}
        title={getAttachmentTitle(attachment())}
      >
        {iconSvg()}
        <AttachmentLabel
          label={getAttachmentLabel(attachment())}
          preserveExtension={!isFolder() && !isTerminal()}
        />
        {detail()}
      </span>
    </Show>
  );
}

function MessageAttachmentRail(props: {
  attachments: DisplayMessageAttachment[];
  leading: boolean;
  label: string;
}) {
  const [visibleCount, setVisibleCount] = createSignal(Math.min(props.attachments.length, 3));
  const [menuOpen, setMenuOpen] = createSignal(false);
  const [menuPosition, setMenuPosition] = createSignal({ left: 0, top: 0 });
  let root: HTMLDivElement | undefined;
  let measurement: HTMLDivElement | undefined;
  let menu: HTMLDivElement | undefined;

  const remainingAttachments = createMemo(() => props.attachments.slice(visibleCount()));
  const updateVisibleCount = () => {
    if (!root || !measurement || root.clientWidth <= 0) return;

    const itemWidths = Array.from(
      measurement.querySelectorAll<HTMLElement>('.message-attachment-measure-item')
    ).map((item) => item.getBoundingClientRect().width);
    if (itemWidths.length !== props.attachments.length || itemWidths.some((width) => width <= 0)) {
      return;
    }

    const gap = 10;
    const totalWidth = itemWidths.reduce(
      (total, width, index) => total + width + (index > 0 ? gap : 0),
      0
    );
    if (totalWidth <= root.clientWidth) {
      setVisibleCount(props.attachments.length);
      return;
    }

    const overflowControlWidth = 26;
    const overflowGap = 8;
    const availableWidth = Math.max(0, root.clientWidth - overflowControlWidth - overflowGap);
    let usedWidth = 0;
    let count = 0;
    for (const width of itemWidths) {
      const nextWidth = usedWidth + width + (count > 0 ? gap : 0);
      if (nextWidth > availableWidth) break;
      usedWidth = nextWidth;
      count += 1;
    }
    setVisibleCount(Math.max(1, count));
  };

  createEffect(() => {
    if (props.attachments.length === 0) return;
    updateVisibleCount();
    if (!root) return;
    const stopObservingResize = observeSettledResize(root, updateVisibleCount);
    onCleanup(stopObservingResize);
  });

  createEffect(() => {
    if (remainingAttachments().length === 0) setMenuOpen(false);
  });

  createEffect(() => {
    if (!menuOpen()) return;

    const handlePointerDown = (event: PointerEvent) => {
      if (
        event.target instanceof Node &&
        !root?.contains(event.target) &&
        !menu?.contains(event.target)
      ) {
        setMenuOpen(false);
      }
    };
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setMenuOpen(false);
    };
    document.addEventListener('pointerdown', handlePointerDown);
    window.addEventListener('keydown', handleKeyDown);
    onCleanup(() => {
      document.removeEventListener('pointerdown', handlePointerDown);
      window.removeEventListener('keydown', handleKeyDown);
    });
  });

  const toggleMenu = (event: MouseEvent) => {
    event.stopPropagation();
    if (menuOpen()) {
      setMenuOpen(false);
      return;
    }

    const trigger = event.currentTarget;
    if (!(trigger instanceof HTMLElement)) return;
    const rect = trigger.getBoundingClientRect();
    const menuWidth = Math.min(260, window.innerWidth - 16);
    setMenuPosition({
      left: Math.max(8, Math.min(window.innerWidth - menuWidth - 8, rect.right - menuWidth)),
      top: rect.bottom + 4,
    });
    setMenuOpen(true);

    queueMicrotask(() => {
      if (!menu) return;
      const menuRect = menu.getBoundingClientRect();
      setMenuPosition({
        left: Math.max(
          8,
          Math.min(window.innerWidth - menuRect.width - 8, rect.right - menuRect.width)
        ),
        top:
          menuRect.bottom <= window.innerHeight - 8
            ? rect.bottom + 4
            : Math.max(8, rect.top - menuRect.height - 4),
      });
    });
  };

  return (
    <div
      ref={(element) => (root = element)}
      class={`message-attachments message-file-attachments${props.leading ? ' message-attachments-leading' : ' message-attachments-standalone'}`}
      aria-label={props.label}
    >
      <div class="message-attachment-visible">
        <For each={props.attachments.slice(0, visibleCount())}>
          {(attachment) => <DisplayMessageAttachmentItem attachment={attachment} />}
        </For>
      </div>
      <Show when={remainingAttachments().length > 0}>
        <button
          type="button"
          class="chat-attachment-chip clickable message-attachment-overflow-trigger"
          aria-label={`Show ${remainingAttachments().length} more attachments`}
          aria-expanded={menuOpen()}
          onPointerDown={(event) => {
            if (event.pointerType === 'mouse') event.preventDefault();
          }}
          onClick={toggleMenu}
        >
          +{remainingAttachments().length}
        </button>
      </Show>
      <Show when={menuOpen()}>
        <Portal mount={document.body}>
          <div
            ref={(element) => (menu = element)}
            class="message-attachment-overflow-menu"
            role="dialog"
            aria-label="Remaining attachments"
            style={{ left: `${menuPosition().left}px`, top: `${menuPosition().top}px` }}
            onClick={() => setMenuOpen(false)}
          >
            <For each={remainingAttachments()}>
              {(attachment) => <DisplayMessageAttachmentItem attachment={attachment} />}
            </For>
          </div>
        </Portal>
      </Show>
      <div
        ref={(element) => (measurement = element)}
        class="message-attachment-measure"
        aria-hidden="true"
      >
        <For each={props.attachments}>
          {(attachment) => (
            <span class="message-attachment-measure-item">
              <FileTypeIcon path={getDisplayMessageAttachmentPath(attachment)} />
              <span>{getDisplayMessageAttachmentLabel(attachment)}</span>
              <Show when={getDisplayMessageAttachmentDetail(attachment)}>
                {(detail) => <span class="chip-detail">{detail()}</span>}
              </Show>
            </span>
          )}
        </For>
      </div>
    </div>
  );
}

function DisplayMessageAttachmentItem(props: { attachment: DisplayMessageAttachment }) {
  return props.attachment.type === 'message' ? (
    <MessageAttachmentChip attachment={props.attachment.attachment} />
  ) : (
    <MessageFileAttachment part={props.attachment.part} />
  );
}

function getDisplayMessageAttachmentLabel(attachment: DisplayMessageAttachment): string {
  if (attachment.type === 'message') return getAttachmentLabel(attachment.attachment);
  return getMessageFileAttachmentLabel(attachment.part);
}

function getDisplayMessageAttachmentDetail(attachment: DisplayMessageAttachment): string | null {
  if (attachment.type !== 'message') return null;
  if (attachment.attachment.type === 'file-selection') {
    return formatContextLineRanges(attachment.attachment.lineRanges);
  }
  if (attachment.attachment.type === 'terminal-selection') {
    return getTerminalLineCountLabel(attachment.attachment.text) ?? 'terminal';
  }
  return null;
}

function getDisplayMessageAttachmentPath(attachment: DisplayMessageAttachment): string | undefined {
  if (attachment.type === 'message') return getMessageAttachmentPath(attachment.attachment);
  return attachment.part.source?.path || attachment.part.filename;
}

function MessageFileAttachment(props: { part: FilePart }) {
  const label = () => getMessageFileAttachmentLabel(props.part);
  const path = () => props.part.source?.path || props.part.filename;

  return (
    <span class="chat-attachment-chip message-attachment-chip" title={label()}>
      <FileTypeIcon path={path()} class="chip-icon" />
      <AttachmentLabel label={label()} preserveExtension />
    </span>
  );
}

function getMessageFileAttachmentLabel(part: FilePart): string {
  const path = part.source?.path || part.filename;
  return path ? formatDisplayPath(path, state.editorContext.workspacePath) : '(file)';
}

function getTerminalLineCountLabel(text: string | undefined): string | null {
  if (!text) return null;
  const lineCount = text.split('\n').length;
  return `${lineCount} ${lineCount === 1 ? 'line' : 'lines'}`;
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

function getMessageAttachmentPath(attachment: MessageAttachment): string | undefined {
  if (attachment.type === 'file-selection') return attachment.filename;
  if (attachment.type === 'file-reference') return attachment.path;
  return undefined;
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
