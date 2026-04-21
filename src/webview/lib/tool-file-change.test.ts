import { describe, expect, it } from 'vitest';
import type { ToolPart, ToolState } from '../types';
import {
  getToolChangePath,
  getToolFileChange,
  getToolReadPath,
  isToolFileRead,
} from './tool-file-change';

function completedState(
  input: Record<string, unknown> = {},
  overrides: Partial<Extract<ToolState, { status: 'completed' }>> = {}
): Extract<ToolState, { status: 'completed' }> {
  return {
    status: 'completed',
    input,
    output: '',
    title: '',
    metadata: {},
    time: { start: 0, end: 1 },
    ...overrides,
  };
}

describe('tool file change helpers', () => {
  it('detects file read tools and extracts read paths', () => {
    expect(isToolFileRead(' read ')).toBe(true);
    expect(isToolFileRead('bash')).toBe(false);
    expect(getToolReadPath('file_read', { status: 'pending', input: { filePath: 'src/app.ts' }, raw: '' })).toBe(
      'src/app.ts'
    );
    expect(getToolReadPath('bash', { status: 'pending', input: { filePath: 'src/app.ts' }, raw: '' })).toBeNull();
  });

  it('infers added, removed, and edited changes from tool names and metadata', () => {
    expect(getToolFileChange('create', completedState({ path: 'src/new.ts' }))).toEqual({
      kind: 'added',
      path: 'src/new.ts',
      dedupeKey: 'added:src/new.ts',
    });

    expect(
      getToolFileChange('delete', completedState({ file_path: 'src/old.ts' }, { metadata: { status: 'deleted' } }))
    ).toEqual({
      kind: 'removed',
      path: 'src/old.ts',
      dedupeKey: 'removed:src/old.ts',
    });

    expect(
      getToolFileChange('custom_tool', completedState({ filename: 'src/app.ts' }, { title: 'Modified src/app.ts' }))
    ).toEqual({
      kind: 'edited',
      path: 'src/app.ts',
      dedupeKey: 'edited:src/app.ts',
    });
  });

  it('detects moves from explicit paths or titles', () => {
    expect(
      getToolFileChange(
        'rename',
        completedState({ fromPath: 'src/old.ts', toPath: 'src/new.ts' })
      )
    ).toEqual({
      kind: 'moved',
      path: 'src/new.ts',
      fromPath: 'src/old.ts',
      toPath: 'src/new.ts',
      dedupeKey: 'moved:src/old.ts->src/new.ts',
    });

    expect(
      getToolFileChange('tool', completedState({}, { title: 'Moved `src/old.ts` -> `src/new.ts`' }))
    ).toEqual({
      kind: 'moved',
      path: 'src/new.ts',
      fromPath: 'src/old.ts',
      toPath: 'src/new.ts',
      dedupeKey: 'moved:src/old.ts->src/new.ts',
    });
  });

  it('returns null when there is no recognizable file change', () => {
    expect(getToolFileChange('bash', completedState({ command: 'pwd' }))).toBeNull();
    expect(getToolFileChange('tool', completedState({}, { title: 'Updated value' }))).toBeNull();
  });

  it('reuses cached results for the same tool state object', () => {
    const state = completedState({ path: 'src/app.ts' }, { title: 'Edited src/app.ts' });
    const first = getToolFileChange('edit', state);
    const second = getToolFileChange('edit', state);
    expect(second).toBe(first);
  });

  it('extracts the change path from tool parts', () => {
    const part: ToolPart = {
      id: 'part-1',
      sessionID: 'session-1',
      messageID: 'message-1',
      type: 'tool',
      callID: 'call-1',
      tool: 'edit',
      state: completedState({ path: 'src/app.ts' }),
    };

    expect(getToolChangePath(part)).toBe('src/app.ts');
  });
});
