import { For, Show, createEffect, createMemo, createSignal, onCleanup } from 'solid-js';
import { Portal } from 'solid-js/web';
import {
  formatAssistantActivityCounts,
  getAssistantActivityPartKey,
  getAssistantActivityStatus,
  isAssistantActivityPart,
  isAssistantActivityPartRunning,
  shouldCompactAssistantActivityPart,
  type AssistantActivityGroupInfo,
  type AssistantActivityPart,
} from '../../lib/assistant-activity';
import { isLoading, compactToolOutput, showInlineFileChanges } from '../../lib/state';
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

export type AssistantFileEditStackGroup = 'start' | 'middle' | 'end';

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

// File-edit stacks rekey on every appended edit, so track their reveal by the
// first part id; otherwise appending an edit replays the whole stack animation.
function getRevealTrackingKey(item: AssistantRenderItem) {
  if (item.kind === 'file-edit-stack') return `file-edit-stack:${item.parts[0]!.id}`;
  if (item.kind === 'activity-group') {
    return `activity-group:${item.parts[0]!.id}:${item.parts[item.parts.length - 1]!.id}`;
  }
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
  allowInitialItemReveal?: boolean;
  claimItemReveal?: (messageId: string, renderKey: string) => boolean;
  questionRequestForTool?: (part: ToolPart) => QuestionRequest | null;
  permissionMatchForTool?: (part: ToolPart) => ToolCallPermissionMatch | null;
  compactActivityGroups?: readonly AssistantActivityGroupInfo[] | null;
  retainedActivityPartKeys?: ReadonlySet<string>;
  exitingActivityPartKeys?: ReadonlySet<string>;
  visibleActiveActivityPartKeys?: ReadonlySet<string>;
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
  const isLocallyCompactActivityCandidate = (part: Part): part is AssistantActivityPart =>
    compactToolOutput() &&
    isAssistantActivityPart(part) &&
    shouldCompactAssistantActivityPart(part, {
      showInlineFileChanges: showInlineFileChanges(),
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
      if (!compactToolOutput() || props.info.mode === 'subagent') return null;

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
      for (const part of displayParts()) {
        if (isLocallyCompactActivityPart(part)) activityParts.push(part);
        else flush();
      }
      flush();
      return groups.length > 0 ? groups : null;
    }
  );
  const compactActivityGroupByPartKey = createMemo(
    () =>
      new Map(
        effectiveCompactActivityGroups()?.flatMap((group) =>
          group.parts.map((part) => [getAssistantActivityPartKey(part), group] as const)
        ) || []
      )
  );
  const getCompactActivitySummaryPartId = (group: AssistantActivityGroupInfo) => {
    if (group.ownerMessageId !== props.info.id) return null;
    return (
      group.parts.find((part) =>
        displayParts().some(
          (displayPart) => displayPart.messageID === part.messageID && displayPart.id === part.id
        )
      )?.id ?? null
    );
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
    const parts = displayParts();

    for (let index = 0; index < parts.length; index += 1) {
      const part = parts[index]!;

      if (
        isLocallyCompactActivityCandidate(part) &&
        isAssistantActivityPartRunning(part) &&
        props.visibleActiveActivityPartKeys &&
        !props.visibleActiveActivityPartKeys.has(getAssistantActivityPartKey(part))
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
        return compactActivityGroupByPartKey().get(
          isAssistantActivityPart(candidate) ? getAssistantActivityPartKey(candidate) : ''
        );
      };

      const activityGroup = canGroupActivityPart(part);
      if (activityGroup && isAssistantActivityPart(part)) {
        const activityParts: AssistantActivityPart[] = [part as AssistantActivityPart];
        while (
          index + 1 < parts.length &&
          !isActiveActivityTrayPart(parts[index + 1]!) &&
          canGroupActivityPart(parts[index + 1]!)?.key === activityGroup.key
        ) {
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
          ref={(element) => {
            queueMicrotask(() => {
              if (!element.isConnected) return;
              element.scrollTo?.({ top: element.scrollHeight, behavior: 'smooth' });
            });
          }}
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
                  />
                </Show>
              </div>
            )}
          </Show>
          <For each={item().parts}>
            {(part) => {
              const partKey = getAssistantActivityPartKey(part);
              const entering = claimReveal(`active-activity:${part.id}`);
              return (
                <div
                  class={`assistant-active-activity-item${entering ? ' is-entering' : ''}${props.retainedActivityPartKeys?.has(partKey) ? ' is-completed' : ''}${props.exitingActivityPartKeys?.has(partKey) ? ' is-exiting' : ''}`}
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
                    />
                  </div>
                </div>
              );
            }}
          </For>
        </div>
      );
    }

    const initialItem = entry.item();
    const revealClass = getRevealClass(initialItem);
    if (initialItem.kind === 'activity-group') {
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
          data-assistant-render-key={entry.key}
        >
          <AssistantActivityGroup
            info={props.info}
            parts={item().parts}
            summaryParts={activityGroup().parts.filter(
              (part) =>
                !isAssistantActivityPartRunning(part) &&
                !props.retainedActivityPartKeys?.has(getAssistantActivityPartKey(part))
            )}
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
                />
              )}
            </For>
          </div>
        </div>
      );
    }

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
            item().part.type === 'tool'
              ? props.questionRequestForTool?.(item().part as ToolPart)
              : undefined
          }
          permissionMatch={
            item().part.type === 'tool'
              ? props.permissionMatchForTool?.(item().part as ToolPart)
              : undefined
          }
        />
      </div>
    );
  };

  return (
    <div class="assistant-message-flow">
      <For each={renderEntries()}>{renderAssistantItem}</For>
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
}) {
  const expanded = () => isActivityGroupExpanded(props.expansionKey);
  const activityStatus = createMemo(() => getAssistantActivityStatus(props.summaryParts));
  const summary = createMemo(() => formatAssistantActivityCounts(props.summaryParts));

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
          <span class="assistant-activity-summary-text" aria-live="polite" aria-atomic="true">
            <span class="assistant-activity-summary-main">{summary()}</span>
            <Show when={activityStatus().failed > 0}>
              <span class="assistant-activity-status-failed">
                {'· '}
                {activityStatus().failed}{' '}
                {activityStatus().failed === 1 ? 'tool failed' : 'tools failed'}
              </span>
            </Show>
            <Show when={activityStatus().aborted > 0}>
              <span>
                {' · '}
                {activityStatus().aborted}{' '}
                {activityStatus().aborted === 1 ? 'tool aborted' : 'tools aborted'}
              </span>
            </Show>
          </span>
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
                />
              </div>
            )}
          </For>
        </div>
      </Show>
    </div>
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
