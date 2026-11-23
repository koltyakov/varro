import { storePath } from '@solidjs/signals';
import { flush } from 'solid-js';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { MessageEntry } from '../types';
import * as bridge from './bridge';
import {
  canSummarizePlan,
  countPlanningTurns,
  resolvePlanContent,
  summarizePlanSession,
} from './plan-content';
import { setState } from './state';
import {
  assistantMessage,
  session,
  textPart,
  userMessage,
} from '../components/MessageList.test-utils';

function userTurn(id: string, text: string, synthetic = false, sessionID = 'plan-session') {
  const entry: MessageEntry = {
    info: { ...userMessage(id), sessionID },
    parts: [textPart(`${id}-text`, text, { synthetic })],
  };
  return entry;
}

function planReply(id: string, text: string): MessageEntry {
  return {
    info: assistantMessage(id, { sessionID: 'plan-session', agent: 'plan' }),
    parts: [textPart(`${id}-text`, text)],
  };
}

beforeEach(() => {
  setState(storePath('sessions', [session('plan-session', { directory: '/repo' })]));
  setState(
    storePath('serverStatus', { state: 'running', apiVersion: 2, url: 'http://localhost:4096' })
  );
  flush();
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('countPlanningTurns', () => {
  it('counts typed prompts in the session and ignores synthetic reminders', () => {
    const messages = [
      userTurn('reminder', 'You are in Plan mode.', true),
      userTurn('first', 'Plan the change'),
      planReply('reply-1', 'Step 1'),
      userTurn('second', 'Also cover tests'),
      userTurn('other', 'Elsewhere', false, 'other'),
    ];
    expect(countPlanningTurns('plan-session', messages)).toBe(2);
    expect(countPlanningTurns('plan-session', messages.slice(0, 3))).toBe(1);
  });
});

describe('resolvePlanContent', () => {
  it('uses the final response for a single planning turn', async () => {
    const apiCall = vi.spyOn(bridge, 'apiCall');
    const messages = [userTurn('first', 'Plan it'), planReply('reply', 'The plan')];
    await expect(resolvePlanContent('plan-session', 'The plan', messages)).resolves.toBe(
      'The plan'
    );
    expect(apiCall).not.toHaveBeenCalled();
  });

  it('summarizes a multi-turn plan through the side-question API', async () => {
    const apiCall = vi.spyOn(bridge, 'apiCall').mockResolvedValue({ text: '  # Final plan  ' });
    const messages = [
      userTurn('first', 'Plan it'),
      planReply('reply-1', 'Draft'),
      userTurn('second', 'Revise step 2'),
      planReply('reply-2', 'Revised'),
    ];
    await expect(resolvePlanContent('plan-session', 'Revised', messages)).resolves.toBe(
      '# Final plan'
    );
    expect(apiCall).toHaveBeenCalledWith(
      'POST',
      '/session/plan-session/side-question?directory=%2Frepo',
      { question: expect.stringContaining('implementation plan agreed in this conversation') },
      expect.objectContaining({ retries: 0 })
    );
  });

  it('falls back to the final response when side questions are unavailable', async () => {
    setState(
      storePath('serverStatus', { state: 'running', apiVersion: 1, url: 'http://localhost:4096' })
    );
    flush();
    const apiCall = vi.spyOn(bridge, 'apiCall');
    const messages = [userTurn('first', 'Plan it'), userTurn('second', 'Revise')];
    expect(canSummarizePlan('plan-session')).toBe(false);
    await expect(resolvePlanContent('plan-session', 'Revised', messages)).resolves.toBe('Revised');
    expect(apiCall).not.toHaveBeenCalled();
  });
});

describe('summarizePlanSession', () => {
  it('rejects an empty summary', async () => {
    vi.spyOn(bridge, 'apiCall').mockResolvedValue({ text: '  ' });
    await expect(summarizePlanSession('plan-session')).rejects.toThrow('no usable plan summary');
  });
});
