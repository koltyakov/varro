import { For, Show, createMemo, createResource, createSignal } from 'solid-js';
import { state } from '../lib/state';
import { client } from '../lib/client';
import { isAssistantMessage } from '../lib/message-metrics';
import type { AssistantMessage, FileDiff, Message as MessageType, Part } from '../types';
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
    <article
      class={props.isFirstInGroup !== false ? (isUser() ? 'mt-4 first:mt-0' : 'mt-1') : 'mt-0.5'}
    >
      <Show when={props.isFirstInGroup !== false}>
        <div
          class={`mb-0.5 text-[11px] font-medium ${isUser() ? 'text-vscode-fg' : 'text-vscode-muted'}`}
        >
          {isUser() ? 'You' : roleLabel(props.info)}
        </div>
      </Show>
      <Show when={isUser()}>
        <UserMessageContent parts={props.parts} />
      </Show>
      <Show when={!isUser() && assistant()}>
        <AssistantMessageContent info={assistant()!} parts={props.parts} />
      </Show>
      <Show when={assistant() && assistant()!.error?.data?.message}>
        <div class="mt-1 rounded border border-vscode-error/25 bg-vscode-error/5 px-3 py-2 text-[12px] text-vscode-error">
          {assistant()!.error?.data?.message || 'error'}
        </div>
      </Show>
      <Show when={assistant() && (diffs() || []).length > 0}>
        <DiffSummary diffs={diffs()!} />
      </Show>
    </article>
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
    <div class="rounded-lg bg-vscode-hover/50 px-3 py-2 text-[13px] leading-[1.5] text-vscode-fg">
      <For each={visibleParts()}>
        {(part) => {
          if (part.type === 'text') {
            return <div class="whitespace-pre-wrap wrap-break-word">{(part as TextPart).text}</div>;
          }
          return <MessagePart part={part} />;
        }}
      </For>
      <Show when={visibleParts().length === 0}>
        <span class="text-vscode-muted italic">(no content)</span>
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
    <div class="space-y-1.5 text-[13px] leading-[1.5] text-vscode-fg">
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
    <div class="mt-1">
      <button
        onClick={() => setExpanded((v) => !v)}
        class="flex items-center gap-1 text-[11px] text-vscode-muted/40 transition-colors hover:text-vscode-muted"
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
          <span class="text-vscode-success">+{summary().add}</span>{' '}
          <span class="text-vscode-error">-{summary().del}</span>
        </span>
      </button>
      <Show when={expanded()}>
        <div class="mt-1 animate-fade-in">
          <DiffView diffs={props.diffs} />
        </div>
      </Show>
    </div>
  );
}
