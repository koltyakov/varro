import { describe, expect, it } from 'vitest';
import type { Message, ToolPart } from '../types';
import { resolveTaskSessionId } from './task-session';

describe('task session resolution', () => {
  it('does not attribute a child created after the next user turn', () => {
    const tool: ToolPart = {
      id: 'tool-1',
      sessionID: 'session-1',
      messageID: 'assistant-1',
      type: 'tool',
      callID: 'call-1',
      tool: 'task',
      state: {
        status: 'completed',
        input: { description: 'Research the issue' },
        output: '',
        title: 'Research the issue',
        metadata: {},
        time: { start: 1_100, end: 1_500 },
      },
    };
    const parent = {
      id: 'assistant-1',
      sessionID: 'session-1',
      role: 'assistant',
      time: { created: 1_000, completed: 1_500 },
    } as Message;

    expect(
      resolveTaskSessionId(
        tool,
        [{ info: parent, parts: [tool] }],
        [
          {
            id: 'late-child',
            parentID: 'session-1',
            title: 'Research the issue',
            time: { created: 2_500 },
          },
        ],
        2_000
      )
    ).toBeNull();

    const toolWithMetadata: ToolPart = {
      ...tool,
      state: { ...tool.state, metadata: { sessionId: 'late-child' } },
    };
    expect(
      resolveTaskSessionId(
        toolWithMetadata,
        [{ info: parent, parts: [toolWithMetadata] }],
        [
          {
            id: 'late-child',
            parentID: 'session-1',
            title: 'Research the issue',
            time: { created: 2_500 },
          },
        ],
        2_000
      )
    ).toBeNull();
  });
});
