import { describe, expect, it } from 'vitest';
import type { AssistantMessage, MessageEntry } from '../../types';
import { assistantMessage, userMessage } from '../MessageList.test-utils';
import { getAssistantRetryStates } from './assistant-retry';

function response(id: string, overrides: Partial<AssistantMessage> = {}): MessageEntry {
  return {
    info: { ...assistantMessage(id), finish: 'tool-calls', ...overrides },
    parts: [],
  };
}

const error = {
  name: 'provider.transport',
  data: { message: 'WebSocket closed with code 1006' },
};
const interrupted = response('interrupted', {
  finish: 'error',
  error,
  retry: { attempt: 2, at: 3 },
});

describe('assistant automatic retry presentation', () => {
  it('waits for a completed provider response before reporting recovery', () => {
    const busy = { 'session-1': { type: 'busy' as const } };
    expect(getAssistantRetryStates([interrupted], busy).get('interrupted')).toBe('retrying');
    expect(
      getAssistantRetryStates(
        [interrupted, response('continuation', { time: { created: 4 }, finish: undefined })],
        busy
      ).get('interrupted')
    ).toBe('retrying');
    expect(
      getAssistantRetryStates([interrupted, response('continuation')], {}).get('interrupted')
    ).toBe('recovered');
  });

  it('keeps the final error actionable when retries fail or are cancelled', () => {
    const final = response('final', { finish: 'error', error });
    expect(getAssistantRetryStates([interrupted, final], {})).toEqual(
      new Map([['interrupted', 'retried']])
    );
    expect(getAssistantRetryStates([interrupted], {}).size).toBe(0);
    expect(
      getAssistantRetryStates(
        [interrupted, response('cancelled', { finish: 'aborted', error: undefined })],
        {}
      ).get('interrupted')
    ).toBe('retried');
  });

  it('does not infer recovery from generated activity, another provider, or a child session', () => {
    for (const unrelated of [
      response('skill', { finish: undefined }),
      response('another-provider', { providerID: 'another-provider', parentID: 'another-user' }),
      response('child', { sessionID: 'child-session' }),
    ]) {
      expect(getAssistantRetryStates([interrupted, unrelated], {}).size).toBe(0);
    }
    expect(
      getAssistantRetryStates(
        [interrupted, { info: userMessage('new-user'), parts: [] }, response('new-response')],
        { 'session-1': { type: 'busy' } }
      ).get('interrupted')
    ).toBe('resolved');
  });

  it('distinguishes automatic recovery from earlier ordinary failures', () => {
    const second = response('second', { finish: 'error', error, retry: { attempt: 3, at: 4 } });
    const ordinary = response('ordinary-error', { finish: 'error', error });
    expect(
      getAssistantRetryStates([ordinary, interrupted, second, response('success')], {})
    ).toEqual(
      new Map([
        ['second', 'recovered'],
        ['interrupted', 'recovered'],
        ['ordinary-error', 'resolved'],
      ])
    );
  });

  it('resolves a historical failure only after a successful response from the same model', () => {
    const failed = response('failed', { finish: 'error', error });
    const user = { info: userMessage('new-user'), parts: [] };
    for (const later of [
      response('pending', { time: { created: 4 }, finish: undefined }),
      response('failed-again', { finish: 'error', error }),
      response('cancelled', { finish: 'aborted' }),
      response('other-model', { modelID: 'other-model' }),
    ]) {
      expect(getAssistantRetryStates([failed, user, later], {}).has('failed')).toBe(false);
    }
    expect(getAssistantRetryStates([failed, user, response('success')], {}).get('failed')).toBe(
      'resolved'
    );
  });
});
