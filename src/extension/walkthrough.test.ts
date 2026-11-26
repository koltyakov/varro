import { describe, expect, it } from 'vitest';
import {
  buildWalkthroughDigest,
  buildWalkthroughPrompt,
  DEFAULT_WALKTHROUGH_DIGEST_CHARS,
  MAX_WALKTHROUGH_DIGEST_CHARS,
  normalizeWalkthrough,
  parseUnifiedDiff,
  renderWalkthroughMarkdown,
  walkthroughDigestBudget,
  WalkthroughTooLargeError,
} from './walkthrough';

const GIT_DIFF = [
  'diff --git a/src/limits.ts b/src/limits.ts',
  'index 1111111..2222222 100644',
  '--- a/src/limits.ts',
  '+++ b/src/limits.ts',
  '@@ -1,3 +1,4 @@ export function reset()',
  ' const a = 1;',
  '-const b = 2;',
  '+const b = 3;',
  '+const c = 4;',
  '@@ -10,2 +11,2 @@',
  ' keep();',
  '--- removed line that looks like a header',
  'diff --git a/src/new.ts b/src/new.ts',
  'new file mode 100644',
  '--- /dev/null',
  '+++ b/src/new.ts',
  '@@ -0,0 +1 @@',
  '+export const fresh = true;',
  'diff --git a/package-lock.json b/package-lock.json',
  '--- a/package-lock.json',
  '+++ b/package-lock.json',
  '@@ -1 +1 @@',
  '-"version": "1"',
  '+"version": "2"',
].join('\n');

describe('walkthrough diff parsing', () => {
  it('parses git diffs into files and hunks, keeping removed lines that resemble headers', () => {
    const files = parseUnifiedDiff(GIT_DIFF, 'staged');
    expect(files.map((file) => [file.path, file.status, file.generated])).toEqual([
      ['src/limits.ts', 'modified', false],
      ['src/new.ts', 'added', false],
      ['package-lock.json', 'modified', true],
    ]);
    expect(files[0]!.hunks).toHaveLength(2);
    expect(files[0]!.hunks[1]!.lines).toEqual([
      ' keep();',
      '--- removed line that looks like a header',
    ]);
    expect(files[0]).toMatchObject({ additions: 2, deletions: 2 });
    expect(files[0]!.hunks[0]!.newStart).toBe(1);
  });

  it('parses patches without a git header', () => {
    const files = parseUnifiedDiff(
      [
        'Index: src/app.ts',
        '===================================================================',
        '--- src/app.ts\t',
        '+++ src/app.ts\t',
        '@@ -4,1 +4,1 @@',
        '-old();',
        '+next();',
      ].join('\n'),
      'unstaged'
    );
    expect(files).toHaveLength(1);
    expect(files[0]).toMatchObject({ path: 'src/app.ts', additions: 1, deletions: 1 });
  });
});

describe('walkthrough generation', () => {
  it('shows the model aliases only and keeps generated files out of its input', () => {
    const files = parseUnifiedDiff(GIT_DIFF, 'staged');
    const { digest, hunkByAlias } = buildWalkthroughDigest(files);
    expect([...hunkByAlias.keys()]).toEqual(['h1', 'h2', 'h3']);
    expect(digest).toContain('[h1] @@ -1,3 +1,4 @@ export function reset()');
    expect(digest).toContain('FILE package-lock.json (modified, +1 -1): generated file');
    expect(digest).not.toContain('"version": "2"');
    const prompt = buildWalkthroughPrompt(digest, 'Staged changes');
    expect(prompt).toContain('----- BEGIN UNTRUSTED STAGED CHANGES DIFF -----');
    // Brief by design: few stops, short explanations, trivial changes folded into "minor".
    expect(prompt).toContain('never more than 8');
    expect(prompt).toContain('Summarize them together in "minor"');
  });

  it('leaves tests and then docs out before refusing a diff that does not fit', () => {
    const body = (count: number) =>
      Array.from({ length: count }, (_, index) => `+line ${index} ${'x'.repeat(40)}`);
    const patch = (path: string, count: number) =>
      [`--- a/${path}`, `+++ b/${path}`, `@@ -0,0 +1,${count} @@`, ...body(count)].join('\n');
    const files = parseUnifiedDiff(
      [
        patch('src/core.ts', 400),
        patch('src/core.test.ts', 2_000),
        patch('docs/usage.md', 2_000),
      ].join('\n'),
      'unstaged'
    );
    const { digest, hunkByAlias } = buildWalkthroughDigest(files, 60_000);
    expect(digest.length).toBeLessThanOrEqual(60_000);
    expect([...hunkByAlias.values()].map((hunk) => hunk.path)).toEqual(['src/core.ts']);
    expect(digest).toContain(
      'FILE src/core.test.ts (modified, +2000 -0): content not shown to fit'
    );
    expect(files.map((file) => file.omitted ?? false)).toEqual([false, true, true]);
    const walkthrough = normalizeWalkthrough(
      { title: 'Core', stops: [{ title: 'Core', hunks: ['h1'], explanation: 'x' }] },
      files,
      hunkByAlias
    );
    expect(walkthrough.uncovered.map((entry) => entry.note)).toEqual([
      'not sent to the model, to fit the request',
      'not sent to the model, to fit the request',
    ]);

    const source = parseUnifiedDiff(patch('src/big.ts', 4_000), 'unstaged');
    expect(() => buildWalkthroughDigest(source, 60_000)).toThrow(WalkthroughTooLargeError);
  });

  it('sizes the walkthrough budget to half the context window, within bounds', () => {
    expect(walkthroughDigestBudget(null)).toBe(DEFAULT_WALKTHROUGH_DIGEST_CHARS);
    expect(walkthroughDigestBudget(128_000)).toBe(192_000);
    expect(walkthroughDigestBudget(1_000_000)).toBe(MAX_WALKTHROUGH_DIGEST_CHARS);
    expect(walkthroughDigestBudget(8_000)).toBe(60_000);
  });

  it('drops unknown or reused aliases and reports what no stop covers', () => {
    const files = parseUnifiedDiff(GIT_DIFF, 'staged');
    const { hunkByAlias } = buildWalkthroughDigest(files);
    const walkthrough = normalizeWalkthrough(
      {
        title: 'Reset limits',
        focus: 'Limits reset sooner.',
        stops: [
          {
            title: 'New reset values',
            importance: 'key',
            hunks: ['h1', 'h99'],
            explanation: 'The reset now uses `b = 3`.',
            observations: [
              { kind: 'decision', note: 'Three, not four.' },
              { kind: 'verdict', note: 'Looks good' },
            ],
          },
          { title: 'Reuse', importance: 'normal', hunks: ['h1'], explanation: 'Dropped.' },
          { title: 'Fresh module', importance: 'context', hunks: ['h3'], explanation: 'Adds it.' },
        ],
        minor: 'Reformats the `keep()` call.',
      },
      files,
      hunkByAlias
    );
    expect(walkthrough.stops.map((stop) => stop.title)).toEqual([
      'New reset values',
      'Fresh module',
    ]);
    expect(walkthrough.minor).toBe('Reformats the `keep()` call.');
    expect(walkthrough.stops[0]!.observations).toEqual([
      { kind: 'decision', note: 'Three, not four.' },
    ]);
    expect(
      walkthrough.uncovered.map((entry) => [entry.file.path, entry.hunks.length, entry.note])
    ).toEqual([
      ['src/limits.ts', 1, null],
      ['package-lock.json', 1, 'generated, not sent to the model'],
    ]);
  });

  it('renders a Markdown report with anchors, exact hunks, and escaped model prose', () => {
    const files = parseUnifiedDiff(GIT_DIFF, 'staged');
    const { hunkByAlias } = buildWalkthroughDigest(files);
    const walkthrough = normalizeWalkthrough(
      {
        title: 'Reset <b>limits</b>',
        focus: 'See [here](https://example.com).',
        stops: [
          {
            title: 'Values',
            importance: 'key',
            hunks: ['h1', 'h2', 'h3'],
            explanation: '# not a heading',
            observations: [],
          },
        ],
        minor: 'Bumps the lockfile.',
      },
      files,
      hunkByAlias
    );
    const markdown = renderWalkthroughMarkdown(walkthrough, files, {
      scopeLabel: 'Staged changes',
      modelLabel: 'openai/gpt-5',
      generatedAt: new Date(0),
      linkFor: (path, line) => `vscode://file/repo/${path}:${line}`,
    });
    expect(markdown).toContain('# Walkthrough: Reset &lt;b&gt;limits&lt;/b&gt;');
    expect(markdown).toContain('> See \\[here\\](https://example.com).');
    expect(markdown).toContain('1. [Values](#1-values) · Key change');
    expect(markdown).toContain('## 1. Values');
    expect(markdown).toContain('\\# not a heading');
    // One header for both hunks of a file, each start line linked; no file: links, which the preview drops.
    expect(markdown).toContain(
      '[**`src/limits.ts`**](<vscode://file/repo/src/limits.ts:1>) · [L1](<vscode://file/repo/src/limits.ts:1>) · [L11](<vscode://file/repo/src/limits.ts:11>)\n\n```diff\n@@ -1,3 +1,4 @@ export function reset()\n const a = 1;'
    );
    expect(markdown.match(/src\/limits\.ts`\*\*\]/g)).toHaveLength(1);
    expect(markdown).toContain('**`src/new.ts`**');
    expect(markdown).not.toContain('file:');
    expect(markdown).toContain('Staged changes · 3 files · +4 −3 · openai/gpt-5');
    expect(markdown).toContain(
      '## Also changed\n\nBumps the lockfile.\n\nNot explained above: [`package-lock.json`](<vscode://file/repo/package-lock.json:1>) (generated, not sent to the model)'
    );
  });
});
