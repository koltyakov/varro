import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createComponent } from 'solid-js';
import { render } from 'solid-js/web';
import type { AssistantMessage, Message, Part, TextPart } from '../types';
import { resetDefaultAppState, setState } from '../lib/state';
import { MessageRows } from '../components/message-list/MessageRows';
import { settlePerfEffects } from './harness';

const { messageRenderCounts } = vi.hoisted(() => ({
  messageRenderCounts: new Map<string, number>(),
}));

vi.mock('../components/Message', async () => {
  const { createRenderEffect } = await import('solid-js');

  return {
    Message(props: { info: Message; streamingText?: string }) {
      createRenderEffect(() => {
        void props.streamingText;
        messageRenderCounts.set(props.info.id, (messageRenderCounts.get(props.info.id) ?? 0) + 1);
      });

      return null;
    },
  };
});

let container: HTMLDivElement | null = null;
let cleanup: (() => void) | undefined;

function createAssistantMessage(id: string): AssistantMessage {
  return {
    id,
    sessionID: 'session-1',
    role: 'assistant',
    time: { created: 1, completed: 2 },
    parentID: 'parent-1',
    modelID: 'gpt-4o',
    providerID: 'openai',
    mode: 'default',
    path: { cwd: '/workspace', root: '/workspace' },
    cost: 0,
    tokens: {
      input: 0,
      output: 0,
      reasoning: 0,
      cache: { read: 0, write: 0 },
    },
  };
}

function createTextPart(id: string, messageID: string, text: string): TextPart {
  return {
    id,
    sessionID: 'session-1',
    messageID,
    type: 'text',
    text,
  };
}

function entry(info: Message, parts: Part[]) {
  return { info, parts };
}

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
    setState('streamingPartId', 'part-a');
    setState('streamingText', 'Alpha');

    cleanup = render(
      () =>
        createComponent(MessageRows, {
          messages,
          modelChangeMap: new Map(),
          lastAssistantID: null,
          previousTrailingFileEventSignatureMap: new Map(),
          fileEditStackGroupMap: new Map(),
          assistantDialogSummaryMap: new Map(),
          hasBuildAgent: false,
          latestPlanImplementationMessageId: null,
          isPlanningAssistantMessage: () => false,
          questionRequestForTool: () => null,
          permissionMatchForTool: () => null,
          shouldShowPlanImplementationAction: () => false,
          buildPlanImplementationPrompt: () => '',
          buildPlanDocumentContent: () => '',
        }),
      container!
    );
    await settlePerfEffects();

    expect(messageRenderCounts.get('message-1')).toBe(1);
    expect(messageRenderCounts.get('message-2')).toBe(1);
    expect(messageRenderCounts.get('message-3')).toBe(1);

    for (let index = 0; index < 10; index += 1) {
      setState('streamingText', `Alpha ${index}`);
    }
    await settlePerfEffects();

    expect(messageRenderCounts.get('message-1')).toBeGreaterThan(1);
    expect(messageRenderCounts.get('message-2')).toBe(1);
    expect(messageRenderCounts.get('message-3')).toBe(1);
  });
});
