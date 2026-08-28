import { describe, expect, it } from 'vitest';
import type { ReasoningPart, ToolPart } from '../types';
import {
  formatAssistantActivitySummary,
  getAssistantActivityGroupMap,
  getAssistantActivityStatus,
  isAssistantActivityPart,
  preserveAssistantActivityGroupKeys,
  shouldCompactAssistantActivityPart,
} from './assistant-activity';
import type { UnknownRecord } from '../../shared/type-utils';

function completedTool(id: string, tool: string, input: UnknownRecord = {}): ToolPart {
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
  const time: ReasoningPart['time'] = { start: 1 };
  if (end !== undefined) time.end = end;
  return {
    id,
    sessionID: 'session-1',
    messageID: 'assistant-1',
    type: 'reasoning',
    text: 'Thinking',
    time,
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
      'Explored: 2 files, 1 thought, 1 search, 1 command, 1 tool call'
    );
  });

  it('counts every modified file in multi-file edit tools', () => {
    const patch = completedTool('patch-1', 'apply_patch', {
      patchText: `*** Begin Patch
*** Add File: src/new.ts
+export const created = true;
*** Update File: src/app.ts
@@
-const value = 1;
+const value = 2;
*** Delete File: src/old.ts
*** End Patch`,
    });

    expect(formatAssistantActivitySummary([patch])).toBe('Explored: 3 edits');
  });

  it('uses canonical alias classification for activity summaries', () => {
    expect(
      formatAssistantActivitySummary([
        completedTool('write-1', 'functions.file_write', { filePath: 'src/app.ts' }),
      ])
    ).toBe('Explored: 1 edit');
  });

  it('detects streaming reasoning and pending or running tools', () => {
    const pending: ToolPart = {
      ...completedTool('pending-1', 'glob'),
      state: { status: 'pending', input: {}, raw: '' },
    };

    expect(getAssistantActivityStatus([reasoning('reasoning-1')]).running).toBe(true);
    expect(getAssistantActivityStatus([pending]).running).toBe(true);
    expect(getAssistantActivityStatus([completedTool('read-1', 'read')]).running).toBe(false);
    expect(formatAssistantActivitySummary([pending])).toBe('Explored: 1 search');
  });

  it('omits failed tools from the collapsed summary', () => {
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
    expect(formatAssistantActivitySummary([failed])).toBe('Explored: 1 command');
  });

  it('includes aborted tools as another activity count', () => {
    const aborted: ToolPart = {
      ...completedTool('bash-1', 'bash'),
      state: {
        status: 'error',
        input: { command: 'npm test' },
        error: 'Tool execution aborted',
        time: { start: 1, end: 2 },
      },
    };

    expect(formatAssistantActivitySummary([aborted])).toBe('Explored: 1 tool aborted');
    expect(formatAssistantActivitySummary([completedTool('read-1', 'read'), aborted])).toBe(
      'Explored: 1 file, 1 tool aborted'
    );
  });

  it('keeps actionable and delegated activity outside compact groups', () => {
    expect(isAssistantActivityPart(completedTool('read-1', 'read'))).toBe(true);
    expect(isAssistantActivityPart(completedTool('question-1', 'question'))).toBe(false);
    expect(isAssistantActivityPart(completedTool('question-2', 'functions.question'))).toBe(false);
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

  it('keeps only active-turn edits outside compact activity', () => {
    const edit = completedTool('edit-1', 'edit');
    const read = completedTool('read-1', 'read');

    expect(
      shouldCompactAssistantActivityPart(edit, {
        keepEditInline: true,
        keepReasoningInline: false,
      })
    ).toBe(false);
    expect(
      shouldCompactAssistantActivityPart(edit, {
        keepEditInline: false,
        keepReasoningInline: false,
      })
    ).toBe(true);
    expect(
      shouldCompactAssistantActivityPart(edit, {
        keepEditInline: true,
        keepReasoningInline: false,
      })
    ).toBe(false);
    expect(
      shouldCompactAssistantActivityPart(read, {
        keepEditInline: true,
        keepReasoningInline: false,
      })
    ).toBe(true);
  });

  it('keeps active-turn reasoning outside compact activity when configured', () => {
    const thought = reasoning('reasoning-1', 2);

    expect(
      shouldCompactAssistantActivityPart(thought, {
        keepEditInline: false,
        keepReasoningInline: true,
      })
    ).toBe(false);
    expect(
      shouldCompactAssistantActivityPart(thought, {
        keepEditInline: false,
        keepReasoningInline: false,
      })
    ).toBe(true);
  });

  it('keeps subject-only active reasoning in compact activity', () => {
    const thought = { ...reasoning('reasoning-1', 2), text: '**Planning**' };

    expect(
      shouldCompactAssistantActivityPart(thought, {
        keepEditInline: false,
        keepReasoningInline: true,
      })
    ).toBe(true);
  });

  it('keeps active apply_patch calls outside compact activity', () => {
    const patch: ToolPart = {
      ...completedTool('patch-1', 'functions.apply_patch'),
      state: { status: 'pending', input: {}, raw: '' },
    };

    expect(
      shouldCompactAssistantActivityPart(patch, {
        keepEditInline: false,
        keepReasoningInline: false,
      })
    ).toBe(false);

    patch.state = {
      status: 'completed',
      input: {},
      output: 'Done',
      title: 'apply_patch',
      metadata: {},
      time: { start: 1, end: 2 },
    };
    expect(
      shouldCompactAssistantActivityPart(patch, {
        keepEditInline: false,
        keepReasoningInline: false,
      })
    ).toBe(true);
  });

  it('keeps active anonymous tools outside compact activity', () => {
    const tool: ToolPart = {
      ...completedTool('anonymous-1', ''),
      state: {
        status: 'running',
        input: {},
        title: 'apply_patch',
        time: { start: 1 },
      },
    };

    expect(
      shouldCompactAssistantActivityPart(tool, {
        keepEditInline: false,
        keepReasoningInline: false,
      })
    ).toBe(false);

    tool.state = {
      status: 'completed',
      input: {},
      output: 'Done',
      title: 'apply_patch',
      metadata: {},
      time: { start: 1, end: 2 },
    };
    expect(
      shouldCompactAssistantActivityPart(tool, {
        keepEditInline: false,
        keepReasoningInline: false,
      })
    ).toBe(true);
  });

  it('groups routine activity across primary assistant messages in one user turn', () => {
    const command = completedTool('bash-1', 'bash');
    const thought = { ...reasoning('reasoning-1', 2), messageID: 'assistant-2' };
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

    const initialWindow = getAssistantActivityGroupMap(messages.slice(2));
    const prependedWindow = getAssistantActivityGroupMap(messages.slice(1));
    expect(prependedWindow.get('assistant-2')?.[0]?.key).not.toBe(
      initialWindow.get('assistant-2')?.[0]?.key
    );

    const preserved = preserveAssistantActivityGroupKeys(prependedWindow, initialWindow);
    expect(preserved.get('assistant-1')?.[0]?.key).toBe(initialWindow.get('assistant-2')?.[0]?.key);
    expect(preserved.get('assistant-2')?.[0]).toBe(preserved.get('assistant-1')?.[0]);
    expect(preserved.get('assistant-1')?.[0]).toMatchObject({
      ownerMessageId: 'assistant-1',
      ownerPartId: 'bash-1',
    });
  });

  it('keeps a pinned summary owner while parallel activity continues joining its group', () => {
    const earlier = completedTool('command-earlier', 'bash');
    const later = { ...completedTool('command-later', 'bash'), messageID: 'assistant-2' };
    const previousGroup = {
      key: 'activity-later',
      ownerMessageId: 'assistant-2',
      ownerPartId: later.id,
      parts: [later],
    };
    const currentGroup = {
      key: 'activity-earlier',
      ownerMessageId: 'assistant-1',
      ownerPartId: earlier.id,
      parts: [earlier, later],
    };
    const previous = new Map([['assistant-2', [previousGroup]]]);
    const current = new Map([
      ['assistant-1', [currentGroup]],
      ['assistant-2', [currentGroup]],
    ]);

    const pinned = preserveAssistantActivityGroupKeys(current, previous, {
      pinPreviousOwner: () => true,
    });
    expect(pinned.get('assistant-1')?.[0]).toMatchObject({
      key: 'activity-later',
      ownerMessageId: 'assistant-2',
      ownerPartId: later.id,
      ownerPinned: true,
    });

    const carried = preserveAssistantActivityGroupKeys(current, pinned);
    expect(carried.get('assistant-1')?.[0]).toMatchObject({
      ownerMessageId: 'assistant-2',
      ownerPartId: later.id,
      ownerPinned: true,
    });
  });

  it('releases a pinned summary owner after its part leaves the group', () => {
    const remaining = completedTool('command-remaining', 'bash');
    const removedOwner = {
      ...completedTool('command-removed', 'bash'),
      messageID: 'assistant-2',
    };
    const previousGroup = {
      key: 'activity-pinned',
      ownerMessageId: 'assistant-2',
      ownerPartId: removedOwner.id,
      ownerPinned: true,
      parts: [remaining, removedOwner],
    };
    const currentGroup = {
      key: 'activity-current',
      ownerMessageId: 'assistant-1',
      ownerPartId: remaining.id,
      parts: [remaining],
    };

    const preserved = preserveAssistantActivityGroupKeys(
      new Map([['assistant-1', [currentGroup]]]),
      new Map([
        ['assistant-1', [previousGroup]],
        ['assistant-2', [previousGroup]],
      ])
    );

    expect(preserved.get('assistant-1')?.[0]).toMatchObject({
      key: 'activity-pinned',
      ownerMessageId: 'assistant-1',
      ownerPartId: remaining.id,
    });
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

  it('keeps completed questions between separate activity groups', () => {
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
          completedTool('read-1', 'read'),
          completedTool('question-1', 'question'),
          completedTool('grep-1', 'grep'),
        ],
      },
    ];

    expect(
      getAssistantActivityGroupMap(messages)
        .get('assistant-1')
        ?.map((group) => group.parts.map((part) => part.id))
    ).toEqual([['read-1'], ['grep-1']]);
  });
});
