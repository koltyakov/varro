import { storePath } from '@solidjs/signals';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createComponent } from 'solid-js';
import { render } from '@solidjs/web';
import type { Message } from '../types';
import { resetDefaultAppState, setState } from '../lib/state';
import { MessageRows } from '../components/message-list/MessageRows';
import { settlePerfEffects, createAssistantMessage, createTextPart, entry } from './harness';

const { messageRenderCounts } = vi.hoisted(() => ({
  messageRenderCounts: new Map<string, number>(),
}));

/* oxlint-disable anti-slop/no-module-mocking -- This benchmark isolates message-row module integration from rendering cost. */
vi.mock('../components/Message', async () => {
  const { createRenderEffect } = await import('solid-js');

  return {
    Message(props: { info: Message; streamingText?: string }) {
      createRenderEffect(
        () => ({ id: props.info.id, text: props.streamingText }),
        ({ id }) => {
          messageRenderCounts.set(id, (messageRenderCounts.get(id) ?? 0) + 1);
        }
      );

      return null;
    },
  };
});

let container: HTMLDivElement | null = null;
let cleanup: (() => void) | undefined;

describe('MessageRows perf guards', () => {
  beforeEach(() => {
    resetDefaultAppState();
    messageRenderCounts.clear();
    container = document.createElement('div');
    document.body.appendChild(container);
  });

  afterEach(() => {
    cleanup?.();
    cleanup = undefined;
    container?.remove();
    container = null;
    messageRenderCounts.clear();
    resetDefaultAppState();
    vi.restoreAllMocks();
  });

  it('limits streamed text reactivity to the row owning the streaming part', async () => {
    const messages = [
      entry(createAssistantMessage('message-1'), [createTextPart('part-a', 'message-1', 'Alpha')]),
      entry(createAssistantMessage('message-2'), [createTextPart('part-b', 'message-2', 'Beta')]),
      entry(createAssistantMessage('message-3'), [createTextPart('part-c', 'message-3', 'Gamma')]),
    ];
    setState(storePath('streamingPartId', 'part-a'));
    setState(storePath('streamingText', 'Alpha'));
    await settlePerfEffects();

    cleanup = render(
      () =>
        createComponent(MessageRows, {
          messages,
          modelChangeMap: new Map(),
          lastAssistantID: null,
          previousTrailingFileEventSignatureMap: new Map(),
          assistantDialogSummaryMap: new Map(),
          isFinalAssistantMessage: () => false,
          promptNumberMap: new Map(),
          showPromptNumbers: false,
          showSentTimestamps: false,
          hasBuildAgent: false,
          latestPlanImplementationMessageId: null,
          questionRequestForTool: () => null,
          permissionMatchForTool: () => null,
        }),
      container!
    );
    await settlePerfEffects();

    expect(messageRenderCounts.get('message-1')).toBe(1);
    expect(messageRenderCounts.get('message-2')).toBe(1);
    expect(messageRenderCounts.get('message-3')).toBe(1);

    for (let index = 0; index < 10; index += 1) {
      setState(storePath('streamingText', `Alpha ${index}`));
    }
    await settlePerfEffects();

    expect(messageRenderCounts.get('message-1')).toBeGreaterThan(1);
    expect(messageRenderCounts.get('message-2')).toBe(1);
    expect(messageRenderCounts.get('message-3')).toBe(1);
  });
});
