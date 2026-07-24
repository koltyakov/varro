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

  it('retains edit input content for inline rendering', () => {
    expect(
      getToolFileChange(
        'edit',
        completedState({
          filePath: 'src/app.ts',
          oldString: 'const value = 1;',
          newString: 'const value = 2;',
        })
      )
    ).toEqual({
      kind: 'edited',
      path: 'src/app.ts',
      before: 'const value = 1;',
      after: 'const value = 2;',
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
              patch: '@@ -0,0 +1,2 @@\n+one\n+two',
            },
            {
              type: 'update',
              filePath: '/repo/src/app.ts',
              relativePath: 'src/app.ts',
              additions: 3,
              deletions: 1,
              patch: '@@ -1 +1 @@\n-old\n+new',
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
        patch: '@@ -0,0 +1,2 @@\n+one\n+two',
        dedupeKey: 'added:src/new.ts',
      },
      {
        kind: 'edited',
        path: 'src/app.ts',
        additions: 3,
        deletions: 1,
        patch: '@@ -1 +1 @@\n-old\n+new',
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
      {
        kind: 'added',
        path: 'src/new.ts',
        patch: '+export const value = true;',
        patchFormat: 'headerless',
        additions: 1,
        deletions: 0,
        dedupeKey: 'added:src/new.ts',
      },
      {
        kind: 'edited',
        path: 'src/app.ts',
        patch: '@@\n-old\n+new',
        patchFormat: 'headerless',
        additions: 1,
        deletions: 1,
        dedupeKey: 'edited:src/app.ts',
      },
      {
        kind: 'moved',
        path: 'src/renamed.ts',
        fromPath: 'src/old.ts',
        toPath: 'src/renamed.ts',
        patch: '@@\n-old\n+new',
        patchFormat: 'headerless',
        additions: 1,
        deletions: 1,
        dedupeKey: 'moved:src/old.ts->src/renamed.ts',
      },
      {
        kind: 'removed',
        path: 'src/gone.ts',
        additions: 0,
        deletions: 0,
        dedupeKey: 'removed:src/gone.ts',
      },
    ]);
  });

  it('merges completed apply_patch metadata with input patches by path', () => {
    const state = completedState(
      {
        patchText: `*** Begin Patch
*** Update File: src/app.ts
@@
-old
+new
*** Update File: src/old.ts
*** Move to: src/renamed.ts
@@
-before
+after
*** Add File: src/input-only.ts
+export const inputOnly = true;
*** End Patch`,
      },
      {
        metadata: {
          files: [
            {
              type: 'update',
              filePath: '/repo/src/app.ts',
              relativePath: 'src/app.ts',
              additions: 1,
              deletions: 1,
              patch: '--- a/src/app.ts\n+++ b/src/app.ts',
            },
            {
              type: 'move',
              filePath: '/repo/src/old.ts',
              movePath: '/repo/src/renamed.ts',
              additions: 0,
              deletions: 0,
            },
          ],
        },
      }
    );

    expect(getToolFileChanges('apply_patch', state)).toEqual([
      {
        kind: 'edited',
        path: 'src/app.ts',
        patch: '@@\n-old\n+new',
        patchFormat: 'headerless',
        additions: 1,
        deletions: 1,
        dedupeKey: 'edited:src/app.ts',
      },
      {
        kind: 'moved',
        path: '/repo/src/renamed.ts',
        fromPath: '/repo/src/old.ts',
        toPath: '/repo/src/renamed.ts',
        patch: '@@\n-before\n+after',
        patchFormat: 'headerless',
        additions: 0,
        deletions: 0,
        dedupeKey: 'moved:/repo/src/old.ts->/repo/src/renamed.ts',
      },
      {
        kind: 'added',
        path: 'src/input-only.ts',
        patch: '+export const inputOnly = true;',
        patchFormat: 'headerless',
        additions: 1,
        deletions: 0,
        dedupeKey: 'added:src/input-only.ts',
      },
    ]);
  });

  it('keeps path-only apply_patch metadata without classifying generic file metadata as edits', () => {
    expect(
      getToolFileChanges(
        'apply_patch',
        completedState(
          {},
          {
            metadata: {
              files: [{ relativePath: 'assets/data.bin', additions: 0, deletions: 0 }],
            },
          }
        )
      )
    ).toEqual([
      {
        kind: 'edited',
        path: 'assets/data.bin',
        additions: 0,
        deletions: 0,
        dedupeKey: 'edited:assets/data.bin',
      },
    ]);

    expect(
      getToolFileChanges(
        'search',
        completedState(
          {},
          {
            metadata: {
              files: [{ type: 'file', filePath: '/repo/src/app.ts', relativePath: 'src/app.ts' }],
            },
          }
        )
      )
    ).toEqual([]);
  });

  it('merges source-path metadata with an input move destination', () => {
    const state = completedState(
      {
        patchText: `*** Begin Patch
*** Update File: src/old.ts
*** Move to: src/new.ts
@@
-old
+new
*** End Patch`,
      },
      {
        metadata: {
          files: [{ type: 'update', relativePath: 'src/old.ts', additions: 1, deletions: 1 }],
        },
      }
    );

    expect(getToolFileChanges('apply_patch', state)).toEqual([
      {
        kind: 'moved',
        path: 'src/new.ts',
        fromPath: 'src/old.ts',
        toPath: 'src/new.ts',
        patch: '@@\n-old\n+new',
        patchFormat: 'headerless',
        additions: 1,
        deletions: 1,
        dedupeKey: 'moved:src/old.ts->src/new.ts',
      },
    ]);
  });

  it('matches metadata one-to-one without merging a move source with a separate add', () => {
    const state = completedState(
      {
        patchText: `*** Begin Patch
*** Add File: src/a.ts
+replacement
*** Update File: src/a.ts
*** Move to: src/b.ts
@@
-original
+moved
*** End Patch`,
      },
      {
        metadata: {
          files: [
            {
              type: 'move',
              filePath: 'src/a.ts',
              movePath: 'src/b.ts',
              additions: 1,
              deletions: 1,
            },
            { type: 'add', relativePath: 'src/a.ts', additions: 1, deletions: 0 },
          ],
        },
      }
    );

    expect(getToolFileChanges('apply_patch', state)).toEqual([
      {
        kind: 'moved',
        path: 'src/b.ts',
        fromPath: 'src/a.ts',
        toPath: 'src/b.ts',
        patch: '@@\n-original\n+moved',
        patchFormat: 'headerless',
        additions: 1,
        deletions: 1,
        dedupeKey: 'moved:src/a.ts->src/b.ts',
      },
      {
        kind: 'added',
        path: 'src/a.ts',
        patch: '+replacement',
        patchFormat: 'headerless',
        additions: 1,
        deletions: 0,
        dedupeKey: 'added:src/a.ts',
      },
    ]);
  });

  it('lets explicit add and delete input kinds override untyped metadata fallbacks', () => {
    const state = completedState(
      {
        patchText: `*** Begin Patch
*** Add File: src/new.ts
+new
*** Delete File: src/gone.ts
-gone
*** End Patch`,
      },
      {
        metadata: {
          files: [
            { relativePath: 'src/new.ts', additions: 1, deletions: 0 },
            { relativePath: 'src/gone.ts', additions: 0, deletions: 1 },
          ],
        },
      }
    );

    expect(
      getToolFileChanges('apply_patch', state).map(({ kind, path }) => ({ kind, path }))
    ).toEqual([
      { kind: 'added', path: 'src/new.ts' },
      { kind: 'removed', path: 'src/gone.ts' },
    ]);
  });

  it('bounds model patch bytes and emits one explicit overflow summary', () => {
    const state: ToolState = {
      status: 'running',
      input: {
        patchText: `*** Begin Patch\n*** Add File: src/large.ts\n+${'x'.repeat(1_100_000)}\n*** Add File: src/unscanned.ts\n+late`,
      },
      title: 'apply_patch',
      metadata: {},
      time: { start: 0 },
    };

    const changes = getToolFileChanges('apply_patch', state);
    expect(changes).toHaveLength(2);
    expect(changes[0]).toMatchObject({
      kind: 'added',
      path: 'src/large.ts',
      previewStatus: 'truncated',
    });
    expect(changes[0]?.patch).toBeUndefined();
    expect(changes[1]).toMatchObject({
      isSummary: true,
      previewStatus: 'truncated',
    });
    expect(changes[1]?.previewMessage).toContain('1 MB input limit');
  });

  it('shares metadata preview budgets without hiding a valid input patch fallback', () => {
    const largePatch = `@@\n+${'x'.repeat(300 * 1024)}`;
    const metadataOnly = getToolFileChanges(
      'apply_patch',
      completedState(
        {},
        {
          metadata: {
            files: Array.from({ length: 3 }, (_, index) => ({
              type: 'update',
              relativePath: `src/metadata-${index}.ts`,
              patch: largePatch,
            })),
          },
        }
      )
    );

    expect(metadataOnly).toHaveLength(3);
    expect(metadataOnly.every((change) => change.patch === undefined)).toBe(true);
    expect(metadataOnly.every((change) => change.previewStatus === 'truncated')).toBe(true);
    expect(metadataOnly[2]?.previewMessage).toContain('total inline patch content limit');

    const merged = getToolFileChanges(
      'apply_patch',
      completedState(
        {
          patchText: `*** Begin Patch
*** Update File: src/app.ts
@@
-old
+new
*** End Patch`,
        },
        {
          metadata: {
            files: [{ type: 'update', relativePath: 'src/app.ts', patch: largePatch }],
          },
        }
      )
    );
    expect(merged[0]).toMatchObject({ path: 'src/app.ts', patch: '@@\n-old\n+new' });
    expect(merged[0]?.previewStatus).toBeUndefined();
  });

  it('keeps truncated input state when its patch replaces metadata context', () => {
    const merged = getToolFileChanges(
      'apply_patch',
      completedState(
        {
          patchText: `*** Begin Patch
*** Update File: src/app.ts
@@
-old
+${'x'.repeat(300 * 1024)}
*** End Patch`,
        },
        {
          metadata: {
            files: [
              {
                type: 'update',
                relativePath: 'src/app.ts',
                patch: '@@ -1 +1 @@\n context only',
                before: 'old',
                after: 'new',
              },
            ],
          },
        }
      )
    );

    expect(merged[0]).toMatchObject({
      path: 'src/app.ts',
      patch: '@@\n-old',
      before: 'old',
      after: 'new',
      previewStatus: 'truncated',
    });
    expect(merged[0]?.previewMessage).toContain('file patch section exceeds');
  });

  it('caps file count and total stored section work', () => {
    const manyFilesPatch = [
      '*** Begin Patch',
      ...Array.from(
        { length: 70 },
        (_, index) => `*** Add File: src/file-${index}.ts\n+line ${index}`
      ),
      '*** End Patch',
    ].join('\n');
    const manyFiles = getToolFileChanges('apply_patch', {
      status: 'running',
      input: { patchText: manyFilesPatch },
      title: 'apply_patch',
      metadata: {},
      time: { start: 0 },
    });

    expect(manyFiles.filter((change) => !change.isSummary)).toHaveLength(64);
    expect(manyFiles.at(-1)).toMatchObject({ isSummary: true, previewStatus: 'truncated' });
    expect(manyFiles.at(-1)?.previewMessage).toContain('after 64 files');

    const oversizedSection = getToolFileChanges('apply_patch', {
      status: 'running',
      input: {
        patchText: [
          '*** Begin Patch',
          '*** Add File: src/oversized-section.ts',
          ...Array.from({ length: 2_100 }, (_, index) => `+line ${index}`),
          '*** Add File: src/after-section.ts',
          '+after',
          '*** End Patch',
        ].join('\n'),
      },
      title: 'apply_patch',
      metadata: {},
      time: { start: 0 },
    });

    expect(oversizedSection).toHaveLength(2);
    expect(oversizedSection[0]).toMatchObject({
      path: 'src/oversized-section.ts',
      previewStatus: 'truncated',
    });
    expect(oversizedSection[0]?.previewMessage).toContain('file patch section exceeds');
    expect(oversizedSection[1]).toMatchObject({
      path: 'src/after-section.ts',
      patch: '+after',
    });

    const sectionLines = Array.from({ length: 1_200 }, (_, index) => `+line ${index}`).join('\n');
    const storedWork = getToolFileChanges('apply_patch', {
      status: 'running',
      input: {
        patchText: [
          '*** Begin Patch',
          ...Array.from(
            { length: 4 },
            (_, index) => `*** Add File: src/section-${index}.ts\n${sectionLines}`
          ),
          '*** End Patch',
        ].join('\n'),
      },
      title: 'apply_patch',
      metadata: {},
      time: { start: 0 },
    });

    expect(storedWork).toHaveLength(4);
    expect(storedWork[3]).toMatchObject({
      path: 'src/section-3.ts',
      previewStatus: 'truncated',
    });
    expect(storedWork[3]?.previewMessage).toContain('total inline patch content limit');
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
