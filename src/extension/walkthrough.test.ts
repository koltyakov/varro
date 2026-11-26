import { describe, expect, it } from 'vitest';
import {
  buildWalkthroughDigest,
  buildWalkthroughPrompt,
  MAX_WALKTHROUGH_DIGEST_CHARS,
  normalizeWalkthrough,
  parseUnifiedDiff,
  renderWalkthroughMarkdown,
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

  it('parses OpenCode session patches without a git header', () => {
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
      'session',
      'src/app.ts'
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
    expect(buildWalkthroughPrompt(digest, 'Staged changes')).toContain(
      '----- BEGIN UNTRUSTED STAGED CHANGES DIFF -----'
    );
  });

  it('refuses a diff that does not fit instead of truncating it', () => {
    const body = Array.from({ length: 4_000 }, (_, index) => `+line ${index} ${'x'.repeat(40)}`);
    const files = parseUnifiedDiff(
      ['--- a/big.ts', '+++ b/big.ts', '@@ -0,0 +1,4000 @@', ...body].join('\n'),
      'unstaged'
    );
    expect(() => buildWalkthroughDigest(files)).toThrow(WalkthroughTooLargeError);
    expect(MAX_WALKTHROUGH_DIGEST_CHARS).toBeLessThan(body.join('\n').length);
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
        routine: [{ path: 'src/limits.ts', note: 'Formatting only' }],
      },
      files,
      hunkByAlias
    );
    expect(walkthrough.stops.map((stop) => stop.title)).toEqual([
      'New reset values',
      'Fresh module',
    ]);
    expect(walkthrough.stops[0]!.observations).toEqual([
      { kind: 'decision', note: 'Three, not four.' },
    ]);
    expect(
      walkthrough.uncovered.map((entry) => [entry.file.path, entry.hunks.length, entry.note])
    ).toEqual([
      ['src/limits.ts', 1, 'Formatting only'],
      ['package-lock.json', 1, 'Generated file, not sent to the model'],
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
        routine: [],
      },
      files,
      hunkByAlias
    );
    const markdown = renderWalkthroughMarkdown(walkthrough, files, {
      scopeLabel: 'Staged changes',
      modelLabel: 'openai/gpt-5',
      generatedAt: new Date(0),
      linkFor: (path, line) => `file:///repo/${path}#L${line}`,
    });
    expect(markdown).toContain('# Walkthrough: Reset &lt;b&gt;limits&lt;/b&gt;');
    expect(markdown).toContain('> See \\[here\\](https://example.com).');
    expect(markdown).toContain('1. [Values](#1-values) · Key change');
    expect(markdown).toContain('## 1. Values');
    expect(markdown).toContain('\\# not a heading');
    expect(markdown).toContain('**[`src/limits.ts`](file:///repo/src/limits.ts#L1)** · line 1');
    expect(markdown).toContain('```diff\n@@ -1,3 +1,4 @@ export function reset()\n const a = 1;');
    expect(markdown).toContain('Staged changes · 3 files · +4 −3 · openai/gpt-5');
    expect(markdown).toContain('## Not covered');
  });
});
