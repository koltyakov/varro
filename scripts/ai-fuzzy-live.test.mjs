import assert from 'node:assert/strict';
import test from 'node:test';
import vm from 'node:vm';

import {
  buildDuplicateDeliveryObserverExpression,
  buildDuplicateDeliveryPrompt,
  buildLivePrompt,
  buildMultiWebviewScenarioPlan,
  canonicalDeliveryFailures,
  classifyPromptDisposition,
  duplicateDeliveryFailures,
  executeActionPlan,
  findSessionDescendants,
  inventoryVerifiedDescendants,
  fixtureIsSafeForScenario,
  missingLiveGates,
  modelDisplayName,
  multiWebviewScenarioFailures,
  parseGitStatusPaths,
  parseRestartCount,
  persistFixtureExitEvidence,
  promptModelFailures,
  queueHandoffMatches,
  selectVarroTargetDescriptor,
  sendComposerPromptWithRetry,
  shouldRetryAi08WithFreshStream,
  shouldRetryNestedHandoff,
  summarizeCanonicalDelivery,
  summarizeQueuedDelivery,
  validateLiveModel,
  verifyActionEffect,
  waitForLiveGate,
  waitForTargetDisappearance,
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

function transcriptStateAt(scrollTop) {
  return {
    focusOwner: 'transcript',
    transcript: { scrollTop, firstVisibleMessageId: 'message-1', firstVisibleTop: 0 },
  };
}

test('keeps live-only gates explicit for AI-07 and AI-08', () => {
  assert.deepEqual(missingLiveGates(ready, 'AI-07'), []);
  assert.deepEqual(missingLiveGates(ready, 'AI-08'), []);
  assert.deepEqual(missingLiveGates({ ...ready, diffControl: false }, 'AI-07'), []);
  assert.deepEqual(missingLiveGates({ ...ready, diffControl: false }, 'AI-08'), [
    'expandable diff control',
  ]);
});

test('keeps the latest live-gate sample and the best busy sample separately', async () => {
  const snapshots = [
    {
      ...ready,
      fileEdit: false,
    },
    {
      ...ready,
      busy: false,
      nestedActivityScroller: null,
    },
  ];
  const busyStates = [true, false];
  const gate = await waitForLiveGate({
    client: { isBusy: async () => busyStates.shift() ?? false },
    cdp: {
      snapshot: async () => snapshots.shift(),
      wheel: async () => false,
    },
    sessionId: 'session',
    scenario: 'AI-07',
    timeoutMs: 1_000,
    pollIntervalMs: 0,
  });

  assert.equal(gate.sawBusy, true);
  assert.equal(gate.snapshot.busy, false);
  assert.equal(gate.bestSnapshot.busy, true);
  assert.deepEqual(gate.missing, ['file edit or diff']);
  assert.deepEqual(gate.latestMissing, ['active model stream', 'scrollable active tray']);
  assert.equal(gate.observations.length, 2);
});

test('builds a targeted bounded recovery prompt from missing gates', () => {
  const prompt = buildLivePrompt({
    seed: 'abc',
    attempt: 2,
    missing: ['file edit or diff', 'scrollable active tray'],
  });

  assert.match(prompt, /^\[VFZ:abc:AI-07:R1:TOOLS-A2\]/);
  assert.match(prompt, /exactly two existing source or test files/);
  assert.match(prompt, /six separate read-only bash calls concurrently/);
  assert.match(prompt, /new turn must independently produce the complete live gate/);
  assert.match(prompt, /especially clear.*file edit or diff, scrollable active tray/);
  assert.match(prompt, /expandable Explored disclosure/);
  assert.match(prompt, /Do not spawn, delegate to, or otherwise use subagents/);
});

test('requests the complete gate in every retry when successive turns split the gates', () => {
  const retries = [
    buildLivePrompt({ seed: 'abc', attempt: 2, missing: ['file edit or diff'] }),
    buildLivePrompt({ seed: 'abc', attempt: 3, missing: ['scrollable active tray'] }),
  ];

  for (const prompt of retries) {
    assert.match(prompt, /eight independent read or search tool calls/);
    assert.match(prompt, /exactly two existing source or test files/);
    assert.match(prompt, /expandable diff/);
    assert.match(prompt, /expandable Explored disclosure/);
    assert.match(prompt, /exactly six separate read-only bash calls concurrently/);
  }
});

test('the initial task requests the content forms needed by the live gate', () => {
  const prompt = buildLivePrompt({ seed: 'abc', attempt: 1 });

  assert.match(prompt, /eight independent read or search tool calls/);
  assert.match(prompt, /exactly two existing source or test files/);
  assert.match(prompt, /exactly six separate read-only bash calls concurrently/);
  assert.match(prompt, /60-second tool timeout/);
});

test('uses distinct live prompt markers for AI-07 and AI-08', () => {
  const ai07 = buildLivePrompt({ seed: 'abc', scenario: 'AI-07', attempt: 1 });
  const ai08 = buildLivePrompt({ seed: 'abc', scenario: 'AI-08', attempt: 1 });

  assert.match(ai07, /^\[VFZ:abc:AI-07:R1:TOOLS-A1\]/);
  assert.match(ai08, /^\[VFZ:abc:AI-08:R1:TOOLS-A1\]/);
  assert.notEqual(ai07, ai08);
});

test('uses a distinct marker for each controller replay', () => {
  const first = buildLivePrompt({ seed: 'abc', scenario: 'AI-08', promptRun: 1, attempt: 1 });
  const second = buildLivePrompt({ seed: 'abc', scenario: 'AI-08', promptRun: 2, attempt: 1 });

  assert.notEqual(first, second);
});

test('retries composer lookup only until native prompt dispatch succeeds', async () => {
  let attempts = 0;
  const sent = await sendComposerPromptWithRetry(
    {
      sendComposerPrompt: async () => {
        attempts += 1;
        return attempts === 3;
      },
    },
    'prompt',
    4,
    0
  );

  assert.equal(sent, true);
  assert.equal(attempts, 3);
});

test('accepts a focused transcript key at its requested scroll boundary', () => {
  const state = {
    focusOwner: 'transcript',
    transcript: {
      scrollTop: 500,
      scrollHeight: 1_000,
      clientHeight: 500,
      firstVisibleMessageId: 'message-1',
      firstVisibleTop: 0,
    },
  };

  assert.deepEqual(verifyActionEffect({ action: 'Space on transcript' }, state, state, { dispatched: true }), {
    verified: true,
  });
});

test('accepts a transcript wheel at its requested scroll boundary', () => {
  const state = transcriptStateAt(0);

  assert.deepEqual(
    verifyActionEffect({ action: 'wheel transcript', delta: -96 }, state, state, {
      dispatched: true,
    }),
    { verified: true }
  );
});

test('distinguishes canonical prompt admission from queued and unobserved input', () => {
  const marker = '[VFZ:abc:TOOLS-A1]';
  const messages = [
    {
      info: { id: 'message-1', role: 'user' },
      parts: [{ type: 'text', text: `${marker} inspect this` }],
    },
  ];
  const queueItems = [{ id: 'queue-1', text: `${marker} inspect this` }];

  assert.deepEqual(classifyPromptDisposition(messages, [], marker), {
    status: 'admitted',
    userIds: ['message-1'],
    queuedItemIds: [],
  });
  assert.deepEqual(classifyPromptDisposition([], queueItems, marker), {
    status: 'queued',
    userIds: [],
    queuedItemIds: ['queue-1'],
  });
  assert.equal(classifyPromptDisposition(messages, queueItems, marker).status, 'admitted-and-queued');
  assert.equal(classifyPromptDisposition([], [], marker).status, 'unobserved');
});

test('dispatches editable-control keys to the composer during AI-08', async () => {
  const keyCalls = [];
  const cdp = {
    key: async (selector, key) => {
      keyCalls.push([selector, key]);
      return true;
    },
    captureActionState: async () => ({
      focusOwner: 'composer',
      transcript: { scrollTop: 10, firstVisibleMessageId: 'message-1', firstVisibleTop: 0 },
    }),
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

test('stops the AI-08 action plan when the model stream settles', async () => {
  const results = await executeActionPlan(
    { wheel: async () => true },
    [{ step: 15, action: 'wheel transcript', delta: -32 }],
    'session',
    0,
    { isActive: async () => false }
  );

  assert.deepEqual(results, [
    {
      step: 15,
      action: 'wheel transcript',
      delta: -32,
      executed: false,
      reason: 'model stream settled',
    },
  ]);
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
    captureActionState: async () => {
      const moved = calls.some(([type]) => type === 'wheel');
      return {
        focusOwner: 'transcript',
        transcript: {
          scrollTop: moved ? 100 : 0,
          firstVisibleMessageId: moved ? 'message-2' : 'message-1',
          firstVisibleTop: 0,
        },
      };
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
  let captures = 0;
  const cdp = {
    click: async (selector) => {
      if (selector.startsWith('.diff-view')) {
        overlayAttempts += 1;
        return overlayAttempts === 3;
      }
      return selector.startsWith('[aria-label="Close expanded diff"]');
    },
    captureActionState: async () => {
      captures += 1;
      if (captures === 1) return { focusOwner: 'transcript', expandedDiffCount: 1 };
      if (captures === 2) return { focusOwner: 'diff', expandedDiffCount: 1 };
      return { focusOwner: 'button', expandedDiffCount: 0 };
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

test('retries diff expansion against fresh active-stream geometry', async () => {
  let clicks = 0;
  let captures = 0;
  const cdp = {
    click: async () => {
      clicks += 1;
      return true;
    },
    captureActionState: async () => {
      captures += 1;
      return { expandedDiffCount: captures >= 3 ? 1 : 0 };
    },
  };

  const results = await executeActionPlan(
    cdp,
    [{ step: 12, action: 'open file card and diff' }],
    'session',
    0
  );

  assert.equal(clicks, 2);
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

test('retries AI-08 only for an early settled stream within the prompt budget', () => {
  assert.equal(
    shouldRetryAi08WithFreshStream({ reason: 'model stream settled' }, 1, 3),
    true
  );
  assert.equal(
    shouldRetryAi08WithFreshStream({ reason: 'model stream settled' }, 3, 3),
    false
  );
  assert.equal(
    shouldRetryAi08WithFreshStream({ reason: 'transcript moved opposite' }, 1, 3),
    false
  );
});

test('builds the controlled duplicate-delivery stream prompt', () => {
  const prompt = buildDuplicateDeliveryPrompt('abc', ['VFZ-DUP-01', 'VFZ-DUP-END']);

  assert.match(prompt, /^\[VFZ:abc:AI-17:R1:DUP\]/);
  assert.match(prompt, /VFZ-DUP-01\nVFZ-DUP-END/);
  assert.match(prompt, /exactly once each/);
});

test('maps requested model IDs to their composer labels', () => {
  assert.equal(modelDisplayName('openai/gpt-5.6-luna'), 'GPT-5.6 Luna');
  assert.equal(modelDisplayName('openai/gpt-5.6-sol'), 'GPT-5.6 Sol');
});

test('accepts only the required Luna and Terra live models', () => {
  assert.equal(validateLiveModel('openai/gpt-5.6-luna'), 'openai/gpt-5.6-luna');
  assert.equal(validateLiveModel('openai/gpt-5.6-terra'), 'openai/gpt-5.6-terra');
  assert.throws(() => validateLiveModel('openai/gpt-5.6-sol'), /Luna|luna/);
});

test('accepts a bounded restart count for duplicate-delivery stress', () => {
  assert.equal(parseRestartCount(undefined), 1);
  assert.equal(parseRestartCount('4'), 4);
  assert.throws(() => parseRestartCount('0'), /integer from 1 through 10/);
  assert.throws(() => parseRestartCount('11'), /integer from 1 through 10/);
});

test('allows AI-08 to continue from the exact recorded AI-07 fixture state', () => {
  const fixture = {
    commit: 'abc',
    status: ' M source.ts',
    changedPaths: ['source.ts'],
    contentHash: 'same-content',
  };
  const manifest = {
    fixture: { commit: 'abc', status: '' },
    livePreparation: { 'AI-07': { prepared: true, fixtureAfterPreparation: fixture } },
  };

  assert.equal(fixtureIsSafeForScenario({ commit: 'abc', status: '' }, manifest, 'AI-07'), true);
  assert.equal(fixtureIsSafeForScenario(fixture, manifest, 'AI-08'), true);
  assert.equal(fixtureIsSafeForScenario(fixture, manifest, 'AI-18'), true);
  assert.equal(fixtureIsSafeForScenario(fixture, manifest, 'AI-07'), false);
  assert.equal(
    fixtureIsSafeForScenario({ ...fixture, status: ' M other.ts' }, manifest, 'AI-08'),
    false
  );
  assert.equal(
    fixtureIsSafeForScenario({ ...fixture, changedPaths: ['other.ts'] }, manifest, 'AI-08'),
    false
  );
  assert.equal(
    fixtureIsSafeForScenario({ ...fixture, contentHash: 'different-content' }, manifest, 'AI-08'),
    false
  );
  assert.equal(
    fixtureIsSafeForScenario(
      fixture,
      { ...manifest, livePreparation: { 'AI-07': { prepared: false, fixtureAfterPreparation: fixture } } },
      'AI-08'
    ),
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
    maxRawAssistantRows: 1,
    maxTokenCounts: [1, 1],
    tokenSeen: [true, true],
  };

  assert.deepEqual(duplicateDeliveryFailures(complete, true), []);
  assert.deepEqual(
    duplicateDeliveryFailures(
      {
        ...complete,
        maxUserRows: 2,
        maxAssistantRows: 2,
        maxRawAssistantRows: 2,
        maxTokenCounts: [1, 2],
      },
      true
    ),
    [
      'sent user prompt rendered more than once',
      'assistant response rendered in multiple rows',
      'assistant response occupied multiple raw rows',
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
        info: {
          id: 'assistant-new',
          role: 'assistant',
          parentID: 'user-new',
          providerID: 'openai',
          modelID: 'gpt-5.6-luna',
          finish: 'stop',
          time: { completed: 1 },
        },
        parts: [{ type: 'text', text: 'VFZ-DUP-01\nVFZ-DUP-END' }],
      },
    ],
    '[VFZ:abc:DUP]',
    ['VFZ-DUP-01', 'VFZ-DUP-END']
  );

  assert.deepEqual(summary.user, { id: 'user-new' });
  assert.equal(summary.assistants[0]?.id, 'assistant-new');
  assert.deepEqual(summary.tokenCounts, [1, 1]);
  assert.equal(summary.tokensInOrder, true);
  assert.deepEqual(canonicalDeliveryFailures(summary), []);
});

test('rejects duplicate canonical users, linked assistants, bad finishes, errors, and token order', () => {
  const summary = summarizeCanonicalDelivery(
    [
      {
        info: { id: 'user-1', role: 'user' },
        parts: [{ type: 'text', text: '[VFZ:abc:DUP]' }],
      },
      {
        info: { id: 'user-2', role: 'user' },
        parts: [{ type: 'text', text: '[VFZ:abc:DUP]' }],
      },
    ],
    '[VFZ:abc:DUP]',
    ['ONE', 'TWO']
  );
  assert.deepEqual(canonicalDeliveryFailures(summary), [
    'canonical transcript did not contain exactly one marked user',
    'canonical transcript did not contain exactly one linked assistant',
    'canonical response did not contain every required token exactly once',
    'canonical response tokens were not in the required order',
  ]);

  const badAssistant = {
    markedUsers: [{ id: 'user-1' }],
    assistants: [
      { id: 'assistant-1', completed: false, finish: 'tool_calls', error: { name: 'failure' } },
      { id: 'assistant-2', completed: true, finish: 'stop', error: null },
    ],
    tokenCounts: [1, 2],
    tokensInOrder: false,
  };
  assert.deepEqual(canonicalDeliveryFailures(badAssistant), [
    'canonical transcript did not contain exactly one linked assistant',
    'linked assistant did not have an accepted completed finish',
    'linked assistant contained an error',
    'canonical response did not contain every required token exactly once',
    'canonical response tokens were not in the required order',
  ]);
});

test('checks the exact canonical provider and model for each marked turn', () => {
  const messages = [
    { info: { id: 'user-1', role: 'user' }, parts: [{ type: 'text', text: '[TURN-1]' }] },
    {
      info: {
        id: 'assistant-1',
        role: 'assistant',
        parentID: 'user-1',
        providerID: 'openai',
        modelID: 'gpt-5.6-terra',
      },
      parts: [],
    },
  ];
  assert.deepEqual(
    promptModelFailures(messages, ['[TURN-1]'], 'openai/gpt-5.6-terra').failures,
    []
  );
  assert.equal(
    promptModelFailures(messages, ['[TURN-1]'], 'openai/gpt-5.6-luna').failures.length,
    1
  );
});

test('selects Varro targets by surface, stable viewId, and session route', () => {
  const targets = [
    {
      id: 'sidebar-target',
      context: { surface: 'sidebar', viewId: 'sidebar' },
      route: { type: 'session', sessionId: 'root' },
    },
    {
      id: 'editor-a-target',
      context: { surface: 'editor', viewId: 'editor-a' },
      route: { type: 'session', sessionId: 'root' },
    },
    {
      id: 'editor-b-target',
      context: { surface: 'editor', viewId: 'editor-b' },
      route: { type: 'session', sessionId: 'child' },
    },
  ];

  assert.equal(
    selectVarroTargetDescriptor(targets, {
      surface: 'editor',
      viewId: 'editor-b',
      sessionId: 'child',
    }).id,
    'editor-b-target'
  );
  assert.throws(
    () => selectVarroTargetDescriptor(targets, { surface: 'editor' }),
    /ambiguous.*editor-a.*editor-b/i
  );
  assert.throws(
    () =>
      selectVarroTargetDescriptor(targets, {
        surface: 'editor',
        viewId: 'editor-b',
        sessionId: 'other',
      }),
    /No Varro iframe matched.*session=other/i
  );
});

test('parses exact changed paths including both sides of a rename', () => {
  assert.deepEqual(
    parseGitStatusPaths(' M source.ts\0?? new file.ts\0R  renamed.ts\0old.ts\0'),
    ['new file.ts', 'old.ts', 'renamed.ts', 'source.ts']
  );
});

test('atomically records fixture evidence and controller failures on exit', async () => {
  const manifest = { livePreparation: { 'AI-07': { scenario: 'AI-07', prepared: true } } };
  let saved = null;
  const fixture = { commit: 'abc', status: ' M source.ts', changedPaths: ['source.ts'] };
  await persistFixtureExitEvidence({
    manifest,
    manifestPath: '/manifest.json',
    scenario: 'AI-07',
    workspace: '/fixture',
    error: new Error('CDP disconnected'),
    readFixture: async () => fixture,
    writeManifest: async (_path, value) => {
      saved = structuredClone(value);
    },
  });

  assert.deepEqual(saved.livePreparation['AI-07'].fixtureAfterPreparation, fixture);
  assert.deepEqual(saved.livePreparation['AI-07'].fixtureExitEvidence.changedPaths, ['source.ts']);
  assert.equal(saved.livePreparation['AI-07'].prepared, false);
  assert.match(saved.livePreparation['AI-07'].failures[0], /CDP disconnected/);
});

test('records only verified action effects', () => {
  const before = {
    focusOwner: 'transcript',
    transcript: { scrollTop: 10, firstVisibleMessageId: 'message-1', firstVisibleTop: 0 },
  };
  const after = {
    focusOwner: 'transcript',
    transcript: { scrollTop: 110, firstVisibleMessageId: 'message-2', firstVisibleTop: 0 },
  };
  assert.equal(
    verifyActionEffect({ action: 'wheel transcript' }, before, after, { dispatched: true })
      .verified,
    true
  );
  assert.equal(
    verifyActionEffect({ action: 'wheel transcript' }, before, before, { dispatched: true })
      .verified,
    false
  );
});

test('rejects opposite wheel movement and a delayed reversal', () => {
  assert.deepEqual(
    verifyActionEffect(
      { action: 'wheel transcript', delta: 96 },
      transcriptStateAt(100),
      transcriptStateAt(40),
      { dispatched: true }
    ),
    { verified: false, reason: 'transcript moved opposite the requested direction' }
  );
  assert.deepEqual(
    verifyActionEffect(
      { action: 'wheel transcript', delta: 96 },
      transcriptStateAt(100),
      transcriptStateAt(180),
      { dispatched: true, settledAfter: transcriptStateAt(140) }
    ),
    { verified: false, reason: 'transcript movement reversed after the input' }
  );
});

test('scopes AI-08 disclosure actions to current-turn message identities', async () => {
  const scope = { messageIds: ['assistant-current'], partIds: ['part-current'] };
  const clicks = [];
  let capture = 0;
  const results = await executeActionPlan(
    {
      captureActionState: async (receivedScope) => {
        assert.deepEqual(receivedScope, scope);
        capture += 1;
        return {
          disclosures: [
            {
              messageId: 'assistant-current',
              key: 'group-current',
              expanded: capture > 1,
            },
          ],
        };
      },
      click: async (selector, receivedScope) => {
        clicks.push([selector, receivedScope]);
        return true;
      },
    },
    [{ step: 9, action: 'expand disclosure' }],
    'session',
    0,
    { scope }
  );

  assert.deepEqual(clicks, [
    [
      '.assistant-activity-summary[data-activity-summary-group-key="group-current"]',
      scope,
    ],
  ]);
  assert.equal(results[0].executed, true);
});

test('inventories transitive descendants without including unrelated sessions', () => {
  const sessions = [
    { id: 'root' },
    { id: 'child', parentID: 'root' },
    { id: 'grandchild', parentID: 'child' },
    { id: 'other' },
  ];
  assert.deepEqual(
    findSessionDescendants(sessions, 'root').map((session) => session.id),
    ['child', 'grandchild']
  );
});

test('records only new descendants whose full ancestry reaches the tracked root', () => {
  const manifest = { runSessions: [{ id: 'root', title: 'VFZ seed root', deleted: false }] };
  const result = inventoryVerifiedDescendants(
    manifest,
    [
      { id: 'root', title: 'VFZ seed root' },
      { id: 'child', title: 'child', parentID: 'root' },
      { id: 'grandchild', title: 'grandchild', parentID: 'child' },
      { id: 'missing-parent', title: 'unsafe', parentID: 'unknown' },
      { id: 'other', title: 'other' },
    ],
    'root',
    new Set(['child']),
    'AI-08'
  );

  assert.deepEqual(result.observed.map((session) => session.id), ['grandchild']);
  assert.deepEqual(result.recorded, [
    {
      id: 'grandchild',
      title: 'grandchild',
      parentID: 'child',
      rootSessionId: 'root',
      deleted: false,
      createdBy: 'AI-08',
    },
  ]);
  assert.equal(manifest.runSessions.some((session) => session.id === 'missing-parent'), false);
});

test('defines and judges the AI-18 multi-webview controller plan', () => {
  const plan = buildMultiWebviewScenarioPlan('seed');
  const replayed = buildMultiWebviewScenarioPlan('seed', 2);
  assert.notEqual(plan[5].marker, replayed[5].marker);
  assert.deepEqual(
    plan.map(({ action }) => action),
    [
      'target sidebar',
      'create and inventory child session',
      'select model and permission in sidebar',
      'route root into editor',
      'route child then root through same editor viewId',
      'start real root stream',
      'queue from sidebar',
      'queue from editor',
      'hide editor and verify queue handoff',
      'reveal editor by stable viewId',
      'toggle inline file changes off and on',
      'reload and restore editor by stable viewId',
      'queue a fresh editor close-handoff item',
      'close editor and verify target disappearance and queue handoff',
      'sample delivery, counts, leakage, and focus',
    ]
  );
  const passing = {
    targets: { sidebarViewId: 'sidebar', editorViewId: 'editor-1' },
    editor: {
      opened: true,
      revealed: true,
      restored: true,
      rootTitleRouted: true,
      childTitleRouted: true,
    },
    synchronization: {
      samples: [
        'sidebar-source',
        'editor-root',
        'editor-root-return',
        'editor-reload',
      ].map((phase) => ({ phase, model: true, permissionMode: true })),
    },
    queues: {
      sessionId: 'root',
      enqueueOrder: [
        { id: 'q1', sourceViewId: 'sidebar' },
        { id: 'q2', sourceViewId: 'editor-1' },
        { id: 'q3', sourceViewId: 'editor-1' },
      ],
      hiddenHandoff: {
        displayedCount: 2,
        queueItems: [
          { id: 'q1', ownerViewId: 'sidebar', sessionId: 'root' },
          { id: 'q2', ownerViewId: 'sidebar', sessionId: 'root' },
        ],
      },
      closedHandoff: {
        displayedCount: 1,
        targetDisappeared: true,
        queueItems: [{ id: 'q3', ownerViewId: 'sidebar', sessionId: 'root' }],
      },
    },
    inlineFileChanges: { hidden: true, shown: true },
    delivery: {
      userCounts: [1, 1, 1],
      assistantCounts: [1, 1, 1],
      assistantValid: [true, true, true],
      ordered: true,
      reloadDuplicateFree: true,
    },
    leakage: {
      rootAbsentFromChild: true,
      childPresentInChild: true,
      childAbsentFromRoot: true,
      rootPresentInRoot: true,
    },
    counts: { accurate: true },
    focus: { usable: true },
    unexpectedDescendants: [],
  };
  assert.deepEqual(multiWebviewScenarioFailures(passing), []);
  assert.match(
    multiWebviewScenarioFailures({ ...passing, counts: { accurate: false } })[0],
    /counts/
  );
});

test('requires exact queue IDs, owner, session, and displayed count for a handoff', () => {
  const sample = {
    displayedCount: 2,
    queueItems: [
      { id: 'q1', ownerViewId: 'sidebar', sessionId: 'root' },
      { id: 'q2', ownerViewId: 'sidebar', sessionId: 'root' },
    ],
  };
  assert.equal(queueHandoffMatches(sample, ['q1', 'q2'], 'sidebar', 2, 'root'), true);
  assert.equal(queueHandoffMatches(sample, ['q1'], 'sidebar', 2, 'root'), false);
  assert.equal(queueHandoffMatches(sample, ['q1', 'q2'], 'editor-1', 2, 'root'), false);
});

test('requires clean linked assistants and exact response markers for queued delivery', () => {
  const turns = [
    { promptMarker: '[Q1]', responseMarker: 'Q1-END' },
    { promptMarker: '[Q2]', responseMarker: 'Q2-END' },
  ];
  const messages = turns.flatMap((turn, index) => {
    const userId = `user-${String(index)}`;
    return [
      {
        info: { id: userId, role: 'user' },
        parts: [{ type: 'text', text: turn.promptMarker }],
      },
      {
        info: {
          id: `assistant-${String(index)}`,
          role: 'assistant',
          parentID: userId,
          finish: 'stop',
          time: { completed: 1 },
        },
        parts: [{ type: 'text', text: turn.responseMarker }],
      },
    ];
  });

  const delivery = summarizeQueuedDelivery(messages, turns);
  assert.deepEqual(delivery.userCounts, [1, 1]);
  assert.deepEqual(delivery.assistantCounts, [1, 1]);
  assert.deepEqual(delivery.assistantValid, [true, true]);
  assert.equal(delivery.ordered, true);
  messages[3].parts[0].text = 'wrong response';
  assert.deepEqual(summarizeQueuedDelivery(messages, turns).assistantValid, [true, false]);
});

test('waits until the exact closed editor target disappears', async () => {
  const samples = [[{ id: 'editor-target' }], [{ id: 'other-target' }]];
  assert.equal(
    await waitForTargetDisappearance(0, 'editor-target', 1_000, async () => samples.shift(), 0),
    true
  );
});
