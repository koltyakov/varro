import { For, Show, createMemo, createResource, createSignal } from 'solid-js';
import { state } from '../lib/state';
import { client } from '../lib/client';
import { isAssistantMessage } from '../lib/message-metrics';
import type { AssistantMessage, FileDiff, Message as MessageType, Part, TextPart } from '../types';
import { DiffView } from './DiffView';
import { MessagePart } from './MessagePart';

export function Message(props: { info: MessageType; parts: Part[]; isFirstInGroup?: boolean }) {
  const isUser = () => props.info.role === 'user';
  const assistant = () => (isAssistantMessage(props.info) ? props.info : null);

  const [diffs] = createResource(
    () => {
      const info = assistant();
      if (!info?.time.completed) return null;
      return `${info.sessionID}:${info.id}`;
    },
    async (key) => {
      const [sessionID, messageID] = key.split(':');
      return client.session.diff(sessionID, messageID).catch(() => [] as FileDiff[]);
    }
  );

  return (
    <>
      <Show when={props.isFirstInGroup !== false}>
        <div class="header">
          <div class="user">
            <div class="avatar-container">
              <div class="avatar codicon-avatar">
                <Show
                  when={isUser()}
                  fallback={
                    <svg class="codicon" viewBox="0 0 16 16" fill="currentColor" style={{ color: 'var(--color-vscode-avatar-fg)' }}>
                      <path d="M8 1a7 7 0 100 14A7 7 0 008 1zm3.5 8.5a3.5 3.5 0 11-7 0 3.5 3.5 0 017 0zM6.5 6a1 1 0 100-2 1 1 0 000 2zm3 0a1 1 0 100-2 1 1 0 000 2z" />
                    </svg>
                  }
                >
                  <svg class="codicon" viewBox="0 0 16 16" fill="currentColor" style={{ color: 'var(--color-vscode-avatar-fg)' }}>
                    <path d="M8 1a7 7 0 100 14A7 7 0 008 1zm0 1.5a2.5 2.5 0 110 5 2.5 2.5 0 010-5zM4.25 12.5a4.5 4.5 0 017.5 0 5.49 5.49 0 01-3.75 1.5 5.49 5.49 0 01-3.75-1.5z" />
                  </svg>
                </Show>
              </div>
            </div>
            <h3 class="username">{isUser() ? 'You' : roleLabel(props.info)}</h3>
          </div>
        </div>
      </Show>

      <div class="value">
        <Show when={isUser()}>
          <UserMessageContent parts={props.parts} />
        </Show>
        <Show when={!isUser() && assistant()}>
          <AssistantMessageContent info={assistant()!} parts={props.parts} />
        </Show>
        <Show when={assistant() && assistant()!.error?.data?.message}>
          <div class="interactive-response-error-details">
            <svg class="error-icon" viewBox="0 0 16 16" fill="currentColor">
              <path d="M8 1a7 7 0 100 14A7 7 0 008 1zm-.5 3h1v5h-1V4zm.5 8a.75.75 0 110-1.5.75.75 0 010 1.5z" />
            </svg>
            <div class="rendered-markdown">
              <p class="error-message-text">
                {assistant()!.error?.data?.message || 'error'}
              </p>
            </div>
          </div>
        </Show>
        <Show when={assistant() && (diffs() || []).length > 0}>
          <DiffSummary diffs={diffs()!} />
        </Show>
      </div>
    </>
  );
}

function roleLabel(info: MessageType): string {
  if (!isAssistantMessage(info)) return 'Assistant';
  const agent = info.agent || info.mode;
  if (agent && agent !== 'primary') return `${cap(agent)}`;
  return 'Assistant';
}

function cap(s: string): string {
  return s.charAt(0).toUpperCase() + s.slice(1);
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

  return (
    <div>
      <For each={props.parts}>
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
      <button
        onClick={() => setExpanded((v) => !v)}
        class="diff-summary-btn"
      >
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
