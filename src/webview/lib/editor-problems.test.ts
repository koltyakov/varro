import { expect, it } from 'vitest';
import type { EditorContext } from '../../shared/protocol';
import {
  formatEditorProblems,
  getEditorIssueCount,
  getProblemsSeverity,
  cloneInlineProblems,
  formatInlineProblem,
  parseInlineProblem,
  problemReferenceLabel,
  problemReferenceLocation,
  problemReferenceSeverity,
  attachedProblemKeys,
  uniqueProblems,
  deduplicateInlineProblems,
  problemReferenceMarker,
} from './editor-problems';

it('recognizes the same diagnostic across equivalent paths, codes, and whitespace', () => {
  const problem = {
    path: 'C:\\repo\\a.ts',
    line: 1,
    severity: 'error' as const,
    source: 'ts',
    code: 2307,
    message: 'Cannot\nfind module',
  };
  expect(
    uniqueProblems([
      problem,
      {
        ...problem,
        path: 'c:/repo/a.ts',
        source: ' TS ',
        code: '2307',
        message: 'Cannot find module',
      },
    ])
  ).toHaveLength(1);
  expect(uniqueProblems([problem, { ...problem, column: 9 }])).toHaveLength(2);
});

it('excludes problems already covered by bulb attachments or inline groups', () => {
  const a = { path: '/repo/a.ts', line: 1, severity: 'error' as const, message: 'A' };
  const b = { ...a, path: '/repo/b.ts', message: 'B' };
  const c = { ...a, path: '/repo/c.ts', message: 'C' };
  const group = { id: 'group', diagnostic: b, group: [b] };
  const seen = attachedProblemKeys(problemReferenceMarker(group), [group], [a]);
  expect(uniqueProblems([a, b, c, c], seen)).toEqual([c]);
});

it('removes overlapping payloads without losing other group members', () => {
  const a = { path: '/repo/a.ts', line: 1, severity: 'error' as const, message: 'Error A' };
  const b = { ...a, path: '/repo/b.ts', message: 'Error B' };
  const individual = { id: 'a', diagnostic: a };
  const group = { id: 'all', diagnostic: a, group: [a, b, b] };
  const repeated = { id: 'b', diagnostic: b };
  const text = `Explain ${problemReferenceMarker(individual)} ${problemReferenceMarker(group)} ${problemReferenceMarker(repeated)} ${problemReferenceMarker(group)}`;
  const normalized = deduplicateInlineProblems(text, [individual, group, repeated], [a]);
  expect(normalized.references).toEqual([{ ...group, diagnostic: b, group: [b] }]);
  expect(normalized.text.split(problemReferenceMarker(group))).toHaveLength(3);
  expect(normalized.text).not.toContain(problemReferenceMarker(individual));
  expect(normalized.text).not.toContain(problemReferenceMarker(repeated));
  expect(formatInlineProblem(normalized.references[0]!).match(/Error B/g)).toHaveLength(1);
});

it('keeps an All selection as a grouped snapshot with a count and highest-severity icon', () => {
  const warning = {
    path: '/repo/a.ts',
    line: 1,
    severity: 'warning' as const,
    message: 'Warning detail',
  };
  const error = {
    path: '/repo/b.ts',
    line: 2,
    severity: 'error' as const,
    message: 'Error detail',
  };
  const reference = { id: 'all', diagnostic: warning, group: [warning, error] };
  expect(problemReferenceLabel(reference)).toBe('Problems');
  expect(problemReferenceLocation(reference)).toBe('2');
  expect(problemReferenceSeverity(reference)).toBe('error');
  expect(parseInlineProblem(formatInlineProblem(reference))).toEqual(reference);
  expect(
    parseInlineProblem(`[Problem all]\n${JSON.stringify({ diagnostic: error, group: [] })}`)
  ).toBeNull();
  const copy = cloneInlineProblems([reference]);
  warning.message = 'Changed';
  expect(copy[0]?.group?.[0]?.message).toBe('Warning detail');
});

it.each([
  ['[VS Code problems for a.ts: 1 errors, 5 warnings]\nWARNING a.ts:1\nSelected warning', 'error'],
  ['[VS Code problems for a.ts: 0 errors, 2 warnings]\nWARNING a.ts:1\nWarning', 'warning'],
  ['[Attached diagnostics: 2 of 2]\nWARNING a.ts:1 - Warning\nERROR b.ts:2 - Error', 'error'],
  ['[Attached diagnostics: 1 of 1]\nINFO a.ts:1 - Information', 'info'],
])('uses the highest severity from the full snapshot: %s', (text, severity) => {
  expect(getProblemsSeverity(text)).toBe(severity);
});

it('keeps automatic counts and messages scoped to the current file even with mixed diagnostics', () => {
  const context: EditorContext = {
    workspacePath: '/repo',
    activeFile: { path: '/repo/a.ts', relativePath: 'a.ts', language: 'typescript' },
    selection: null,
    diagnosticCounts: { errors: 2, warnings: 0 },
    diagnostics: [
      { path: '/repo/a.ts', line: 1, severity: 'error', message: 'Current file error' },
      { path: '/repo/b.ts', line: 1, severity: 'error', message: 'Other file error' },
    ],
  };
  expect(getEditorIssueCount(context)).toBe(1);
  expect(formatEditorProblems(context)).toContain('1 errors, 0 warnings');
  expect(formatEditorProblems(context)).toContain('Current file error');
  expect(formatEditorProblems(context)).not.toContain('Other file error');
  context.activeFile = { path: '/repo/clean.ts', relativePath: 'clean.ts', language: 'typescript' };
  expect(getEditorIssueCount(context)).toBe(0);
  expect(formatEditorProblems(context)).toBeNull();
});
