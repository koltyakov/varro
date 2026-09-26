import { For, Show, createEffect, createMemo, createSignal, onCleanup } from 'solid-js';
import {
  formatExtensionContext,
  readExtensionContextBlock,
} from '../../../shared/extension-context';
import type { ExtensionContext } from '../../../shared/extension-context';
import { readLegacyExtensionContext, showAttachmentDetails } from '../../host/extensions';
import { Portal } from 'solid-js/web';
import { createPastedText, readPastedTextDataUrl } from '../../../shared/pasted-text';
import { SESSION_RESUME_PROMPT } from '../../../shared/session-pauses';
import type {
  DatabaseContext,
  DatabaseAttachment,
  InlineProblemAttachment,
} from '../../../shared/protocol';
import {
  databaseAttachmentDetail,
  databaseContextDetail,
  isDatabaseContext,
  formatDatabaseAttachmentReference,
  parseDatabaseAttachmentReference,
} from '../../../shared/database-context';
import { formatDatabaseContext } from '../../lib/database-context';
import {
  formatDisplayPath,
  getLeafPathName,
  isAbsolutePath,
  normalizePath,
} from '../../lib/path-display';
import { postMessage } from '../../lib/bridge';
import type { MessageEditContext } from '../../lib/message-edit-state';
import { splitSessionReferenceText, type SessionReference } from '../../lib/session-reference';
import { rememberDirectSessionReturn } from '../../lib/session-navigation';
import { state } from '../../lib/state';
import { observeSettledResize } from '../../lib/settled-resize-observer';
import { selectSession } from '../../hooks/useOpenCode';
import type {
  AgentPart,
  AssistantMessage,
  FilePart,
  MessageEntry,
  Part,
  TextPart,
  ToolPart,
} from '../../types';
import {
  formatContextLineRanges,
  formatSelectionReference,
  getFirstContextLine,
  mergeContextFile,
  parseSelectionReference,
  TERMINAL_SELECTION_MARKER,
} from '../../../shared/context-files';
import { AttachmentLabel } from '../AttachmentLabel';
import { ImagePreviewOverlay, createImagePreviewEffect } from '../ImagePreview';
import type { PreviewImage } from '../ImagePreview';
import { MarkdownRenderer, renderCodeBlockHtml } from '../MarkdownRenderer';
import type { MarkdownInlineSlot } from '../MarkdownRenderer';
import { getPdfDataUrlSize } from '../../../shared/native-pdf';
import { FileTypeIcon } from '../FileTypeIcon';
import { FolderIcon } from '../FolderIcon';
import { ExternalLinkIcon } from '../ExternalLinkIcon';
import {
  isSafeExternalHref,
  splitExternalLinkText,
  type ExternalLinkTextSegment,
} from '../../lib/external-link';
import { formatAgentLabel } from '../../lib/format';
import { AgentChip } from './AgentChip';
import { InlineMessageImage } from '../InlineMessageImage';
import { MaterialChipIcon } from '../MaterialChipIcon';
import { isFunction } from '../../lib/runtime-values';
import { navArrowLeftIcon, navArrowRightIcon } from '../../lib/ui-icons';
import { UiIcon } from '../UiIcon';
import { formatSkillReference, parseSkillAttachment } from '../../lib/skill-reference';
import {
  getProblemsSeverity,
  parseIssueAttachment,
  PROBLEMS_REFERENCE,
  parseInlineProblem,
  problemReferenceMarker,
  problemReferenceLocation,
  problemReferenceLabel,
  problemReferenceDetails,
  problemReferenceSeverity,
} from '../../lib/editor-problems';
import type { IssueAttachment } from '../../lib/editor-problems';
import { ProblemsIcon } from '../ProblemsIcon';
import { ProblemsTooltip } from '../ProblemsTooltip';

export type MessageAttachment =
  | { type: 'extension-context'; context: ExtensionContext }
  | { type: 'problem-reference'; reference: InlineProblemAttachment }
  | ({ type: 'issues' } & IssueAttachment)
  | { type: 'database'; context: DatabaseContext }
  | { type: 'skill'; name: string }
  | {
      type: 'file-selection';
      filename: string;
      lineRanges: Array<{ startLine: number; endLine: number }>;
    }
  | {
      type: 'editor-text';
      filename: string;
      kind: 'selection' | 'dirty-buffer';
      language: string;
      lineRange: { startLine: number; endLine: number };
      text?: string;
      truncated: boolean;
    }
  | { type: 'terminal-selection'; terminalName: string; text?: string }
  | { type: 'file-reference'; path: string; isDirectory: boolean; database?: DatabaseAttachment };

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
  automaticActions: string[];
  automaticParts: ToolPart[];
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
  | { type: 'file-part'; part: FilePart }
  | { type: 'agent'; part: AgentPart };

type InlineRenderableAttachment =
  | { type: 'message-attachment'; attachment: MessageAttachment }
  | { type: 'file-part'; part: FilePart; marker: string }
  | { type: 'image-file'; part: FilePart; index: number; marker?: string; label?: string }
  | { type: 'agent'; part: AgentPart; marker: string };

type InlineTextSegment =
  | { type: 'text'; content: string }
  | { type: 'attachment'; attachment: InlineRenderableAttachment }
  | { type: 'session'; reference: SessionReference }
  | Extract<ExternalLinkTextSegment, { type: 'external-link' }>;

const VISION_DELEGATION_CONTEXT_RE =
  /^\[Image for @[^:\]\n]+: [^\]\n]+\]\nWhen calling the [^\n]+ subagent, include \{file:[^}\n]+\} in its task prompt\.$/;
const USER_CODE_FENCE_RE = /```([^\n`]*)\n([\s\S]*?)```/g;
function bindUserMessageOverflowFade(element: HTMLElement, trackText: () => string[]) {
  const update = () => {
    const hasMoreBelow = element.scrollTop + element.clientHeight < element.scrollHeight - 1;
    element.classList.toggle('has-more-below', hasMoreBelow);
    for (const codeBlock of element.querySelectorAll<HTMLElement>(
      '.user-message-code-block:not(.user-message-terminal-code-block) pre.code-block'
    )) {
      codeBlock.classList.toggle(
        'is-truncated',
        codeBlock.scrollHeight > codeBlock.clientHeight + 1
      );
    }
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

function parseUserMessageSegments(text: string): UserMessageSegment[] {
  const normalized = text.replace(/\r\n?/g, '\n');
  const markup = getUserMessageMarkupSuffix(normalized);
  if (markup) {
    const segments = markup.prefix ? parseUserMessageSegments(markup.prefix) : [];
    segments.push({ type: 'markup', content: markup.content, format: markup.format });
    return segments;
  }

  const trimmed = normalized.trim();
  if (trimmed.startsWith('<') && trimmed.endsWith('>')) {
    return [{ type: 'text', content: normalized }];
  }

  const segments: UserMessageSegment[] = [];
  let lastIndex = 0;

  for (const match of normalized.matchAll(USER_CODE_FENCE_RE)) {
    const index = match.index ?? 0;
    if (index > lastIndex) {
      const content = normalized.slice(lastIndex, index).replace(/^\n+|\n+$/g, '');
      if (content.length > 0) segments.push({ type: 'text', content });
    }

    segments.push({
      type: 'code',
      content: match[2]!,
      language: match[1]!.trim() || undefined,
    });
    lastIndex = index + match[0].length;
  }

  if (lastIndex < normalized.length) {
    const content = normalized.slice(lastIndex).replace(/^\n+/, '');
    if (content.length > 0) segments.push({ type: 'text', content });
  }

  return segments.length > 0 ? segments : [{ type: 'text', content: normalized }];
}

function hasUserMarkdownSyntax(text: string): boolean {
  return (
    /^(?: {0,3}#{1,6}\s| {0,3}>\s| {0,3}(?:[-+*]|\d+[.)])\s)/m.test(text) ||
    /(?:\*\*|__|~~|`|\[[^\]\n]+\]\([^\n)]+\))/.test(text) ||
    /(?:^|[^*])\*[^*\n]+\*(?:[^*]|$)/.test(text) ||
    /(?:^|[^_])_[^_\n]+_(?:[^_]|$)/.test(text)
  );
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
  const automaticActions = new Set<string>();
  const automaticParts: ToolPart[] = [];
  const attachments: MessageAttachment[] = [];
  const fileParts: FilePart[] = [];
  const agentParts: AgentPart[] = [];

  for (const part of parts) {
    if (part.type === 'file') {
      if (!fileParts.some((file) => file.url === part.url && file.mime === part.mime)) {
        fileParts.push(part);
      }
      continue;
    }

    if (part.type === 'agent') {
      agentParts.push(part);
      continue;
    }

    if (part.type !== 'text') continue;
    // SAFETY: The surrounding shape or discriminator check establishes the TextPart contract used below.
    const text = (part as TextPart).text;
    if (!text || text === SESSION_RESUME_PROMPT || isVisionDelegationContextText(text)) continue;
    const problemReference = parseInlineProblem(text);
    if (problemReference) {
      attachments.push({ type: 'problem-reference', reference: problemReference });
      continue;
    }
    const skill = parseSkillAttachment(text);
    if (skill) {
      if (
        !attachments.some((attachment) => attachment.type === 'skill' && attachment.name === skill)
      ) {
        attachments.push({ type: 'skill', name: skill });
      }
      continue;
    }

    const parsedText = parseUserMessageText(text);
    attachments.push(...parsedText.attachments);
    if (part.synthetic) {
      if (parsedText.messageTexts.some((value) => value.trim())) {
        automaticActions.add(getAutomaticAction(part));
        automaticParts.push(automaticActionPart(part));
      }
      continue;
    }
    messageTexts.push(...parsedText.messageTexts);
  }

  // A file/resource read emits both a descriptive part and an arbitrary content part.
  if (
    automaticActions.has('Added file context') ||
    automaticActions.has('Added MCP resource context')
  ) {
    automaticActions.delete('Added automatic context');
  }
  return {
    messageTexts,
    automaticActions: [...automaticActions],
    automaticParts,
    attachments: attachments.filter(
      (attachment, index) =>
        attachments.findIndex(
          (candidate) => JSON.stringify(candidate) === JSON.stringify(attachment)
        ) === index &&
        !(
          attachment.type === 'file-reference' &&
          fileParts.some(
            (part) => part.filename === attachment.path || part.source?.path === attachment.path
          )
        )
    ),
    fileParts,
    agentParts,
  };
}

const SHELL_HEADER_RE = /^<shell\s+((?:"[^"]*"|'[^']*'|[^'">])*)>/;

function automaticActionPart(part: TextPart): ToolPart {
  const title = getAutomaticAction(part);
  const text = part.text.trim();
  const shell = text.startsWith('<shell ') ? SHELL_HEADER_RE.exec(text) : null;
  const input: Record<string, string> = {};
  if (shell) {
    for (const match of shell[1]!.matchAll(/([\w-]+)=(?:"([^"]*)"|'([^']*)')/g)) {
      input[match[1]!] = match[2] ?? match[3]!;
    }
  }
  const output = shell
    ? text
        .slice(shell[0].length)
        .replace(/<\/shell>\s*$/, '')
        .trim()
    : part.text;
  const time = { start: part.time?.start ?? 0, end: part.time?.end ?? part.time?.start ?? 0 };
  return {
    id: part.id,
    messageID: part.messageID,
    sessionID: part.sessionID,
    type: 'tool',
    tool: 'automatic_action',
    callID: `automatic:${part.id}`,
    state:
      input.state === 'failed'
        ? {
            status: 'error',
            input: { ...input, description: title },
            error: output || title,
            metadata: {},
            time,
          }
        : { status: 'completed', input, output, title, metadata: {}, time },
  };
}

// Presentation only: retain server message/part identities without changing canonical history.
export function getAutomaticActionInfo(info: MessageEntry['info']): AssistantMessage {
  return {
    id: info.id,
    sessionID: info.sessionID,
    role: 'assistant',
    time: { created: info.time.created, completed: info.time.created },
    parentID: '',
    modelID: '',
    providerID: '',
    mode: 'automatic',
    path: { cwd: '', root: '' },
    cost: 0,
    tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
  };
}

export function projectAutomaticActionMessage(message: MessageEntry): MessageEntry {
  if (message.info.role !== 'user') return message;
  const parsed = parseUserMessageContent(message.parts);
  if (
    !parsed.automaticParts.length ||
    hasUserMessageContent(parsed) ||
    message.info.summary?.diffsOmitted ||
    message.parts.some((part) => part.type === 'compaction')
  )
    return message;
  return { info: getAutomaticActionInfo(message.info), parts: parsed.automaticParts };
}

function getAutomaticAction(part: TextPart): string {
  const text = part.text.trim();
  if (
    part.metadata?.compaction_continue === true ||
    text.endsWith(
      'Continue if you have next steps, or stop and ask for clarification if you are unsure how to proceed.'
    )
  )
    return 'Continued after context compaction';
  if (text === 'Summarize the task tool output above and continue with your task.') {
    return 'Continued after subagent task';
  }
  if (text === 'The following tool was executed by the user') return 'Ran a shell command';
  if (
    text.startsWith('The server restarted while you were working.') ||
    text.startsWith('The previous response was interrupted.') ||
    text.startsWith(
      'Continue from where you were interrupted by the server restart or extension reload.'
    )
  ) {
    return 'Resumed after interruption';
  }
  if (text.startsWith('Instructions from:')) return 'Loaded agent instructions';
  if (text.startsWith('<shell ')) {
    const header = SHELL_HEADER_RE.exec(text)?.[1] ?? '';
    if (/\bstate=(?:"failed"|'failed')/.test(header)) return 'Background command failed';
    return 'Background command finished';
  }
  if (/^The plan at .+ has been approved, you can now edit files\. Execute the plan$/s.test(text)) {
    return 'Started approved plan';
  }
  if (text.startsWith('<system-reminder>')) {
    if (text.includes('Your operational mode has changed from plan to build.'))
      return 'Switched to build mode';
    if (text.includes('Plan mode is active') || text.includes('Plan Mode'))
      return 'Entered plan mode';
    return 'Updated session instructions';
  }
  if (/^The user explicitly (?:mentioned these skills|invoked .+ skill)/s.test(text)) {
    return 'Added skill instructions';
  }
  if (
    text.startsWith('Use the above message and context to generate a prompt and call the task tool')
  ) {
    return 'Requested subagent task';
  }
  if (text.startsWith('Read tool failed to read ')) return 'Could not read attached file';
  if (
    text.startsWith('Called the Read tool with the following input:') ||
    text.startsWith('<path>')
  ) {
    return 'Added file context';
  }
  if (text.startsWith('Failed to read MCP resource ')) return 'Could not read MCP resource';
  if (text.startsWith('[Binary MCP resource omitted:')) return 'Skipped unsupported MCP attachment';
  if (
    text.startsWith('Reading MCP resource:') ||
    text.startsWith('[Binary MCP resource attached:')
  ) {
    return 'Added MCP resource context';
  }
  return 'Added automatic context';
}

export function hasUserMessageContent(parsed: ParsedUserMessageContent): boolean {
  return (
    parsed.messageTexts.some((text) => text.trim().length > 0) ||
    parsed.attachments.length > 0 ||
    parsed.fileParts.length > 0 ||
    parsed.agentParts.length > 0
  );
}

export function isWrapperlessUserMessageContent(parsed: ParsedUserMessageContent): boolean {
  const attachmentCount =
    parsed.attachments.length + parsed.fileParts.length + parsed.agentParts.length;
  if (attachmentCount === 0) return false;
  if (parsed.messageTexts.length === 0) return true;

  const indexedAttachments = parsed.attachments.map((attachment, index) => ({
    id: `attachment-${index}`,
    attachment,
    marker: getAttachmentTextMarker(attachment),
  }));
  const segments = parsed.messageTexts
    .flatMap((text) =>
      buildInlineTextSegments(
        text,
        indexedAttachments,
        parsed.fileParts.filter((part) => part.mime.startsWith('image/')),
        parsed.agentParts,
        parsed.fileParts
      )
    )
    .filter((segment) => segment.type !== 'text' || segment.content.trim().length > 0);

  return segments.length > 0 && segments.every((segment) => segment.type === 'attachment');
}

function isVisionDelegationContextText(text: string): boolean {
  return VISION_DELEGATION_CONTEXT_RE.test(text.replace(/\r\n?/g, '\n').trim());
}

type ParsedUserMessageText = {
  messageTexts: string[];
  attachments: MessageAttachment[];
};

function parseUserMessageText(text: string): ParsedUserMessageText {
  const normalized = text.replace(/\r\n?/g, '\n');
  const lines = normalized.split('\n');
  const messageTexts: string[] = [];
  const attachments: MessageAttachment[] = [];
  const textBuffer: string[] = [];
  const standaloneReference = isStandaloneFileReference(normalized.trim());
  // Older sends could append bare absolute attachment paths before V2 joined the parts.
  // Recover only a trailing path block; inline prose and fenced examples stay text.
  let trailingPathStart = lines.length;
  while (trailingPathStart > 0) {
    const line = lines[trailingPathStart - 1]!.trim();
    if (line && !(isAbsolutePath(normalizePath(line)) && isStandaloneFileReference(line))) break;
    trailingPathStart -= 1;
  }
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
      const extensionBlock =
        readExtensionContextBlock(lines, index) ?? readLegacyExtensionContext(lines, index);
      if (extensionBlock) {
        flushTextBuffer();
        attachments.push({ type: 'extension-context', context: extensionBlock.context });
        index = extensionBlock.end;
        continue;
      }
      // Some backends join prompt and context parts into one text part.
      if (parseIssueAttachment(`${line}\n`)) {
        let end = index + 1;
        while (end < lines.length) {
          const candidate = lines[end]!.trim();
          if (
            parseIssueAttachment(`${candidate}\n`) ||
            parseUserMessageAttachmentLine(candidate, false) ||
            /^\[(?:Working directory:|Database context\]|Extension context\]|Selection from terminal |Unsaved (?:selection|buffer) from |Problem [\w-]+\])/.test(
              candidate
            )
          )
            break;
          end += 1;
        }
        const issues = parseIssueAttachment(lines.slice(index, end).join('\n').trimEnd());
        if (issues) {
          flushTextBuffer();
          attachments.push({ type: 'issues', ...issues });
          index = end - 1;
          continue;
        }
      }

      if (trimmedLine.startsWith('[Working directory:')) {
        flushTextBuffer();
        continue;
      }

      if (trimmedLine === '[Database context]') {
        const openingFence = lines[index + 1]?.trim().match(/^(`{3,})json$/);
        if (openingFence) {
          const end = lines.findIndex(
            (candidate, position) => position > index + 1 && candidate.trim() === openingFence[1]
          );
          if (end !== -1) {
            try {
              const context: unknown = JSON.parse(lines.slice(index + 2, end).join('\n'));
              if (isDatabaseContext(context)) {
                flushTextBuffer();
                attachments.push({ type: 'database', context });
                index = end;
                continue;
              }
            } catch {
              // Malformed context remains visible as ordinary message text.
            }
          }
        }
      }

      const terminalMatch = trimmedLine.match(/^\[Selection from terminal (.+?)\]/);
      if (terminalMatch) {
        flushTextBuffer();
        let terminalText = '';

        const openingFence = lines[index + 1]?.trim().match(/^(`{3,})([^`]*)$/);
        if (openingFence) {
          const fence = openingFence[1]!;
          const content: string[] = [];
          index += 2;
          while (index < lines.length && lines[index]!.trim() !== fence) {
            content.push(lines[index]!);
            index += 1;
          }
          terminalText = content.join('\n');
        }
        attachments.push({
          type: 'terminal-selection',
          terminalName: terminalMatch[1]!,
          text: terminalText || undefined,
        });
        continue;
      }

      const editorTextMatch = trimmedLine.match(
        /^\[(Unsaved selection|Unsaved buffer) from (.+) lines (\d+)-(\d+)(; truncated)?\]$/
      );
      if (editorTextMatch) {
        flushTextBuffer();
        let language = 'text';
        let editorText: string | undefined;
        const openingFence = lines[index + 1]?.trim().match(/^(`{3,})([^`]*)$/);

        if (openingFence) {
          const fence = openingFence[1]!;
          language = openingFence[2]!.trim() || 'text';
          const content: string[] = [];
          index += 2;
          while (index < lines.length && lines[index]!.trim() !== fence) {
            content.push(lines[index]!);
            index += 1;
          }
          editorText = content.join('\n');
        }

        attachments.push({
          type: 'editor-text',
          filename: editorTextMatch[2]!,
          kind: editorTextMatch[1] === 'Unsaved selection' ? 'selection' : 'dirty-buffer',
          language,
          lineRange: {
            startLine: Number(editorTextMatch[3]),
            endLine: Number(editorTextMatch[4]),
          },
          text: editorText,
          truncated: Boolean(editorTextMatch[5]),
        });
        continue;
      }

      const attachment = parseUserMessageAttachmentLine(
        trimmedLine,
        (standaloneReference && trimmedLine === normalized.trim()) || index >= trailingPathStart
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
  const database = parseDatabaseAttachmentReference(line);
  if (database)
    return {
      type: 'file-reference',
      path: database.path,
      database: database.database,
      isDirectory: false,
    };

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
        isDirectory: /[/\\]$/.test(match[1]!),
      };
    }
  }

  // @ tokens belong to the prompt body unless backed by a separate attachment.
  // This includes standalone mentions and scoped package names.
  if (hasMentionReference(line)) {
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

function hasMentionReference(line: string): boolean {
  const match = line.match(/(^|[\s(])@([^\s@)]+?\/?)(?=$|[\s),.:;!?])/);
  return match !== null;
}

export function getUserMessageEditText(parts: Part[]): string {
  return parseUserMessageContent(parts).messageTexts.join('\n');
}

export function getUserMessageEditContext(parts: Part[]): MessageEditContext {
  const parsed = parseUserMessageContent(parts);
  const filesByPath = new Map<string, MessageEditContext['files'][number]>();
  for (const attachment of parsed.attachments) {
    if (
      attachment.type === 'terminal-selection' ||
      attachment.type === 'issues' ||
      attachment.type === 'problem-reference' ||
      attachment.type === 'editor-text' ||
      attachment.type === 'database' ||
      attachment.type === 'extension-context' ||
      attachment.type === 'skill'
    )
      continue;

    const path = attachment.type === 'file-selection' ? attachment.filename : attachment.path;
    const file: MessageEditContext['files'][number] = {
      path,
      relativePath: path,
      type: attachment.type === 'file-reference' && attachment.isDirectory ? 'directory' : 'file',
      lineRanges: attachment.type === 'file-selection' ? attachment.lineRanges : undefined,
      database:
        attachment.type === 'file-reference' && attachment.database
          ? { ...attachment.database }
          : undefined,
    };
    const key = normalizePath(path);
    filesByPath.set(key, mergeContextFile(filesByPath.get(key), file));
  }
  const files = [...filesByPath.values()];
  for (const part of parsed.fileParts) {
    if (part.mime !== 'text/plain') continue;
    const text = readPastedTextDataUrl(part.url);
    if (text === null) continue;
    files.push({ ...createPastedText(text), relativePath: part.filename || 'pasted-text.txt' });
  }
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
  const extensionContexts = parsed.attachments.flatMap((attachment) =>
    attachment.type === 'extension-context' ? [attachment.context] : []
  );

  const context: MessageEditContext = {
    files,
    inlineProblems: parsed.attachments.some((attachment) => attachment.type === 'problem-reference')
      ? parsed.attachments.flatMap((attachment) =>
          attachment.type === 'problem-reference' ? [attachment.reference] : []
        )
      : undefined,
    images,
    pdfs: pdfs.length > 0 ? pdfs : undefined,
    issues: (() => {
      const problems = parsed.attachments.find((attachment) => attachment.type === 'issues');
      return problems &&
        getAttachmentTextMarker(problems) === PROBLEMS_REFERENCE &&
        parsed.messageTexts.some((text) => text.includes(PROBLEMS_REFERENCE))
        ? { ...problems, inline: true }
        : problems;
    })(),
    terminalSelection:
      terminalAttachment?.type === 'terminal-selection' && terminalAttachment.text
        ? { terminalName: terminalAttachment.terminalName, text: terminalAttachment.text }
        : null,
  };
  if (extensionContexts.length > 0) context.extensionContexts = extensionContexts;
  return context;
}

export function hasUserMessageEditableContent(parts: Part[]): boolean {
  if (getUserMessageEditText(parts).trim().length > 0) return true;

  const context = getUserMessageEditContext(parts);
  return (
    context.files.length > 0 ||
    !!context.extensionContexts?.length ||
    context.images.length > 0 ||
    (context.pdfs?.length ?? 0) > 0 ||
    context.terminalSelection !== null ||
    !!context.issues
  );
}

export function getUserMessagePreviewText(parts: Part[]): string {
  const parsed = parseUserMessageContent(parts);
  const firstText = parsed.messageTexts
    .map((text) =>
      parsed.attachments.reduce(
        (value, attachment) =>
          attachment.type === 'problem-reference'
            ? value.replaceAll(
                problemReferenceMarker(attachment.reference),
                `${problemReferenceLabel(attachment.reference)} ${problemReferenceLocation(attachment.reference)}`
              )
            : value,
        text
      )
    )
    .map((text) => text.replace(/\s+/g, ' ').trim())
    .find((text) => text.length > 0);
  if (firstText) return firstText;

  const firstAttachment = parsed.attachments[0];
  if (firstAttachment) {
    switch (firstAttachment.type) {
      case 'extension-context':
        return firstAttachment.context.label;
      case 'problem-reference':
        return `${problemReferenceLabel(firstAttachment.reference)} ${problemReferenceLocation(firstAttachment.reference)}`;
      case 'issues':
        return `Problems ${firstAttachment.count}`;
      case 'database':
        return `Database: ${firstAttachment.context.name}`;
      case 'file-selection':
        return `Selection: ${getLeafPathName(firstAttachment.filename)}`;
      case 'editor-text':
        return `${firstAttachment.kind === 'selection' ? 'Selection' : 'Buffer'}: ${getLeafPathName(firstAttachment.filename)}`;
      case 'terminal-selection': {
        const lineCount = getTerminalLineCountLabel(firstAttachment.text);
        return `Terminal: ${firstAttachment.terminalName}${lineCount ? ` (${lineCount})` : ''}`;
      }
      case 'file-reference':
        return firstAttachment.database
          ? `Table: ${firstAttachment.database.name}`
          : `${firstAttachment.isDirectory ? 'Folder' : 'File'}: ${getLeafPathName(firstAttachment.path)}`;
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

export function UserMessageContent(props: {
  parts: Part[];
  leadingAgent?: string;
  promptNumber?: number;
  onMessageHoverChange?: (hovering: boolean) => void;
}) {
  const parsed = createMemo(() => parseUserMessageContent(props.parts));
  const agentParts = createMemo(() => getDisplayAgentParts(parsed()));
  const leadingAgentPart = createMemo<AgentPart | null>(() => {
    if (!props.leadingAgent) return null;
    return {
      id: `display-leading-agent-${props.leadingAgent}`,
      sessionID: '',
      messageID: '',
      type: 'agent',
      name: props.leadingAgent,
    };
  });
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
        (attachment.type === 'skill' || !inlineAttachmentIds().has(id)) &&
        attachment !== expandedTerminalAttachment()
    )
  );
  const visibleAgentParts = createMemo(() => {
    const leading = leadingAgentPart();
    return agentParts().filter((part) => {
      if (leading && part.name.toLowerCase() === leading.name.toLowerCase()) return false;
      const marker = part.source?.value || `@${part.name}`;
      return !parsed().messageTexts.some((text) => text.includes(marker));
    });
  });
  const inlineAgentParts = createMemo(() => {
    const leadingName = leadingAgentPart()?.name.toLowerCase();
    return leadingName
      ? agentParts().filter((part) => part.name.toLowerCase() !== leadingName)
      : agentParts();
  });

  const imageParts = createMemo(() =>
    parsed().fileParts.filter((part) => part.mime.startsWith('image/'))
  );
  const otherFileParts = createMemo(() =>
    parsed().fileParts.filter(
      (part) =>
        !part.mime.startsWith('image/') &&
        !parsed().messageTexts.some((text) => {
          const marker = getInlineFileMarker(part);
          return marker && text.includes(marker);
        })
    )
  );
  const displayAttachments = createMemo<DisplayMessageAttachment[]>(() => [
    ...(leadingAgentPart() ? [{ type: 'agent' as const, part: leadingAgentPart()! }] : []),
    ...visibleAttachments().map(({ attachment }) => ({
      type: 'message' as const,
      attachment,
    })),
    ...otherFileParts().map((part) => ({ type: 'file-part' as const, part })),
  ]);
  const attachmentCount = createMemo(() => displayAttachments().length);
  const hasMessageText = createMemo(() => parsed().messageTexts.length > 0);
  const hasImageTiles = createMemo(() => hasMessageText() && imageParts().length > 0);
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
      <Show when={hasImageTiles()}>
        <div
          class="user-message-leading-content"
          on:mouseenter={() => props.onMessageHoverChange?.(false)}
        >
          <Show when={displayAttachments().length > 0}>
            <MessageAttachmentRail
              attachments={displayAttachments()}
              leading
              label={`${attachmentCount()} ${attachmentCount() === 1 ? 'attachment' : 'attachments'}`}
            />
          </Show>
          <Show when={visibleAgentParts().length > 0}>
            <div class="message-attachments message-attachments-leading">
              <For each={visibleAgentParts()}>{(part) => <AgentChip part={part} />}</For>
            </div>
          </Show>
          <UserMessageImageTiles imageParts={imageParts()} onOpenPreview={openImagePreview} />
        </div>
      </Show>
      <Show when={!hasImageTiles() && displayAttachments().length > 0}>
        <MessageAttachmentRail
          attachments={displayAttachments()}
          leading={hasTrailingAttachmentContent()}
          label={`${attachmentCount()} ${attachmentCount() === 1 ? 'attachment' : 'attachments'}`}
        />
      </Show>
      <Show when={!hasImageTiles() && visibleAgentParts().length > 0}>
        <div class="message-attachments message-attachments-leading">
          <For each={visibleAgentParts()}>{(part) => <AgentChip part={part} />}</For>
        </div>
      </Show>
      <Show when={expandedTerminalAttachment()}>
        {(attachment) => <TerminalMessageCodeBlock attachment={attachment()} />}
      </Show>
      <Show when={parsed().messageTexts.length > 0}>
        <Show
          when={hasImageTiles()}
          fallback={
            <UserMessageTextList
              messageTexts={parsed().messageTexts}
              attachments={indexedAttachments()}
              imageParts={imageParts()}
              fileParts={parsed().fileParts}
              agentParts={inlineAgentParts()}
              onOpenImagePreview={openImagePreview}
            />
          }
        >
          <div
            class="user-message-image-text-bubble"
            on:mouseenter={() => props.onMessageHoverChange?.(true)}
          >
            <Show when={props.promptNumber}>
              {(promptNumber) => (
                <span class="prompt-number-badge" aria-hidden="true">
                  {promptNumber()}
                </span>
              )}
            </Show>
            <UserMessageTextList
              messageTexts={parsed().messageTexts}
              attachments={indexedAttachments()}
              imageParts={imageParts()}
              fileParts={parsed().fileParts}
              agentParts={inlineAgentParts()}
              onOpenImagePreview={openImagePreview}
            />
          </div>
        </Show>
      </Show>
      <Show when={!hasContent()}>
        <p class="user-message-empty">(no content)</p>
      </Show>
      <Show when={imageParts().length > 0 && !hasImageTiles()}>
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

function UserMessageTextList(props: {
  messageTexts: string[];
  attachments: IndexedMessageAttachment[];
  fileParts: FilePart[];
  imageParts: FilePart[];
  agentParts: AgentPart[];
  onOpenImagePreview: (index: number) => void;
}) {
  return (
    <div
      class="user-message-text-scroll"
      ref={(element) => bindUserMessageOverflowFade(element, () => props.messageTexts)}
    >
      <For each={props.messageTexts}>
        {(text) => (
          <UserMessageTextContent
            text={text}
            attachments={props.attachments}
            fileParts={props.fileParts}
            imageParts={props.imageParts}
            agentParts={props.agentParts}
            onOpenImagePreview={props.onOpenImagePreview}
          />
        )}
      </For>
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
        <p class="user-message-text">
          <InlineAttachmentText
            content={value()}
            attachments={attachments()}
            fileParts={parsed().fileParts}
            imageParts={imageParts()}
            agentParts={agentParts()}
            onOpenImagePreview={(index) => props.onOpenImagePreview?.(index)}
          />
        </p>
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
  fileParts: FilePart[];
  imageParts: FilePart[];
  agentParts: AgentPart[];
  onOpenImagePreview: (index: number) => void;
}) {
  const segments = createMemo(() => parseUserMessageSegments(props.text));
  const inlineSlots = createMemo<MarkdownInlineSlot[]>(() => {
    const slots = new Map<string, MarkdownInlineSlot>();
    for (const segment of buildInlineTextSegments(
      props.text,
      props.attachments,
      props.imageParts,
      props.agentParts,
      props.fileParts
    )) {
      if (segment.type === 'session' || segment.type === 'text') continue;
      if (segment.type === 'external-link') {
        if (segment.kind !== 'git') continue;
        slots.set(segment.href, {
          marker: segment.href,
          render: () => <ExternalLink link={segment} />,
        });
        continue;
      }

      const attachment = segment.attachment;
      const marker =
        attachment.type === 'agent' || attachment.type === 'file-part'
          ? attachment.marker
          : attachment.type === 'image-file'
            ? attachment.marker || attachment.label || getInlineImageLabel(attachment.part)
            : getInlineAttachmentCopyMarker(attachment.attachment);
      slots.set(marker, {
        marker,
        render: () =>
          attachment.type === 'file-part' ? (
            <MessageFileAttachment part={attachment.part} inline marker={attachment.marker} />
          ) : attachment.type === 'agent' ? (
            <InlineAgentChip part={attachment.part} marker={attachment.marker} />
          ) : attachment.type === 'image-file' ? (
            <InlineImageAttachmentChip
              part={attachment.part}
              index={attachment.index}
              marker={attachment.marker}
              label={attachment.label}
              onClick={() => props.onOpenImagePreview(attachment.index)}
            />
          ) : (
            <InlineMessageAttachmentChip attachment={attachment.attachment} />
          ),
      });
    }
    return [...slots.values()];
  });

  return (
    <For each={segments()}>
      {(segment) =>
        segment.type === 'code' ? (
          <UserMessageCodeBlock content={segment.content} language={segment.language} />
        ) : segment.type === 'markup' ? (
          <p class="user-message-text user-message-format-chip-row">
            <UserMessageMarkupChip content={segment.content} format={segment.format} />
          </p>
        ) : hasUserMarkdownSyntax(segment.content) ? (
          <Show when={segment.content.length > 0}>
            <MarkdownRenderer
              content={segment.content}
              cacheByContent
              class="user-message-text user-message-markdown user-message-code-block"
              inlineSlots={inlineSlots()}
              disablePathLinkify
              escapeHtml
            />
          </Show>
        ) : (
          <Show when={segment.content.length > 0}>
            <p class="user-message-text">
              <InlineAttachmentText
                content={segment.content}
                attachments={props.attachments}
                fileParts={props.fileParts}
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

function InlineAttachmentText(props: {
  content: string;
  attachments: IndexedMessageAttachment[];
  fileParts: FilePart[];
  imageParts: FilePart[];
  agentParts: AgentPart[];
  onOpenImagePreview: (index: number) => void;
}) {
  const segments = createMemo(() =>
    buildInlineTextSegments(
      props.content,
      props.attachments,
      props.imageParts,
      props.agentParts,
      props.fileParts
    )
  );

  return (
    <For each={segments()}>
      {(segment) => {
        if (segment.type === 'text') return segment.content;
        if (segment.type === 'session') {
          return <SessionReferenceLink reference={segment.reference} />;
        }
        if (segment.type === 'external-link') {
          return <ExternalLink link={segment} />;
        }
        if (segment.attachment.type === 'agent') {
          return (
            <InlineAgentChip part={segment.attachment.part} marker={segment.attachment.marker} />
          );
        }
        if (segment.attachment.type === 'file-part') {
          return (
            <MessageFileAttachment
              part={segment.attachment.part}
              inline
              marker={segment.attachment.marker}
            />
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

function TerminalMessageCodeBlock(props: {
  attachment: Extract<MessageAttachment, { type: 'terminal-selection' }>;
}) {
  const openTerminalSelection = () => openAttachment(props.attachment);
  const handleClick = (event: MouseEvent) => {
    const target = event.target;
    if (target instanceof Element && target.closest('.code-block-header')) return;
    event.stopPropagation();
    if (window.getSelection()?.toString()) return;
    openTerminalSelection();
  };

  return (
    <div
      class="user-message-terminal-preview"
      role="button"
      tabIndex={0}
      onClick={handleClick}
      onKeyDown={(event) => {
        if (event.key !== 'Enter' && event.key !== ' ') return;
        event.preventDefault();
        openTerminalSelection();
      }}
    >
      <div
        class="interactive-result-code-block user-message-code-block user-message-terminal-code-block"
        data-lang="text"
      >
        <div class="code-block-header">
          <MaterialChipIcon kind="terminal" class="user-message-terminal-header-icon" />
          <span class="code-block-lang">{props.attachment.terminalName}</span>
          <span class="code-block-detail">{getTerminalLineCountLabel(props.attachment.text)}</span>
        </div>
        <pre class="code-block">
          <code class="hljs">{props.attachment.text ?? ''}</code>
        </pre>
      </div>
    </div>
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
                      <UiIcon source={navArrowLeftIcon} width="14" height="14" />
                    </button>
                    <button
                      type="button"
                      class="message-image-carousel-nav"
                      onClick={() => step(1)}
                      aria-label="Next image"
                      title="Next image"
                    >
                      <UiIcon source={navArrowRightIcon} width="14" height="14" />
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
  if (
    splitExternalLinkText(trimmed).some(
      (segment) => segment.type === 'external-link' && segment.kind === 'git'
    )
  ) {
    return false;
  }
  if (/\[\d+\/\d+\]/.test(trimmed)) return false;
  if (/["'{}[\],<>|]/.test(trimmed) || trimmed.includes('>')) return false;
  // A lone trailing backslash is not enough evidence of a directory path.
  if (/^[^/\\]+\\$/.test(trimmed)) return false;

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
  if (/^\.[A-Za-z0-9][\w.-]*$/.test(trimmed)) return true;
  if (/^LICENSE(?:[._-][A-Za-z0-9.-]+)?$/i.test(trimmed)) return true;
  return /^\w[\w.-]*\.\w{1,12}$/.test(trimmed);
}

function getAttachmentTextMarker(attachment: MessageAttachment): string | null {
  switch (attachment.type) {
    case 'extension-context':
      return null;
    case 'problem-reference':
      return problemReferenceMarker(attachment.reference);
    case 'skill':
      return formatSkillReference(attachment.name);
    case 'file-reference':
      return `@${attachment.path}`;
    case 'file-selection':
      return `@${attachment.filename}`;
    case 'editor-text':
      return null;
    case 'terminal-selection':
      return TERMINAL_SELECTION_MARKER;
    case 'database':
      return null;
    case 'issues':
      return attachment.text.startsWith('[Attached diagnostics:') ? PROBLEMS_REFERENCE : null;
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
  agentParts: AgentPart[],
  fileParts: FilePart[] = []
): InlineTextSegment[] {
  const attachmentByMarker = new Map<string, InlineRenderableAttachment>();

  for (const part of fileParts) {
    const marker = getInlineFileMarker(part);
    if (marker) attachmentByMarker.set(marker, { type: 'file-part', part, marker });
  }

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

function ExternalLink(props: { link: Extract<InlineTextSegment, { type: 'external-link' }> }) {
  const openExternal = (event: MouseEvent) => {
    event.preventDefault();
    if (!isSafeExternalHref(props.link.target)) return;
    postMessage({ type: 'vscode/open-external', payload: { url: props.link.target } });
  };

  return (
    <a
      class="external-link"
      href={props.link.target}
      data-external="true"
      title={`Open ${props.link.href}`}
      onClick={openExternal}
    >
      <span class="link-leading-content">
        <Show when={props.link.kind === 'git'} fallback={<ExternalLinkIcon />}>
          <MaterialChipIcon kind="git" class="external-link-icon" />
        </Show>
        <span class="link-leading-label">{props.link.href.slice(0, 1)}</span>
      </span>
      {props.link.href.slice(1)}
    </a>
  );
}

function SessionReferenceLink(props: { reference: SessionReference }) {
  const firstWord = props.reference.title.match(/^\S+/)?.[0] ?? '';
  const openSession = (event: MouseEvent) => {
    event.preventDefault();
    if (state.activeSessionId) {
      rememberDirectSessionReturn(props.reference.id, state.activeSessionId);
    }
    void selectSession(props.reference.id, { directory: props.reference.directory });
  };

  return (
    <a
      class="session-reference-link"
      href={props.reference.href}
      data-copy-marker={props.reference.marker}
      data-session-id={props.reference.id}
      data-session-directory={props.reference.directory}
      title={`Open session ${props.reference.id}`}
      onClick={openSession}
    >
      <span class="link-leading-content">
        <MaterialChipIcon kind="session" class="session-reference-icon" />
        <span class="link-leading-label">{firstWord}</span>
      </span>
      {props.reference.title.slice(firstWord.length)}
      <Show when={props.reference.folderLabel}>
        <span class="session-reference-folder"> · {props.reference.folderLabel}</span>
      </Show>
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

function UserMessageImageTiles(props: {
  imageParts: FilePart[];
  onOpenPreview: (index: number) => void;
}) {
  let scroller: HTMLDivElement | undefined;
  const [canScrollBack, setCanScrollBack] = createSignal(false);
  const [canScrollForward, setCanScrollForward] = createSignal(false);
  const updateScrollState = () => {
    if (!scroller) return;
    setCanScrollBack(scroller.scrollLeft > 1);
    setCanScrollForward(scroller.scrollLeft + scroller.clientWidth < scroller.scrollWidth - 1);
  };
  const scrollTiles = (direction: -1 | 1) => {
    if (!scroller) return;
    scroller.scrollBy({
      left: direction * Math.max(72, scroller.clientWidth * 0.8),
      behavior: 'smooth',
    });
  };

  createEffect(() => {
    void props.imageParts.length;
    queueMicrotask(updateScrollState);
  });

  return (
    <div class="user-message-image-tiles-shell">
      <Show when={canScrollBack() || canScrollForward()}>
        <div
          class="user-message-image-scroll-controls"
          role="group"
          aria-label="Attached image navigation"
        >
          <button
            type="button"
            class="user-message-image-scroll-button"
            aria-label="Previous attached images"
            disabled={!canScrollBack()}
            onClick={() => scrollTiles(-1)}
          >
            <UiIcon source={navArrowLeftIcon} width="13" height="13" />
          </button>
          <button
            type="button"
            class="user-message-image-scroll-button"
            aria-label="Next attached images"
            disabled={!canScrollForward()}
            onClick={() => scrollTiles(1)}
          >
            <UiIcon source={navArrowRightIcon} width="13" height="13" />
          </button>
        </div>
      </Show>
      <div
        ref={(element) => {
          scroller = element;
          const stopObservingResize = observeSettledResize(element, updateScrollState);
          onCleanup(stopObservingResize);
          queueMicrotask(updateScrollState);
        }}
        class="user-message-image-tiles"
        role="group"
        aria-label="Attached images"
        onScroll={updateScrollState}
      >
        <For each={props.imageParts}>
          {(part, index) => {
            const displayName = () => getImageDisplayName(part);
            return (
              <button
                type="button"
                class="user-message-image-tile"
                aria-label={`Open image preview: ${displayName()}`}
                on:click={(event) => {
                  event.stopPropagation();
                  props.onOpenPreview(index());
                }}
              >
                <InlineMessageImage src={part.url} alt={displayName()} allowCover={false} />
              </button>
            );
          }}
        </For>
      </div>
    </div>
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
  if (props.attachment.type === 'problem-reference')
    return <ProblemReferenceChip reference={props.attachment.reference} inline />;
  if (props.attachment.type === 'issues') {
    return (
      <ProblemsTooltip text={props.attachment.text} action="Click to view captured details">
        <button
          type="button"
          class="inline-chip inline-chip-clickable"
          data-copy-marker={PROBLEMS_REFERENCE}
          onClick={() => openAttachment(props.attachment)}
        >
          <ProblemsIcon severity={getProblemsSeverity(props.attachment.text)} />
          <span class="inline-chip-label">Problems</span>
          <span class="inline-chip-detail">{props.attachment.count}</span>
        </button>
      </ProblemsTooltip>
    );
  }
  if (props.attachment.type === 'skill') {
    return (
      <span
        class="inline-chip"
        data-copy-marker={getInlineAttachmentCopyMarker(props.attachment)}
        title={getAttachmentTitle(props.attachment)}
      >
        <MaterialChipIcon kind="skill" class="inline-chip-icon" />
        <span class="inline-chip-label">{getAttachmentLabel(props.attachment)}</span>
      </span>
    );
  }
  const attachment = () => props.attachment;
  const isFolder = () =>
    attachment().type === 'file-reference' &&
    // SAFETY: The surrounding shape or discriminator check establishes the Extract<MessageAttachment, { type: 'file-reference' }> contract used below.
    (attachment() as Extract<MessageAttachment, { type: 'file-reference' }>).isDirectory;
  const terminal = () => {
    const value = attachment();
    return value.type === 'terminal-selection' ? value : null;
  };
  const fileSelection = () =>
    // SAFETY: The surrounding shape or discriminator check establishes the Extract<MessageAttachment, { type: 'file-selection' }> contract used below.
    attachment().type === 'file-selection'
      ? (attachment() as Extract<MessageAttachment, { type: 'file-selection' }>)
      : null;
  const copyMarker = () => getInlineAttachmentCopyMarker(attachment());
  const database = () => {
    const value = attachment();
    return value.type === 'file-reference' ? value.database : undefined;
  };
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
        fallback={
          <Show
            when={database()}
            fallback={
              <Show
                when={terminal()}
                fallback={<FileTypeIcon path={filePath()} class="inline-chip-icon" />}
              >
                <MaterialChipIcon kind="terminal" class="inline-chip-icon" />
              </Show>
            }
          >
            <MaterialChipIcon kind="table" class="inline-chip-icon" />
          </Show>
        }
      >
        <FolderIcon class="inline-chip-icon" width="11" height="11" />
      </Show>
      <span class="inline-chip-label">{getAttachmentLabel(attachment())}</span>
      <Show when={showAttachmentDetails() && database()}>
        {(table) => <span class="inline-chip-detail">{databaseAttachmentDetail(table())}</span>}
      </Show>
      <Show when={fileSelection()}>
        {(selection) => (
          <span class="inline-chip-detail">{formatContextLineRanges(selection().lineRanges)}</span>
        )}
      </Show>
      <Show when={terminal()}>
        {(selection) => (
          <span class="inline-chip-detail">{getTerminalLineCountLabel(selection().text)}</span>
        )}
      </Show>
    </button>
  );
}

function ProblemReferenceChip(props: { reference: InlineProblemAttachment; inline?: boolean }) {
  return (
    <ProblemsTooltip
      text={problemReferenceDetails(props.reference, state.editorContext.workspacePath)}
      action={props.reference.group ? 'Click to view captured details' : 'Open problem in editor'}
    >
      <button
        type="button"
        class={
          props.inline
            ? 'inline-chip inline-chip-clickable'
            : 'chat-attachment-chip message-attachment-chip clickable'
        }
        data-copy-marker={problemReferenceMarker(props.reference)}
        onClick={() => openAttachment({ type: 'problem-reference', reference: props.reference })}
      >
        <ProblemsIcon severity={problemReferenceSeverity(props.reference)} />
        <span class={props.inline ? 'inline-chip-label' : 'chip-label'}>
          {problemReferenceLabel(props.reference)}
        </span>
        <span class={props.inline ? 'inline-chip-detail' : 'chip-detail'}>
          {problemReferenceLocation(props.reference)}
        </span>
      </button>
    </ProblemsTooltip>
  );
}

function openAttachment(value: MessageAttachment) {
  if (value.type === 'problem-reference') {
    if (value.reference.group) {
      postMessage({
        type: 'vscode/open-text',
        payload: {
          content: problemReferenceDetails(value.reference, state.editorContext.workspacePath),
          title: `Problems ${value.reference.group.length}`,
          language: 'plaintext',
        },
      });
      return;
    }
    postMessage({
      type: 'vscode/open',
      payload: {
        path: value.reference.diagnostic.path,
        line: value.reference.diagnostic.line,
        kind: 'file',
      },
    });
    return;
  }
  if (value.type === 'issues') {
    postMessage({
      type: 'vscode/open-text',
      payload: { content: value.text, title: `Problems ${value.count}`, language: 'plaintext' },
    });
    return;
  }
  if (value.type === 'extension-context') {
    postMessage({
      type: 'vscode/open-text',
      payload: {
        content: value.context.captured?.text ?? JSON.stringify(value.context.data, null, 2),
        title: value.context.label,
        language: 'plaintext',
      },
    });
    return;
  }
  if (value.type === 'database') {
    postMessage({
      type: 'vscode/open-text',
      payload: {
        content: JSON.stringify(value.context, null, 2),
        title: `${value.context.name} database context`,
        language: 'json',
      },
    });
    return;
  }
  if (value.type === 'skill') return;
  if (value.type === 'editor-text') {
    if (value.text === undefined) return;
    postMessage({
      type: 'vscode/open-text',
      payload: {
        content: value.text,
        title: `${getLeafPathName(value.filename)} ${value.kind === 'selection' ? 'unsaved selection' : 'unsaved buffer'}`,
        language: value.language,
      },
    });
    return;
  }

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
  if (props.attachment.type === 'problem-reference')
    return <ProblemReferenceChip reference={props.attachment.reference} />;
  if (props.attachment.type === 'issues') {
    return (
      <ProblemsTooltip text={props.attachment.text} action="Click to view captured details">
        <button
          class="chat-attachment-chip message-attachment-chip message-attachment-chip-clickable clickable"
          data-copy-marker={getStandaloneAttachmentCopyText(props.attachment)}
          onClick={() => openAttachment(props.attachment)}
        >
          <ProblemsIcon severity={getProblemsSeverity(props.attachment.text)} />
          <AttachmentLabel label="Problems" />
          <span class="chip-detail">{props.attachment.count}</span>
        </button>
      </ProblemsTooltip>
    );
  }
  const attachment = () => props.attachment;
  const isFolder = () =>
    attachment().type === 'file-reference' &&
    // SAFETY: The surrounding shape or discriminator check establishes the Extract<MessageAttachment, { type: 'file-reference' }> contract used below.
    (attachment() as Extract<MessageAttachment, { type: 'file-reference' }>).isDirectory;
  const isTerminal = () => attachment().type === 'terminal-selection';
  const isOpenable = () => {
    const value = attachment();
    if (value.type === 'skill') return false;
    if (value.type === 'terminal-selection') return Boolean(value.text);
    if (value.type === 'editor-text') return value.text !== undefined;
    return true;
  };

  const handleClick = () => openAttachment(attachment());

  const iconSvg = () => {
    const value = attachment();
    if (value.type === 'extension-context' && value.context.captured?.icon === 'table')
      return <MaterialChipIcon kind="table" class="chip-icon" />;
    if (value.type === 'extension-context' && value.context.captured?.icon === 'terminal')
      return <MaterialChipIcon kind="terminal" class="chip-icon" />;
    if (value.type === 'file-reference' && value.database)
      return <MaterialChipIcon kind="table" class="chip-icon" />;
    if (attachment().type === 'database')
      return <MaterialChipIcon kind="table" class="chip-icon" />;
    if (attachment().type === 'skill') return <MaterialChipIcon kind="skill" class="chip-icon" />;
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
    if (
      !showAttachmentDetails() &&
      (value.type === 'extension-context' ||
        value.type === 'database' ||
        (value.type === 'file-reference' && value.database))
    )
      return null;
    if (value.type === 'extension-context')
      return <span class="chip-detail">{value.context.captured?.detail}</span>;
    if (value.type === 'file-reference' && value.database)
      return <span class="chip-detail">{databaseAttachmentDetail(value.database)}</span>;
    if (value.type === 'database')
      return <span class="chip-detail">{databaseContextDetail(value.context)}</span>;
    if (value.type === 'file-selection') {
      return <span class="chip-detail">{formatContextLineRanges(value.lineRanges)}</span>;
    }
    if (value.type === 'editor-text') {
      const range = formatContextLineRanges([value.lineRange]);
      return <span class="chip-detail">{value.truncated ? `${range}; truncated` : range}</span>;
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

    const gap = 5;
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
            <span
              class={`message-attachment-measure-item${attachment.type === 'agent' ? ' agent-attachment-chip' : ''}`}
            >
              <Show
                when={attachment.type === 'agent'}
                fallback={
                  <Show
                    when={
                      attachment.type === 'message' &&
                      (attachment.attachment.type === 'database' ||
                        (attachment.attachment.type === 'file-reference' &&
                          !!attachment.attachment.database))
                    }
                    fallback={<FileTypeIcon path={getDisplayMessageAttachmentPath(attachment)} />}
                  >
                    <MaterialChipIcon kind="table" class="chip-icon" />
                  </Show>
                }
              >
                <MaterialChipIcon kind="agent" class="chip-icon" />
              </Show>
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
  if (props.attachment.type === 'message') {
    return <MessageAttachmentChip attachment={props.attachment.attachment} />;
  }
  if (props.attachment.type === 'agent') {
    return <AgentChip part={props.attachment.part} />;
  }
  return <MessageFileAttachment part={props.attachment.part} />;
}

function getDisplayMessageAttachmentLabel(attachment: DisplayMessageAttachment): string {
  if (attachment.type === 'message') return getAttachmentLabel(attachment.attachment);
  if (attachment.type === 'agent') return formatAgentLabel(attachment.part.name);
  return getMessageFileAttachmentLabel(attachment.part);
}

function getDisplayMessageAttachmentDetail(attachment: DisplayMessageAttachment): string | null {
  if (attachment.type !== 'message') return null;
  const value = attachment.attachment;
  if (
    !showAttachmentDetails() &&
    (value.type === 'extension-context' ||
      value.type === 'database' ||
      (value.type === 'file-reference' && value.database))
  )
    return null;
  if (value.type === 'extension-context') return value.context.captured?.detail ?? null;
  if (attachment.attachment.type === 'problem-reference')
    return problemReferenceLocation(attachment.attachment.reference);
  if (attachment.attachment.type === 'issues') return String(attachment.attachment.count);
  if (attachment.attachment.type === 'file-reference' && attachment.attachment.database)
    return databaseAttachmentDetail(attachment.attachment.database);
  if (attachment.attachment.type === 'database')
    return databaseContextDetail(attachment.attachment.context);
  if (attachment.attachment.type === 'file-selection') {
    return formatContextLineRanges(attachment.attachment.lineRanges);
  }
  if (attachment.attachment.type === 'editor-text') {
    const range = formatContextLineRanges([attachment.attachment.lineRange]);
    return attachment.attachment.truncated ? `${range}; truncated` : range;
  }
  if (attachment.attachment.type === 'terminal-selection') {
    return getTerminalLineCountLabel(attachment.attachment.text) ?? 'terminal';
  }
  return null;
}

function getDisplayMessageAttachmentPath(attachment: DisplayMessageAttachment): string | undefined {
  if (attachment.type === 'message') return getMessageAttachmentPath(attachment.attachment);
  if (attachment.type === 'agent') return undefined;
  return attachment.part.source?.path || attachment.part.filename;
}

function getInlineFileMarker(part: FilePart): string | null {
  if (part.mime.startsWith('image/')) return null;
  return part.filename ? `@${part.filename}` : null;
}

function MessageFileAttachment(props: { part: FilePart; inline?: boolean; marker?: string }) {
  const label = () => getMessageFileAttachmentLabel(props.part);
  const path = () => props.part.source?.path || props.part.filename;
  const text = () => readPastedTextDataUrl(props.part.url);

  return (
    <span
      class={
        props.inline
          ? 'inline-chip inline-chip-clickable'
          : 'chat-attachment-chip message-attachment-chip'
      }
      data-copy-marker={props.marker}
      title={label()}
      role={text() !== null ? 'button' : undefined}
      tabIndex={text() !== null ? 0 : undefined}
      on:click={(event) => {
        event.stopPropagation();
        const content = text();
        if (content !== null)
          postMessage({
            type: 'vscode/open-text',
            payload: { content, title: label(), language: 'plaintext' },
          });
      }}
      onKeyDown={(event) => {
        if (text() !== null && (event.key === 'Enter' || event.key === ' ')) {
          event.preventDefault();
          event.currentTarget.click();
        }
      }}
    >
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
    case 'extension-context':
      return attachment.context.label;
    case 'problem-reference':
      return problemReferenceLabel(attachment.reference);
    case 'issues':
      return 'Problems';
    case 'database':
      return attachment.context.name;
    case 'skill':
      return attachment.name;
    case 'file-selection':
      return getLeafPathName(attachment.filename);
    case 'editor-text':
      return getLeafPathName(attachment.filename);
    case 'terminal-selection':
      return attachment.terminalName;
    case 'file-reference':
      return attachment.database?.name ?? getLeafPathName(attachment.path);
  }
}

function getMessageAttachmentPath(attachment: MessageAttachment): string | undefined {
  if (attachment.type === 'problem-reference')
    return attachment.reference.group ? undefined : attachment.reference.diagnostic.path;
  if (attachment.type === 'file-selection') return attachment.filename;
  if (attachment.type === 'editor-text') return attachment.filename;
  if (attachment.type === 'file-reference') return attachment.path;
  return undefined;
}

function getAttachmentTitle(attachment: MessageAttachment): string {
  switch (attachment.type) {
    case 'extension-context':
      return `${attachment.context.label}${attachment.context.captured?.detail ? ` · ${attachment.context.captured.detail}` : ''}`;
    case 'problem-reference':
      return attachment.reference.group
        ? `Problems ${attachment.reference.group.length}`
        : `${attachment.reference.diagnostic.path}:${attachment.reference.diagnostic.line}: ${attachment.reference.diagnostic.message}`;
    case 'issues':
      return `Problems ${attachment.count}: click to view details`;
    case 'database':
      return `${attachment.context.name} · ${databaseContextDetail(attachment.context)}`;
    case 'skill':
      return `Skill: ${attachment.name}`;
    case 'file-selection':
      return `${attachment.filename}:${attachment.lineRanges.map((range) => `${range.startLine}-${range.endLine}`).join(',')}`;
    case 'editor-text':
      return `${attachment.filename}:${attachment.lineRange.startLine}-${attachment.lineRange.endLine}${attachment.truncated ? ' (truncated)' : ''}`;
    case 'terminal-selection':
      return `Terminal: ${attachment.terminalName}`;
    case 'file-reference':
      return attachment.database
        ? `${attachment.database.name} · ${attachment.database.dataSource ?? ''} · ${databaseAttachmentDetail(attachment.database)}`
        : attachment.path;
  }
}

function getInlineAttachmentCopyMarker(attachment: MessageAttachment): string {
  return getAttachmentTextMarker(attachment) ?? getStandaloneAttachmentCopyText(attachment);
}

function getStandaloneAttachmentCopyText(attachment: MessageAttachment): string {
  switch (attachment.type) {
    case 'extension-context':
      return formatExtensionContext(attachment.context);
    case 'problem-reference':
      return problemReferenceMarker(attachment.reference);
    case 'issues':
      return `[Problems ${attachment.count}]`;
    case 'database':
      return formatDatabaseContext(attachment.context);
    case 'skill':
      return formatSkillReference(attachment.name);
    case 'file-selection':
      return formatSelectionReference(attachment.filename, attachment.lineRanges);
    case 'editor-text': {
      const source = attachment.kind === 'selection' ? 'Unsaved selection' : 'Unsaved buffer';
      const truncation = attachment.truncated ? '; truncated' : '';
      return `[${source} from ${attachment.filename} lines ${attachment.lineRange.startLine}-${attachment.lineRange.endLine}${truncation}]`;
    }
    case 'terminal-selection':
      return `[Selection from terminal ${attachment.terminalName}]`;
    case 'file-reference':
      return attachment.database
        ? formatDatabaseAttachmentReference(attachment.path, attachment.database)
        : attachment.path;
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
    // SAFETY: The surrounding shape or discriminator check establishes the Text contract used below.
    return extractSelectedTextNode(node as Text, range);
  }

  if (node.nodeType !== Node.ELEMENT_NODE) return '';

  // SAFETY: The surrounding shape or discriminator check establishes the HTMLElement contract used below.
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
      // SAFETY: The surrounding shape or discriminator check establishes the HTMLElement contract used below.
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
  if (isFunction(range.intersectsNode)) {
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
