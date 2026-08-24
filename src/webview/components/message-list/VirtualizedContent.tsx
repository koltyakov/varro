import { For, Show, createEffect, createMemo, createSignal, onCleanup } from 'solid-js';
import type { MessageEntry } from '../../types';
import type { VirtualMetrics, VisibleRange } from './virtualization';
import type { MessageBlockBoundary } from './row-layout';
import { MessageRow, type MessageRowSharedProps } from './MessageRows';

export function VirtualizedContent(
  props: {
    messages: MessageEntry[];
    visibleRange?: Partial<VisibleRange>;
    virtualMetrics?: VirtualMetrics;
    renderEmptyMessageIds?: ReadonlySet<string>;
    messageBlockBoundaryMap?: ReadonlyMap<string, MessageBlockBoundary>;
    forceVirtualContent?: (messageId: string) => boolean;
    canReleaseVirtualPlaceholders?: () => boolean;
    outerListVirtualized?: boolean;
  } & MessageRowSharedProps
) {
  const visibleRange = createMemo<VisibleRange>(() => ({
    start: props.visibleRange?.start ?? 0,
    end: props.visibleRange?.end ?? props.messages.length,
    topPad: props.visibleRange?.topPad ?? 0,
    bottomPad: props.visibleRange?.bottomPad ?? 0,
    coreStart: props.visibleRange?.coreStart ?? 0,
    coreEnd: props.visibleRange?.coreEnd ?? props.messages.length,
    pinnedIndex: props.visibleRange?.pinnedIndex,
    pinnedGapStart: props.visibleRange?.pinnedGapStart,
    pinnedGapEnd: props.visibleRange?.pinnedGapEnd,
  }));
  const coreStart = createMemo(() => visibleRange().coreStart);
  const coreEnd = createMemo(() => visibleRange().coreEnd);
  const pinnedIndex = createMemo(() => visibleRange().pinnedIndex);
  const pinnedGapStart = createMemo(() => visibleRange().pinnedGapStart);
  const pinnedGapEnd = createMemo(() => visibleRange().pinnedGapEnd);
  const hasPinnedGap = createMemo(
    () =>
      pinnedGapStart() !== undefined &&
      pinnedGapEnd() !== undefined &&
      pinnedGapStart()! < pinnedGapEnd()!
  );
  type PinnedSegment =
    | { type: 'gap'; start: number; end: number }
    | { type: 'message'; index: number; message: MessageEntry };
  const pinnedSegments = createMemo<PinnedSegment[]>(() => {
    if (!hasPinnedGap()) return [];
    const start = pinnedGapStart()!;
    const end = pinnedGapEnd()!;
    const segments: PinnedSegment[] = [];
    let gapStart = start;
    for (let index = start; index < end; index += 1) {
      const message = props.messages[index]!;
      const forceContent =
        !!props.forceVirtualContent?.(message.info.id) ||
        !!props.assistantActivityGroupMap?.has(message.info.id);
      if (!forceContent) continue;
      if (gapStart < index) segments.push({ type: 'gap', start: gapStart, end: index });
      segments.push({ type: 'message', index, message });
      gapStart = index + 1;
    }
    if (gapStart < end) segments.push({ type: 'gap', start: gapStart, end });
    return segments;
  });
  type VirtualGap = { virtualGap: true; start: number; end: number };
  const renderItems = createMemo<Array<MessageEntry | VirtualGap>>(() => {
    const range = visibleRange();
    if (!hasPinnedGap()) return props.messages.slice(range.start, range.end);

    const items: Array<MessageEntry | VirtualGap> = props.messages.slice(
      range.start,
      pinnedGapStart()!
    );
    for (const segment of pinnedSegments()) {
      if (segment.type === 'gap') {
        items.push({ virtualGap: true, start: segment.start, end: segment.end });
      } else {
        items.push(segment.message);
      }
    }
    items.push(...props.messages.slice(pinnedGapEnd()!, range.end));
    return items;
  });
  const messageIndexes = createMemo(
    () => new Map(props.messages.map((message, index) => [message, index] as const))
  );
  // Keep the temporary gap inert through pin removal, then hydrate its bounded remainder when input is idle.
  const retainedPinnedPlaceholderMessageIds = new Set<string>();
  const [retainedPlaceholderVersion, setRetainedPlaceholderVersion] = createSignal(0);
  let releaseRetainedPlaceholdersRaf = 0;
  let releaseRetainedPlaceholdersTimer: ReturnType<typeof setTimeout> | 0 = 0;
  const cancelRetainedPlaceholderRelease = () => {
    if (releaseRetainedPlaceholdersRaf) cancelAnimationFrame(releaseRetainedPlaceholdersRaf);
    if (releaseRetainedPlaceholdersTimer) clearTimeout(releaseRetainedPlaceholdersTimer);
    releaseRetainedPlaceholdersRaf = 0;
    releaseRetainedPlaceholdersTimer = 0;
  };
  const scheduleRetainedPlaceholderRelease = () => {
    if (
      releaseRetainedPlaceholdersRaf ||
      releaseRetainedPlaceholdersTimer ||
      retainedPinnedPlaceholderMessageIds.size === 0
    ) {
      return;
    }
    if (props.canReleaseVirtualPlaceholders && !props.canReleaseVirtualPlaceholders()) {
      releaseRetainedPlaceholdersTimer = setTimeout(() => {
        releaseRetainedPlaceholdersTimer = 0;
        scheduleRetainedPlaceholderRelease();
      }, 50);
      return;
    }
    releaseRetainedPlaceholdersRaf = requestAnimationFrame(() => {
      releaseRetainedPlaceholdersRaf = 0;
      if (props.canReleaseVirtualPlaceholders && !props.canReleaseVirtualPlaceholders()) {
        scheduleRetainedPlaceholderRelease();
        return;
      }
      retainedPinnedPlaceholderMessageIds.clear();
      setRetainedPlaceholderVersion((version) => version + 1);
    });
  };
  createEffect(() => {
    const currentMessageIds = new Set(props.messages.map((message) => message.info.id));
    for (const messageId of retainedPinnedPlaceholderMessageIds) {
      if (!currentMessageIds.has(messageId)) retainedPinnedPlaceholderMessageIds.delete(messageId);
    }
    const segments = pinnedSegments();
    if (segments.length > 0) {
      for (const segment of segments) {
        if (segment.type !== 'gap') continue;
        for (let index = segment.start; index < segment.end; index += 1) {
          const messageId = props.messages[index]?.info.id;
          if (messageId) retainedPinnedPlaceholderMessageIds.add(messageId);
        }
      }
      cancelRetainedPlaceholderRelease();
      return;
    }
    scheduleRetainedPlaceholderRelease();
  });
  onCleanup(cancelRetainedPlaceholderRelease);

  const renderMessage = (msg: MessageEntry, absoluteIndex: () => number) => {
    const nearViewport = createMemo(() => {
      const index = absoluteIndex();
      return (index >= coreStart() && index < coreEnd()) || index === pinnedIndex();
    });
    const virtualHeight = createMemo(() => {
      const metrics = props.virtualMetrics;
      if (!metrics) return undefined;
      const index = absoluteIndex();
      return metrics.prefix[index + 1]! - metrics.prefix[index]!;
    });
    const forceVirtualContent = createMemo(
      () =>
        !!props.forceVirtualContent?.(msg.info.id) ||
        !!props.assistantActivityGroupMap?.has(msg.info.id)
    );
    const previousVisibleIndex = createMemo(() => {
      let previousIndex = absoluteIndex() - 1;
      while (
        previousIndex >= 0 &&
        props.renderEmptyMessageIds?.has(props.messages[previousIndex]!.info.id)
      ) {
        previousIndex -= 1;
      }
      return previousIndex;
    });
    const followsVisibleAssistantResponse = createMemo(() => {
      const previousIndex = previousVisibleIndex();
      return (
        msg.info.role === 'assistant' &&
        previousIndex >= 0 &&
        props.messages[previousIndex]!.info.role === 'assistant'
      );
    });
    const followsBorderedBlock = createMemo(() => {
      const previousIndex = previousVisibleIndex();
      if (previousIndex < 0) return false;
      const previousMessageId = props.messages[previousIndex]!.info.id;
      return (
        props.messageBlockBoundaryMap?.get(previousMessageId)?.endsBordered === true &&
        props.messageBlockBoundaryMap?.get(msg.info.id)?.startsBordered === true
      );
    });
    const continuesVisibleActivityGroup = createMemo(() => {
      const previousIndex = previousVisibleIndex();
      if (msg.info.role !== 'assistant' || previousIndex < 0) return false;
      const previousMessage = props.messages[previousIndex]!;
      if (previousMessage.info.role !== 'assistant') return false;
      const currentGroups = props.assistantActivityGroupMap?.get(msg.info.id);
      const previousGroups = props.assistantActivityGroupMap?.get(previousMessage.info.id);
      if (!currentGroups || !previousGroups) return false;
      const previousKeys = new Set(previousGroups.map((group) => group.key));
      return currentGroups.some((group) => previousKeys.has(group.key));
    });
    const virtualPlaceholder = createMemo(() => {
      retainedPlaceholderVersion();
      const messageId = msg.info.id;
      if (forceVirtualContent()) {
        retainedPinnedPlaceholderMessageIds.delete(messageId);
        return false;
      }
      return retainedPinnedPlaceholderMessageIds.has(messageId);
    });
    return (
      <MessageRow
        msg={msg}
        nearViewport={nearViewport()}
        virtualHeight={virtualHeight()}
        virtualPlaceholder={virtualPlaceholder()}
        renderEmpty={props.renderEmptyMessageIds?.has(msg.info.id)}
        followsVisibleAssistantResponse={followsVisibleAssistantResponse()}
        followsBorderedBlock={followsBorderedBlock()}
        continuesVisibleActivityGroup={continuesVisibleActivityGroup()}
        modelChangeMap={props.modelChangeMap}
        promptNumberMap={props.promptNumberMap}
        showPromptNumbers={props.showPromptNumbers}
        showSentTimestamps={props.showSentTimestamps}
        revealedSentTimestampMessageId={props.revealedSentTimestampMessageId}
        revealedWorkedSummaryPromptMessageId={props.revealedWorkedSummaryPromptMessageId}
        showWorkedSummaryTimes={props.showWorkedSummaryTimes}
        suppressTimestampAnimations={props.suppressTimestampAnimations}
        lastAssistantID={props.lastAssistantID}
        previousTrailingFileEventSignatureMap={props.previousTrailingFileEventSignatureMap}
        assistantDialogSummaryMap={props.assistantDialogSummaryMap}
        isFinalAssistantMessage={props.isFinalAssistantMessage}
        assistantActivityGroupMap={props.assistantActivityGroupMap}
        retainedActivityPartKeys={props.retainedActivityPartKeys}
        exitingActivityPartKeys={props.exitingActivityPartKeys}
        visibleActiveActivityPartKeys={props.visibleActiveActivityPartKeys}
        groupedActiveActivityPartKeys={props.groupedActiveActivityPartKeys}
        hasBuildAgent={props.hasBuildAgent}
        latestPlanImplementationMessageId={props.latestPlanImplementationMessageId}
        outerListVirtualized={props.outerListVirtualized}
        claimMessageEntrance={props.claimMessageEntrance}
        claimAssistantItemReveal={props.claimAssistantItemReveal}
        observeMeasuredRow={props.observeMeasuredRow}
        questionRequestForTool={props.questionRequestForTool}
        permissionMatchForTool={props.permissionMatchForTool}
        onWorkedSummaryHoverChange={props.onWorkedSummaryHoverChange}
        onUserMessageHoverChange={props.onUserMessageHoverChange}
      />
    );
  };

  return (
    <>
      <Show when={visibleRange().topPad > 0}>
        <div
          class="virtual-spacer virtual-spacer-top"
          style={{ height: `${visibleRange().topPad}px` }}
          aria-hidden="true"
        />
      </Show>
      <For each={renderItems()}>
        {(item) =>
          'virtualGap' in item ? (
            <div
              class="virtual-spacer virtual-pinned-gap"
              style={{
                height: `${(props.virtualMetrics?.prefix[item.end] ?? 0) - (props.virtualMetrics?.prefix[item.start] ?? 0)}px`,
              }}
              aria-hidden="true"
            />
          ) : (
            renderMessage(item, () => messageIndexes().get(item) ?? -1)
          )
        }
      </For>
      <Show when={visibleRange().bottomPad > 0}>
        <div
          class="virtual-spacer virtual-spacer-bottom"
          style={{ height: `${visibleRange().bottomPad}px` }}
          aria-hidden="true"
        />
      </Show>
    </>
  );
}
