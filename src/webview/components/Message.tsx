import { For, Show, createMemo, createResource, createSignal } from 'solid-js';
import { client } from '../lib/client';
import { isAssistantMessage } from '../lib/message-metrics';
import type {
  AssistantMessage,
  FileDiff,
  FilePart,
  Message as MessageType,
  Part,
  TextPart,
  ToolPart,
} from '../types';
import { DiffView } from './DiffView';
import { MessagePart } from './MessagePart';
import { state } from '../lib/state';
import { getLeafPathName } from '../lib/path-display';
import { postMessage } from '../lib/bridge';

export function Message(props: { info: MessageType; parts: Part[]; isLastAssistant?: boolean }) {
  const isUser = () => props.info.role === 'user';
  const assistant = () => (isAssistantMessage(props.info) ? props.info : null);
  const isSubagent = () => assistant()?.mode === 'subagent';
  const visibleAssistantParts = createMemo(() =>
    assistant() ? props.parts.filter(shouldShowAssistantPartInline) : props.parts
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
  const shouldRender = () =>
    isUser() ||
    visibleAssistantParts().length > 0 ||
    !!assistant()?.error?.data?.message ||
    (diffs() || []).length > 0;

  return (
    <Show when={shouldRender()}>
      <div class={`chat-turn ${isUser() ? 'chat-turn-user' : 'chat-turn-assistant'}`}>
        <div
          class={`value chat-turn-content ${
            isUser() ? 'chat-turn-card user-message-card' : 'assistant-turn-content'
          } ${isSubagent() ? 'chat-turn-subagent' : ''}`}
        >
          <Show when={isUser()}>
            <UserMessageContent parts={props.parts} />
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

function getToolFilePath(part: Part): string | null {
  if (part.type !== 'tool') return null;
  const input = ((part as ToolPart).state.input || {}) as Record<string, unknown>;
  for (const key of ['file_path', 'filePath', 'path', 'filename']) {
    if (typeof input[key] === 'string' && (input[key] as string).length > 0) {
      return input[key] as string;
    }
  }
  return null;
}

function isFileEditPart(part: Part): boolean {
  if (part.type !== 'tool') return false;
  const name = (part as ToolPart).tool.toLowerCase();
  return (
    [
      'edit',
      'write',
      'create',
      'file_edit',
      'file_write',
      'file_create',
      'update_file',
      'replace',
      'insert',
      'apply_edit',
      'apply_diff',
    ].includes(name) && getToolFilePath(part) !== null
  );
}

function deduplicateFileEdits(parts: Part[]): Part[] {
  const result: Part[] = [];
  for (let i = 0; i < parts.length; i++) {
    if (!isFileEditPart(parts[i])) {
      result.push(parts[i]);
      continue;
    }
    const path = getToolFilePath(parts[i]);
    let last = i;
    while (
      last + 1 < parts.length &&
      isFileEditPart(parts[last + 1]) &&
      getToolFilePath(parts[last + 1]) === path
    ) {
      last++;
    }
    result.push(parts[last]);
    i = last;
  }
  return result;
}

function AssistantMessageContent(props: { info: AssistantMessage; parts: Part[] }) {
  let subtaskIndex = 0;

  const childRuns = createMemo(() =>
    state.messages
      .filter(
        (entry): entry is { info: AssistantMessage; parts: Part[] } =>
          isAssistantMessage(entry.info) &&
          entry.info.parentID === props.info.id &&
          entry.info.mode === 'subagent'
      )
      .sort((a, b) => a.info.time.created - b.info.time.created)
  );

  const dedupedParts = createMemo(() => deduplicateFileEdits(props.parts));

  return (
    <div class="assistant-message-flow">
      <For each={dedupedParts()}>
        {(part) => {
          const matchedRun = part.type === 'subtask' ? childRuns()[subtaskIndex++] : undefined;
          return <MessagePart part={part} messageInfo={props.info} subtaskRun={matchedRun?.info} />;
        }}
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
      <button onClick={() => setExpanded((v) => !v)} class="diff-summary-btn">
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
  return !(part.type === 'tool' && isTodoToolPart(part));
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
