import assert from 'node:assert/strict';
import test from 'node:test';

import { partitionTestArguments } from './run-tests.mjs';

const scriptTests = ['scripts/ai-fuzzy-live.test.mjs', 'scripts/vscode-launch-process.test.mjs'];

test('runs only the requested Node script test and preserves its name pattern', () => {
  assert.deepEqual(
    partitionTestArguments(
      ['scripts/ai-fuzzy-live.test.mjs', '--test-name-pattern', 'signed movement'],
      scriptTests
    ),
    {
      vitestArgs: [],
      nodeArgs: ['--test-name-pattern', 'signed movement', 'scripts/ai-fuzzy-live.test.mjs'],
      runVitest: false,
      runNode: true,
    }
  );
});

test('runs only the requested Vitest test and preserves its name pattern', () => {
  assert.deepEqual(
    partitionTestArguments(['src/webview/components/ChatInput.test.ts', '-t', 'queue'], scriptTests),
    {
      vitestArgs: ['src/webview/components/ChatInput.test.ts', '-t', 'queue'],
      nodeArgs: [],
      runVitest: true,
      runNode: false,
    }
  );
});

test('partitions mixed test files and translates test-name flags', () => {
  assert.deepEqual(
    partitionTestArguments(
      ['scripts/ai-fuzzy-live.test.mjs', 'src/shared/protocol.test.ts', '-t', 'queue'],
      scriptTests
    ),
    {
      vitestArgs: ['src/shared/protocol.test.ts', '-t', 'queue'],
      nodeArgs: ['--test-name-pattern', 'queue', 'scripts/ai-fuzzy-live.test.mjs'],
      runVitest: true,
      runNode: true,
    }
  );
});

test('runs both complete suites when no arguments are supplied', () => {
  assert.deepEqual(partitionTestArguments([], scriptTests), {
    vitestArgs: [],
    nodeArgs: scriptTests,
    runVitest: true,
    runNode: true,
  });
});
