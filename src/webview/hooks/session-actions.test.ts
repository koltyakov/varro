import { describe, expect, it, vi } from 'vitest';
import type { Message } from '../types';
import {
  implementPlanWithDependencies,
  INIT_PROMPT,
  initSessionWithDependencies,
  openPlanWithDependencies,
  runSlashCommandWithDependencies,
} from './session/session-actions';

function userMessage(id: string): Message {
  return {
    id,
    sessionID: 'session-1',
    role: 'user',
    time: { created: 0 },
    agent: 'build',
    model: { providerID: 'openai', modelID: 'gpt-4o' },
  };
}

describe('session-actions helpers', () => {
  it('switches to the build agent before sending plan implementation prompts', async () => {
    const applySelectedAgent = vi.fn();
    const sendMessage = vi.fn(async () => {});

    await implementPlanWithDependencies(
      {
        getActiveSessionId: () => 'session-1',
        getBuildAgent: () => 'build',
        setError: vi.fn(),
        clearSkippedPlanSession: vi.fn(),
        applySelectedAgent,
        sendMessage,
      },
      'Implement it',
      'session-1'
    );

    expect(applySelectedAgent).toHaveBeenCalledWith('build', 'session-1');
    expect(sendMessage).toHaveBeenCalledWith('Implement it');
  });

  it('rejects empty plan content before opening the plan', async () => {
    const setError = vi.fn();
    const openPlan = vi.fn(async () => {});

    await openPlanWithDependencies(
      {
        getActiveSessionId: () => 'session-1',
        setError,
        openPlan,
      },
      '   ',
      'session-1'
    );

    expect(openPlan).not.toHaveBeenCalled();
    expect(setError).toHaveBeenCalledWith('Plan content is empty');
  });

  it('initializes blank sessions by sending the AGENTS prompt', async () => {
    const sendMessage = vi.fn(async () => {});

    await initSessionWithDependencies({
      getActiveSessionId: () => 'session-1',
      createSession: vi.fn(async () => 'session-2'),
      getMessageCount: () => 0,
      setError: vi.fn(),
      sendMessage,
    });

    expect(sendMessage).toHaveBeenCalledWith(INIT_PROMPT);
  });

  it('refuses to initialize non-blank sessions', async () => {
    const setError = vi.fn();

    await initSessionWithDependencies({
      getActiveSessionId: () => 'session-1',
      createSession: vi.fn(async () => 'session-2'),
      getMessageCount: () => 1,
      setError,
      sendMessage: vi.fn(async () => {}),
    });

    expect(setError).toHaveBeenCalledWith('Init is only available for blank sessions');
  });

  it('runs slash commands and updates the active session state', async () => {
    const upsertMessageInfo = vi.fn();
    const upsertPart = vi.fn();
    const syncTodosFromMessages = vi.fn();
    const requestMessageListScrollToBottom = vi.fn();
    const startLoading = vi.fn();
    const stopLoading = vi.fn();

    const result = await runSlashCommandWithDependencies(
      {
        hasCommand: (name) => name === 'test',
        getActiveSessionId: () => 'session-1',
        createSession: vi.fn(async () => 'session-2'),
        startLoading,
        runSessionCommand: vi.fn(async () => ({
          info: userMessage('user-2'),
          parts: [
            {
              id: 'part-1',
              sessionID: 'session-1',
              messageID: 'user-2',
              type: 'text',
              text: 'Run tests',
            },
          ],
        })),
        shouldApplyToActiveSession: () => true,
        upsertMessageInfo,
        upsertPart,
        syncTodosFromMessages,
        requestMessageListScrollToBottom,
        syncSession: vi.fn(async () => {}),
        recheckSessionStatus: vi.fn(async () => {}),
        stopLoading,
        setError: vi.fn(),
      },
      'test',
      '--watch'
    );

    expect(result).toBe(true);
    expect(startLoading).toHaveBeenCalledTimes(1);
    expect(upsertMessageInfo).toHaveBeenCalledWith(userMessage('user-2'));
    expect(upsertPart).toHaveBeenCalledWith({
      id: 'part-1',
      sessionID: 'session-1',
      messageID: 'user-2',
      type: 'text',
      text: 'Run tests',
    });
    expect(syncTodosFromMessages).toHaveBeenCalledTimes(1);
    expect(requestMessageListScrollToBottom).toHaveBeenCalledTimes(1);
    expect(stopLoading).toHaveBeenCalledTimes(1);
  });

  it('rejects unknown slash commands', async () => {
    const setError = vi.fn();

    const result = await runSlashCommandWithDependencies(
      {
        hasCommand: () => false,
        getActiveSessionId: () => 'session-1',
        createSession: vi.fn(async () => 'session-2'),
        startLoading: vi.fn(),
        runSessionCommand: vi.fn(async () => ({ info: userMessage('user-2'), parts: [] })),
        shouldApplyToActiveSession: () => true,
        upsertMessageInfo: vi.fn(),
        upsertPart: vi.fn(),
        syncTodosFromMessages: vi.fn(),
        requestMessageListScrollToBottom: vi.fn(),
        syncSession: vi.fn(async () => {}),
        recheckSessionStatus: vi.fn(async () => {}),
        stopLoading: vi.fn(),
        setError,
      },
      'missing',
      ''
    );

    expect(result).toBe(false);
    expect(setError).toHaveBeenCalledWith('Unknown command: /missing');
  });
});
