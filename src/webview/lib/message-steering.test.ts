import { describe, expect, it } from 'vitest';
import type { AssistantMessage, MessageEntry, UserMessage } from '../types';
import { SESSION_RESUME_PROMPT } from '../../shared/session-pauses';
import { collectSteeringMessages } from './message-steering';

function prompt(id: string, created: number, sessionID = 'session-1'): MessageEntry<UserMessage> {
  return {
    info: {
      id,
      sessionID,
      role: 'user',
      time: { created },
      agent: 'build',
      model: { providerID: 'openai', modelID: 'test' },
    },
    parts: [{ id: `${id}-text`, sessionID, messageID: id, type: 'text', text: id }],
  };
}

function response(
  id: string,
  changes: Partial<AssistantMessage> = {}
): MessageEntry<AssistantMessage> {
  return {
    info: {
      id,
      sessionID: 'session-1',
      role: 'assistant',
      time: { created: 2 },
      parentID: 'prompt',
      modelID: 'test',
      providerID: 'openai',
      mode: 'build',
      path: { cwd: '/repo', root: '/repo' },
      cost: 0,
      tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
      ...changes,
    },
    parts: [],
  };
}

describe('collectSteeringMessages', () => {
  it('uses retained delivery for background steering and queued follow-ups without full history', () => {
    const steer = prompt('background-steer', 10);
    steer.info.delivery = 'steer';
    const queued = prompt('queued', 11);
    queued.info.delivery = 'queue';
    expect([...collectSteeringMessages([steer, queued]).ids]).toEqual(['background-steer']);
  });
  it.each([undefined, 'tool_calls'])(
    'finds steering across assistant activity with finish=%s',
    (finish) => {
      const activity = response(
        'activity',
        finish ? { finish, time: { created: 2, completed: 3 } } : {}
      );
      const messages = [prompt('prompt', 1), activity, prompt('steer', 4)];
      expect([...collectSteeringMessages(messages).ids]).toEqual(['steer']);
    }
  );

  it('retains classification when an earlier assistant finishes after the steer arrived', () => {
    const messages = [
      prompt('prompt', 1),
      response('answer', { finish: 'stop', time: { created: 2, completed: 5 } }),
      prompt('steer', 3),
      response('continuation', { finish: 'stop', time: { created: 6, completed: 7 } }),
      prompt('next-turn', 8),
    ];
    expect([...collectSteeringMessages(messages).ids]).toEqual(['steer']);
  });

  it('keeps queued follow-ups after completion as ordinary prompts', () => {
    expect([
      ...collectSteeringMessages([
        prompt('prompt', 1),
        response('answer', { finish: 'stop', time: { created: 2, completed: 3 } }),
        prompt('queued-follow-up', 4),
      ]).ids,
    ]).toEqual([]);
  });

  it('ignores pending steers, automatic notices, compaction and split metadata', () => {
    const pending = prompt('pending', 3);
    pending.info.pendingDelivery = 'steer';
    const automatic = prompt('automatic', 4);
    automatic.parts = [
      {
        id: 'automatic-text',
        messageID: 'automatic',
        sessionID: 'session-1',
        type: 'text',
        text: '<shell id="test" state="completed">Done</shell>',
        synthetic: true,
      },
    ];
    const compaction = prompt('compaction', 5);
    compaction.parts = [
      {
        id: 'compact-part',
        messageID: 'compaction',
        sessionID: 'session-1',
        type: 'compaction',
        auto: true,
      },
    ];
    expect([
      ...collectSteeringMessages([
        prompt('prompt', 1),
        response('activity'),
        pending,
        automatic,
        compaction,
        { ...prompt('metadata-only', 6), parts: [] },
        prompt('delivered', 7),
      ]).ids,
    ]).toEqual(['delivered']);
  });

  it('carries unfinished turns through history segments without mixing sessions', () => {
    const history = collectSteeringMessages([prompt('prompt', 1), response('activity')]);
    const tail = collectSteeringMessages(
      [prompt('child-prompt', 3, 'child'), prompt('steer', 4)],
      history
    );
    expect([...tail.ids]).toEqual(['steer']);
    expect([...history.ids]).toEqual([]);
  });

  it('does not treat the resume action as a steer or a retry as a completed turn', () => {
    const resume = prompt('resume', 3);
    resume.parts = [
      {
        id: 'resume-text',
        messageID: 'resume',
        sessionID: 'session-1',
        type: 'text',
        text: SESSION_RESUME_PROMPT,
      },
    ];
    expect([
      ...collectSteeringMessages([
        prompt('prompt', 1),
        response('retry', {
          finish: 'error',
          retry: { attempt: 1, at: 4 },
          time: { created: 2, completed: 3 },
        }),
        resume,
        prompt('steer', 5),
      ]).ids,
    ]).toEqual(['steer']);
  });
});
