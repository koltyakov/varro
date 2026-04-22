import { describe, expect, it } from 'vitest';
import type { AssistantMessage, Message, UserMessage } from '../types';
import type { Part } from '../types';
import { buildPlanImplementationPrompt, getLatestPlanImplementationMessageId } from './MessageList';

function textPart(id: string, text: string, options?: { ignored?: boolean; synthetic?: boolean }): Part {
  return {
    id,
    sessionID: 'session-1',
    messageID: 'message-1',
    type: 'text',
    text,
    ...options,
  };
}

function userMessage(id: string): UserMessage {
  return {
    id,
    sessionID: 'session-1',
    role: 'user',
    time: { created: 1 },
    agent: 'build',
    model: { providerID: 'openai', modelID: 'gpt-5.4' },
  };
}

function assistantMessage(id: string, options?: { agent?: string }): AssistantMessage {
  return {
    id,
    sessionID: 'session-1',
    role: 'assistant',
    time: { created: 1, completed: 2 },
    parentID: 'parent-1',
    modelID: 'gpt-5.4',
    providerID: 'openai',
    mode: 'default',
    agent: options?.agent,
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

function entry(info: Message) {
  return { info, parts: [] as Part[] };
}

describe('buildPlanImplementationPrompt', () => {
  it('uses a stable handoff prompt without copying visible plan text', () => {
    expect(
      buildPlanImplementationPrompt([
        textPart('ignored', 'draft', { ignored: true }),
        textPart('plan-1', '1. Update the API route.'),
        textPart('plan-2', '2. Add the missing UI state.'),
      ])
    ).toBe(
      'Implement the plan from your last response in the current workspace. Make the code changes instead of revising the plan.'
    );
  });

  it('uses the same stable handoff prompt when the plan has no visible text', () => {
    expect(
      buildPlanImplementationPrompt([textPart('synthetic', 'placeholder', { synthetic: true })])
    ).toBe(
      'Implement the plan from your last response in the current workspace. Make the code changes instead of revising the plan.'
    );
  });
});

describe('getLatestPlanImplementationMessageId', () => {
  it('returns the last plan response when it is the latest message', () => {
    expect(
      getLatestPlanImplementationMessageId([
        entry(userMessage('user-1')),
        entry(assistantMessage('assistant-1', { agent: 'plan' })),
      ])
    ).toBe('assistant-1');
  });

  it('returns null when a user prompt appears after the plan response', () => {
    expect(
      getLatestPlanImplementationMessageId([
        entry(userMessage('user-1')),
        entry(assistantMessage('assistant-1', { agent: 'plan' })),
        entry(userMessage('user-2')),
      ])
    ).toBeNull();
  });

  it('returns null when the latest assistant response is not a plan response', () => {
    expect(
      getLatestPlanImplementationMessageId([
        entry(userMessage('user-1')),
        entry(assistantMessage('assistant-1', { agent: 'plan' })),
        entry(assistantMessage('assistant-2', { agent: 'build' })),
      ])
    ).toBeNull();
  });
});
