import { describe, expect, it } from 'vitest';
import type { Part, ToolPart, ToolState } from '../types';
import {
  getDiffFileChanges,
  getMessageFileChanges,
  getToolChangePath,
  getToolFileChange,
  getToolFileChanges,
  getToolFileChangeSignature,
  getToolReadPath,
  isToolFileRead,
} from './tool-file-change';

function toolPart(tool: string, state: ToolState): Part {
  return {
    id: `part-${tool}`,
    sessionID: 'session-1',
    messageID: 'message-1',
    type: 'tool',
    callID: `call-${tool}`,
    tool,
    state,
  } as Part;
}

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
    expect(
      getToolReadPath('file_read', {
        status: 'pending',
        input: { filePath: 'src/app.ts' },
        raw: '',
      })
    ).toBe('src/app.ts');
    expect(
      getToolReadPath('bash', { status: 'pending', input: { filePath: 'src/app.ts' }, raw: '' })
    ).toBeNull();
  });

  it('infers added, removed, and edited changes from tool names and metadata', () => {
    expect(getToolFileChange('create', completedState({ path: 'src/new.ts' }))).toEqual({
      kind: 'added',
      path: 'src/new.ts',
      dedupeKey: 'added:src/new.ts',
    });

    expect(
      getToolFileChange(
        'delete',
        completedState({ file_path: 'src/old.ts' }, { metadata: { status: 'deleted' } })
      )
    ).toEqual({
      kind: 'removed',
      path: 'src/old.ts',
      dedupeKey: 'removed:src/old.ts',
    });

    expect(
      getToolFileChange(
        'custom_tool',
        completedState({ filename: 'src/app.ts' }, { title: 'Modified src/app.ts' })
      )
    ).toEqual({
      kind: 'edited',
      path: 'src/app.ts',
      dedupeKey: 'edited:src/app.ts',
    });
  });

  it('detects moves from explicit paths or titles', () => {
    expect(
      getToolFileChange('rename', completedState({ fromPath: 'src/old.ts', toPath: 'src/new.ts' }))
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

  it('extracts OpenCode write metadata paths', () => {
    expect(
      getToolFileChange(
        'write',
        completedState(
          {},
          { metadata: { filepath: '/repo/src/app.ts', additions: 4, deletions: 1 } }
        )
      )
    ).toEqual({
      kind: 'edited',
      path: '/repo/src/app.ts',
      additions: 4,
      deletions: 1,
      dedupeKey: 'edited:/repo/src/app.ts',
    });
  });

  it('extracts multi-file apply_patch metadata', () => {
    const state = completedState(
      {},
      {
        metadata: {
          files: [
            {
              type: 'add',
              filePath: '/repo/src/new.ts',
              relativePath: 'src/new.ts',
              additions: 2,
              deletions: 0,
            },
            {
              type: 'update',
              filePath: '/repo/src/app.ts',
              relativePath: 'src/app.ts',
              additions: 3,
              deletions: 1,
            },
            {
              type: 'move',
              filePath: '/repo/src/old.ts',
              movePath: '/repo/src/renamed.ts',
              relativePath: 'src/renamed.ts',
              additions: 0,
              deletions: 0,
            },
          ],
        },
      }
    );

    expect(getToolFileChanges('apply_patch', state)).toEqual([
      {
        kind: 'added',
        path: 'src/new.ts',
        additions: 2,
        deletions: 0,
        dedupeKey: 'added:src/new.ts',
      },
      {
        kind: 'edited',
        path: 'src/app.ts',
        additions: 3,
        deletions: 1,
        dedupeKey: 'edited:src/app.ts',
      },
      {
        kind: 'moved',
        path: '/repo/src/renamed.ts',
        fromPath: '/repo/src/old.ts',
        toPath: '/repo/src/renamed.ts',
        additions: 0,
        deletions: 0,
        dedupeKey: 'moved:/repo/src/old.ts->/repo/src/renamed.ts',
      },
    ]);
    expect(getToolFileChangeSignature('apply_patch', state)).toBe(
      'added:src/new.ts|edited:src/app.ts|moved:/repo/src/old.ts->/repo/src/renamed.ts'
    );
  });

  it('extracts apply_patch file changes from running patch input', () => {
    const state: ToolState = {
      status: 'running',
      input: {
        patchText: `*** Begin Patch
*** Add File: src/new.ts
+export const value = true;
*** Update File: src/app.ts
@@
-old
+new
*** Update File: src/old.ts
*** Move to: src/renamed.ts
@@
-old
+new
*** Delete File: src/gone.ts
*** End Patch`,
      },
      title: 'apply_patch',
      metadata: {},
      time: { start: 0 },
    };

    expect(getToolFileChanges('functions.apply_patch', state)).toEqual([
      { kind: 'added', path: 'src/new.ts', dedupeKey: 'added:src/new.ts' },
      { kind: 'edited', path: 'src/app.ts', dedupeKey: 'edited:src/app.ts' },
      {
        kind: 'moved',
        path: 'src/renamed.ts',
        fromPath: 'src/old.ts',
        toPath: 'src/renamed.ts',
        dedupeKey: 'moved:src/old.ts->src/renamed.ts',
      },
      { kind: 'removed', path: 'src/gone.ts', dedupeKey: 'removed:src/gone.ts' },
    ]);
  });

  it('returns null when there is no recognizable file change', () => {
    expect(getToolFileChange('bash', completedState({ command: 'pwd' }))).toBeNull();
    expect(getToolFileChange('tool', completedState({}, { title: 'Updated value' }))).toBeNull();
  });

  it('does not mistake URLs or plain dotted strings for file paths', () => {
    expect(
      getToolFileChange('tool', completedState({}, { title: 'Updated https://example.com' }))
    ).toBeNull();
    expect(
      getToolFileChange('tool', completedState({}, { title: 'Updated example.com' }))
    ).toBeNull();
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

  it('collects deduplicated file changes across messages including diff summaries', () => {
    const messages = [
      {
        info: {
          summary: { diffs: [{ file: 'src/app.ts', before: '', after: 'x', additions: 5 }] },
        },
        parts: [],
      },
      {
        parts: [
          toolPart(
            'edit',
            completedState({ path: 'src/app.ts', additions: 2, deletions: 1 }, { title: 'Edited' })
          ),
          toolPart('edit', completedState({ path: 'src/util.ts', additions: 3 })),
          // A patch part for a real file (with an extension) is kept as an edit.
          { type: 'patch', files: ['src/touched.ts'] } as Part,
        ],
      },
    ];

    expect(getMessageFileChanges(messages)).toEqual([
      {
        kind: 'edited',
        path: 'src/app.ts',
        additions: 7,
        deletions: 1,
        dedupeKey: 'edited:src/app.ts',
      },
      {
        kind: 'edited',
        path: 'src/util.ts',
        additions: 3,
        dedupeKey: 'edited:src/util.ts',
      },
      {
        kind: 'edited',
        path: 'src/touched.ts',
        dedupeKey: 'edited:src/touched.ts',
      },
    ]);
  });

  it('builds file changes from a session diff summary, inferring kind', () => {
    expect(
      getDiffFileChanges([
        { file: 'src/new.ts', before: '', after: 'export {}', additions: 1, deletions: 0 },
        { file: 'src/app.ts', before: 'a', after: 'b', additions: 2, deletions: 2 },
        { file: 'src/gone.ts', before: 'x', after: '', additions: 0, deletions: 3 },
      ])
    ).toEqual([
      {
        kind: 'added',
        path: 'src/new.ts',
        additions: 1,
        deletions: 0,
        dedupeKey: 'added:src/new.ts',
      },
      {
        kind: 'edited',
        path: 'src/app.ts',
        additions: 2,
        deletions: 2,
        dedupeKey: 'edited:src/app.ts',
      },
      {
        kind: 'removed',
        path: 'src/gone.ts',
        additions: 0,
        deletions: 3,
        dedupeKey: 'removed:src/gone.ts',
      },
    ]);
  });

  it('merges absolute and relative paths and drops directory entries', () => {
    const workspace = '/repo';
    const messages = [
      {
        parts: [
          // Directory-level change that should be filtered out.
          toolPart('create', completedState({ path: 'src' })),
          toolPart(
            'edit',
            completedState({ path: '/repo/src/app.ts', additions: 4, deletions: 2 })
          ),
        ],
      },
      // Same file reported by a patch part using the relative path.
      { parts: [{ type: 'patch', files: ['src/app.ts'] } as Part] },
    ];

    expect(getMessageFileChanges(messages, workspace)).toEqual([
      {
        kind: 'edited',
        path: 'src/app.ts',
        additions: 4,
        deletions: 2,
        dedupeKey: 'edited:src/app.ts',
      },
    ]);
  });

  it('drops standalone directory entries while keeping edited files', () => {
    const messages = [
      {
        parts: [
          // Pre-existing directory reported as a change; no line counts.
          toolPart('create', completedState({ path: 'src/extension' })),
          toolPart('edit', completedState({ path: 'src/webview/App.tsx', additions: 3 })),
          // Extensionless file that carries real edits stays.
          toolPart('edit', completedState({ path: 'Makefile', additions: 1, deletions: 1 })),
        ],
      },
    ];

    expect(getMessageFileChanges(messages).map((change) => change.path)).toEqual([
      'src/webview/App.tsx',
      'Makefile',
    ]);
  });
});
