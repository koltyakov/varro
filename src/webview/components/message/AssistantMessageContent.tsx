import { For, Show, createEffect, createMemo, createSignal, onCleanup, onMount } from 'solid-js';
import { isLoading } from '../../lib/state';
import {
  getFinalAssistantTextPartId,
  isFileEditPart,
  shouldShowAssistantPartInHighlightedCard,
} from '../../lib/part-utils';
import { getToolFileChange } from '../../lib/tool-file-change';
import type { AssistantMessage, Part, TextPart, ToolPart } from '../../types';
import { MarkdownRenderer } from '../MarkdownRenderer';
import { MessagePart } from '../MessagePart';

export type AssistantFileEditStackGroup = 'start' | 'middle' | 'end';

type AssistantRenderItem =
  | { kind: 'part'; key: string; part: Part }
  | { kind: 'file-edit-stack'; key: string; parts: ToolPart[] };

type AssistantPartVirtualRange = {
  start: number;
  end: number;
  topPad: number;
  bottomPad: number;
};

const COMPACTION_BOUNDARY_RE =
  /^(?: {0,3}(?:-(?:[ \t]*-){2,}|\*(?:[ \t]*\*){2,}|_(?:[ \t]*_){2,})[ \t]*\r?\n)+|(?:\r?\n(?: {0,3}(?:-(?:[ \t]*-){2,}|\*(?:[ \t]*\*){2,}|_(?:[ \t]*_){2,})[ \t]*))+[ \t]*(?:\r?\n\s*)*$/g;
const ASSISTANT_PART_VIRTUALIZE_THRESHOLD = 40;
const ASSISTANT_PART_DEFAULT_ITEM_HEIGHT = 120;
const ASSISTANT_PART_OVERSCAN = 3;

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
  if (params.visibleDiffCount > 0) return false;
  if (params.fileEditStackGroup) return false;
  if (params.hasError) return 'plain';
  if (!params.highlightFinalAnswer) {
    return 'plain';
  }

  const parts = params.layoutParts;
  if (parts.length === 0) return false;
  const textPartCount = parts.filter((part) => part.type === 'text').length;
  const hasReasoningPart = parts.some((part) => part.type === 'reasoning');

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
      textPartCount > 1 &&
      (params.hasStructuredAssistantParts || params.isSubagent)
    ) {
      return 'plain';
    }
    return false;
  }

  const part = parts[0];
  if (part.type === 'reasoning') return 'bare';
  return part.type === 'tool' && !isFileEditPart(part) ? 'bare' : false;
}

function shouldShowReadModeToggle(text: string): boolean {
  const normalized = text.replace(/\r\n?/g, '\n').trim();
  if (normalized.length === 0) return false;

  const lineCount = normalized.split('\n').length;
  return normalized.length >= 420 || lineCount >= 8;
}

export function deduplicateFileEdits(parts: Part[]): Part[] {
  const result: Part[] = [];
  for (let index = 0; index < parts.length; index += 1) {
    if (!isFileEditPart(parts[index])) {
      result.push(parts[index]);
      continue;
    }
    const currentChange = getToolFileChange(
      (parts[index] as ToolPart).tool,
      (parts[index] as ToolPart).state
    );
    let last = index;
    while (
      last + 1 < parts.length &&
      isFileEditPart(parts[last + 1]) &&
      getToolFileChange((parts[last + 1] as ToolPart).tool, (parts[last + 1] as ToolPart).state)
        ?.dedupeKey === currentChange?.dedupeKey
    ) {
      last += 1;
    }
    result.push(parts[last]);
    index = last;
  }
  return result;
}

function lowerBound(values: number[], target: number) {
  let low = 0;
  let high = values.length - 1;
  while (low < high) {
    const mid = Math.floor((low + high) / 2);
    if (values[mid] < target) low = mid + 1;
    else high = mid;
  }
  return low;
}

function pruneMeasuredAssistantPartHeights(
  measuredHeights: Map<string, number>,
  itemKeys: readonly string[]
) {
  const itemKeySet = new Set(itemKeys);
  let changed = false;
  for (const key of measuredHeights.keys()) {
    if (itemKeySet.has(key)) continue;
    measuredHeights.delete(key);
    changed = true;
  }
  return changed;
}

export function calculateAssistantPartVirtualRange(args: {
  itemKeys: string[];
  measuredHeights: Map<string, number>;
  scrollTop: number;
  viewportHeight: number;
  defaultItemHeight?: number;
  overscan?: number;
}): AssistantPartVirtualRange {
  const itemCount = args.itemKeys.length;
  const defaultItemHeight = args.defaultItemHeight ?? ASSISTANT_PART_DEFAULT_ITEM_HEIGHT;
  const overscan = args.overscan ?? ASSISTANT_PART_OVERSCAN;
  if (itemCount === 0) return { start: 0, end: 0, topPad: 0, bottomPad: 0 };

  const prefix = Array.from<number>({ length: itemCount + 1 });
  prefix[0] = 0;
  for (let index = 0; index < itemCount; index += 1) {
    prefix[index + 1] =
      prefix[index] + (args.measuredHeights.get(args.itemKeys[index]) ?? defaultItemHeight);
  }

  const overscanPx = overscan * defaultItemHeight;
  const startOffset = Math.max(0, args.scrollTop - overscanPx);
  const endOffset = Math.max(startOffset, args.scrollTop + args.viewportHeight + overscanPx);
  const start = Math.max(0, Math.min(itemCount - 1, lowerBound(prefix, startOffset + 1) - 1));
  const end = Math.min(itemCount, Math.max(start + 1, lowerBound(prefix, endOffset + 1)));

  return {
    start,
    end,
    topPad: prefix[start] || 0,
    bottomPad: (prefix[itemCount] || 0) - (prefix[end] || 0),
  };
}

export function AssistantMessageContent(props: {
  info: AssistantMessage;
  parts: Part[];
  errorMessage?: string | null;
  onRetry?: (() => void) | undefined;
  highlightFinalAnswer?: boolean;
  highlightPlanningAnswer?: boolean;
  suppressHighlightedCardMetaParts?: boolean;
  textForPart: (part: Part) => string | null;
}) {
  let flowRef: HTMLDivElement | undefined;
  let scrollContainerRef: HTMLDivElement | null = null;
  let viewportRafId = 0;
  let measurementRafId = 0;
  const dedupedParts = createMemo(() => deduplicateFileEdits(props.parts));
  const measuredItemHeights = new Map<string, number>();
  const [hasScrollContainer, setHasScrollContainer] = createSignal(false);
  const [viewportTop, setViewportTop] = createSignal(0);
  const [viewportHeight, setViewportHeight] = createSignal(0);
  const [measurementVersion, setMeasurementVersion] = createSignal(0);
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

  const renderItems = createMemo(() => {
    const items: AssistantRenderItem[] = [];
    const parts = displayParts();

    for (let index = 0; index < parts.length; index += 1) {
      const part = parts[index];

      if (isFileEditPart(part)) {
        const fileEditParts: ToolPart[] = [part as ToolPart];
        while (index + 1 < parts.length && isFileEditPart(parts[index + 1])) {
          fileEditParts.push(parts[++index] as ToolPart);
        }
        items.push({
          kind: 'file-edit-stack',
          key: `file-edit-stack:${fileEditParts[0].id}:${fileEditParts[fileEditParts.length - 1].id}`,
          parts: fileEditParts,
        });
        continue;
      }

      items.push({ kind: 'part', key: `part:${part.id}`, part });
    }

    return items;
  });

  const shouldVirtualizeParts = createMemo(
    () =>
      hasScrollContainer() &&
      !readModeOpen() &&
      renderItems().length >= ASSISTANT_PART_VIRTUALIZE_THRESHOLD
  );
  const renderItemKeys = createMemo(() => renderItems().map((item) => item.key));

  function measureVisibleItems() {
    if (!shouldVirtualizeParts() || !flowRef) return;
    let changed = false;
    const items = flowRef.querySelectorAll<HTMLElement>('[data-assistant-render-key]');
    for (const item of items) {
      const key = item.dataset.assistantRenderKey;
      if (!key) continue;
      const height = item.getBoundingClientRect().height;
      if (height > 0 && (measuredItemHeights.get(key) ?? 0) !== height) {
        measuredItemHeights.set(key, height);
        changed = true;
      }
    }
    if (changed) {
      setMeasurementVersion((version) => version + 1);
    }
  }

  function cancelScheduledMeasurements() {
    if (viewportRafId) {
      cancelAnimationFrame(viewportRafId);
      viewportRafId = 0;
    }
    if (measurementRafId) {
      cancelAnimationFrame(measurementRafId);
      measurementRafId = 0;
    }
  }

  function sampleViewport() {
    viewportRafId = 0;
    if (!flowRef || !scrollContainerRef) return;
    const containerRect = scrollContainerRef.getBoundingClientRect();
    const flowRect = flowRef.getBoundingClientRect();
    setViewportTop(Math.max(0, containerRect.top - flowRect.top));
    setViewportHeight(scrollContainerRef.clientHeight || Math.max(0, containerRect.height));
  }

  function scheduleViewportSample() {
    if (viewportRafId) return;
    viewportRafId = requestAnimationFrame(sampleViewport);
  }

  function scheduleVisibleItemMeasurement() {
    if (measurementRafId) return;
    measurementRafId = requestAnimationFrame(() => {
      measurementRafId = 0;
      measureVisibleItems();
    });
  }

  onMount(() => {
    scrollContainerRef = flowRef?.closest('.interactive-list') as HTMLDivElement | null;
    setHasScrollContainer(!!scrollContainerRef);
  });

  createEffect(() => {
    if (!shouldVirtualizeParts() || !scrollContainerRef) {
      cancelScheduledMeasurements();
      return;
    }

    const handleScroll = () => {
      scheduleViewportSample();
    };

    scrollContainerRef.addEventListener('scroll', handleScroll);
    const viewportObserver =
      typeof ResizeObserver === 'undefined'
        ? null
        : new ResizeObserver(() => {
            scheduleViewportSample();
            scheduleVisibleItemMeasurement();
          });
    viewportObserver?.observe(scrollContainerRef);
    if (flowRef) viewportObserver?.observe(flowRef);

    queueMicrotask(() => {
      if (!shouldVirtualizeParts()) return;
      sampleViewport();
      scheduleVisibleItemMeasurement();
    });

    onCleanup(() => {
      scrollContainerRef?.removeEventListener('scroll', handleScroll);
      viewportObserver?.disconnect();
      cancelScheduledMeasurements();
    });
  });

  createEffect(() => {
    if (pruneMeasuredAssistantPartHeights(measuredItemHeights, renderItemKeys())) {
      setMeasurementVersion((version) => version + 1);
    }
  });

  const partVirtualRange = createMemo<AssistantPartVirtualRange>(() => {
    const items = renderItems();
    if (!shouldVirtualizeParts() || items.length === 0) {
      return { start: 0, end: items.length, topPad: 0, bottomPad: 0 };
    }

    measurementVersion();
    return calculateAssistantPartVirtualRange({
      itemKeys: renderItemKeys(),
      measuredHeights: measuredItemHeights,
      scrollTop: viewportTop(),
      viewportHeight: viewportHeight(),
    });
  });
  const visibleRenderItems = createMemo(() => {
    const items = renderItems();
    if (!shouldVirtualizeParts()) return items;
    return items.slice(partVirtualRange().start, partVirtualRange().end);
  });

  createEffect(() => {
    if (!shouldVirtualizeParts()) return;
    partVirtualRange();
    queueMicrotask(() => {
      if (!shouldVirtualizeParts()) return;
      scheduleVisibleItemMeasurement();
    });
  });

  const renderAssistantItem = (item: AssistantRenderItem) =>
    item.kind === 'file-edit-stack' ? (
      <div class="assistant-message-flow-item" data-assistant-render-key={item.key}>
        <div class="assistant-file-edit-stack">
          <For each={item.parts}>
            {(part) => (
              <MessagePart
                part={part}
                messageInfo={props.info}
                streamedText={props.textForPart(part)}
              />
            )}
          </For>
        </div>
      </div>
    ) : (
      <div
        data-assistant-render-key={item.key}
        class={getAssistantFlowItemClass(
          item.part,
          finalTextPartId(),
          !!props.highlightPlanningAnswer
        )}
      >
        <Show
          when={
            item.part.type === 'text' && item.part.id === finalTextPartId() && showReadModeToggle()
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
        />
      </div>
    );

  return (
    <div
      ref={(element) => {
        flowRef = element;
      }}
      class="assistant-message-flow"
    >
      <Show when={shouldVirtualizeParts() && partVirtualRange().topPad > 0}>
        <div style={{ height: `${partVirtualRange().topPad}px` }} />
      </Show>
      <For each={visibleRenderItems()}>{renderAssistantItem}</For>
      <Show when={shouldVirtualizeParts() && partVirtualRange().bottomPad > 0}>
        <div style={{ height: `${partVirtualRange().bottomPad}px` }} />
      </Show>
      <Show when={props.errorMessage}>
        <div class="assistant-message-flow-item assistant-message-flow-item-error rendered-markdown">
          <p>{props.errorMessage!}</p>
          <Show when={props.onRetry}>
            <div class="assistant-message-flow-item-error-actions">
              <button
                type="button"
                class="assistant-dialog-summary-action assistant-dialog-summary-action-implement assistant-message-flow-item-error-action"
                disabled={isLoading()}
                onClick={() => props.onRetry?.()}
              >
                Retry
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
