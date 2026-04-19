import { For, Show, createMemo, createResource, createSignal } from 'solid-js';
import { client } from '../lib/client';
import { isAssistantMessage } from '../lib/message-metrics';
import type { AssistantMessage, FileDiff, Message as MessageType, Part, TextPart, ToolPart } from '../types';
import { DiffView } from './DiffView';
import { MessagePart } from './MessagePart';
import { state } from '../lib/state';

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

function UserMessageContent(props: { parts: Part[] }) {
  const visibleParts = () =>
    props.parts.filter(
      (p) =>
        (p.type === 'text' &&
          !(p as TextPart).text?.startsWith('[Working directory:') &&
          !(p as TextPart).text?.startsWith('[Selection from')) ||
        p.type === 'file'
    );
  return (
    <div class="rendered-markdown">
      <For each={visibleParts()}>
        {(part) => {
          if (part.type === 'text') {
            return <p class="user-message-text">{(part as TextPart).text}</p>;
          }
          return <MessagePart part={part} />;
        }}
      </For>
      <Show when={visibleParts().length === 0}>
        <p class="user-message-empty">(no content)</p>
      </Show>
    </div>
  );
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
    ['edit', 'write', 'create', 'file_edit', 'file_write', 'file_create',
     'update_file', 'replace', 'insert', 'apply_edit', 'apply_diff'].includes(name) &&
    getToolFilePath(part) !== null
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
    while (last + 1 < parts.length && isFileEditPart(parts[last + 1]) && getToolFilePath(parts[last + 1]) === path) {
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
          class={`h-3 w-3 transition-transform ${expanded() ? 'rotate-90' : ''}`}
          viewBox="0 0 16 16"
          fill="currentColor"
        >
          <path d="M6 4l4 4-4 4z" />
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
