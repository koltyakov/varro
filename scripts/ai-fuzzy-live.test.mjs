import assert from 'node:assert/strict';
import test from 'node:test';
import vm from 'node:vm';
import { JSDOM } from 'jsdom';

import {
  beginLivePreparationRun,
  buildDuplicateDeliveryObserverExpression,
  buildDuplicateDeliveryPrompt,
  buildLivePrompt,
  buildMultiWebviewScenarioPlan,
  canonicalDeliveryFailures,
  CdpController,
  classifyPromptDisposition,
  clickOpenInEditor,
  duplicateDeliveryFailures,
  executeActionPlan,
  findSessionDescendants,
  inventoryVerifiedDescendants,
  lifecycleScenarioFailures,
  fixtureIsSafeForScenario,
  missingLiveGates,
  modelDisplayName,
  multiWebviewScenarioFailures,
  parseGitStatusPaths,
  parseRestartCount,
  persistFixtureExitEvidence,
  promptModelFailures,
  queueHandoffMatches,
  recordLivePreparationResult,
  restoreSidebarSessionFromPicker,
  selectVarroTargetDescriptor,
  sendComposerPromptWithRetry,
  sessionSnapshotMatches,
  shouldRetryAi08WithFreshStream,
  shouldRetryActivityWithFreshStream,
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

test('frame and event evidence stay in the installed document when action worlds change', async () => {
  const controller = Object.assign(Object.create(CdpController.prototype), {
    targetId: 'iframe',
    frameId: 'content',
    targetContext: { viewId: 'sidebar' },
    contextId: 1,
    mainContextUniqueId: 'document-A',
  });
  const world = vm.createContext({ window: new EventTarget(), performance, structuredClone });
  controller.call = async (method, params) => {
    assert.equal(method, 'Runtime.evaluate');
    assert.equal(params.uniqueContextId, 'document-A');
    assert.equal(params.contextId, undefined);
    try {
      return { result: { value: vm.runInContext(params.expression, world) } };
    } catch (error) {
      return { exceptionDetails: { text: String(error) } };
    }
  };
  const owner = controller.observationOwner();
  await controller.startSessionEventCapture(owner);
  await controller.evaluateObservation(
    owner,
    'Install test frame observer',
    'globalThis.observer = { stop: () => 42 }; true'
  );
  world.window.dispatchEvent(
    new MessageEvent('message', {
      data: { type: 'server/event', payload: { type: 'session.idle' } },
    })
  );
  controller.contextId = 2;
  assert.equal(await controller.evaluateObservation(owner, 'Stop', 'observer.stop()'), 42);
  assert.equal((await controller.finishSessionEventCapture(owner))[0].event.type, 'session.idle');
  await assert.rejects(
    controller.finishSessionEventCapture(owner),
    /Installed session-event capture is missing/
  );
  controller.mainContextUniqueId = 'document-B';
  await assert.rejects(
    controller.evaluateObservation(owner, 'Stop', 'observer.stop()'),
    /Stop.*document-A.*owner changed.*document-B/
  );
});

test('AI-08 retains completed action evidence and identifies the interrupted step', async () => {
  const results = [];
  const started = [];
  let top = 0;
  const cdp = {
    captureActionState: async () => ({
      transcript: { scrollTop: top, firstVisibleMessageId: 'one', firstVisibleTop: -top },
    }),
    wheel: async () => {
      if (top) throw new Error('action target lost');
      top = 100;
      return true;
    },
  };
  const plan = [1, 2].map((step) => ({ step, action: 'wheel transcript', delta: 100 }));
  await assert.rejects(
    executeActionPlan(cdp, plan, '', 0, {
      results,
      onActionStart: ({ step }) => started.push(step),
    }),
    /action target lost/
  );
  assert.deepEqual(started, [1, 2]);
  assert.deepEqual(
    results.map(({ step, executed }) => ({ step, executed })),
    [{ step: 1, executed: true }]
  );
});

test('AI-18 defaults to the current pinned fixture layout', async () => {
  const { DEFAULT_AI18_FIXTURE_EDIT_PATH } = await import('./ai-fuzzy-live.mjs');
  assert.equal(DEFAULT_AI18_FIXTURE_EDIT_PATH, 'packages/util/src/bom.ts');
});

test('composer verification preserves line breaks and logical attachment markers', async () => {
  const dom = new JSDOM('<div aria-label="Message composer"></div>');
  try {
    const editor = dom.window.document.querySelector('[aria-label="Message composer"]');
    const controller = Object.create(CdpController.prototype);
    controller.evaluate = async (expression) =>
      vm.runInNewContext(expression, {
        document: dom.window.document,
        Node: dom.window.Node,
      });
    editor.innerHTML = 'first<br>second\u200B';
    assert.equal(await controller.readComposerText(), 'first\nsecond');
    editor.innerHTML = '<br>';
    assert.equal(await controller.readComposerText(), '');
    editor.innerHTML = '<span data-chip-marker="@src/file.ts">file.ts</span>\u200B tail';
    assert.equal(await controller.readComposerText(), '@src/file.ts tail');
  } finally {
    dom.window.close();
  }
});

test('composer replacement uses native select-all and verifies the exact input before Enter', async () => {
  const controller = Object.create(CdpController.prototype);
  const calls = [];
  let value = '@old-file.ts ';
  let selected = false;
  controller.click = async () => true;
  controller.readComposerText = async () => value;
  controller.call = async (method, params) => {
    calls.push({ method, params });
    if (params.commands?.includes('selectAll')) selected = true;
    if (method === 'Input.insertText') value = selected ? params.text : value + params.text;
  };
  assert.equal(await controller.sendComposerPrompt('/thinking'), true);
  assert.equal(value, '/thinking');
  assert.ok(calls.some((call) => call.params.commands?.includes('selectAll')));
  assert.equal(calls.filter((call) => call.params.key === 'Enter').length, 2);
});

test('composer replacement never submits a contaminated or restored draft', async () => {
  const controller = Object.create(CdpController.prototype);
  const calls = [];
  controller.click = async () => true;
  controller.readComposerText = async () => 'old draft /thinking';
  controller.call = async (method, params) => {
    calls.push({ method, params });
  };
  await assert.rejects(controller.sendComposerPrompt('/thinking'), /composer.*match/i);
  assert.equal(
    calls.some((call) => call.params.key === 'Enter'),
    false
  );
});

for (const [key, virtualKeyCode] of [
  ['Backspace', 8],
  ['Escape', 27],
  ['ArrowLeft', 37],
  ['ArrowRight', 39],
  ['Delete', 46],
]) {
  test(`native ${key} includes Chromium's Windows key codes`, async () => {
    const controller = Object.create(CdpController.prototype);
    const calls = [];
    controller.call = async (method, params) => {
      calls.push({ method, params });
    };
    assert.equal(await controller.key('', key), true);
    assert.deepEqual(
      calls.map((call) => call.params.type),
      ['keyDown', 'keyUp']
    );
    for (const call of calls) {
      assert.equal(call.method, 'Input.dispatchKeyEvent');
      assert.equal(call.params.key, key);
      assert.equal(call.params.windowsVirtualKeyCode, virtualKeyCode);
      assert.equal(call.params.nativeVirtualKeyCode, virtualKeyCode);
    }
  });
}

test('awaits asynchronous frame observations before returning their values', async () => {
  const controller = Object.create(CdpController.prototype);
  controller.contextId = 7;
  controller.call = async (_method, params) => {
    const value = vm.runInNewContext(params.expression);
    return { result: { value: params.awaitPromise ? await value : undefined } };
  };
  assert.deepEqual(await controller.evaluate('Promise.resolve(42)'), 42);
});

test('queue handoff readiness requires an enabled, exposed native steer control', async () => {
  const dom = new JSDOM(
    '<div data-queued-message-id="queue" data-queued-message-owner="sidebar"><button aria-label="Play queued message"></button><button aria-label="Send as Steer" hidden></button></div>'
  );
  try {
    const controller = Object.create(CdpController.prototype);
    controller.evaluate = async (expression) =>
      vm.runInNewContext(expression, { document: dom.window.document });
    const button = dom.window.document.querySelector('[aria-label="Send as Steer"]');
    button.getBoundingClientRect = () => ({ width: 22 });
    assert.equal((await controller.readQueueRow('queue')).steerAvailable, false);
    button.hidden = false;
    button.disabled = true;
    assert.equal((await controller.readQueueRow('queue')).steerAvailable, false);
    button.disabled = false;
    const queueRow = await controller.readQueueRow('queue');
    assert.equal(queueRow.steerAvailable, true);
    assert.equal(queueRow.ownerViewId, 'sidebar');
    assert.equal(queueRow.paused, true);
    button.getBoundingClientRect = () => ({ width: 0 });
    assert.equal((await controller.readQueueRow('queue')).steerAvailable, false);
    assert.equal(await controller.readQueueRow('other'), null);
  } finally {
    dom.window.close();
  }
});

test('reveals an unmounted current-turn disclosure without substituting another turn', async () => {
  const { revealRetainedActivity } = await import('./ai-fuzzy-live.mjs');
  const scope = { messageIds: ['tool-message'] },
    inputs = [];
  let step = 0;
  const cdp = {
    snapshot: async () => ({ routeSessionId: 'session' }),
    captureActionState: async (requested) => {
      assert.equal(requested, scope);
      return {
        transcript: { scrollTop: 1000 - step * 420 },
        disclosures: step === 2 ? [{ visible: true }] : [{ visible: false }],
      };
    },
    wheel: async (selector, delta, edge) => {
      inputs.push({ selector, delta, edge });
      step++;
      return true;
    },
  };
  const result = await revealRetainedActivity(cdp, 'session', scope, { wait: async () => {} });
  assert.equal(result.found, true);
  assert.equal(inputs.length, 2);
  assert.ok(inputs.every((input) => input.delta === -420 && input.edge === 'right'));
});

test('retained activity navigation stops on missing scope, another route, and its native-input bound', async () => {
  const { revealRetainedActivity } = await import('./ai-fuzzy-live.mjs');
  const cdp = {
    snapshot: async () => ({ routeSessionId: 'other' }),
    captureActionState: async () => ({ transcript: { scrollTop: 5000 }, disclosures: [] }),
    wheel: async () => true,
  };
  assert.equal((await revealRetainedActivity(cdp, 'session', null)).actions.length, 0);
  assert.equal(
    (await revealRetainedActivity(cdp, 'session', { messageIds: ['tool'] })).actions.length,
    0
  );
  cdp.snapshot = async () => ({ routeSessionId: 'session' });
  const result = await revealRetainedActivity(
    cdp,
    'session',
    { messageIds: ['tool'] },
    { maxSteps: 2, wait: async () => {} }
  );
  assert.equal(result.found, false);
  assert.equal(result.actions.length, 2);
});

test('live snapshots use the folder-scoped sidebar route in a fresh profile', async () => {
  const controller = Object.create(CdpController.prototype);
  controller.mainContextId = 1;
  controller.evaluate = async () => ({ title: 'wanted' });
  controller.call = async (_method, params) => ({
    result: {
      value: vm.runInNewContext(params.expression, {
        __initialWebviewState: {
          webviewContext: { surface: 'sidebar', viewId: 'sidebar' },
          editorContext: { workspacePath: '/repo' },
        },
        __vscodeWebviewState: {
          getState: () => ({
            'varro.lastOpenedView:/repo': {
              type: 'session',
              sessionId: 'wanted',
              directory: '/repo/nested',
            },
          }),
        },
        localStorage: { getItem: () => null },
        document: { querySelectorAll: () => [] },
      }),
    },
  });
  assert.equal((await controller.snapshot()).routeSessionId, 'wanted');
});

test('diff toggles require a rendered visibility transition, not just command dispatch', () => {
  assert.deepEqual(
    verifyActionEffect(
      { action: 'show file diffs' },
      { inlineDiffCount: 0 },
      { inlineDiffCount: 1 },
      { dispatched: true }
    ),
    { verified: true }
  );
  assert.deepEqual(
    verifyActionEffect(
      { action: 'hide file diffs' },
      { inlineDiffCount: 1 },
      { inlineDiffCount: 0 },
      { dispatched: true }
    ),
    { verified: true }
  );
  assert.equal(
    verifyActionEffect(
      { action: 'show file diffs' },
      { inlineDiffCount: 0 },
      { inlineDiffCount: 0 },
      { dispatched: true }
    ).verified,
    false
  );
});

test('held scrollbar actions require pointer ownership, boundary arrival, and painted content', () => {
  const before = {};
  const after = {
    transcript: {
      scrollTop: 800,
      scrollHeight: 1000,
      clientHeight: 200,
      visibleRows: [{ messageId: 'last', top: 0 }],
    },
  };
  const action = { action: 'held scrollbar to bottom' };
  assert.deepEqual(verifyActionEffect(action, before, after, { dispatched: true, held: true }), {
    verified: true,
  });
  assert.equal(
    verifyActionEffect(action, before, after, { dispatched: true, held: false }).verified,
    false
  );
  assert.equal(
    verifyActionEffect(
      action,
      before,
      { transcript: { ...after.transcript, visibleRows: [] } },
      { dispatched: true, held: true }
    ).verified,
    false
  );
});

test('held native scrollbar input releases the button even if an intermediate move fails', async () => {
  const controller = Object.create(CdpController.prototype);
  controller.evaluate = async () => ({ x: 490, start: 20, end: 400 });
  const calls = [];
  controller.call = async (_method, params) => {
    calls.push(params.type);
    if (params.type === 'mouseMoved') throw new Error('lost target');
  };
  await assert.rejects(controller.dragTranscriptScrollbar(1), /lost target/);
  assert.deepEqual(calls, ['mousePressed', 'mouseMoved', 'mouseReleased']);
});

test('native thumb targeting re-grabs once only after observed range growth with painted content', async () => {
  const controller = Object.create(CdpController.prototype);
  controller.evaluate = async (expression) =>
    expression.includes('hasAttribute') ? true : { x: 490, start: 20, end: 1, range: 1000 };
  let releases = 0;
  controller.call = async (_method, params) => {
    if (params.type === 'mouseReleased') releases++;
  };
  controller.captureActionState = async () => ({
    transcript: {
      scrollTop: releases === 1 ? 100 : 0,
      scrollHeight: 1300,
      clientHeight: 200,
      visibleRows: [{ messageId: 'visible', top: 0 }],
    },
  });
  const result = await controller.dragTranscriptScrollbar(0);
  assert.equal(result.attempts.length, 2);
  assert.equal(result.attempts[1].reached, true);
  assert.equal(releases, 2);
});

test('native fractional grabs use distinct thumb endpoints and verify fractional arrival', async () => {
  const endpoints = [];
  for (const fraction of [0.25, 0.75, 0.5]) {
    const controller = Object.create(CdpController.prototype);
    const list = {
      scrollHeight: 2000,
      clientHeight: 400,
      scrollTop: 0,
      offsetWidth: 500,
      clientWidth: 490,
      getBoundingClientRect: () => ({ top: 100, bottom: 900, right: 500, height: 800 }),
      hasAttribute: () => true,
      querySelectorAll: () => [list],
    };
    controller.evaluate = async (expression) =>
      vm.runInNewContext(expression, {
        document: { querySelector: () => list },
        innerHeight: 1100,
      });
    controller.call = async (_method, params) => {
      if (params.type === 'mouseReleased') endpoints.push(params.y);
    };
    controller.captureActionState = async () => ({
      transcript: {
        scrollTop: fraction * 1600,
        scrollHeight: 2000,
        clientHeight: 400,
        visibleRows: [{ messageId: 'visible', top: 0 }],
      },
    });
    const result = await controller.dragTranscriptScrollbar(fraction);
    assert.equal(result.dispatched, true);
    assert.equal(result.held, true);
    assert.equal(result.attempts.length, 1);
    assert.equal(result.attempts[0].reached, true);
  }
  assert.deepEqual(endpoints, [340, 660, 500]);
});

test('invalid scrollbar fractions never dispatch native input', async () => {
  const controller = Object.create(CdpController.prototype);
  controller.evaluate = async () => {
    throw new Error('Unexpected evaluation');
  };
  for (const fraction of [-1, 2, NaN, Infinity, undefined])
    await assert.rejects(controller.dragTranscriptScrollbar(fraction), /fraction/);
});

test('fractional arrival allows only native pointer quantization, not a wrong destination', async () => {
  for (const [offset, expected] of [
    [12, true],
    [60, false],
  ]) {
    const controller = Object.create(CdpController.prototype);
    controller.evaluate = async (expression) =>
      expression.includes('hasAttribute')
        ? { held: true, visible: true, top: 7500 + offset, range: 30000 }
        : { x: 490, start: 700, end: 200, range: 30000, travel: 600 };
    controller.call = async () => {};
    controller.captureActionState = async () => ({
      transcript: {
        scrollTop: 7500 + offset,
        scrollHeight: 30600,
        clientHeight: 600,
        visibleRows: [{ messageId: 'visible', top: 0 }],
      },
    });
    const result = await controller.dragTranscriptScrollbar(0.25);
    assert.equal(result.attempts[0].targetTolerance, 51.5);
    assert.equal(result.attempts[0].reached, expected);
    assert.equal(result.attempts.length, 1);
  }
});

test('fractional native targeting calibrates the held drag and preserves failed observations', async () => {
  for (const failure of [null, 'blank', 'ownership']) {
    const controller = Object.create(CdpController.prototype);
    const range = 29824;
    const start = 657.90625;
    const travel = 610.90625;
    const end = start - 0.75 * travel;
    const events = [];
    let top = range;
    controller.call = async (_method, event) => {
      events.push(event);
      if (event.type === 'mouseMoved') {
        // Different native travel from the controller's estimate; integer pointer coordinates.
        top = Math.round(range + ((Math.round(event.y) - Math.round(start)) * range) / 614);
      }
    };
    controller.evaluate = async (expression) =>
      expression.includes('hasAttribute')
        ? { held: failure !== 'ownership', visible: failure !== 'blank', top, range }
        : { x: 481, start, end, range, travel };
    controller.captureActionState = async () => ({
      transcript: {
        scrollTop: top,
        scrollHeight: range + 631,
        clientHeight: 631,
        visibleRows: [{}],
      },
    });
    const result = await controller.dragTranscriptScrollbar(0.25);
    const [attempt] = result.attempts;
    assert.equal(result.attempts.length, 1);
    assert.equal(attempt.held, failure !== 'ownership');
    assert.equal(attempt.reached, !failure);
    assert.equal(events.at(-1).type, 'mouseReleased');
    assert.equal(events.at(-1).y, events.at(-2).y);
    assert.equal(attempt.samples.length, failure ? 1 : 3);
    if (!failure) {
      assert.ok(Math.abs(attempt.samples[1].top - range / 4) > attempt.targetTolerance);
      assert.ok(Math.abs(top - range / 4) <= attempt.targetTolerance);
    }
  }
});

test('retries an exhausted live tool window without retrying a scrolling failure', () => {
  const execution = { executed: false, actions: [{ outcome: 'active-window-ended' }] };
  assert.equal(shouldRetryActivityWithFreshStream(execution, 1, 3), true);
  assert.equal(shouldRetryActivityWithFreshStream(execution, 3, 3), false);
  assert.equal(shouldRetryActivityWithFreshStream({ ...execution, executed: true }, 1, 3), false);
  assert.equal(
    shouldRetryActivityWithFreshStream(
      { executed: false, actions: [{ outcome: 'bottom-not-reached' }] },
      1,
      3
    ),
    false
  );
  assert.equal(
    shouldRetryActivityWithFreshStream({ executed: false, failurePhase: 'nested-handoff' }, 1, 3),
    false
  );
});

function transcriptStateAt(scrollTop) {
  return {
    focusOwner: 'transcript',
    transcript: { scrollTop, firstVisibleMessageId: 'message-1', firstVisibleTop: 0 },
  };
}

test('accepts the current Sol model without substituting a different model', () => {
  assert.equal(validateLiveModel('openai/gpt-6.1-sol'), 'openai/gpt-6.1-sol');
  assert.equal(modelDisplayName('openai/gpt-6.1-sol'), 'GPT-6.1 Sol');
  assert.throws(() => validateLiveModel('other/gpt-6.1-sol'), /--model/);
  assert.throws(() => validateLiveModel('openai/gpt-6.1-sol-fast'), /--model/);
});

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
  assert.deepEqual(gate.latestMissing, ['active model stream']);
  assert.equal(gate.observations.length, 2);
});

test('prepares the sticky gate even without a nested activity scroller', async () => {
  let wheelCount = 0;
  const gate = await waitForLiveGate({
    client: { isBusy: async () => true },
    cdp: {
      snapshot: async () => ({
        ...ready,
        nestedActivityScroller: null,
        stickyMessageId: wheelCount >= 2 ? 'message-1' : null,
      }),
      click: async (selector) => {
        assert.equal(selector, '.assistant-activity-summary[aria-expanded="false"]');
        return true;
      },
      key: async (selector, key) => {
        assert.equal(selector, '.interactive-list');
        assert.equal(key, 'End');
        wheelCount += 1;
        return true;
      },
    },
    sessionId: 'session',
    scenario: 'AI-07',
    timeoutMs: 1_000,
    pollIntervalMs: 0,
  });

  assert.equal(wheelCount, 2);
  assert.deepEqual(gate.missing, []);
});

test('bounds native sticky preparation while the marked prompt is not sticky', async () => {
  let wheelCount = 0;
  const gate = await waitForLiveGate({
    client: { isBusy: async () => true },
    cdp: {
      snapshot: async () => ({
        ...ready,
        stickyMessageId: wheelCount >= 5 ? 'message-1' : null,
      }),
      click: async () => false,
      key: async () => {
        wheelCount += 1;
        return true;
      },
    },
    sessionId: 'session',
    scenario: 'AI-08',
    timeoutMs: 1_000,
    pollIntervalMs: 0,
  });

  assert.equal(wheelCount, 5);
  assert.deepEqual(gate.missing, []);
});

test('builds a targeted bounded recovery prompt from missing gates', () => {
  const prompt = buildLivePrompt({
    seed: 'abc',
    attempt: 2,
    missing: ['file edit or diff'],
  });

  assert.match(prompt, /^\[VFZ:abc:AI-07:R1:TOOLS-A2\]/);
  assert.match(prompt, /one to three existing source or test files/);
  assert.match(prompt, /new turn must independently produce the complete live gate/);
  assert.match(prompt, /especially clear.*file edit or diff/);
  assert.match(prompt, /expandable Explored disclosure/);
  assert.match(prompt, /Do not use sleep, no-op commands, duplicate status commands/);
  assert.match(prompt, /Do not spawn, delegate to, or otherwise use subagents/);
});

test('requests the complete gate in every retry when successive turns split the gates', () => {
  const retries = [
    buildLivePrompt({ seed: 'abc', attempt: 2, missing: ['file edit or diff'] }),
    buildLivePrompt({ seed: 'abc', attempt: 3, missing: ['expandable activity disclosure'] }),
  ];

  for (const prompt of retries) {
    assert.match(prompt, /three to five separate read or search operations/);
    assert.match(prompt, /one to three existing source or test files/);
    assert.match(prompt, /expandable diff/);
    assert.match(prompt, /expandable Explored disclosure/);
    assert.doesNotMatch(prompt, /sleep \d/);
  }
});

test('the initial task requests the content forms needed by the live gate', () => {
  const prompt = buildLivePrompt({ seed: 'abc', attempt: 1 });

  assert.match(prompt, /three to five separate read or search operations/);
  assert.match(prompt, /one to three existing source or test files/);
  assert.match(prompt, /run a focused test plus any broader check warranted by the change/);
  assert.doesNotMatch(prompt, /sleep \d/);
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

  assert.deepEqual(
    verifyActionEffect({ action: 'Space on transcript' }, state, state, { dispatched: true }),
    {
      verified: true,
    }
  );
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

test('accepts a boundary wheel while streaming layout changes bottom geometry', () => {
  const before = {
    focusOwner: 'transcript',
    transcript: {
      scrollTop: 500,
      scrollHeight: 1_000,
      clientHeight: 500,
      firstVisibleMessageId: 'message-1',
      firstVisibleTop: -5,
    },
  };
  const after = {
    focusOwner: 'transcript',
    transcript: {
      scrollTop: 498,
      scrollHeight: 998,
      clientHeight: 500,
      firstVisibleMessageId: 'message-1',
      firstVisibleTop: -3,
    },
  };

  assert.deepEqual(
    verifyActionEffect({ action: 'wheel transcript', delta: 420 }, before, after, {
      dispatched: true,
      settledAfter: after,
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
  assert.equal(
    classifyPromptDisposition(messages, queueItems, marker).status,
    'admitted-and-queued'
  );
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
  assert.equal(
    results.every(({ executed }) => executed),
    true
  );
});

test('dispatches both native scrollbar destinations through the AI-08 executor', async () => {
  const destinations = [];
  let fraction = 0;
  const cdp = {
    dragTranscriptScrollbar: async (next) => {
      destinations.push(next);
      fraction = next;
      return { dispatched: true, held: true };
    },
    captureActionState: async () => ({
      transcript: {
        scrollTop: fraction * 800,
        scrollHeight: 1000,
        clientHeight: 200,
        visibleRows: [{ messageId: fraction ? 'last' : 'first', top: 0 }],
      },
    }),
  };
  const results = await executeActionPlan(
    cdp,
    [
      { step: 1, action: 'held scrollbar to top' },
      { step: 2, action: 'held scrollbar to bottom' },
    ],
    'session',
    0
  );
  assert.deepEqual(destinations, [0, 1]);
  assert.equal(
    results.every(({ executed }) => executed),
    true
  );
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

test('verifies a bottom-pinned jump against its detached starting point', async () => {
  const calls = [];
  let top = 1000;
  const cdp = {
    click: async (selector) => {
      calls.push(['click', selector]);
      if (calls.length !== 4) return false;
      top = 1000;
      return true;
    },
    wheel: async (selector, delta, side) => {
      calls.push(['wheel', selector, delta, side]);
      top = 580;
      return true;
    },
    captureActionState: async () => ({
      focusOwner: 'transcript',
      transcript: {
        sessionId: 'session',
        scrollTop: top,
        scrollHeight: 1600,
        clientHeight: 600,
        firstVisibleMessageId: top === 1000 ? 'latest' : 'older',
        firstVisibleTop: 0,
        visibleRows: [{ messageId: top === 1000 ? 'latest' : 'older', top: 0 }],
      },
    }),
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
  assert.equal(results[0].navigationStart.transcript.scrollTop, 580);
  assert.equal(results[0].before.transcript.scrollTop, 1000);
  assert.equal(results[0].after.transcript.scrollTop, 1000);
});

test('does not pass an unverified jump just because it started at bottom', () => {
  const action = { action: 'click sticky or jump to latest' };
  const pinned = {
    transcript: {
      sessionId: 'session',
      scrollTop: 1000,
      scrollHeight: 1600,
      clientHeight: 600,
      firstVisibleMessageId: 'latest',
      firstVisibleTop: 0,
      visibleRows: [{ messageId: 'latest', top: 0 }],
    },
  };
  const detached = {
    transcript: { ...pinned.transcript, scrollTop: 580, firstVisibleMessageId: 'older' },
  };
  assert.equal(verifyActionEffect(action, pinned, pinned, { dispatched: true }).verified, false);
  assert.equal(
    verifyActionEffect(action, pinned, pinned, {
      dispatched: true,
      navigationStart: pinned,
    }).verified,
    false
  );
  assert.equal(
    verifyActionEffect(action, pinned, detached, {
      dispatched: true,
      navigationStart: detached,
    }).verified,
    false
  );
  assert.equal(
    verifyActionEffect(
      action,
      pinned,
      { transcript: { ...pinned.transcript, sessionId: 'other' } },
      {
        dispatched: true,
        navigationStart: detached,
      }
    ).verified,
    false
  );
});

test('allows bounded follow lag only for a verified active-stream jump', () => {
  const action = { action: 'click sticky or jump to latest' };
  const before = {
    transcript: {
      sessionId: 'session',
      scrollTop: 1000,
      scrollHeight: 1600,
      clientHeight: 600,
      firstVisibleMessageId: 'latest',
      firstVisibleTop: 0,
      visibleRows: [{ messageId: 'latest', top: 0 }],
    },
  };
  const start = {
    transcript: {
      ...before.transcript,
      scrollTop: 580,
      firstVisibleMessageId: 'older',
      visibleRows: [{ messageId: 'older', top: 0 }],
    },
  };
  const after = { transcript: { ...before.transcript, scrollTop: 960 } };
  assert.equal(
    verifyActionEffect(action, before, after, {
      dispatched: true,
      navigationStart: start,
    }).verified,
    false
  );
  assert.equal(
    verifyActionEffect(action, before, after, {
      dispatched: true,
      navigationStart: start,
      streaming: true,
    }).verified,
    true
  );
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
  assert.equal(shouldRetryAi08WithFreshStream({ reason: 'model stream settled' }, 1, 3), true);
  assert.equal(shouldRetryAi08WithFreshStream({ reason: 'model stream settled' }, 3, 3), false);
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
  assert.equal(modelDisplayName('openai/gpt-6-luna-fast'), 'GPT-6 Luna Fast');
  assert.equal(modelDisplayName('openai/gpt-6-sol'), 'GPT-6 Sol');
});

test('accepts only the required Luna Fast and Sol live models', () => {
  assert.equal(validateLiveModel('openai/gpt-6-luna-fast'), 'openai/gpt-6-luna-fast');
  assert.equal(validateLiveModel('openai/gpt-6-sol'), 'openai/gpt-6-sol');
  assert.throws(() => validateLiveModel('openai/gpt-5.6-luna'), /Luna|luna/);
});

test('accepts a bounded restart count for duplicate-delivery stress', () => {
  assert.equal(parseRestartCount(undefined), 1);
  assert.equal(parseRestartCount('4'), 4);
  assert.throws(() => parseRestartCount('0'), /integer from 1 through 10/);
  assert.throws(() => parseRestartCount('11'), /integer from 1 through 10/);
});

test('independent scenarios accept a clean baseline or exact owned edits, not a previous scenario verdict', () => {
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
  assert.equal(fixtureIsSafeForScenario(fixture, manifest, 'AI-19'), true);
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
      {
        ...manifest,
        livePreparation: { 'AI-07': { prepared: false, fixtureAfterPreparation: fixture } },
      },
      'AI-08'
    ),
    false
  );
  for (const scenario of ['AI-08', 'AI-18', 'AI-19']) {
    assert.equal(
      fixtureIsSafeForScenario(
        { commit: 'abc', status: '' },
        { fixture: manifest.fixture },
        scenario
      ),
      true
    );
    const failed = {
      ...manifest,
      livePreparation: {
        'AI-07': {
          prepared: false,
          fixtureExitEvidence: { ...fixture, capturedAt: '2026-09-22T10:00:00Z' },
        },
      },
    };
    assert.equal(fixtureIsSafeForScenario(fixture, failed, scenario), true);
    assert.equal(
      fixtureIsSafeForScenario({ ...fixture, contentHash: 'external-edit' }, failed, scenario),
      false
    );
    failed.livePreparation['AI-19'] = {
      fixtureExitEvidence: {
        ...fixture,
        contentHash: 'later-edit',
        capturedAt: '2026-09-22T11:00:00Z',
      },
    };
    assert.equal(fixtureIsSafeForScenario(fixture, failed, scenario), false);
    assert.equal(
      fixtureIsSafeForScenario({ ...fixture, contentHash: 'later-edit' }, failed, scenario),
      true
    );
    assert.equal(
      fixtureIsSafeForScenario({ ...fixture, commit: 'different' }, failed, scenario),
      false
    );
  }
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

test('matches open sessions by recorded route ID rather than title alone', () => {
  const snapshot = { routeSessionId: 'session-1', title: 'Duplicate title' };

  assert.equal(sessionSnapshotMatches(snapshot, 'session-1', 'Duplicate title'), true);
  assert.equal(sessionSnapshotMatches(snapshot, 'session-2', 'Duplicate title'), false);
});

test('parses exact changed paths including both sides of a rename', () => {
  assert.deepEqual(parseGitStatusPaths(' M source.ts\0?? new file.ts\0R  renamed.ts\0old.ts\0'), [
    'new file.ts',
    'old.ts',
    'renamed.ts',
    'source.ts',
  ]);
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

test('cleanup aggregation retains the original controller failure and nested cleanup cause', async () => {
  const manifest = {};
  await persistFixtureExitEvidence({
    manifest,
    manifestPath: '/manifest.json',
    scenario: 'AI-08',
    workspace: '/fixture',
    error: new AggregateError(
      [
        new Error('original action target disappeared'),
        new AggregateError(
          [new Error('observer context was destroyed')],
          'observer cleanup failed'
        ),
      ],
      'frame observation cleanup failed'
    ),
    readFixture: async () => ({ commit: 'abc', status: '', changedPaths: [] }),
    writeManifest: async () => {},
  });
  const failure = manifest.livePreparation['AI-08'].controllerFailure;
  assert.match(failure, /original action target disappeared/);
  assert.match(failure, /observer cleanup failed/);
  assert.match(failure, /observer context was destroyed/);
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

test('uses painted rows instead of raw scroll coordinates for delayed reversal checks', () => {
  const before = {
    focusOwner: 'transcript',
    transcript: {
      scrollTop: 100,
      scrollHeight: 1_000,
      clientHeight: 400,
      visibleRows: [{ messageId: 'message-1', top: 100 }],
    },
  };
  const after = {
    focusOwner: 'transcript',
    transcript: {
      scrollTop: 200,
      scrollHeight: 1_100,
      clientHeight: 400,
      visibleRows: [{ messageId: 'message-1', top: 0 }],
    },
  };
  const settledAfter = {
    focusOwner: 'transcript',
    transcript: {
      scrollTop: 150,
      scrollHeight: 1_050,
      clientHeight: 400,
      visibleRows: [{ messageId: 'message-1', top: 0 }],
    },
  };

  assert.deepEqual(
    verifyActionEffect({ action: 'key on transcript', key: 'End' }, before, after, {
      dispatched: true,
      settledAfter,
    }),
    { verified: true }
  );
});

test('preserves the recorded AI-08 ArrowUp failure despite concurrent height growth', () => {
  // Reduced from seed 20260908T215225Z, action 26. These are row boxes, not descendants.
  const [before, after] = [
    [65818, 66575, [-212, 106, 185, 211, 361, 361, 485]],
    [68639, 69347, [-261, 57, 136, 162, 312, 312, 436]],
  ].map(([scrollTop, scrollHeight, tops]) => ({
    focusOwner: 'transcript',
    transcript: {
      scrollTop,
      scrollHeight,
      clientHeight: 491,
      visibleRows: tops.map((top, index) => ({ messageId: `row-${index}`, top })),
    },
  }));
  assert.deepEqual(
    verifyActionEffect({ action: 'key on transcript', key: 'ArrowUp' }, before, after, {
      dispatched: true,
      settledAfter: after,
    }),
    { verified: false, reason: 'transcript moved opposite the requested direction' }
  );
});

test('does not mistake anchor-preserving height compensation for native movement', () => {
  const before = {
    focusOwner: 'composer',
    transcript: {
      scrollTop: 100,
      scrollHeight: 1000,
      clientHeight: 400,
      visibleRows: [{ messageId: 'message-1', top: 20 }],
    },
  };
  const after = {
    ...before,
    transcript: { ...before.transcript, scrollTop: 300, scrollHeight: 1200 },
  };
  assert.deepEqual(
    verifyActionEffect({ action: 'Space in composer' }, before, after, { dispatched: true }),
    { verified: true }
  );
  assert.deepEqual(
    verifyActionEffect({ action: 'wheel transcript', delta: 96 }, before, after, {
      dispatched: true,
    }),
    { verified: false, reason: 'transcript destination did not move' }
  );
});

test('requires direction evidence when height changes without a shared visible row', () => {
  const before = {
    focusOwner: 'transcript',
    transcript: {
      scrollTop: 100,
      scrollHeight: 1000,
      clientHeight: 400,
      visibleRows: [{ messageId: 'old', top: 20 }],
    },
  };
  const after = {
    ...before,
    transcript: {
      ...before.transcript,
      scrollTop: 300,
      scrollHeight: 1200,
      visibleRows: [{ messageId: 'new', top: 20 }],
    },
  };
  for (const delta of [-96, 96]) {
    assert.deepEqual(
      verifyActionEffect({ action: 'wheel transcript', delta }, before, after, {
        dispatched: true,
      }),
      { verified: false, reason: 'transcript movement direction could not be verified' }
    );
  }
});

test('keeps shared-row direction authoritative over height-driven scroll coordinates', () => {
  const before = {
    focusOwner: 'transcript',
    transcript: {
      scrollTop: 100,
      scrollHeight: 1000,
      clientHeight: 400,
      visibleRows: [{ messageId: 'message-1', top: 20 }],
    },
  };
  const after = {
    ...before,
    transcript: {
      ...before.transcript,
      scrollTop: 300,
      scrollHeight: 1240,
      visibleRows: [{ messageId: 'message-1', top: 60 }],
    },
  };
  const action = { action: 'key on transcript', key: 'ArrowUp' };
  assert.deepEqual(
    verifyActionEffect(action, before, after, { dispatched: true, settledAfter: after }),
    {
      verified: true,
    }
  );
  assert.deepEqual(verifyActionEffect(action, before, after), {
    verified: false,
    reason: 'input was not dispatched',
  });
  assert.equal(
    verifyActionEffect(
      action,
      before,
      { ...after, focusOwner: 'composer' },
      {
        dispatched: true,
      }
    ).verified,
    false
  );
  assert.equal(
    verifyActionEffect(
      { action: 'Space in composer' },
      before,
      {
        ...after,
        focusOwner: 'composer',
      },
      { dispatched: true }
    ).verified,
    false
  );
});

test('verifies disjoint viewport movement from stable mounted message order', () => {
  const before = {
    focusOwner: 'transcript',
    transcript: {
      sessionId: 'session-1',
      scrollTop: 60760,
      scrollHeight: 61480,
      clientHeight: 514,
      mountedMessageIds: ['older', 'middle', 'newer'],
      visibleRows: [{ messageId: 'newer', top: 0 }],
    },
  };
  const after = {
    ...before,
    transcript: {
      ...before.transcript,
      scrollTop: 60290,
      scrollHeight: 61524,
      visibleRows: [{ messageId: 'older', top: -78 }],
    },
  };
  const action = { action: 'key on transcript', key: 'Shift+Space' };
  assert.deepEqual(
    verifyActionEffect(action, before, after, { dispatched: true, settledAfter: after }),
    { verified: true }
  );
  assert.equal(
    verifyActionEffect({ ...action, key: 'Space' }, before, after, { dispatched: true }).verified,
    false
  );
  for (const transcript of [
    { ...after.transcript, sessionId: 'other-session' },
    { ...after.transcript, mountedMessageIds: ['newer', 'middle', 'older'] },
  ]) {
    assert.equal(
      verifyActionEffect(action, before, { ...after, transcript }, { dispatched: true }).verified,
      false
    );
  }
});

test('requires settle evidence when height changes without a shared visible row', () => {
  const before = {
    focusOwner: 'transcript',
    transcript: {
      scrollTop: 100,
      scrollHeight: 1000,
      clientHeight: 400,
      visibleRows: [{ messageId: 'message-1', top: 100 }],
    },
  };
  const after = {
    ...before,
    transcript: {
      ...before.transcript,
      scrollTop: 200,
      visibleRows: [{ messageId: 'message-1', top: 0 }],
    },
  };
  const settledAfter = {
    ...after,
    transcript: { ...after.transcript, scrollTop: 150, scrollHeight: 950, visibleRows: [] },
  };
  assert.deepEqual(
    verifyActionEffect({ action: 'wheel transcript', delta: 96 }, before, after, {
      dispatched: true,
      settledAfter,
    }),
    { verified: false, reason: 'settled transcript movement direction could not be verified' }
  );
});

test('reads canonical order when Home leaves both mounted windows', async () => {
  const before = {
    focusOwner: 'transcript',
    transcript: {
      sessionId: 'session',
      scrollTop: 19000,
      scrollHeight: 20825,
      clientHeight: 514,
      mountedMessageIds: ['new'],
      visibleRows: [{ messageId: 'new', top: -16 }],
    },
  };
  const after = {
    focusOwner: 'transcript',
    transcript: {
      sessionId: 'session',
      scrollTop: 9309,
      scrollHeight: 29924,
      clientHeight: 514,
      mountedMessageIds: ['old'],
      visibleRows: [{ messageId: 'old', top: -34 }],
    },
  };
  let capture = 0;
  let reads = 0;
  const actions = await executeActionPlan(
    {
      captureActionState: async () => (capture++ === 0 ? before : after),
      key: async () => true,
    },
    [{ step: 45, action: 'key on transcript', key: 'Home' }],
    'session',
    0,
    {
      readMessageOrder: async () => {
        reads += 1;
        return ['old', 'middle', 'new'];
      },
    }
  );
  assert.equal(actions[0].executed, true);
  assert.equal(reads, 1);
  assert.deepEqual(actions[0].messageOrder, ['old', 'middle', 'new']);
  assert.equal(
    verifyActionEffect({ action: 'key on transcript', key: 'Home' }, before, after, {
      dispatched: true,
      messageOrder: ['new', 'middle', 'old'],
    }).verified,
    false
  );
});

test('uses the current editor action label', async () => {
  let clickedText = null;
  const clicked = await clickOpenInEditor({
    clickText: async (text) => {
      clickedText = text;
      return true;
    },
  });

  assert.equal(clicked, true);
  assert.equal(clickedText, 'Open in Editor');
});

test('returns the sidebar from a managed child before using the session picker fallback', async () => {
  const root = { routeSessionId: 'root', title: 'Root' };
  let active = { routeSessionId: 'child', title: 'Child' };
  let escaped = false;
  const restored = await restoreSidebarSessionFromPicker(
    {
      snapshot: async () => active,
      clickText: async (text) => {
        assert.equal(text, 'Return to parent');
        active = root;
        return true;
      },
      click: async () => false,
      key: async () => {
        escaped = true;
        return true;
      },
    },
    'root',
    'Root'
  );

  assert.equal(restored, true);
  assert.equal(escaped, false);
});

test('restores the exact sidebar session when Escape returns to an unrelated route', async () => {
  const root = { routeSessionId: 'root', title: 'Root' };
  let active = { routeSessionId: 'unrelated', title: 'Unrelated' };
  const actions = [];
  const restored = await restoreSidebarSessionFromPicker(
    {
      snapshot: async () => active,
      clickText: async () => false,
      click: async (selector) => {
        actions.push(selector);
        return selector === '[aria-label="Back to sessions"]';
      },
      key: async () => true,
      clickSession: async (sessionId) => {
        actions.push(sessionId);
        assert.equal(sessionId, 'root');
        active = root;
        return true;
      },
    },
    'root',
    'Root'
  );

  assert.equal(restored, true);
  assert.deepEqual(actions.slice(-2), ['[aria-label="Back to sessions"]', 'root']);
});

test('retains a failed live run when recording its replay', () => {
  const failedRun = {
    scenario: 'AI-08',
    promptRun: 1,
    prepared: false,
    actionFailure: { step: 45, reason: 'transcript movement reversed after the input' },
    recordedAt: '2026-08-29T00:00:00.000Z',
  };
  const manifest = { livePreparation: { 'AI-08': failedRun } };

  assert.equal(beginLivePreparationRun(manifest, 'AI-08'), 2);
  recordLivePreparationResult(manifest, 'AI-08', {
    scenario: 'AI-08',
    promptRun: 2,
    prepared: true,
    actionFailure: null,
  });

  assert.equal(manifest.livePreparation['AI-08'].prepared, true);
  assert.equal(manifest.livePreparation['AI-08'].runs.length, 1);
  assert.deepEqual(manifest.livePreparation['AI-08'].runs[0], failedRun);
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
    ['.assistant-activity-summary[data-activity-summary-group-key="group-current"]', scope],
  ]);
  assert.equal(results[0].executed, true);
});

test('targets a visible current-turn disclosure before a hidden retained disclosure', async () => {
  let expanded = false;
  const clicks = [];
  const scope = { messageIds: ['current'] };
  const results = await executeActionPlan(
    {
      captureActionState: async () => ({
        disclosures: [
          { messageId: 'current', key: 'hidden', expanded: false, visible: false },
          { messageId: 'current', key: 'visible', expanded, visible: true },
        ],
      }),
      click: async (selector, receivedScope) => {
        assert.deepEqual(receivedScope, scope);
        clicks.push(selector);
        if (!selector.includes('="visible"')) return false;
        expanded = true;
        return true;
      },
    },
    [{ step: 9, action: 'expand disclosure' }],
    'session',
    0,
    { scope }
  );
  assert.equal(results[0].executed, true);
  assert.equal(clicks.length, 1);
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

  assert.deepEqual(
    result.observed.map((session) => session.id),
    ['grandchild']
  );
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
  assert.equal(
    manifest.runSessions.some((session) => session.id === 'missing-parent'),
    false
  );
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
      samples: ['sidebar-source', 'editor-root', 'editor-root-return', 'editor-reload'].map(
        (phase) => ({ phase, model: true, permissionMode: true })
      ),
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
    fileDiffs: { hidden: true, shown: true },
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
  messages[1].parts.unshift({ type: 'reasoning', text: 'Reply with Q1-END' });
  const reasoningEcho = summarizeQueuedDelivery(messages, turns);
  assert.deepEqual(reasoningEcho.assistantValid, [true, true]);
  assert.equal(reasoningEcho.assistantOutcomes[0][0].textMarkerCount, 1);
  assert.equal(reasoningEcho.assistantOutcomes[0][0].reasoningMarkerCount, 1);
  messages[1].parts[1].text = '';
  assert.deepEqual(summarizeQueuedDelivery(messages, turns).assistantValid, [false, true]);
  messages[1].parts[1].text = 'Q1-END Q1-END';
  assert.deepEqual(summarizeQueuedDelivery(messages, turns).assistantValid, [false, true]);
  messages[1].parts[1].text = 'Q1-END';
  messages[3].parts[0].text = 'wrong response';
  assert.deepEqual(summarizeQueuedDelivery(messages, turns).assistantValid, [true, false]);
});

test('judges the AI-19 permission, queue handoff, steer, and draft lifecycle', () => {
  const passing = {
    editor: {
      opened: true,
      revealed: true,
      sameViewId: true,
      orphanedDraftCleared: true,
    },
    permissions: {
      sidebarFullReachedEditor: true,
      editorAutoReachedSidebar: true,
    },
    queue: {
      initialOwner: true,
      paused: true,
      edited: true,
      transferredToSidebar: true,
      steerDispatched: true,
      removedAfterSteer: true,
    },
    delivery: {
      userCounts: [1],
      assistantCounts: [1],
      assistantValid: [true],
    },
    unexpectedDescendants: [],
  };

  assert.deepEqual(lifecycleScenarioFailures(passing), []);
  assert.match(
    lifecycleScenarioFailures({
      ...passing,
      editor: { ...passing.editor, orphanedDraftCleared: false },
    })[0],
    /ordinary draft/
  );

  const turn = { promptMarker: '[LATE-STEER]', responseMarker: 'LATE-STEER-END' };
  const messages = [
    {
      info: { id: 'late-user', role: 'user' },
      parts: [{ type: 'text', text: turn.promptMarker }],
    },
  ];
  const expiredDelivery = summarizeQueuedDelivery(messages, [turn]);
  assert.deepEqual(expiredDelivery.assistantCounts, [0]);
  assert.match(
    lifecycleScenarioFailures({ ...passing, delivery: expiredDelivery })[0],
    /canonical user\/assistant delivery/
  );
  messages.push({
    info: {
      id: 'late-assistant',
      role: 'assistant',
      parentID: 'late-user',
      finish: 'stop',
      time: { completed: 1 },
    },
    parts: [{ type: 'text', text: turn.responseMarker }],
  });
  // Waiting for idle does not update the earlier summary object. Recompute from
  // the final canonical snapshot before judging the lifecycle.
  assert.deepEqual(expiredDelivery.assistantCounts, [0]);
  assert.deepEqual(
    lifecycleScenarioFailures({
      ...passing,
      delivery: summarizeQueuedDelivery(messages, [turn]),
    }),
    []
  );
});

test('waits until the exact closed editor target disappears', async () => {
  const samples = [[{ id: 'editor-target' }], [{ id: 'other-target' }]];
  assert.equal(
    await waitForTargetDisappearance(0, 'editor-target', 1_000, async () => samples.shift(), 0),
    true
  );
});
