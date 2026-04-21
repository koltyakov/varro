import { beforeEach, describe, expect, it } from 'vitest';
import type { AssistantMessage, Part } from '../types';
import {
  applyMessagePartDelta,
  clearMessages,
  clearStreamingState,
  state,
  upsertMessage,
} from './state';

function assistantMessage(id = 'message-1', sessionID = 'session-1'): AssistantMessage {
  return {
    id,
    sessionID,
    role: 'assistant',
    time: { created: 0 },
    parentID: 'user-1',
    modelID: 'model-1',
    providerID: 'provider-1',
    mode: 'default',
    path: { cwd: '/', root: '/' },
    cost: 0,
    tokens: {
      input: 0,
      output: 0,
      reasoning: 0,
      cache: { read: 0, write: 0 },
    },
  };
}

function reasoningPart(text: string): Part {
  return {
    id: 'reason-1',
    sessionID: 'session-1',
    messageID: 'message-1',
    type: 'reasoning',
    text,
    time: { start: 0 },
  };
}

function textPart(id: string, text: string): Part {
  return {
    id,
    sessionID: 'session-1',
    messageID: 'message-1',
    type: 'text',
    text,
  };
}

describe('state streaming deltas', () => {
  beforeEach(() => {
    clearMessages();
    clearStreamingState();
  });

  it('updates existing reasoning parts as deltas arrive', () => {
    upsertMessage({
      info: assistantMessage(),
      parts: [reasoningPart('Planning'), textPart('text-1', '')],
    });

    applyMessagePartDelta('message-1', 'reason-1', ' more', 'session-1');
    applyMessagePartDelta('message-1', 'text-1', 'Answer', 'session-1');

    expect(state.messages[0]?.parts[0]).toMatchObject({
      id: 'reason-1',
      type: 'reasoning',
      text: 'Planning more',
    });
    expect(state.messages[0]?.parts[1]).toMatchObject({
      id: 'text-1',
      type: 'text',
      text: 'Answer',
    });
  });

  it('resumes streaming from the part text after another part becomes active', () => {
    upsertMessage({
      info: assistantMessage(),
      parts: [reasoningPart('Thinking'), textPart('text-1', 'Done')],
    });

    applyMessagePartDelta('message-1', 'reason-1', ' carefully', 'session-1');
    applyMessagePartDelta('message-1', 'text-1', ' already', 'session-1');
    applyMessagePartDelta('message-1', 'reason-1', ' now', 'session-1');

    expect(state.messages[0]?.parts[0]).toMatchObject({
      id: 'reason-1',
      type: 'reasoning',
      text: 'Thinking carefully now',
    });
    expect(state.streamingPartId).toBe('reason-1');
    expect(state.streamingText).toBe('Thinking carefully now');
  });
});
