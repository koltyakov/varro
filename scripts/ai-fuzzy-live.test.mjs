import assert from 'node:assert/strict';
import test from 'node:test';
import vm from 'node:vm';

import {
  buildDuplicateDeliveryObserverExpression,
  buildDuplicateDeliveryPrompt,
  buildLivePrompt,
  duplicateDeliveryFailures,
  executeActionPlan,
  fixtureIsSafeForScenario,
  missingLiveGates,
  modelDisplayName,
  parseRestartCount,
  shouldRetryNestedHandoff,
  summarizeCanonicalDelivery,
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
  assert.match(prompt, /six separate read-only bash calls concurrently/);
  assert.match(prompt, /Do not repeat completed work/);
});

test('the initial task requests the content forms needed by the live gate', () => {
  const prompt = buildLivePrompt({ seed: 'abc', attempt: 1 });

  assert.match(prompt, /eight independent read or search tool calls/);
  assert.match(prompt, /exactly two existing source or test files/);
  assert.match(prompt, /exactly six separate read-only bash calls concurrently/);
});

test('dispatches editable-control keys to the composer during AI-08', async () => {
  const keyCalls = [];
  const cdp = {
    key: async (selector, key) => {
      keyCalls.push([selector, key]);
      return true;
    },
  };

  const results = await executeActionPlan(
    cdp,
    [
      { step: 1, action: 'PageDown in composer' },
      { step: 2, action: 'Space in composer' },
      { step: 3, action: 'Shift+Space in composer' },
    ],
    'session',
    0
  );

  assert.deepEqual(keyCalls, [
    ['[aria-label="Message composer"]', 'PageDown'],
    ['[aria-label="Message composer"]', 'Space'],
    ['[aria-label="Message composer"]', 'Shift+Space'],
  ]);
  assert.equal(results.every(({ executed }) => executed), true);
});

test('exposes the jump control when AI-08 starts bottom-pinned', async () => {
  const calls = [];
  const cdp = {
    click: async (selector) => {
      calls.push(['click', selector]);
      return calls.length === 4;
    },
    wheel: async (selector, delta, side) => {
      calls.push(['wheel', selector, delta, side]);
      return true;
    },
  };

  const results = await executeActionPlan(
    cdp,
    [{ step: 14, action: 'click sticky or jump to latest' }],
    'session',
    0
  );

  assert.deepEqual(calls, [
    ['click', '[data-sticky-msg-id]'],
    ['click', '[aria-label="Scroll to latest message"]'],
    ['wheel', '.interactive-list', -420, 'right'],
    ['click', '[aria-label="Scroll to latest message"]'],
  ]);
  assert.equal(results[0].executed, true);
});

test('waits for the expanded diff to mount before closing it', async () => {
  let overlayAttempts = 0;
  const cdp = {
    click: async (selector) => {
      if (selector.startsWith('.diff-view')) {
        overlayAttempts += 1;
        return overlayAttempts === 3;
      }
      return selector.startsWith('[aria-label="Close expanded diff"]');
    },
  };

  const results = await executeActionPlan(
    cdp,
    [{ step: 13, action: 'focus and close diff' }],
    'session',
    0
  );

  assert.equal(overlayAttempts, 3);
  assert.equal(results[0].executed, true);
});

test('retries a nested handoff only when live tray geometry changed', () => {
  const handoff = {
    passed: false,
    before: {
      activeActivityCount: 4,
      transcript: { scrollHeight: 1000 },
      nestedActivityScroller: { scrollHeight: 128, clientHeight: 108 },
    },
    afterNested: {
      activeActivityCount: 6,
      transcript: { scrollHeight: 1014 },
      nestedActivityScroller: { scrollHeight: 237, clientHeight: 122 },
    },
  };

  assert.equal(shouldRetryNestedHandoff(handoff), true);
  assert.equal(
    shouldRetryNestedHandoff({
      ...handoff,
      before: handoff.afterNested,
    }),
    false
  );
  assert.equal(shouldRetryNestedHandoff({ ...handoff, passed: true }), false);
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

test('allows AI-08 to continue from the exact recorded AI-07 fixture state', () => {
  const fixture = { commit: 'abc', status: ' M source.ts' };
  const manifest = {
    fixture: { commit: 'abc', status: '' },
    livePreparation: { 'AI-07': { fixtureAfterPreparation: fixture } },
  };

  assert.equal(fixtureIsSafeForScenario({ commit: 'abc', status: '' }, manifest, 'AI-07'), true);
  assert.equal(fixtureIsSafeForScenario(fixture, manifest, 'AI-08'), true);
  assert.equal(fixtureIsSafeForScenario(fixture, manifest, 'AI-07'), false);
  assert.equal(
    fixtureIsSafeForScenario({ ...fixture, status: ' M other.ts' }, manifest, 'AI-08'),
    false
  );
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

test('summarizes the canonical assistant response for the marked user prompt', () => {
  const summary = summarizeCanonicalDelivery(
    [
      {
        info: { id: 'user-old', role: 'user' },
        parts: [{ type: 'text', text: 'old prompt' }],
      },
      {
        info: { id: 'user-new', role: 'user' },
        parts: [{ type: 'text', text: '[VFZ:abc:DUP] prompt' }],
      },
      {
        info: { id: 'assistant-new', role: 'assistant', parentID: 'user-new', finish: 'stop' },
        parts: [{ type: 'text', text: 'VFZ-DUP-01\nVFZ-DUP-END' }],
      },
    ],
    '[VFZ:abc:DUP]',
    ['VFZ-DUP-01', 'VFZ-DUP-END']
  );

  assert.deepEqual(summary.user, { id: 'user-new' });
  assert.equal(summary.assistants[0]?.id, 'assistant-new');
  assert.deepEqual(summary.expectedTokensPresent, [true, true]);
});
