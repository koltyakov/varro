import { describe, expect, it } from 'vitest';
import type { ReasoningPart, ToolPart } from '../types';
import {
  formatAssistantActivitySummary,
  getAssistantActivityGroupMap,
  getAssistantActivityStatus,
  isAssistantActivityPart,
} from './assistant-activity';

function completedTool(id: string, tool: string, input: Record<string, unknown> = {}): ToolPart {
  return {
    id,
    sessionID: 'session-1',
    messageID: 'assistant-1',
    type: 'tool',
    callID: `call-${id}`,
    tool,
    state: {
      status: 'completed',
      input,
      output: 'ok',
      title: tool,
      metadata: {},
      time: { start: 1, end: 2 },
    },
  };
}

function reasoning(id: string, end?: number): ReasoningPart {
  return {
    id,
    sessionID: 'session-1',
    messageID: 'assistant-1',
    type: 'reasoning',
    text: 'Thinking',
    time: { start: 1, ...(end === undefined ? {} : { end }) },
  };
}

describe('assistant activity summaries', () => {
  it('counts activity in a stable, human-readable order', () => {
    const parts = [
      completedTool('grep-1', 'grep'),
      reasoning('reasoning-1', 2),
      completedTool('read-1', 'read', { filePath: 'src/a.ts' }),
      completedTool('read-2', 'read', { filePath: 'src/b.ts' }),
      completedTool('bash-1', 'bash'),
      completedTool('custom-1', 'mcp.custom'),
    ];

    expect(formatAssistantActivitySummary(parts)).toBe(
      'Explored 2 files, 1 thought, 1 search, 1 command, 1 tool call'
    );
  });

  it('detects streaming reasoning and pending or running tools', () => {
    const pending: ToolPart = {
      ...completedTool('pending-1', 'glob'),
      state: { status: 'pending', input: {}, raw: '' },
    };

    expect(getAssistantActivityStatus([reasoning('reasoning-1')]).running).toBe(true);
    expect(getAssistantActivityStatus([pending]).running).toBe(true);
    expect(getAssistantActivityStatus([completedTool('read-1', 'read')]).running).toBe(false);
    expect(formatAssistantActivitySummary([pending])).toBe('Exploring 1 search');
  });

  it('surfaces failed tools in the collapsed summary', () => {
    const failed: ToolPart = {
      ...completedTool('bash-1', 'bash'),
      state: {
        status: 'error',
        input: { command: 'npm test' },
        error: 'Tests failed',
        time: { start: 1, end: 2 },
      },
    };

    expect(getAssistantActivityStatus([failed])).toEqual({ running: false, failed: 1, aborted: 0 });
    expect(formatAssistantActivitySummary([failed])).toBe('Explored 1 command · 1 tool failed');
  });

  it('keeps agent and subtask activity outside compact groups', () => {
    expect(isAssistantActivityPart(completedTool('read-1', 'read'))).toBe(true);
    expect(isAssistantActivityPart(completedTool('task-1', 'task'))).toBe(false);
    expect(
      isAssistantActivityPart({
        id: 'agent-1',
        sessionID: 'session-1',
        messageID: 'assistant-1',
        type: 'agent',
        name: 'explore',
      })
    ).toBe(false);
    expect(
      isAssistantActivityPart({
        id: 'subtask-1',
        sessionID: 'session-1',
        messageID: 'assistant-1',
        type: 'subtask',
        prompt: 'Inspect the code',
        description: 'Explore code',
        agent: 'explore',
      })
    ).toBe(false);
    expect(
      isAssistantActivityPart({
        id: 'text-1',
        sessionID: 'session-1',
        messageID: 'assistant-1',
        type: 'text',
        text: 'Result',
      })
    ).toBe(false);
  });

  it('groups routine activity across primary assistant messages in one user turn', () => {
    const command = completedTool('bash-1', 'bash');
    const thought = reasoning('reasoning-1', 2);
    const messages = [
      {
        info: {
          id: 'user-1',
          sessionID: 'session-1',
          role: 'user' as const,
          time: { created: 0 },
          agent: 'build',
          model: { providerID: 'provider-1', modelID: 'model-1' },
        },
        parts: [],
      },
      {
        info: {
          id: 'assistant-1',
          sessionID: 'session-1',
          role: 'assistant' as const,
          time: { created: 1, completed: 2 },
          parentID: 'user-1',
          modelID: 'model-1',
          providerID: 'provider-1',
          mode: 'default',
          path: { cwd: '/', root: '/' },
          cost: 0,
          tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
        },
        parts: [command],
      },
      {
        info: {
          id: 'assistant-2',
          sessionID: 'session-1',
          role: 'assistant' as const,
          time: { created: 3, completed: 4 },
          parentID: 'user-1',
          modelID: 'model-1',
          providerID: 'provider-1',
          mode: 'default',
          path: { cwd: '/', root: '/' },
          cost: 0,
          tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
        },
        parts: [thought],
      },
    ];

    const groups = getAssistantActivityGroupMap(messages);
    const firstGroup = groups.get('assistant-1')?.[0];
    const secondMessageGroup = groups.get('assistant-2')?.[0];

    expect(firstGroup).toBe(secondMessageGroup);
    expect(firstGroup).toMatchObject({
      ownerMessageId: 'assistant-1',
      ownerPartId: 'bash-1',
    });
    expect(firstGroup?.parts.map((part) => part.id)).toEqual(['bash-1', 'reasoning-1']);
    expect(getAssistantActivityGroupMap(messages.slice(1)).get('assistant-1')?.[0]?.key).toBe(
      firstGroup?.key
    );
  });

  it('starts a new activity group after visible response text', () => {
    const command = completedTool('bash-1', 'bash');
    const thought = reasoning('reasoning-1', 2);
    const messages = [
      {
        info: {
          id: 'assistant-1',
          sessionID: 'session-1',
          role: 'assistant' as const,
          time: { created: 1, completed: 2 },
          parentID: 'user-1',
          modelID: 'model-1',
          providerID: 'provider-1',
          mode: 'default',
          path: { cwd: '/', root: '/' },
          cost: 0,
          tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
        },
        parts: [
          command,
          {
            id: 'text-1',
            sessionID: 'session-1',
            messageID: 'assistant-1',
            type: 'text' as const,
            text: 'First response',
          },
          thought,
        ],
      },
    ];

    expect(
      getAssistantActivityGroupMap(messages)
        .get('assistant-1')
        ?.map((group) => group.parts.map((part) => part.id))
    ).toEqual([['bash-1'], ['reasoning-1']]);
  });
});
