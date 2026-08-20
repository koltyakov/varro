import { For, Show, createEffect, createMemo, createSignal, onCleanup, onMount } from 'solid-js';
import { Portal } from 'solid-js/web';
import {
  getAssistantActivityCountItems,
  getAssistantActivityPartKey,
  getAssistantActivityStatus,
  isAssistantActivityPart,
  isAssistantActivityPartRunning,
  shouldCompactAssistantActivityPart,
  type AssistantActivityGroupInfo,
  type AssistantActivityKind,
  type AssistantActivityPart,
} from '../../lib/assistant-activity';
import { isLoading, showInlineFileChanges } from '../../lib/state';
import { prepareMeasuredEntrance } from '../../lib/measured-entrance';
import { trapModalFocus } from '../../lib/modal-focus';
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
import {
  getMessageBlockExpanded,
  setMessageBlockExpanded,
  trackMessageBlockExpansionState,
} from '../../lib/tool-call-expansion-state';
import type { AssistantMessage, Part, QuestionRequest, TextPart, ToolPart } from '../../types';
import { MarkdownRenderer } from '../MarkdownRenderer';
import { MessagePart } from '../MessagePart';
import { PermissionPrompt } from '../PermissionPrompt';

type AssistantRenderItem =
  | { kind: 'part'; key: string; part: Part }
  | { kind: 'file-edit-stack'; key: string; parts: ToolPart[] }
  | { kind: 'active-activity-tray'; key: string; parts: AssistantActivityPart[] }
  | { kind: 'activity-group'; key: string; parts: AssistantActivityPart[] };

type AssistantRenderEntry = {
  key: string;
  item: () => AssistantRenderItem;
  update: (item: AssistantRenderItem) => void;
};

function getActivityGroupRevealTrackingKey(parts: readonly AssistantActivityPart[]) {
  return `activity-group:${parts[0]!.id}`;
}

// File-edit stacks rekey on every appended edit, so track their reveal by the
// first part id; otherwise appending an edit replays the whole stack animation.
function getRevealTrackingKey(item: AssistantRenderItem) {
  if (item.kind === 'file-edit-stack') return `file-edit-stack:${item.parts[0]!.id}`;
  if (item.kind === 'activity-group') return getActivityGroupRevealTrackingKey(item.parts);
  return item.key;
}

const COMPACTION_BOUNDARY_RE =
  /^(?: {0,3}(?:-(?:[ \t]*-){2,}|\*(?:[ \t]*\*){2,}|_(?:[ \t]*_){2,})[ \t]*\r?\n)+|(?:\r?\n(?: {0,3}(?:-(?:[ \t]*-){2,}|\*(?:[ \t]*\*){2,}|_(?:[ \t]*_){2,})[ \t]*))+[ \t]*(?:\r?\n\s*)*$/g;
const [readModeAltPressed, setReadModeAltPressed] = createSignal(false);
let readModeAltListenerCount = 0;

function handleReadModeAltKeydown(event: KeyboardEvent) {
  if (event.key === 'Alt') setReadModeAltPressed(true);
}

function handleReadModeAltKeyup(event: KeyboardEvent) {
  if (event.key === 'Alt') setReadModeAltPressed(false);
}

function handleReadModeAltMousemove(event: MouseEvent) {
  setReadModeAltPressed(event.altKey);
}

function handleReadModeAltBlur() {
  setReadModeAltPressed(false);
}

function retainReadModeAltListener() {
  if (readModeAltListenerCount === 0) {
    window.addEventListener('keydown', handleReadModeAltKeydown);
    window.addEventListener('keyup', handleReadModeAltKeyup);
    window.addEventListener('mousemove', handleReadModeAltMousemove);
    window.addEventListener('blur', handleReadModeAltBlur);
  }
  readModeAltListenerCount += 1;

  return () => {
    readModeAltListenerCount -= 1;
    if (readModeAltListenerCount > 0) return;
    window.removeEventListener('keydown', handleReadModeAltKeydown);
    window.removeEventListener('keyup', handleReadModeAltKeyup);
    window.removeEventListener('mousemove', handleReadModeAltMousemove);
    window.removeEventListener('blur', handleReadModeAltBlur);
    setReadModeAltPressed(false);
  };
}

export function stripCompactionBoundaryMarkdown(text: string) {
  return text.replace(COMPACTION_BOUNDARY_RE, '').trim();
}

export function getAssistantContainerVariant(params: {
  isUser: boolean;
  visibleDiffCount: number;
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
      // SAFETY: The surrounding shape or discriminator check establishes the ToolPart contract used below.
      (parts[index]! as ToolPart).tool,
      // SAFETY: The surrounding shape or discriminator check establishes the ToolPart contract used below.
      (parts[index]! as ToolPart).state
    );
    let last = index;
    while (
      last + 1 < parts.length &&
      isFileEditPart(parts[last + 1]!) &&
      getToolFileChangeSignature(
        // SAFETY: The surrounding shape or discriminator check establishes the ToolPart contract used below.
        (parts[last + 1]! as ToolPart).tool,
        // SAFETY: The surrounding shape or discriminator check establishes the ToolPart contract used below.
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

const MAX_VISIBLE_ACTIVE_ACTIVITY_ITEMS = 3;

function prepareActiveActivityItemsViewport(element: HTMLDivElement) {
  let updateQueued = false;
  let previousItemSignature = '';
  const observedItems = new Set<Element>();

  const update = () => {
    updateQueued = false;
    if (!element.isConnected) return;

    const expandedItem = element.querySelector<HTMLElement>(
      ':scope > .assistant-active-activity-item:has(.tool-invocation-chevron.expanded, .thinking-chevron.expanded)'
    );
    const items = expandedItem
      ? [expandedItem]
      : [
          ...element.querySelectorAll<HTMLElement>(
            ':scope > .assistant-active-activity-item:not(.is-exiting)'
          ),
        ];
    for (const item of items) {
      if (observedItems.has(item)) continue;
      observedItems.add(item);
      resizeObserver?.observe(item);
    }
    for (const item of observedItems) {
      // SAFETY: The surrounding shape or discriminator check establishes the HTMLElement contract used below.
      if (items.includes(item as HTMLElement)) continue;
      observedItems.delete(item);
      resizeObserver?.unobserve(item);
    }

    if (items.length > MAX_VISIBLE_ACTIVE_ACTIVITY_ITEMS) {
      const firstItem = items[0]!;
      const lastVisibleItem = items[MAX_VISIBLE_ACTIVE_ACTIVITY_ITEMS - 1]!;
      const firstItemContent = firstItem.querySelector<HTMLElement>(
        '.assistant-active-activity-item-content'
      );
      const firstItemPadding = firstItemContent
        ? Number.parseFloat(getComputedStyle(firstItemContent).paddingTop) || 0
        : 0;
      const maxHeight =
        lastVisibleItem.offsetTop +
        lastVisibleItem.offsetHeight -
        firstItem.offsetTop -
        firstItemPadding;
      if (maxHeight > 0) {
        element.style.setProperty('--assistant-active-activity-items-max-height', `${maxHeight}px`);
      }
    } else {
      element.style.removeProperty('--assistant-active-activity-items-max-height');
    }

    const itemSignature = items.map((item) => item.dataset.activityPartId).join('\u0000');
    if (itemSignature === previousItemSignature) return;
    previousItemSignature = itemSignature;
    if (items.length <= 1) {
      element.scrollTop = 0;
    } else {
      element.scrollTop = element.scrollHeight;
    }
    if (globalThis.CSSAnimation !== undefined) {
      const entranceAnimations = items.flatMap((item) =>
        item
          .getAnimations()
          .filter(
            (animation): animation is CSSAnimation =>
              animation instanceof globalThis.CSSAnimation &&
              animation.animationName === 'assistant-active-activity-in'
          )
      );
      if (entranceAnimations.length > 0) {
        void Promise.allSettled(entranceAnimations.map((animation) => animation.finished)).then(
          () => {
            if (element.isConnected && previousItemSignature === itemSignature) {
              element.scrollTop = element.scrollHeight;
            }
          }
        );
      }
    }
  };
  const queueUpdate = () => {
    if (updateQueued) return;
    updateQueued = true;
    queueMicrotask(update);
  };
  const resizeObserver =
    globalThis.ResizeObserver === undefined ? null : new globalThis.ResizeObserver(queueUpdate);
  const mutationObserver = new MutationObserver(queueUpdate);
  mutationObserver.observe(element, {
    attributes: true,
    attributeFilter: ['class'],
    childList: true,
    subtree: true,
  });
  queueUpdate();

  return () => {
    mutationObserver.disconnect();
    resizeObserver?.disconnect();
  };
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
  allowInitialItemReveal?: boolean;
  claimItemReveal?: (messageId: string, renderKey: string) => boolean;
  questionRequestForTool?: (part: ToolPart) => QuestionRequest | null;
  permissionMatchForTool?: (part: ToolPart) => ToolCallPermissionMatch | null;
  compactActivityGroups?: readonly AssistantActivityGroupInfo[] | null;
  retainedActivityPartKeys?: ReadonlySet<string>;
  exitingActivityPartKeys?: ReadonlySet<string>;
  visibleActiveActivityPartKeys?: ReadonlySet<string>;
  groupedActiveActivityPartKeys?: ReadonlySet<string>;
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
  const orderedDisplayParts = createMemo(() => {
    const parts = displayParts();
    const ordered: Part[] = [];

    for (let index = 0; index < parts.length;) {
      const part = parts[index]!;
      if (!isAssistantActivityPart(part)) {
        ordered.push(part);
        index += 1;
        continue;
      }

      let end = index + 1;
      while (end < parts.length && isAssistantActivityPart(parts[end]!)) end += 1;
      const activityParts = parts.slice(index, end);
      const waitingParts = activityParts.filter(
        (candidate): candidate is ToolPart =>
          candidate.type === 'tool' && !!props.permissionMatchForTool?.(candidate)
      );
      if (waitingParts.length === 0) {
        ordered.push(...activityParts);
      } else {
        const waitingIds = new Set(waitingParts.map((candidate) => candidate.id));
        ordered.push(
          ...activityParts.filter((candidate) => !waitingIds.has(candidate.id)),
          ...waitingParts
        );
      }
      index = end;
    }

    return ordered;
  });
  const trailingPermissionMatch = createMemo(() => {
    for (const part of orderedDisplayParts()) {
      if (part.type !== 'tool' || props.questionRequestForTool?.(part)) continue;
      const match = props.permissionMatchForTool?.(part);
      if (match?.isActive && match.isPrimaryOwner) return match;
    }
    return null;
  });
  const isLocallyCompactActivityCandidate = (part: Part): part is AssistantActivityPart =>
    isAssistantActivityPart(part) &&
    shouldCompactAssistantActivityPart(part, {
      keepEditInline: props.info.time.completed === undefined && !props.info.error,
    }) &&
    (part.type !== 'tool' ||
      (!props.questionRequestForTool?.(part) && !props.permissionMatchForTool?.(part)));
  const isLocallyCompactActivityPart = (part: Part): part is AssistantActivityPart =>
    isLocallyCompactActivityCandidate(part) &&
    !isAssistantActivityPartRunning(part) &&
    !props.retainedActivityPartKeys?.has(getAssistantActivityPartKey(part));
  const isActiveActivityTrayPart = (part: Part) => {
    if (!isLocallyCompactActivityCandidate(part)) return false;
    const key = getAssistantActivityPartKey(part);
    return (
      (isAssistantActivityPartRunning(part) &&
        (!props.visibleActiveActivityPartKeys ||
          props.visibleActiveActivityPartKeys.has(getAssistantActivityPartKey(part)))) ||
      !!props.retainedActivityPartKeys?.has(key) ||
      !!props.exitingActivityPartKeys?.has(key)
    );
  };
  const effectiveCompactActivityGroups = createMemo<readonly AssistantActivityGroupInfo[] | null>(
    () => {
      if (props.compactActivityGroups !== undefined) return props.compactActivityGroups;
      if (props.info.mode === 'subagent') return null;

      const groups: AssistantActivityGroupInfo[] = [];
      let activityParts: AssistantActivityPart[] = [];
      const flush = () => {
        const ownerPart = activityParts[0];
        if (!ownerPart) return;
        groups.push({
          key: `activity-segment\u0000${props.info.sessionID}\u0000${props.info.id}\u0000${ownerPart.id}`,
          ownerMessageId: props.info.id,
          ownerPartId: ownerPart.id,
          parts: activityParts,
        });
        activityParts = [];
      };
      for (const part of orderedDisplayParts()) {
        if (isLocallyCompactActivityPart(part)) activityParts.push(part);
        else flush();
      }
      flush();
      return groups.length > 0 ? groups : null;
    }
  );
  const compactActivityGroupByPartKey = createMemo(
    () =>
      new Map<string, AssistantActivityGroupInfo>(
        effectiveCompactActivityGroups()?.flatMap((group) =>
          group.parts.flatMap((part) =>
            isLocallyCompactActivityCandidate(part)
              ? [[getAssistantActivityPartKey(part), group] as const]
              : []
          )
        ) || []
      )
  );
  const getCompactActivitySummaryPartId = (group: AssistantActivityGroupInfo) => {
    if (group.ownerMessageId !== props.info.id) return null;
    return orderedDisplayParts().some((part) => part.id === group.ownerPartId)
      ? group.ownerPartId
      : null;
  };
  const finalTextPartId = createMemo(() =>
    getFinalAssistantTextPartId(displayParts(), !!props.highlightFinalAnswer, props.textForPart)
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
    onCleanup(retainReadModeAltListener());
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
    const parts = orderedDisplayParts();

    for (let index = 0; index < parts.length; index += 1) {
      const part = parts[index]!;

      if (
        isLocallyCompactActivityCandidate(part) &&
        isAssistantActivityPartRunning(part) &&
        props.visibleActiveActivityPartKeys &&
        !props.visibleActiveActivityPartKeys.has(getAssistantActivityPartKey(part)) &&
        !compactActivityGroupByPartKey().has(getAssistantActivityPartKey(part))
      ) {
        continue;
      }

      if (isAssistantActivityPart(part) && isActiveActivityTrayPart(part)) {
        const activityParts: AssistantActivityPart[] = [part];
        while (index + 1 < parts.length) {
          const nextPart = parts[index + 1]!;
          if (!isAssistantActivityPart(nextPart) || !isActiveActivityTrayPart(nextPart)) break;
          activityParts.push(nextPart);
          index += 1;
        }
        const key = `active-activity-tray:${activityParts[0]!.id}`;
        const previous = previousByKey.get(key);
        if (
          previous?.kind === 'active-activity-tray' &&
          samePartList(previous.parts, activityParts)
        ) {
          items.push(previous);
        } else {
          items.push({ kind: 'active-activity-tray', key, parts: activityParts });
        }
        continue;
      }

      const canGroupActivityPart = (candidate: Part) => {
        if (!isAssistantActivityPart(candidate)) return undefined;
        return compactActivityGroupByPartKey().get(getAssistantActivityPartKey(candidate));
      };

      const activityGroup = canGroupActivityPart(part);
      if (activityGroup && isAssistantActivityPart(part)) {
        // SAFETY: The surrounding shape or discriminator check establishes the AssistantActivityPart contract used below.
        const activityParts: AssistantActivityPart[] = [part as AssistantActivityPart];
        while (
          index + 1 < parts.length &&
          !isActiveActivityTrayPart(parts[index + 1]!) &&
          canGroupActivityPart(parts[index + 1]!)?.key === activityGroup.key
        ) {
          // SAFETY: The surrounding shape or discriminator check establishes the AssistantActivityPart contract used below.
          activityParts.push(parts[++index]! as AssistantActivityPart);
        }
        const key = `activity-group:${activityParts[0]!.id}`;
        const previous = previousByKey.get(key);
        if (previous?.kind === 'activity-group' && samePartList(previous.parts, activityParts)) {
          items.push(previous);
        } else {
          items.push({ kind: 'activity-group', key, parts: activityParts });
        }
        continue;
      }

      if (isFileEditPart(part)) {
        // SAFETY: The surrounding shape or discriminator check establishes the ToolPart contract used below.
        const fileEditParts: ToolPart[] = [part as ToolPart];
        while (index + 1 < parts.length && isFileEditPart(parts[index + 1]!)) {
          // SAFETY: The surrounding shape or discriminator check establishes the ToolPart contract used below.
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
  const renderEntries = createMemo<AssistantRenderEntry[]>((previousEntries) => {
    const previousByKey = new Map(
      (previousEntries || []).map((entry) => [entry.key, entry] as const)
    );

    return renderItems().map((item) => {
      const previous = previousByKey.get(item.key);
      if (previous) {
        previous.update(item);
        return previous;
      }

      let currentItem = item;
      const [readItem, setItem] = createSignal(item, { equals: false });
      return {
        key: item.key,
        item: readItem,
        update: (nextItem) => {
          if (nextItem === currentItem) return;
          currentItem = nextItem;
          setItem(nextItem);
        },
      };
    });
  }, []);
  const revealedRenderKeys = new Set<string>();

  if (!props.claimItemReveal && !props.allowInitialItemReveal) {
    for (const item of renderItems()) {
      const trackingKey = getRevealTrackingKey(item);
      revealedRenderKeys.add(trackingKey);
    }
  }

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
    if (props.info.time.completed !== undefined && item.kind !== 'activity-group') return '';
    return claimReveal(getRevealTrackingKey(item)) ? ' assistant-message-flow-item-streamed' : '';
  };

  const renderAssistantItem = (entry: AssistantRenderEntry) => {
    if (entry.item().kind === 'active-activity-tray') {
      const item = () =>
        // SAFETY: The surrounding shape or discriminator check establishes the Extract<AssistantRenderItem, { kind: 'active-activity-tray' }> contract used below.
        entry.item() as Extract<AssistantRenderItem, { kind: 'active-activity-tray' }>;
      const activeSummary = () => {
        for (const part of item().parts) {
          const group = compactActivityGroupByPartKey().get(getAssistantActivityPartKey(part));
          if (group?.ownerMessageId !== props.info.id || group.ownerPartId !== part.id) continue;
          const summaryParts = group.parts.filter(
            (groupPart) =>
              !isAssistantActivityPartRunning(groupPart) &&
              !props.retainedActivityPartKeys?.has(getAssistantActivityPartKey(groupPart))
          );
          return {
            group,
            summaryParts,
          };
        }
        return null;
      };
      const hasExitingPart = () =>
        item().parts.some((part) =>
          props.exitingActivityPartKeys?.has(getAssistantActivityPartKey(part))
        );
      return (
        <div
          class={`assistant-active-activity-tray${hasExitingPart() ? ' is-exiting' : ''}${activeSummary() ? ' has-active-summary' : ''}`}
          data-assistant-render-key={entry.key}
          aria-label="Active tools"
        >
          <Show when={activeSummary()}>
            {(active) => (
              <div class="assistant-active-activity-summary">
                <Show
                  when={active().summaryParts.length > 0}
                  fallback={
                    <div class="assistant-activity-summary assistant-activity-summary-placeholder">
                      <span class="assistant-activity-summary-text">
                        <span class="assistant-activity-summary-main">Exploring</span>
                      </span>
                    </div>
                  }
                >
                  <AssistantActivityGroup
                    info={props.info}
                    parts={item().parts}
                    summaryParts={active().summaryParts}
                    expansionKey={active().group.key}
                    showSummary={true}
                    textForPart={props.textForPart}
                    lightweight={!!isLightweight()}
                    questionRequestForTool={props.questionRequestForTool}
                    permissionMatchForTool={props.permissionMatchForTool}
                    onSummaryShown={() => {
                      const summaryPartKeys = new Set(
                        active().summaryParts.map(getAssistantActivityPartKey)
                      );
                      const localSummaryParts = item().parts.filter((part) =>
                        summaryPartKeys.has(getAssistantActivityPartKey(part))
                      );
                      if (localSummaryParts.length > 0) {
                        claimReveal(getActivityGroupRevealTrackingKey(localSummaryParts));
                      }
                    }}
                  />
                </Show>
              </div>
            )}
          </Show>
          <div
            ref={(element) => onCleanup(prepareActiveActivityItemsViewport(element))}
            class="assistant-active-activity-items"
            data-max-visible-items={MAX_VISIBLE_ACTIVE_ACTIVITY_ITEMS}
          >
            <For each={item().parts}>
              {(part) => {
                const partKey = getAssistantActivityPartKey(part);
                const entering = claimReveal(`active-activity:${part.id}`) && !isLightweight();
                const exiting = () =>
                  !isLightweight() && !!props.exitingActivityPartKeys?.has(partKey);
                return (
                  <div
                    class={`assistant-active-activity-item${entering ? ' is-entering' : ''}${props.retainedActivityPartKeys?.has(partKey) ? ' is-completed' : ''}${exiting() ? ' is-exiting' : ''}`}
                    data-activity-part-id={part.id}
                  >
                    <div class="assistant-active-activity-item-content">
                      <MessagePart
                        part={part}
                        messageInfo={props.info}
                        streamedText={props.textForPart(part)}
                        lightweight={isLightweight()}
                        questionRequest={
                          part.type === 'tool' ? props.questionRequestForTool?.(part) : undefined
                        }
                        permissionMatch={
                          part.type === 'tool' ? props.permissionMatchForTool?.(part) : undefined
                        }
                        renderPermissionPrompt={false}
                      />
                    </div>
                  </div>
                );
              }}
            </For>
          </div>
        </div>
      );
    }

    const initialItem = entry.item();
    const revealClass = getRevealClass(initialItem);
    if (initialItem.kind === 'activity-group') {
      // SAFETY: The surrounding shape or discriminator check establishes the Extract<AssistantRenderItem, { kind: 'activity-group' }> contract used below.
      const item = () => entry.item() as Extract<AssistantRenderItem, { kind: 'activity-group' }>;
      const activityGroup = () =>
        compactActivityGroupByPartKey().get(
          `${item().parts[0]!.messageID}\u0000${item().parts[0]!.id}`
        )!;
      const showSummary = () =>
        activityGroup().ownerMessageId === props.info.id &&
        item().parts.some((part) => part.id === getCompactActivitySummaryPartId(activityGroup()));
      return (
        <div
          class={`assistant-message-flow-item${revealClass ? ' assistant-activity-group-settling' : ''}${!showSummary() && !isActivityGroupExpanded(activityGroup().key) ? ' assistant-message-flow-item-hidden' : ''}`}
          data-assistant-activity-group-key={
            showSummary() ? encodeURIComponent(activityGroup().key) : undefined
          }
          data-assistant-render-key={entry.key}
        >
          <AssistantActivityGroup
            info={props.info}
            parts={item().parts}
            summaryParts={activityGroup().parts.filter((part) => {
              const key = getAssistantActivityPartKey(part);
              const activePartKeys =
                props.groupedActiveActivityPartKeys ?? props.visibleActiveActivityPartKeys;
              return (
                (!isAssistantActivityPartRunning(part) || !activePartKeys?.has(key)) &&
                (!props.retainedActivityPartKeys?.has(key) ||
                  isActivityGroupExpanded(activityGroup().key))
              );
            })}
            expansionKey={activityGroup().key}
            showSummary={showSummary()}
            textForPart={props.textForPart}
            lightweight={!!isLightweight()}
            questionRequestForTool={props.questionRequestForTool}
            permissionMatchForTool={props.permissionMatchForTool}
          />
        </div>
      );
    }

    if (initialItem.kind === 'file-edit-stack') {
      // SAFETY: The surrounding shape or discriminator check establishes the Extract<AssistantRenderItem, { kind: 'file-edit-stack' }> contract used below.
      const item = () => entry.item() as Extract<AssistantRenderItem, { kind: 'file-edit-stack' }>;
      return (
        <div
          ref={(element) => {
            if (revealClass) {
              onCleanup(
                prepareMeasuredEntrance(element, {
                  animationName: 'streamed-assistant-item-in',
                  heightProperty: '--streamed-assistant-item-height',
                  skipWithin: '.interactive-item-entering',
                })
              );
            }
          }}
          class={`assistant-message-flow-item${revealClass}`}
          data-assistant-render-key={entry.key}
        >
          <div class="assistant-file-edit-stack">
            <For each={item().parts}>
              {(part) => (
                <MessagePart
                  part={part}
                  messageInfo={props.info}
                  streamedText={props.textForPart(part)}
                  lightweight={isLightweight()}
                  questionRequest={props.questionRequestForTool?.(part)}
                  permissionMatch={props.permissionMatchForTool?.(part)}
                  renderPermissionPrompt={false}
                />
              )}
            </For>
          </div>
        </div>
      );
    }

    // SAFETY: The surrounding shape or discriminator check establishes the Extract<AssistantRenderItem, { kind: 'part' }> contract used below.
    const item = () => entry.item() as Extract<AssistantRenderItem, { kind: 'part' }>;
    return (
      <div
        ref={(element) => {
          if (revealClass) {
            onCleanup(
              prepareMeasuredEntrance(element, {
                animationName: 'streamed-assistant-item-in',
                heightProperty: '--streamed-assistant-item-height',
                skipWithin: '.interactive-item-entering',
              })
            );
          }
        }}
        data-assistant-render-key={entry.key}
        class={`${getAssistantFlowItemClass(
          item().part,
          finalTextPartId(),
          !!props.highlightPlanningAnswer
        )}${revealClass}`}
      >
        <Show
          when={
            item().part.type === 'text' &&
            item().part.id === finalTextPartId() &&
            showReadModeToggle() &&
            readModeAltPressed()
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
          part={item().part}
          messageInfo={props.info}
          streamedText={props.textForPart(item().part)}
          lightweight={isLightweight()}
          questionRequest={
            // SAFETY: The surrounding shape or discriminator check establishes the ToolPart contract used below.
            item().part.type === 'tool'
              ? props.questionRequestForTool?.(item().part as ToolPart)
              : undefined
          }
          permissionMatch={
            // SAFETY: The surrounding shape or discriminator check establishes the ToolPart contract used below.
            item().part.type === 'tool'
              ? props.permissionMatchForTool?.(item().part as ToolPart)
              : undefined
          }
          renderPermissionPrompt={false}
        />
      </div>
    );
  };

  return (
    <div class="assistant-message-flow">
      <For each={renderEntries()}>{renderAssistantItem}</For>
      <Show when={trailingPermissionMatch()}>
        {(match) => (
          <PermissionPrompt
            permission={match().permission}
            queuePosition={match().queuePosition}
            queueTotal={match().queueTotal}
          />
        )}
      </Show>
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
        <Portal>
          <div
            ref={(element) => onCleanup(trapModalFocus(element))}
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
              <div
                class="assistant-read-overlay-inner"
                onClick={(event) => event.stopPropagation()}
              >
                <div class="assistant-read-mode-content">
                  <MarkdownRenderer
                    content={finalTextContent()}
                    cacheByContent={!!props.info.time.completed}
                  />
                </div>
              </div>
            </div>
          </div>
        </Portal>
      </Show>
    </div>
  );
}

function AssistantActivityGroup(props: {
  info: AssistantMessage;
  parts: AssistantActivityPart[];
  summaryParts: AssistantActivityPart[];
  expansionKey: string;
  showSummary: boolean;
  textForPart: (part: Part) => string | null;
  lightweight: boolean;
  questionRequestForTool?: (part: ToolPart) => QuestionRequest | null;
  permissionMatchForTool?: (part: ToolPart) => ToolCallPermissionMatch | null;
  onSummaryShown?: () => void;
}) {
  const expanded = () => isActivityGroupExpanded(props.expansionKey);
  const activityStatus = createMemo(() => getAssistantActivityStatus(props.summaryParts));
  const activityItems = createMemo(() => getAssistantActivityCountItems(props.summaryParts));

  createEffect(() => {
    if (!props.showSummary || props.summaryParts.length === 0) return;
    props.onSummaryShown?.();
  });

  const toggleExpanded = () => {
    const nextExpanded = !expanded();
    setMessageBlockExpanded(props.expansionKey, nextExpanded);
  };

  return (
    <div class="assistant-activity-group">
      <Show when={props.showSummary}>
        <button
          type="button"
          class="assistant-activity-summary"
          aria-expanded={expanded()}
          onClick={toggleExpanded}
        >
          <AssistantActivitySummaryText
            items={activityItems()}
            aborted={activityStatus().aborted}
          />
          <svg
            class={`assistant-activity-chevron${expanded() ? ' expanded' : ''}`}
            viewBox="0 0 16 16"
            fill="none"
            stroke="currentColor"
            stroke-width="1.5"
            stroke-linecap="round"
            stroke-linejoin="round"
            width="12"
            height="12"
            aria-hidden="true"
          >
            <path d="M6 4l4 4-4 4" />
          </svg>
        </button>
      </Show>
      <Show when={expanded()}>
        <div class="assistant-activity-details">
          <For each={props.parts}>
            {(part) => (
              <div class="assistant-activity-detail">
                <MessagePart
                  part={part}
                  messageInfo={props.info}
                  streamedText={props.textForPart(part)}
                  lightweight={props.lightweight}
                  questionRequest={
                    part.type === 'tool' ? props.questionRequestForTool?.(part) : undefined
                  }
                  permissionMatch={
                    part.type === 'tool' ? props.permissionMatchForTool?.(part) : undefined
                  }
                  renderPermissionPrompt={false}
                />
              </div>
            )}
          </For>
        </div>
      </Show>
    </div>
  );
}

type AssistantActivityCountItem = ReturnType<typeof getAssistantActivityCountItems>[number];
type AssistantActivityResizeMeasurement = () => (() => void) | undefined;

const activitySummaryResizeMeasurements = new WeakMap<
  Element,
  Set<AssistantActivityResizeMeasurement>
>();
const activitySummaryResizeElements = new Set<Element>();
let activitySummaryResizeObserver: ResizeObserver | null = null;

function observeActivitySummaryResize(
  element: Element,
  measurement: AssistantActivityResizeMeasurement
) {
  if (!activitySummaryResizeObserver && globalThis.ResizeObserver !== undefined) {
    activitySummaryResizeObserver = new ResizeObserver((entries) => {
      const updates = entries.flatMap((entry) => {
        const measurements = activitySummaryResizeMeasurements.get(entry.target);
        if (!measurements) return [];
        return [...measurements].flatMap((measure) => {
          const update = measure();
          return update ? [update] : [];
        });
      });
      for (const update of updates) update();
    });
  }
  let measurements = activitySummaryResizeMeasurements.get(element);
  if (!measurements) {
    measurements = new Set();
    activitySummaryResizeMeasurements.set(element, measurements);
    activitySummaryResizeElements.add(element);
    activitySummaryResizeObserver?.observe(element);
  }
  measurements.add(measurement);

  return () => {
    const currentMeasurements = activitySummaryResizeMeasurements.get(element);
    currentMeasurements?.delete(measurement);
    if (currentMeasurements && currentMeasurements.size > 0) return;
    activitySummaryResizeMeasurements.delete(element);
    activitySummaryResizeElements.delete(element);
    activitySummaryResizeObserver?.unobserve?.(element);
    if (activitySummaryResizeElements.size > 0) return;
    activitySummaryResizeObserver?.disconnect();
    activitySummaryResizeObserver = null;
  };
}

function AssistantActivitySummaryText(props: {
  items: AssistantActivityCountItem[];
  aborted: number;
}) {
  const [compactCount, setCompactCount] = createSignal(0);
  let textElement: HTMLSpanElement | undefined;
  let measurementElement: HTMLSpanElement | undefined;

  const fullLabel = () => {
    const statusLabels =
      props.aborted > 0
        ? [`${props.aborted} ${props.aborted === 1 ? 'tool aborted' : 'tools aborted'}`]
        : [];
    return `Explored: ${[...props.items.map((item) => item.label), ...statusLabels].join(', ')}`;
  };

  const measure: AssistantActivityResizeMeasurement = () => {
    const button = textElement?.closest('button');
    const host = button?.parentElement;
    const chevron = button?.querySelector<SVGElement>('.assistant-activity-chevron');
    if (!button || !host || !chevron || !measurementElement || host.clientWidth <= 0) return;

    const buttonStyle = getComputedStyle(button);
    const gap = Number.parseFloat(buttonStyle.columnGap || buttonStyle.gap) || 0;
    const availableWidth = host.clientWidth - chevron.getBoundingClientRect().width - gap;
    const nounWidths = [
      ...measurementElement.querySelectorAll<HTMLElement>('.assistant-activity-summary-noun'),
    ].map((element) => element.getBoundingClientRect().width);
    const iconWidths = [
      ...measurementElement.querySelectorAll<HTMLElement>('.assistant-activity-kind-icon'),
    ].map((element) => element.getBoundingClientRect().width);
    let candidateWidth = measurementElement.getBoundingClientRect().width;
    if (
      availableWidth <= 0 ||
      candidateWidth <= 0 ||
      nounWidths.length !== props.items.length ||
      iconWidths.length !== props.items.length ||
      nounWidths.some((width) => width <= 0) ||
      iconWidths.some((width) => width <= 0)
    ) {
      return;
    }

    let nextCompactCount = 0;
    while (candidateWidth > availableWidth && nextCompactCount < props.items.length) {
      const itemIndex = props.items.length - nextCompactCount - 1;
      candidateWidth -= nounWidths[itemIndex]! - iconWidths[itemIndex]!;
      nextCompactCount += 1;
    }
    return () => setCompactCount(nextCompactCount);
  };

  createEffect(() => {
    fullLabel();
    queueMicrotask(() => measure()?.());
  });

  onMount(() => {
    const host = textElement?.closest('button')?.parentElement;
    if (!host) return;
    const resizeTarget = host.closest('.assistant-message-flow') ?? host;
    onCleanup(observeActivitySummaryResize(resizeTarget, measure));
  });

  return (
    <>
      <span
        ref={(element) => (textElement = element)}
        class="assistant-activity-summary-text"
        aria-live="polite"
        aria-atomic="true"
        aria-label={fullLabel()}
      >
        <AssistantActivitySummaryCandidate
          items={props.items}
          compactCount={compactCount()}
          aborted={props.aborted}
        />
      </span>
      <Portal mount={document.body}>
        <span
          ref={(element) => (measurementElement = element)}
          class="assistant-activity-summary-measure"
          aria-hidden="true"
        >
          <AssistantActivitySummaryCandidate
            items={props.items}
            compactCount={0}
            aborted={props.aborted}
            measureIcons
          />
        </span>
      </Portal>
    </>
  );
}

function AssistantActivitySummaryCandidate(props: {
  items: AssistantActivityCountItem[];
  compactCount: number;
  aborted: number;
  measureIcons?: boolean;
}) {
  const compactFrom = () => props.items.length - props.compactCount;

  return (
    <>
      <span class="assistant-activity-summary-main">
        Explored:{' '}
        <span class="assistant-activity-summary-counts">
          <For each={props.items}>
            {(item, index) => (
              <>
                <Show when={index() > 0}>, </Show>
                <span class="assistant-activity-summary-item">
                  {item.count}{' '}
                  <Show
                    when={index() < compactFrom()}
                    fallback={<AssistantActivityKindIcon kind={item.kind} />}
                  >
                    <span class="assistant-activity-summary-noun">
                      {item.label.slice(String(item.count).length + 1)}
                    </span>
                  </Show>
                  <Show when={props.measureIcons}>
                    <AssistantActivityKindIcon kind={item.kind} measure />
                  </Show>
                </span>
              </>
            )}
          </For>
          <Show when={props.aborted > 0}>
            <Show when={props.items.length > 0}>, </Show>
            {props.aborted} {props.aborted === 1 ? 'tool aborted' : 'tools aborted'}
          </Show>
        </span>
      </span>
    </>
  );
}

function AssistantActivityKindIcon(props: { kind: AssistantActivityKind; measure?: boolean }) {
  const glyph = () => {
    switch (props.kind) {
      case 'files':
        return (
          <>
            <path d="M4 21.4V2.6c0-.331.269-.6.6-.6h11.652c.159 0 .311.063.424.176l3.148 3.148c.113.113.176.265.176.424V21.4c0 .331-.269.6-.6.6H4.6a.6.6 0 0 1-.6-.6Z" />
            <path d="M16 2v3.4c0 .331.269.6.6.6H20" />
          </>
        );
      case 'reasoning':
        return (
          <>
            <path d="M9 18h6M10 21h4" />
            <path d="M9 15c0-2-.5-2.5-1.5-3.5A5 5 0 0 1 6 8c0-3 2-5 6-5s6 2 6 5a5 5 0 0 1-1.5 3.5c-1 1-1.5 1.5-1.5 3.5" />
          </>
        );
      case 'searches':
        return (
          <>
            <circle cx="11" cy="11" r="7" />
            <path d="m16 16 5 5" />
          </>
        );
      case 'edits':
        return (
          <>
            <path d="M4 20h4l11-11-4-4L4 16z" />
            <path d="m13.5 6.5 4 4" />
          </>
        );
      case 'commands':
        return (
          <>
            <path d="m5 7 5 5-5 5" />
            <path d="M13 17h7" />
          </>
        );
      case 'web':
        return (
          <>
            <circle cx="12" cy="12" r="9" />
            <path d="M3 12h18M12 3a14 14 0 0 1 0 18M12 3a14 14 0 0 0 0 18" />
          </>
        );
      case 'questions':
        return (
          <>
            <circle cx="12" cy="12" r="9" />
            <path d="M9.5 9a2.5 2.5 0 1 1 3.5 2.3c-.7.3-1 .8-1 1.7M12 17h.01" />
          </>
        );
      case 'skills':
        return (
          <path d="m12 3 1.2 4.2L17 9l-3.8 1.8L12 15l-1.2-4.2L7 9l3.8-1.8zM5 15l.7 2.3L8 18l-2.3.7L5 21l-.7-2.3L2 18l2.3-.7z" />
        );
      case 'tools':
        return <path d="M14 6a4 4 0 0 0-5 5L3 17l4 4 6-6a4 4 0 0 0 5-5l-3 3-4-4z" />;
    }
  };

  return (
    <span
      class={`assistant-activity-kind-icon${props.measure ? ' is-measurement' : ''}`}
      data-kind={props.kind}
      aria-hidden="true"
    >
      <svg
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        stroke-width={props.kind === 'files' ? '1.6' : '1.8'}
        stroke-linecap="round"
        stroke-linejoin="round"
      >
        {glyph()}
      </svg>
    </span>
  );
}

function isActivityGroupExpanded(key: string) {
  trackMessageBlockExpansionState();
  return getMessageBlockExpanded(key) ?? false;
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
    <svg viewBox="0 0 24 24" fill="none" aria-hidden="true">
      <path
        d="M9 9L4 4M4 4V8M4 4H8"
        stroke="currentColor"
        stroke-width="1.6"
        stroke-linecap="round"
        stroke-linejoin="round"
      />
      <path
        d="M15 9L20 4M20 4V8M20 4H16"
        stroke="currentColor"
        stroke-width="1.6"
        stroke-linecap="round"
        stroke-linejoin="round"
      />
      <path
        d="M9 15L4 20M4 20V16M4 20H8"
        stroke="currentColor"
        stroke-width="1.6"
        stroke-linecap="round"
        stroke-linejoin="round"
      />
      <path
        d="M15 15L20 20M20 20V16M20 20H16"
        stroke="currentColor"
        stroke-width="1.6"
        stroke-linecap="round"
        stroke-linejoin="round"
      />
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
