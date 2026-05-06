import { For, Show, createMemo } from 'solid-js';
import type { Message, Part } from '../../types';
import type { VisibleRange } from './virtualization';
import { MessageRow, type MessageRowSharedProps } from './MessageRows';

export function VirtualizedContent(
  props: {
    messages: Array<{ info: Message; parts: Part[] }>;
    visibleRange?: Partial<VisibleRange>;
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
  }));
  const visible = createMemo(() => props.messages.slice(visibleRange().start, visibleRange().end));
  const rangeOffset = createMemo(() => visibleRange().start);
  const coreStart = createMemo(() => visibleRange().coreStart);
  const coreEnd = createMemo(() => visibleRange().coreEnd);

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
            return absIndex >= coreStart() && absIndex < coreEnd();
          });
          return (
            <MessageRow
              msg={msg}
              nearViewport={nearViewport()}
              modelChangeMap={props.modelChangeMap}
              lastAssistantID={props.lastAssistantID}
              previousTrailingFileEventSignatureMap={props.previousTrailingFileEventSignatureMap}
              fileEditStackGroupMap={props.fileEditStackGroupMap}
              assistantDialogSummaryMap={props.assistantDialogSummaryMap}
              highlightedAssistantMessageIds={props.highlightedAssistantMessageIds}
              hasBuildAgent={props.hasBuildAgent}
              latestPlanImplementationMessageId={props.latestPlanImplementationMessageId}
              outerListVirtualized={props.outerListVirtualized}
              observeMeasuredRow={props.observeMeasuredRow}
              isPlanningAssistantMessage={props.isPlanningAssistantMessage}
              questionRequestForTool={props.questionRequestForTool}
              permissionMatchForTool={props.permissionMatchForTool}
              shouldShowPlanImplementationAction={props.shouldShowPlanImplementationAction}
              buildPlanImplementationPrompt={props.buildPlanImplementationPrompt}
              buildPlanDocumentContent={props.buildPlanDocumentContent}
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
