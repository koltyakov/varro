import { For, Show, createMemo, createResource, createSignal } from 'solid-js';
import { client } from '../lib/client';
import { isAssistantMessage } from '../lib/message-metrics';
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
import { showThinking, state, getChildRunsByParentId } from '../lib/state';
import { getLeafPathName } from '../lib/path-display';
import { postMessage } from '../lib/bridge';
import { getToolFileChange, getToolReadPath } from '../lib/tool-file-change';
import { collapseLeadingDuplicateFileEvents } from '../lib/message-event-collapse';

export type AssistantFileEditStackGroup = 'start' | 'middle' | 'end';

export function Message(props: {
  info: MessageType;
  parts: Part[];
  isLastAssistant?: boolean;
  previousTrailingFileEventSignature?: string | null;
  fileEditStackGroup?: AssistantFileEditStackGroup | null;
}) {
  const isUser = () => props.info.role === 'user';
  const assistant = () => (isAssistantMessage(props.info) ? props.info : null);
  const isSubagent = () => assistant()?.mode === 'subagent';
  const normalizedParts = createMemo(() =>
    assistant()
      ? collapseLeadingDuplicateFileEvents(
          props.parts,
          props.previousTrailingFileEventSignature ?? null
        )
      : props.parts
  );
  const visibleAssistantParts = createMemo(() =>
    assistant() ? normalizedParts().filter(shouldShowAssistantPartInline) : normalizedParts()
  );
  const layoutAssistantParts = createMemo(() =>
    assistant() ? deduplicateFileEdits(visibleAssistantParts()) : []
  );

  const [diffs] = createResource(
    () => {
      const info = assistant();
      if (!info?.time.completed) return null;
      if (!props.isLastAssistant) return null;
      return info.sessionID;
    },
    async (sessionID) => {
      return client.session.diff(sessionID).catch(() => [] as FileDiff[]);
    }
  );
  const compactionDivider = createMemo<CompactionPart | null>(() => {
    const parts = normalizedParts();
    const compactions = parts.filter((p): p is CompactionPart => p.type === 'compaction');
    if (compactions.length === 0) return null;
    const hasOtherVisibleContent = parts.some((p) => {
      if (p.type === 'compaction') return false;
      if (p.type === 'text') return p.text.trim().length > 0;
      if (p.type === 'file') return true;
      return false;
    });
    return hasOtherVisibleContent ? null : compactions[compactions.length - 1];
  });
  const shouldRender = () =>
    !!compactionDivider() ||
    isUser() ||
    visibleAssistantParts().length > 0 ||
    !!assistant()?.error?.data?.message ||
    (diffs() || []).length > 0;
  const useBareAssistantContainer = () => {
    if (isUser()) return false;
    if (assistant()?.error?.data?.message) return false;
    if ((diffs() || []).length > 0) return false;
    if (props.fileEditStackGroup) return false;
    const parts = layoutAssistantParts();
    if (parts.length === 0) return false;
    if (parts.every(isFileReadPart)) return false;
    return parts.length === 1 && parts[0]?.type === 'tool' && !isFileEditPart(parts[0]);
  };

  return (
    <Show when={shouldRender()}>
      <Show
        when={!compactionDivider()}
        fallback={<CompactionDivider part={compactionDivider()!} />}
      >
      <div class={`chat-turn ${isUser() ? 'chat-turn-user' : 'chat-turn-assistant'}`}>
        <div
          class={`value chat-turn-content ${
            isUser()
              ? 'chat-turn-card user-message-card'
              : `assistant-turn-content${useBareAssistantContainer() ? ' assistant-turn-content-bare' : ''}`
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
            <AssistantMessageContent info={assistant()!} parts={visibleAssistantParts()} />
          </Show>
          <Show when={assistant() && assistant()!.error?.data?.message}>
            <div class="interactive-response-error-details">
              <svg class="error-icon" viewBox="0 0 16 16" fill="currentColor">
                <path d="M8 1a7 7 0 100 14A7 7 0 008 1zm-.5 3h1v5h-1V4zm.5 8a.75.75 0 110-1.5.75.75 0 010 1.5z" />
              </svg>
              <div class="rendered-markdown">
                <p class="error-message-text">{assistant()!.error?.data?.message || 'error'}</p>
              </div>
            </div>
          </Show>
          <Show when={assistant() && (diffs() || []).length > 0}>
            <DiffSummary diffs={diffs()!} />
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
  | { type: 'file-selection'; filename: string; startLine: number; endLine: number }
  | { type: 'terminal-selection'; terminalName: string }
  | { type: 'file-reference'; path: string; isDirectory: boolean };

function UserMessageContent(props: { parts: Part[] }) {
  const parsed = createMemo(() => {
    const messageTexts: string[] = [];
    const attachments: MessageAttachment[] = [];
    const imageParts: FilePart[] = [];

    for (const part of props.parts) {
      if (part.type === 'file') {
        imageParts.push(part as FilePart);
        continue;
      }

      if (part.type !== 'text') continue;
      const text = (part as TextPart).text;
      if (!text) continue;

      if (text.startsWith('[Working directory:')) continue;

      if (text.startsWith('[Selection from ') && !text.startsWith('[Selection from terminal')) {
        const match = text.match(/^\[Selection from (.+?) lines (\d+)-(\d+)\]/);
        if (match) {
          attachments.push({
            type: 'file-selection',
            filename: match[1],
            startLine: parseInt(match[2]),
            endLine: parseInt(match[3]),
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

    return { messageTexts, attachments, imageParts };
  });

  const hasContent = () =>
    parsed().messageTexts.length > 0 ||
    parsed().imageParts.length > 0 ||
    parsed().attachments.length > 0;

  return (
    <div class="rendered-markdown">
      <For each={parsed().messageTexts}>{(text) => <p class="user-message-text">{text}</p>}</For>
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
      <For each={parsed().imageParts}>{(part) => <MessagePart part={part} />}</For>
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
    const wp = state.editorContext.workspacePath;
    if (!wp) return;
    const relativePath = a.type === 'file-reference' ? a.path : a.filename;
    const absolutePath = `${wp}/${relativePath}`;
    const line = a.type === 'file-selection' ? a.startLine : undefined;
    postMessage({ type: 'vscode/open', payload: { path: absolutePath, line } });
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
      return (
        <span class="chip-detail">
          L{a.startLine}-{a.endLine}
        </span>
      );
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
      return `${att.filename}:${att.startLine}-${att.endLine}`;
    case 'terminal-selection':
      return `Terminal: ${att.terminalName}`;
    case 'file-reference':
      return att.path;
  }
}

function isFileEditPart(part: Part): boolean {
  if (part.type !== 'tool') return false;
  return getToolFileChange((part as ToolPart).tool, (part as ToolPart).state) !== null;
}

function isFileReadPart(part: Part): boolean {
  if (part.type !== 'tool') return false;
  return getToolReadPath((part as ToolPart).tool, (part as ToolPart).state) !== null;
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

function AssistantMessageContent(props: { info: AssistantMessage; parts: Part[] }) {
  const childRunsMap = createMemo(() => getChildRunsByParentId(state.messages));
  const childRuns = createMemo(() => childRunsMap().get(props.info.id) || []);

  const dedupedParts = createMemo(() => deduplicateFileEdits(props.parts));
  const renderItems = createMemo(() => {
    const items: Array<
      | { kind: 'part'; part: Part; matchedRun?: AssistantMessage }
      | { kind: 'file-edit-stack'; parts: ToolPart[] }
    > = [];
    const parts = dedupedParts();
    let subtaskRank = 0;

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

      if (part.type === 'subtask') {
        items.push({
          kind: 'part',
          part,
          matchedRun: childRuns()[subtaskRank++]?.info,
        });
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
            <div class="assistant-file-edit-stack">
              <For each={item.parts}>
                {(part) => <MessagePart part={part} messageInfo={props.info} />}
              </For>
            </div>
          ) : (
            <MessagePart part={item.part} messageInfo={props.info} subtaskRun={item.matchedRun} />
          )
        }
      </For>
    </div>
  );
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
      <button onClick={() => setExpanded((v) => !v)} class="diff-summary-btn" aria-expanded={expanded()}>
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

function shouldShowAssistantPartInline(part: Part) {
  if (part.type === 'tool') return !isTodoToolPart(part);

  switch (part.type) {
    case 'text':
      return part.text.trim().length > 0;
    case 'reasoning':
      return showThinking();
    case 'agent':
    case 'retry':
    case 'compaction':
    case 'subtask':
    case 'file':
      return true;
    default:
      return false;
  }
}

function isTodoToolPart(part: Extract<Part, { type: 'tool' }>) {
  const toolName = part.tool.trim().toLowerCase();
  if (
    toolName.includes('todo') ||
    toolName === 'update_plan' ||
    toolName === 'updateplan' ||
    toolName === 'todowrite'
  ) {
    return true;
  }

  const title =
    (part.state.status === 'running' || part.state.status === 'completed'
      ? part.state.title
      : undefined) || '';
  const normalizedTitle = title.trim().toLowerCase();
  return (
    normalizedTitle.includes('todo') ||
    normalizedTitle === 'update plan' ||
    normalizedTitle === 'updating plan'
  );
}
