import { For, Show, createEffect, createMemo, createSignal, onCleanup } from 'solid-js';
import type { MessageEntry } from '../../types';
import type { VirtualMetrics, VisibleRange } from './virtualization';
import { MessageRow, type MessageRowSharedProps } from './MessageRows';

export function VirtualizedContent(
  props: {
    messages: MessageEntry[];
    visibleRange?: Partial<VisibleRange>;
    virtualMetrics?: VirtualMetrics;
    renderEmptyMessageIds?: ReadonlySet<string>;
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
  const visible = createMemo(() => props.messages.slice(visibleRange().start, visibleRange().end));
  const rangeOffset = createMemo(() => visibleRange().start);
  const coreStart = createMemo(() => visibleRange().coreStart);
  const coreEnd = createMemo(() => visibleRange().coreEnd);
  const pinnedIndex = createMemo(() => visibleRange().pinnedIndex);
  const pinnedGapStart = createMemo(() => visibleRange().pinnedGapStart);
  const pinnedGapEnd = createMemo(() => visibleRange().pinnedGapEnd);
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
    const pinnedGapActive = pinnedGapStart() !== undefined && pinnedGapEnd() !== undefined;
    if (pinnedGapActive) {
      cancelRetainedPlaceholderRelease();
      return;
    }
    scheduleRetainedPlaceholderRelease();
  });
  onCleanup(cancelRetainedPlaceholderRelease);

  return (
    <>
      <Show when={visibleRange().topPad > 0}>
        <div
          class="virtual-spacer virtual-spacer-top"
          style={{ height: `${visibleRange().topPad}px` }}
          aria-hidden="true"
        />
      </Show>
      <For each={visible()}>
        {(msg, index) => {
          const nearViewport = createMemo(() => {
            const absIndex = index() + rangeOffset();
            return (absIndex >= coreStart() && absIndex < coreEnd()) || absIndex === pinnedIndex();
          });
          const virtualHeight = createMemo(() => {
            const metrics = props.virtualMetrics;
            if (!metrics) return undefined;
            const absIndex = index() + rangeOffset();
            return metrics.prefix[absIndex + 1]! - metrics.prefix[absIndex]!;
          });
          const forceVirtualContent = createMemo(
            () =>
              !!props.forceVirtualContent?.(msg.info.id) ||
              !!props.assistantActivityGroupMap?.has(msg.info.id)
          );
          const previousVisibleIndex = createMemo(() => {
            let previousIndex = index() + rangeOffset() - 1;
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
          const pinnedGapPlaceholder = createMemo(() => {
            const absIndex = index() + rangeOffset();
            const gapStart = pinnedGapStart();
            const gapEnd = pinnedGapEnd();
            return (
              gapStart !== undefined &&
              gapEnd !== undefined &&
              absIndex >= gapStart &&
              absIndex < gapEnd &&
              !forceVirtualContent()
            );
          });
          const virtualPlaceholder = createMemo(() => {
            retainedPlaceholderVersion();
            const messageId = msg.info.id;
            if (forceVirtualContent()) {
              retainedPinnedPlaceholderMessageIds.delete(messageId);
              return false;
            }
            if (pinnedGapPlaceholder()) retainedPinnedPlaceholderMessageIds.add(messageId);
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
              continuesVisibleActivityGroup={continuesVisibleActivityGroup()}
              modelChangeMap={props.modelChangeMap}
              promptNumberMap={props.promptNumberMap}
              showPromptNumbers={props.showPromptNumbers}
              lastAssistantID={props.lastAssistantID}
              previousTrailingFileEventSignatureMap={props.previousTrailingFileEventSignatureMap}
              assistantDialogSummaryMap={props.assistantDialogSummaryMap}
              isFinalAssistantMessage={props.isFinalAssistantMessage}
              assistantActivityGroupMap={props.assistantActivityGroupMap}
              retainedActivityPartKeys={props.retainedActivityPartKeys}
              exitingActivityPartKeys={props.exitingActivityPartKeys}
              visibleActiveActivityPartKeys={props.visibleActiveActivityPartKeys}
              hasBuildAgent={props.hasBuildAgent}
              latestPlanImplementationMessageId={props.latestPlanImplementationMessageId}
              outerListVirtualized={props.outerListVirtualized}
              claimMessageEntrance={props.claimMessageEntrance}
              claimAssistantItemReveal={props.claimAssistantItemReveal}
              observeMeasuredRow={props.observeMeasuredRow}
              questionRequestForTool={props.questionRequestForTool}
              permissionMatchForTool={props.permissionMatchForTool}
            />
          );
        }}
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
