import { describe, expect, it, vi } from 'vitest';
import { projectDeferredPart } from './message-content';
import { getToolFileChanges } from '../shared/tool-file-change';
import type { ToolPart } from '../shared/opencode-types';
import { getSearchResultCount } from '../shared/tool-summary';

describe('deferred history content', () => {
  const base = { id: 'part-1', sessionID: 'session-1', messageID: 'message-1' };

  it('does not construct deferred URLs for unchanged ordinary text', () => {
    const encode = vi.spyOn(globalThis, 'encodeURIComponent');
    try {
      for (let index = 0; index < 10_000; index++) {
        const part = { ...base, id: `text-${index}`, type: 'text', text: 'Ordinary text' };
        expect(projectDeferredPart(part, '/workspace')).toBe(part);
      }
      expect(encode.mock.calls.length).toBe(0);
    } finally {
      encode.mockRestore();
    }
  });

  it('preserves unchanged reasoning, files without URLs, and small tools by identity', () => {
    const parts = [
      { ...base, type: 'reasoning', text: 'x'.repeat(513), time: { start: 1 } },
      { ...base, type: 'reasoning', text: 'x'.repeat(512), time: { start: 1, end: 2 } },
      { ...base, type: 'file', mime: 'image/png' },
      ...['bash', 'question', 'todowrite'].map((tool) => ({
        ...base,
        type: 'tool',
        tool,
        state: { status: 'completed', input: {}, output: 'done', metadata: {} },
      })),
    ];
    for (const part of parts) expect(projectDeferredPart(part, '/workspace')).toBe(part);
  });

  it.each([undefined, '/work space/文?%#'])(
    'preserves exact scoped references and projected fields with directory %s',
    (directory) => {
      const identity = { sessionID: 'session/one', messageID: 'message ?%', id: 'part#é' };
      const reference =
        '/session/session%2Fone/message/message%20%3F%25/part/part%23%C3%A9' +
        (directory ? '?directory=%2Fwork%20space%2F%E6%96%87%3F%25%23' : '');
      const file = { ...identity, type: 'file', url: 'data:image/png;base64,original' };
      expect(projectDeferredPart(file, directory)).toEqual({
        ...file,
        url: `varro-content:${reference}`,
      });
      expect(file.url).toBe('data:image/png;base64,original');

      const reasoning = {
        ...identity,
        type: 'reasoning',
        text: 'r'.repeat(513),
        time: { start: 1, end: 2 },
        metadata: { private: 'details' },
      };
      expect(projectDeferredPart(reasoning, directory)).toEqual({
        ...reasoning,
        text: 'r'.repeat(512),
        metadata: undefined,
        deferred: reference,
      });
      expect(reasoning.text).toHaveLength(513);
      expect(reasoning.metadata).toEqual({ private: 'details' });

      const tool = {
        ...identity,
        type: 'tool',
        tool: 'bash',
        state: {
          status: 'completed',
          input: { command: 'npm test' },
          output: 'o'.repeat(513),
          title: 'Run tests',
          metadata: {},
          time: { start: 1, end: 2 },
        },
      };
      expect(projectDeferredPart(tool, directory)).toEqual({
        ...tool,
        deferred: reference,
        metadata: undefined,
        state: {
          ...tool.state,
          output: 'o'.repeat(512),
          error: undefined,
          raw: undefined,
          attachments: undefined,
          deferredFiles: [],
        },
      });
      expect(tool.state.output).toHaveLength(513);
    }
  );

  it.each(['bash', 'question', 'todowrite'])(
    'projects %s attachments while preserving the tool body and untouched attachment identities',
    (tool) => {
      const file = { ...base, type: 'file', url: 'data:image/png;base64,original' };
      const text = { ...base, id: 'text', type: 'text', text: 'Attachment text' };
      const part = {
        ...base,
        type: 'tool',
        tool,
        state: {
          status: 'completed',
          input: {},
          output: tool === 'bash' ? 'done' : 'full body'.repeat(1000),
          metadata: {},
          attachments: [file, text, null],
        },
      };
      const projected = projectDeferredPart(part, '/work space');
      expect(projected).toEqual({
        ...part,
        state: {
          ...part.state,
          attachments: [
            {
              ...file,
              url: 'varro-content:/session/session-1/message/message-1/part/part-1?directory=%2Fwork%20space',
            },
            text,
            null,
          ],
        },
      });
      expect(projected.state.attachments[1]).toBe(text);
      expect(projected.state.input).toBe(part.state.input);
      expect(projected.state.metadata).toBe(part.state.metadata);
      expect(part.state.attachments[0]).toBe(file);
      expect(file.url).toBe('data:image/png;base64,original');
    }
  );

  it('bounds running output and wide metadata without losing the running state or tool input', () => {
    const part = {
      ...base,
      type: 'tool',
      tool: 'bash',
      state: {
        status: 'running',
        input: { command: 'npm test' },
        time: { start: 100 },
        metadata: {
          output: 'line\n'.repeat(100000),
          entries: Array.from({ length: 10000 }, () => ({ title: 'label'.repeat(1000) })),
        },
      },
    };
    const projected = projectDeferredPart(part);
    expect(JSON.stringify(projected).length).toBeLessThan(20_000);
    expect(projected.state).toMatchObject({
      status: 'running',
      input: { command: 'npm test' },
      time: { start: 100 },
    });
    expect(projected.deferred).toContain('/part/part-1');
    expect(part.state.metadata.output.length).toBe(500000);
  });

  it('preserves complete search counts and paths while omitting long tool bodies', () => {
    const part: ToolPart = {
      ...base,
      type: 'tool',
      tool: 'glob',
      callID: 'call-1',
      state: {
        status: 'completed',
        input: { path: `/workspace/${'directory/'.repeat(60)}` },
        title: 'Find files',
        output: Array.from({ length: 100 }, (_, index) => `src/file-${index}.ts`).join('\n'),
        metadata: {},
        time: { start: 1, end: 2 },
      },
    };
    const projected = projectDeferredPart(part);
    expect(projected.state.input.path).toBe(part.state.input.path);
    expect(getSearchResultCount(projected.tool, projected.state)).toEqual({
      count: 100,
      truncated: false,
    });
    expect(projected.deferred).toBeTruthy();
  });

  it('retains file-change identities and counts without sending patches or snapshots', () => {
    const part: ToolPart = {
      ...base,
      type: 'tool',
      tool: 'apply_patch',
      callID: 'call-1',
      state: {
        status: 'completed',
        input: {
          patchText: `*** Begin Patch\n*** Add File: src/new.ts\n+${'code'.repeat(50_000)}\n*** End Patch`,
        },
        title: 'Patched files',
        output: 'done',
        metadata: {},
        time: { start: 1, end: 2 },
      },
    };
    const projected = projectDeferredPart(part);
    expect(JSON.stringify(projected).length).toBeLessThan(3000);
    const changes = getToolFileChanges(projected.tool, projected.state);
    expect(changes).toHaveLength(1);
    expect(changes[0]).toMatchObject({ path: 'src/new.ts', kind: 'added', additions: 1 });
    expect(changes[0]?.after).toBeUndefined();
    expect(changes[0]?.patch).toBeUndefined();
  });

  it('keeps image identity and labels without transferring the original', () => {
    const original = {
      ...base,
      type: 'file',
      mime: 'image/png',
      filename: 'shot.png',
      url: `data:image/png;base64,${'a'.repeat(100_000)}`,
    };
    const projected = projectDeferredPart(original, '/workspace');
    expect(projected.url).toMatch(/^varro-content:/);
    expect(projected.filename).toBe(original.filename);
    expect(JSON.stringify(projected).length).toBeLessThan(1000);
    expect(original.url.length).toBeGreaterThan(100_000);
  });

  it('defers completed reasoning and tool bodies but preserves live activity', () => {
    const text = `**Checking the implementation**\n\n${'detail '.repeat(10_000)}`;
    const reasoning = { ...base, type: 'reasoning', text, time: { start: 1, end: 2 } };
    expect(projectDeferredPart(reasoning).text.length).toBeLessThan(600);
    expect(projectDeferredPart(reasoning).deferred).toBeTruthy();
    const live = { ...reasoning, time: { start: 1 } };
    expect(projectDeferredPart(live)).toBe(live);
    const tool = {
      ...base,
      type: 'tool',
      tool: 'bash',
      state: {
        status: 'completed',
        input: { command: 'npm test' },
        output: text,
        metadata: {},
        time: { start: 1, end: 2 },
      },
    };
    const projected = projectDeferredPart(tool);
    expect(JSON.stringify(projected).length).toBeLessThan(2000);
    expect(projected.state.input.command).toBe('npm test');
    expect(projected.deferred).toBeTruthy();
  });
});
