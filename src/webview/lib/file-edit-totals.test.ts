import { describe, expect, it } from 'vitest';
import type { Part, ToolPart } from '../types';
import {
  collectFileEditTotals,
  getFileEditRuns,
  sameFileEditTotals,
  sameFileEditTotalsMap,
  type FileEditTotals,
} from './file-edit-totals';
import { getToolFileChanges } from './tool-file-change';

type Status = 'empty' | 'running' | 'completed' | 'error';

/** A Claude-style edit: OpenCode v2 stores its counts per file in `metadata.files`. */
function edit(
  id: string,
  messageID: string,
  path: string,
  status: Status = 'completed',
  counts: [number, number] = [2, 1]
): ToolPart {
  const input = { path, oldString: 'a', newString: 'b' };
  return {
    id,
    messageID,
    sessionID: 'session-1',
    type: 'tool',
    tool: 'edit',
    callID: `${id}-call`,
    state:
      status === 'empty'
        ? { status: 'pending', input: {}, raw: '' }
        : status === 'running'
          ? { status: 'running', input, title: 'edit', time: { start: 1 } }
          : status === 'error'
            ? { status: 'error', input, error: 'no match', time: { start: 1, end: 2 } }
            : {
                status: 'completed',
                input,
                output: 'ok',
                title: 'edit',
                metadata: {
                  files: [
                    { file: path, status: 'modified', additions: counts[0], deletions: counts[1] },
                  ],
                },
                time: { start: 1, end: 2 },
              },
  };
}

function text(id: string, messageID: string): Part {
  return { id, messageID, sessionID: 'session-1', type: 'text', text: 'Next.' };
}

function assistant(id: string, parts: Part[]) {
  return { info: { role: 'assistant' }, parts: parts.map((part) => ({ ...part, messageID: id })) };
}

const noParts: Part[] = [];
const user = { info: { role: 'user' }, parts: noParts };

function keyOf(path: string) {
  const part = edit('key', 'key', path);
  return getToolFileChanges(part.tool, part.state)[0]!.dedupeKey;
}

function combinedFor(totals: FileEditTotals | undefined, path: string) {
  return totals ? { edits: totals.edits, ...totals.files.get(keyOf(path)) } : undefined;
}

describe('getFileEditRuns', () => {
  it('keeps the first key and latest payload, and lists every merged edit', () => {
    const a = edit('a', 'm1', 'src/app.ts');
    const b = edit('b', 'm1', 'src/app.ts');
    const other = edit('c', 'm1', 'src/other.ts');
    const runs = getFileEditRuns([a, b, other]);

    expect(runs.map((run) => [run.key, run.part.id, run.members.map((part) => part.id)])).toEqual([
      ['a', 'b', ['a', 'b']],
      ['c', 'c', ['c']],
    ]);
  });
});

describe('collectFileEditTotals', () => {
  it('sums completed edits merged into one card within a message', () => {
    const { totals } = collectFileEditTotals(
      [
        assistant('m1', [
          edit('a', 'm1', 'src/app.ts', 'completed', [2, 1]),
          edit('b', 'm1', 'src/app.ts', 'completed', [3, 0]),
          edit('c', 'm1', 'src/app.ts', 'completed', [1, 4]),
        ]),
      ],
      null
    );

    // Keyed by the displayed (latest) part, the one the card's ToolCall renders.
    expect([...totals.keys()]).toEqual(['c']);
    expect(combinedFor(totals.get('c'), 'src/app.ts')).toEqual({
      edits: 3,
      additions: 6,
      deletions: 5,
    });
  });

  it('counts only completed edits and leaves a single completed edit on its own counts', () => {
    const running = collectFileEditTotals(
      [
        assistant('m1', [
          edit('a', 'm1', 'src/app.ts'),
          edit('b', 'm1', 'src/app.ts'),
          edit('c', 'm1', 'src/app.ts', 'running'),
        ]),
      ],
      null
    ).totals;
    expect(combinedFor(running.get('c'), 'src/app.ts')).toEqual({
      edits: 2,
      additions: 4,
      deletions: 2,
    });

    const failed = collectFileEditTotals(
      [assistant('m1', [edit('a', 'm1', 'src/app.ts'), edit('b', 'm1', 'src/app.ts', 'error')])],
      null
    ).totals;
    expect(failed.size).toBe(0);
  });

  it('adds edits that collapse into an earlier message card', () => {
    const { totals } = collectFileEditTotals(
      [
        assistant('m1', [edit('a', 'm1', 'src/app.ts', 'completed', [1, 0])]),
        assistant('m2', [edit('b', 'm2', 'src/app.ts', 'completed', [2, 1])]),
        assistant('m3', [edit('c', 'm3', 'src/app.ts', 'completed', [3, 2])]),
      ],
      null
    );

    expect([...totals.keys()]).toEqual(['a']);
    expect(combinedFor(totals.get('a'), 'src/app.ts')).toEqual({
      edits: 3,
      additions: 6,
      deletions: 3,
    });
  });

  it('follows collapse membership exactly: one leading duplicate, then a new card', () => {
    const { totals } = collectFileEditTotals(
      [
        assistant('m1', [edit('a', 'm1', 'src/app.ts')]),
        assistant('m2', [
          edit('b', 'm2', 'src/app.ts'),
          text('t', 'm2'),
          edit('c', 'm2', 'src/app.ts'),
        ]),
        assistant('m3', [edit('d', 'm3', 'src/app.ts')]),
      ],
      null
    );

    // b collapses into a's card; c starts m2's own card, which d then joins.
    expect(combinedFor(totals.get('a'), 'src/app.ts')).toEqual({
      edits: 2,
      additions: 4,
      deletions: 2,
    });
    expect(combinedFor(totals.get('c'), 'src/app.ts')).toEqual({
      edits: 2,
      additions: 4,
      deletions: 2,
    });
  });

  it('does not combine across a user message or a different file', () => {
    expect(
      collectFileEditTotals(
        [
          assistant('m1', [edit('a', 'm1', 'src/app.ts')]),
          user,
          assistant('m2', [edit('b', 'm2', 'src/app.ts')]),
        ],
        null
      ).totals.size
    ).toBe(0);
    expect(
      collectFileEditTotals(
        [
          assistant('m1', [edit('a', 'm1', 'src/app.ts')]),
          assistant('m2', [edit('b', 'm2', 'src/other.ts')]),
        ],
        null
      ).totals.size
    ).toBe(0);
  });

  it('keeps separate cards when top-level counts make the next message distinct', () => {
    const withCounts = (id: string, messageID: string, additions: number): ToolPart => ({
      ...edit(id, messageID, 'src/app.ts'),
      state: {
        status: 'completed',
        input: { path: 'src/app.ts' },
        output: 'ok',
        title: 'edit',
        metadata: { additions, deletions: 0 },
        time: { start: 1, end: 2 },
      },
    });

    expect(
      collectFileEditTotals(
        [assistant('m1', [withCounts('a', 'm1', 1)]), assistant('m2', [withCounts('b', 'm2', 2)])],
        null
      ).totals.size
    ).toBe(0);
  });

  it('ignores a held-back call without input and declines edits without counts', () => {
    expect(
      collectFileEditTotals(
        [
          assistant('m1', [edit('a', 'm1', 'src/app.ts')]),
          assistant('m2', [edit('b', 'm2', 'src/app.ts', 'empty')]),
        ],
        null
      ).totals.size
    ).toBe(0);

    const uncounted: ToolPart = {
      ...edit('b', 'm1', 'src/app.ts'),
      state: {
        status: 'completed',
        input: { path: 'src/app.ts' },
        output: 'ok',
        title: 'edit',
        metadata: {},
        time: { start: 1, end: 2 },
      },
    };
    expect(
      collectFileEditTotals([assistant('m1', [edit('a', 'm1', 'src/app.ts'), uncounted])], null)
        .totals.size
    ).toBe(0);
  });

  it('totals each file of a multi-file patch separately', () => {
    const patch = (id: string, app: [number, number], util: [number, number]): ToolPart => ({
      id,
      messageID: 'm1',
      sessionID: 'session-1',
      type: 'tool',
      tool: 'apply_patch',
      callID: `${id}-call`,
      state: {
        status: 'completed',
        input: {},
        output: '',
        title: 'apply_patch',
        metadata: {
          files: [
            { type: 'update', relativePath: 'src/app.ts', additions: app[0], deletions: app[1] },
            { type: 'update', relativePath: 'src/util.ts', additions: util[0], deletions: util[1] },
          ],
        },
        time: { start: 1, end: 2 },
      },
    });
    const first = patch('p1', [1, 0], [2, 2]);
    const second = patch('p2', [3, 1], [0, 5]);
    const { totals } = collectFileEditTotals([assistant('m1', [first, second])], null);
    const files = getToolFileChanges(second.tool, second.state);

    expect(totals.get('p2')?.files.get(files[0]!.dedupeKey)).toEqual({
      additions: 4,
      deletions: 1,
    });
    expect(totals.get('p2')?.files.get(files[1]!.dedupeKey)).toEqual({
      additions: 2,
      deletions: 7,
    });
  });

  it('carries the owning card across message ranges', () => {
    const history = collectFileEditTotals(
      [assistant('m1', [edit('a', 'm1', 'src/app.ts'), edit('b', 'm1', 'src/app.ts')])],
      null
    );
    const tail = collectFileEditTotals(
      [assistant('m2', [edit('c', 'm2', 'src/app.ts')])],
      history.chain
    );

    expect(combinedFor(history.totals.get('b'), 'src/app.ts')?.edits).toBe(2);
    // The tail entry includes the history card's own edits and overrides it when merged.
    expect(combinedFor(tail.totals.get('b'), 'src/app.ts')).toEqual({
      edits: 3,
      additions: 6,
      deletions: 3,
    });
  });
});

describe('file edit totals stability', () => {
  it('reuses unchanged totals so unrelated updates notify no card', () => {
    const first = collectFileEditTotals(
      [assistant('m1', [edit('a', 'm1', 'src/app.ts'), edit('b', 'm1', 'src/app.ts')])],
      null
    ).totals;
    const next = collectFileEditTotals(
      [
        assistant('m1', [edit('a', 'm1', 'src/app.ts'), edit('b', 'm1', 'src/app.ts')]),
        assistant('m2', [text('t', 'm2'), edit('z', 'm2', 'src/other.ts', 'running')]),
      ],
      null,
      first
    ).totals;

    expect(next.get('b')).toBe(first.get('b'));
    expect(sameFileEditTotalsMap(first, next)).toBe(true);
  });

  it('compares totals structurally', () => {
    const files = new Map([['edited:a', { additions: 1, deletions: 0 }]]);
    expect(sameFileEditTotals({ edits: 2, files }, { edits: 2, files: new Map(files) })).toBe(true);
    expect(sameFileEditTotals({ edits: 2, files }, { edits: 3, files })).toBe(false);
    expect(
      sameFileEditTotals(
        { edits: 2, files },
        { edits: 2, files: new Map([['edited:a', { additions: 2, deletions: 0 }]]) }
      )
    ).toBe(false);
    expect(sameFileEditTotals(undefined, undefined)).toBe(true);
  });
});
