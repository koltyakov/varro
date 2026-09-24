import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  assistantMessage,
  session,
  textPart,
  userMessage,
} from '../components/MessageList.test-utils';
import { client } from './client';
import { resetDefaultAppState, setState, state } from './state';
import { getSessionPauseMap, recordSessionPause } from './session-pauses';
import type { MessageEntry } from '../types';

afterEach(() => {
  vi.restoreAllMocks();
  resetDefaultAppState();
});

describe('session pause markers', () => {
  const pausedSession = session('session-1', {
    metadata: { varro: { pauses: [{ messageId: 'boundary', pausedAt: 100 }] } },
  });
  const boundary = { info: assistantMessage('boundary'), parts: [] };

  it('resumes only when later conversation work arrives in the same session', () => {
    const messages: MessageEntry[] = [
      boundary,
      { info: assistantMessage('child-answer', { sessionID: 'child' }), parts: [] },
      {
        info: userMessage('notice'),
        parts: [
          {
            id: 'notice-part',
            sessionID: 'session-1',
            messageID: 'notice',
            type: 'text',
            text: '<shell id="one" state="completed">Done</shell>',
            synthetic: true,
          },
        ],
      },
      {
        info: { ...userMessage('queued'), pendingDelivery: 'steer' as const },
        parts: [textPart('queued-part', 'Later')],
      },
    ];
    expect(getSessionPauseMap([pausedSession], messages).get('boundary')?.resumed).toBe(false);
    messages.push({
      info: userMessage('continue'),
      parts: [textPart('continue-part', 'Continue')],
    });
    // Message order, rather than client/server clock agreement, determines continuation.
    expect(getSessionPauseMap([pausedSession], messages).get('boundary')?.resumed).toBe(true);
  });

  it('persists the canonical boundary while preserving other session metadata', async () => {
    const current = session('session-1', {
      metadata: { source: 'test', varro: { agent: 'build' } },
    });
    setState('sessions', [current]);
    vi.spyOn(client.session, 'get').mockResolvedValue(current);
    vi.spyOn(client.session, 'messages').mockResolvedValue([boundary]);
    const update = vi
      .spyOn(client.session, 'update')
      .mockImplementation(async (_id, body) => ({ ...current, metadata: body.metadata }));
    await recordSessionPause('session-1');
    expect(update).toHaveBeenCalledWith(
      'session-1',
      {
        metadata: {
          source: 'test',
          varro: {
            agent: 'build',
            pauses: [{ messageId: 'boundary', pausedAt: expect.any(Number) }],
          },
        },
      },
      { directory: '/workspace' }
    );
    expect(getSessionPauseMap(state.sessions, [boundary]).get('boundary')?.resumed).toBe(false);
    const reopened = JSON.parse(JSON.stringify(state.sessions));
    expect(getSessionPauseMap(reopened, [boundary]).get('boundary')?.messageId).toBe('boundary');
  });

  it('does not duplicate a pause marker when the same boundary is paused again', async () => {
    vi.spyOn(client.session, 'get').mockResolvedValue(pausedSession);
    vi.spyOn(client.session, 'messages').mockResolvedValue([boundary]);
    const update = vi.spyOn(client.session, 'update');
    await recordSessionPause('session-1');
    expect(update).not.toHaveBeenCalled();
  });
});
