import { For, Show, createEffect, createMemo, createSignal, onCleanup } from 'solid-js';
import { isLoading, showInlineFileChanges } from '../../lib/state';
import {
  getFinalAssistantTextPartId,
  isFileEditPart,
  shouldShowAssistantPartInHighlightedCard,
} from '../../lib/part-utils';
import {
  getToolFileChangeSignature,
  getToolInlineFileChangesLayoutSignature,
} from '../../lib/tool-file-change';
import type { ToolCallPermissionMatch } from '../../lib/tool-call-matching';
import type { AssistantMessage, Part, QuestionRequest, TextPart, ToolPart } from '../../types';
import { MarkdownRenderer } from '../MarkdownRenderer';
import { MessagePart } from '../MessagePart';

export type AssistantFileEditStackGroup = 'start' | 'middle' | 'end';

type AssistantRenderItem =
  | { kind: 'part'; key: string; part: Part }
  | { kind: 'file-edit-stack'; key: string; parts: ToolPart[] };

// File-edit stacks rekey on every appended edit, so track their reveal by the
// first part id; otherwise appending an edit replays the whole stack animation.
function getRevealTrackingKey(item: AssistantRenderItem) {
  return item.kind === 'file-edit-stack' ? `file-edit-stack:${item.parts[0]!.id}` : item.key;
}

const COMPACTION_BOUNDARY_RE =
  /^(?: {0,3}(?:-(?:[ \t]*-){2,}|\*(?:[ \t]*\*){2,}|_(?:[ \t]*_){2,})[ \t]*\r?\n)+|(?:\r?\n(?: {0,3}(?:-(?:[ \t]*-){2,}|\*(?:[ \t]*\*){2,}|_(?:[ \t]*_){2,})[ \t]*))+[ \t]*(?:\r?\n\s*)*$/g;
const [readModeShiftPressed, setReadModeShiftPressed] = createSignal(false);
let readModeShiftListenerCount = 0;

function handleReadModeShiftKeydown(event: KeyboardEvent) {
  if (event.key === 'Shift') setReadModeShiftPressed(true);
}

function handleReadModeShiftKeyup(event: KeyboardEvent) {
  if (event.key === 'Shift') setReadModeShiftPressed(false);
}

function handleReadModeShiftMousemove(event: MouseEvent) {
  setReadModeShiftPressed(event.shiftKey);
}

function handleReadModeShiftBlur() {
  setReadModeShiftPressed(false);
}

function retainReadModeShiftListener() {
  if (readModeShiftListenerCount === 0) {
    window.addEventListener('keydown', handleReadModeShiftKeydown);
    window.addEventListener('keyup', handleReadModeShiftKeyup);
    window.addEventListener('mousemove', handleReadModeShiftMousemove);
    window.addEventListener('blur', handleReadModeShiftBlur);
  }
  readModeShiftListenerCount += 1;

  return () => {
    readModeShiftListenerCount -= 1;
    if (readModeShiftListenerCount > 0) return;
    window.removeEventListener('keydown', handleReadModeShiftKeydown);
    window.removeEventListener('keyup', handleReadModeShiftKeyup);
    window.removeEventListener('mousemove', handleReadModeShiftMousemove);
    window.removeEventListener('blur', handleReadModeShiftBlur);
    setReadModeShiftPressed(false);
  };
}

export function stripCompactionBoundaryMarkdown(text: string) {
  return text.replace(COMPACTION_BOUNDARY_RE, '').trim();
}

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
  if (params.hasError) return 'plain';

  const parts = params.layoutParts;
  const textPartCount = parts.filter((part) => part.type === 'text').length;
  const hasReasoningPart = parts.some((part) => part.type === 'reasoning');

  if (params.highlightFinalAnswer && textPartCount >= 1) {
    return 'plain';
  }

  if (params.visibleDiffCount > 0) return 'plain';
  if (params.fileEditStackGroup) return false;
  if (!params.highlightFinalAnswer) {
    return 'plain';
  }

  if (parts.length === 0) return false;

  if (params.highlightFinalAnswer && textPartCount === 0) {
    return parts.length === 1 && parts[0]!.type === 'tool' && !isFileEditPart(parts[0]!)
      ? 'bare'
      : 'plain';
  }

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
      textPartCount >= 1 &&
      (params.hasStructuredAssistantParts || params.isSubagent)
    ) {
      return 'plain';
    }
    return false;
  }

  const part = parts[0]!;
  if (part.type === 'reasoning') return 'bare';
  return part.type === 'tool' && !isFileEditPart(part) ? 'bare' : false;
}

export function shouldShowReadModeToggle(text: string): boolean {
  let start = 0;
  let end = text.length;
  while (start < end && text[start]!.trim().length === 0) start += 1;
  while (end > start && text[end - 1]!.trim().length === 0) end -= 1;

  if (end <= start) return false;
  if (end - start >= 420) return true;

  let lineCount = 1;
  for (let index = start; index < end; index += 1) {
    const char = text[index];
    if (char === '\r') {
      lineCount += 1;
      if (text[index + 1] === '\n') index += 1;
    } else if (char === '\n') {
      lineCount += 1;
    }

    if (lineCount >= 8) return true;
  }

  return false;
}

export function deduplicateFileEdits(parts: Part[]): Part[] {
  const result: Part[] = [];
  for (let index = 0; index < parts.length; index += 1) {
    if (!isFileEditPart(parts[index]!)) {
      result.push(parts[index]!);
      continue;
    }
    const currentChangeSignature = getToolFileChangeSignature(
      (parts[index]! as ToolPart).tool,
      (parts[index]! as ToolPart).state
    );
    let last = index;
    while (
      last + 1 < parts.length &&
      isFileEditPart(parts[last + 1]!) &&
      getToolFileChangeSignature(
        (parts[last + 1]! as ToolPart).tool,
        (parts[last + 1]! as ToolPart).state
      ) === currentChangeSignature
    ) {
      last += 1;
    }
    result.push(parts[last]!);
    index = last;
  }
  return result;
}

function samePartList(previous: readonly Part[], next: readonly Part[]) {
  return previous.length === next.length && previous.every((part, index) => part === next[index]);
}

export function getFileEditStackRenderKey(
  parts: readonly ToolPart[],
  inlinePreviewEnabled: boolean
) {
  const baseKey = `file-edit-stack:${parts[0]!.id}:${parts[parts.length - 1]!.id}`;
  if (!inlinePreviewEnabled) return baseKey;

  const inlinePreviewSignature = parts
    .map((part) => getToolInlineFileChangesLayoutSignature(part.tool, part.state))
    .filter((signature): signature is string => signature !== null)
    .join('|');
  return inlinePreviewSignature ? `${baseKey}:inline:${inlinePreviewSignature}` : baseKey;
}

export function AssistantMessageContent(props: {
  info: AssistantMessage;
  parts: Part[];
  errorMessage?: string | null;
  errorAction?: { label: string; run: () => void } | undefined;
  onRetry?: (() => void) | undefined;
  highlightFinalAnswer?: boolean;
  highlightPlanningAnswer?: boolean;
  suppressHighlightedCardMetaParts?: boolean;
  isLastAssistant?: boolean;
  nearViewport?: boolean;
  outerListVirtualized?: boolean;
  textForPart: (part: Part) => string | null;
  claimItemReveal?: (messageId: string, renderKey: string) => boolean;
  questionRequestForTool?: (part: ToolPart) => QuestionRequest | null;
  permissionMatchForTool?: (part: ToolPart) => ToolCallPermissionMatch | null;
}) {
  const dedupedParts = createMemo(() => deduplicateFileEdits(props.parts));
  const [readModeOpen, setReadModeOpen] = createSignal(false);
  const displayParts = createMemo(() =>
    props.suppressHighlightedCardMetaParts
      ? dedupedParts().filter((part) => {
          if (part.type === 'text') {
            const effectiveText = props.textForPart(part) ?? part.text;
            return shouldShowAssistantPartInHighlightedCard({ ...part, text: effectiveText });
          }
          return shouldShowAssistantPartInHighlightedCard(part);
        })
      : dedupedParts()
  );
  const finalTextPartId = createMemo(() =>
    getFinalAssistantTextPartId(displayParts(), !!props.highlightFinalAnswer)
  );
  const finalTextPart = createMemo(() => {
    const partId = finalTextPartId();
    if (!partId) return null;
    const part = displayParts().find(
      (candidate): candidate is TextPart => candidate.type === 'text' && candidate.id === partId
    );
    return part || null;
  });
  const finalTextContent = createMemo(() => {
    const part = finalTextPart();
    if (!part) return '';
    return props.textForPart(part) ?? part.text;
  });
  const showReadModeToggle = createMemo(() => shouldShowReadModeToggle(finalTextContent()));

  createEffect(() => {
    onCleanup(retainReadModeShiftListener());
  });

  createEffect(() => {
    if (!readModeOpen()) return;

    const handleKeydown = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return;
      event.preventDefault();
      setReadModeOpen(false);
    };

    window.addEventListener('keydown', handleKeydown);
    document.body.classList.add('chat-read-mode-open');

    onCleanup(() => {
      window.removeEventListener('keydown', handleKeydown);
      document.body.classList.remove('chat-read-mode-open');
    });
  });

  createEffect(() => {
    if (finalTextPart()) return;
    setReadModeOpen(false);
  });

  const renderItems = createMemo<AssistantRenderItem[]>((previousItems) => {
    const previousByKey = new Map((previousItems || []).map((item) => [item.key, item]));
    const items: AssistantRenderItem[] = [];
    const parts = displayParts();

    for (let index = 0; index < parts.length; index += 1) {
      const part = parts[index]!;

      if (isFileEditPart(part)) {
        const fileEditParts: ToolPart[] = [part as ToolPart];
        while (index + 1 < parts.length && isFileEditPart(parts[index + 1]!)) {
          fileEditParts.push(parts[++index]! as ToolPart);
        }
        const key = getFileEditStackRenderKey(fileEditParts, showInlineFileChanges());
        const previous = previousByKey.get(key);
        if (previous?.kind === 'file-edit-stack' && samePartList(previous.parts, fileEditParts)) {
          items.push(previous);
        } else {
          items.push({
            kind: 'file-edit-stack',
            key,
            parts: fileEditParts,
          });
        }
        continue;
      }

      const key = `part:${part.id}`;
      const previous = previousByKey.get(key);
      if (previous?.kind === 'part' && previous.part === part) {
        items.push(previous);
      } else {
        items.push({ kind: 'part', key, part });
      }
    }

    return items;
  }, []);
  const revealedRenderKeys = new Set<string>();

  const isLightweight = createMemo(
    () => props.outerListVirtualized && props.nearViewport === false
  );

  const claimReveal = (trackingKey: string) => {
    if (props.claimItemReveal) return props.claimItemReveal(props.info.id, trackingKey);
    if (revealedRenderKeys.has(trackingKey)) return false;
    revealedRenderKeys.add(trackingKey);
    return true;
  };

  const getRevealClass = (item: AssistantRenderItem) => {
    if (props.info.time.completed !== undefined) return '';
    return claimReveal(getRevealTrackingKey(item)) ? ' assistant-message-flow-item-streamed' : '';
  };

  const renderAssistantItem = (item: AssistantRenderItem) => {
    const revealClass = getRevealClass(item);
    return item.kind === 'file-edit-stack' ? (
      <div class={`assistant-message-flow-item${revealClass}`} data-assistant-render-key={item.key}>
        <div class="assistant-file-edit-stack">
          <For each={item.parts}>
            {(part) => (
              <MessagePart
                part={part}
                messageInfo={props.info}
                streamedText={props.textForPart(part)}
                lightweight={isLightweight()}
                questionRequest={
                  part.type === 'tool'
                    ? props.questionRequestForTool?.(part as ToolPart)
                    : undefined
                }
                permissionMatch={
                  part.type === 'tool'
                    ? props.permissionMatchForTool?.(part as ToolPart)
                    : undefined
                }
              />
            )}
          </For>
        </div>
      </div>
    ) : (
      <div
        data-assistant-render-key={item.key}
        class={`${getAssistantFlowItemClass(
          item.part,
          finalTextPartId(),
          !!props.highlightPlanningAnswer
        )}${revealClass}`}
      >
        <Show
          when={
            item.part.type === 'text' &&
            item.part.id === finalTextPartId() &&
            showReadModeToggle() &&
            readModeShiftPressed()
          }
        >
          <div class="assistant-read-mode-toggle-shell">
            <button
              type="button"
              class="assistant-read-mode-toggle"
              aria-label="Open read mode"
              title="Open read mode"
              onClick={() => setReadModeOpen(true)}
            >
              <ExpandCornersIcon />
            </button>
          </div>
        </Show>
        <MessagePart
          part={item.part}
          messageInfo={props.info}
          streamedText={props.textForPart(item.part)}
          lightweight={isLightweight()}
          questionRequest={
            item.part.type === 'tool'
              ? props.questionRequestForTool?.(item.part as ToolPart)
              : undefined
          }
          permissionMatch={
            item.part.type === 'tool'
              ? props.permissionMatchForTool?.(item.part as ToolPart)
              : undefined
          }
        />
      </div>
    );
  };

  return (
    <div class="assistant-message-flow">
      <For each={renderItems()}>{renderAssistantItem}</For>
      <Show when={props.errorMessage}>
        <div class="assistant-message-flow-item assistant-message-flow-item-error rendered-markdown">
          <p>{props.errorMessage!}</p>
          <Show when={props.errorAction || props.onRetry}>
            <div class="assistant-message-flow-item-error-actions">
              <button
                type="button"
                class="assistant-dialog-summary-action assistant-dialog-summary-action-implement assistant-message-flow-item-error-action"
                disabled={isLoading()}
                onClick={() => (props.errorAction ? props.errorAction.run() : props.onRetry?.())}
              >
                {props.errorAction?.label || 'Retry'}
              </button>
            </div>
          </Show>
        </div>
      </Show>
      <Show when={readModeOpen() && finalTextContent().trim().length > 0}>
        <div
          class="assistant-read-overlay"
          role="dialog"
          aria-modal="true"
          aria-label="Read mode"
          onClick={() => setReadModeOpen(false)}
        >
          <button
            type="button"
            class="assistant-read-mode-close"
            aria-label="Exit read mode"
            title="Exit read mode"
            onClick={(event) => {
              event.stopPropagation();
              setReadModeOpen(false);
            }}
          >
            <CloseIcon />
          </button>
          <div class="assistant-read-overlay-scroll">
            <div class="assistant-read-overlay-inner" onClick={(event) => event.stopPropagation()}>
              <div class="assistant-read-mode-content">
                <MarkdownRenderer
                  content={finalTextContent()}
                  cacheByContent={!!props.info.time.completed}
                />
              </div>
            </div>
          </div>
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
  if (part.type === 'file' && part.mime.startsWith('image/')) {
    return `${className} assistant-message-flow-item-image`;
  }
  if (part.type !== 'text' || part.id !== finalTextPartId) return className;

  return `${className} assistant-message-flow-item-final assistant-message-flow-item-final-readable${highlightPlanningAnswer ? ' assistant-message-flow-item-final-planning' : ''}`;
}

function ExpandCornersIcon() {
  return (
    <svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
      <path d="M9.29 13.29 4 18.59V17a1 1 0 0 0-2 0v4a1 1 0 0 0 .08.38 1 1 0 0 0 .54.54A1 1 0 0 0 3 22H7a1 1 0 0 0 0-2H5.41l5.3-5.29a1 1 0 0 0-1.42-1.42ZM5.41 4H7a1 1 0 0 0 0-2H3a1 1 0 0 0-.38.08 1 1 0 0 0-.54.54A1 1 0 0 0 2 3V7a1 1 0 0 0 2 0V5.41l5.29 5.3a1 1 0 0 0 1.42 0 1 1 0 0 0 0-1.42ZM21 16a1 1 0 0 0-1 1v1.59l-5.29-5.3a1 1 0 0 0-1.42 1.42L18.59 20H17a1 1 0 0 0 0 2h4a1 1 0 0 0 .38-.08 1 1 0 0 0 .54-.54A1 1 0 0 0 22 21V17a1 1 0 0 0-1-1Zm.92-13.38a1 1 0 0 0-.54-.54A1 1 0 0 0 21 2H17a1 1 0 0 0 0 2h1.59l-5.3 5.29a1 1 0 0 0 0 1.42 1 1 0 0 0 1.42 0L20 5.41V7a1 1 0 0 0 2 0V3a1 1 0 0 0-.08-.38Z" />
    </svg>
  );
}

function CloseIcon() {
  return (
    <svg
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      stroke-width="1.7"
      aria-hidden="true"
    >
      <path d="m4 4 8 8" stroke-linecap="round" />
      <path d="m12 4-8 8" stroke-linecap="round" />
    </svg>
  );
}
