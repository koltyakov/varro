import { describe, expect, it } from 'vitest';
import { projectDeferredPart } from './message-content';
import { getToolFileChanges } from '../shared/tool-file-change';
import type { ToolPart } from '../shared/opencode-types';
import { getSearchResultCount } from '../shared/tool-summary';

describe('deferred history content', () => {
  const base = { id: 'part-1', sessionID: 'session-1', messageID: 'message-1' };

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
