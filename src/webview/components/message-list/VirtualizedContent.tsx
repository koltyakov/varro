import { Show, createMemo } from 'solid-js';
import type { Message, Part } from '../../types';
import type { VisibleRange } from './virtualization';
import { MessageRows, type MessageRowSharedProps } from './MessageRows';

export function VirtualizedContent(
  props: {
    messages: Array<{ info: Message; parts: Part[] }>;
    visibleRange?: Partial<VisibleRange>;
  } & MessageRowSharedProps
) {
  const visibleRange = createMemo<VisibleRange>(() => ({
    start: props.visibleRange?.start ?? 0,
    end: props.visibleRange?.end ?? props.messages.length,
    topPad: props.visibleRange?.topPad ?? 0,
    bottomPad: props.visibleRange?.bottomPad ?? 0,
  }));
  const visible = createMemo(() => props.messages.slice(visibleRange().start, visibleRange().end));

  return (
    <>
      <Show when={visibleRange().topPad > 0}>
        <div style={{ height: `${visibleRange().topPad}px` }} />
      </Show>
      <MessageRows
        messages={visible()}
        modelChangeMap={props.modelChangeMap}
        lastAssistantID={props.lastAssistantID}
        previousTrailingFileEventSignatureMap={props.previousTrailingFileEventSignatureMap}
        fileEditStackGroupMap={props.fileEditStackGroupMap}
        assistantDialogSummaryMap={props.assistantDialogSummaryMap}
        hasBuildAgent={props.hasBuildAgent}
        latestPlanImplementationMessageId={props.latestPlanImplementationMessageId}
        observeMeasuredRow={props.observeMeasuredRow}
        isPlanningAssistantMessage={props.isPlanningAssistantMessage}
        shouldShowPlanImplementationAction={props.shouldShowPlanImplementationAction}
        buildPlanImplementationPrompt={props.buildPlanImplementationPrompt}
        buildPlanDocumentContent={props.buildPlanDocumentContent}
      />
      <Show when={visibleRange().bottomPad > 0}>
        <div style={{ height: `${visibleRange().bottomPad}px` }} />
      </Show>
    </>
  );
}
