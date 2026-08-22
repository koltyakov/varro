import assert from 'node:assert/strict';
import test from 'node:test';
import vm from 'node:vm';

import {
  buildDuplicateDeliveryObserverExpression,
  buildDuplicateDeliveryPrompt,
  buildLivePrompt,
  duplicateDeliveryFailures,
  missingLiveGates,
  modelDisplayName,
  parseRestartCount,
} from './ai-fuzzy-live.mjs';

const ready = {
  virtualized: true,
  busy: true,
  stickyMessageId: 'message-1',
  fileEdit: true,
  disclosure: true,
  diffControl: true,
  nestedActivityScroller: { hasRange: true },
};

test('keeps live-only gates explicit for AI-07 and AI-08', () => {
  assert.deepEqual(missingLiveGates(ready, 'AI-07'), []);
  assert.deepEqual(missingLiveGates(ready, 'AI-08'), []);
  assert.deepEqual(missingLiveGates({ ...ready, diffControl: false }, 'AI-07'), []);
  assert.deepEqual(missingLiveGates({ ...ready, diffControl: false }, 'AI-08'), [
    'expandable diff control',
  ]);
});

test('builds a targeted bounded recovery prompt from missing gates', () => {
  const prompt = buildLivePrompt({
    seed: 'abc',
    attempt: 2,
    missing: ['file edit or diff', 'scrollable active tray'],
  });

  assert.match(prompt, /^\[VFZ:abc:TOOLS-A2\]/);
  assert.match(prompt, /exactly two existing files/);
  assert.match(prompt, /ten independent read or search calls/);
  assert.match(prompt, /Do not repeat completed work/);
});

test('the initial task requests the content forms needed by the live gate', () => {
  const prompt = buildLivePrompt({ seed: 'abc', attempt: 1 });

  assert.match(prompt, /eight independent read or search tool calls/);
  assert.match(prompt, /exactly two existing source or test files/);
  assert.match(prompt, /another parallel group/);
});

test('builds the controlled duplicate-delivery stream prompt', () => {
  const prompt = buildDuplicateDeliveryPrompt('abc', ['VFZ-DUP-01', 'VFZ-DUP-END']);

  assert.match(prompt, /^\[VFZ:abc:DUP\]/);
  assert.match(prompt, /VFZ-DUP-01\nVFZ-DUP-END/);
  assert.match(prompt, /exactly once each/);
});

test('maps requested model IDs to their composer labels', () => {
  assert.equal(modelDisplayName('openai/gpt-5.6-luna'), 'GPT-5.6 Luna');
  assert.equal(modelDisplayName('openai/gpt-5.6-sol'), 'GPT-5.6 Sol');
});

test('accepts a bounded restart count for duplicate-delivery stress', () => {
  assert.equal(parseRestartCount(undefined), 1);
  assert.equal(parseRestartCount('4'), 4);
  assert.throws(() => parseRestartCount('0'), /integer from 1 through 10/);
  assert.throws(() => parseRestartCount('11'), /integer from 1 through 10/);
});

test('builds valid JavaScript for the duplicate-delivery frame observer', () => {
  const expression = buildDuplicateDeliveryObserverExpression('[VFZ:abc:DUP]', [
    'VFZ-DUP-01',
    'VFZ-DUP-END',
  ]);

  assert.doesNotThrow(() => new vm.Script(expression));
  assert.match(expression, /join\('\\n'\)/);
});

test('rejects transient duplicate user rows, assistant rows, and stream tokens', () => {
  const complete = {
    userSeen: true,
    assistantSeen: true,
    maxUserRows: 1,
    maxAssistantRows: 1,
    maxTokenCounts: [1, 1],
    tokenSeen: [true, true],
  };

  assert.deepEqual(duplicateDeliveryFailures(complete, true), []);
  assert.deepEqual(
    duplicateDeliveryFailures(
      { ...complete, maxUserRows: 2, maxAssistantRows: 2, maxTokenCounts: [1, 2] },
      true
    ),
    [
      'sent user prompt rendered more than once',
      'assistant response rendered in multiple rows',
      'a streamed token rendered more than once',
    ]
  );
});
