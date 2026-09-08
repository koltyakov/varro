import assert from 'node:assert/strict';
import test from 'node:test';
import { readFile } from 'node:fs/promises';
import { executeActivityScenario } from './ai-fuzzy-live.mjs';

const tool = (id, status) => ({ id, type: 'tool', state: { status } });

function harness({ stale = false, settledEarly = false, attached = false } = {}) {
  let reads = 0;
  const calls = [];
  const client = {
    isBusy: async () => !settledEarly,
    messages: async () => {
      reads++;
      return [
        { info: { id: 'user', role: 'user' }, parts: [{ type: 'text', text: '[marked]' }] },
        { info: { id: 'old', role: 'assistant', parentID: 'other' }, parts: [tool('old-tool', 'completed')] },
        { info: { id: 'assistant', role: 'assistant', parentID: 'user' }, parts: [
          tool('one', stale || reads > 1 ? 'completed' : 'running'),
          tool('two', stale || reads > 1 ? 'completed' : 'pending'),
          tool('final', 'running'),
        ] },
      ];
    },
  };
  const cdp = {
    snapshot: async () => ({ jumpToLatest: !attached, transcript: { scrollTop: attached ? 900 : 500, scrollHeight: 1000, clientHeight: 100 } }),
    click: async (selector) => { calls.push(selector); attached = true; return true; },
  };
  return {
    calls,
    options: {
      cdp, client, sessionId: 'session', marker: '[marked]', scope: { messageIds: ['assistant'] },
      timeoutMs: 30, pollIntervalMs: 0,
      runActions: async (_cdp, plan) => { calls.push(...plan.map((item) => item.action)); return plan.map((item) => ({ ...item, executed: true })); },
    },
  };
}

test('AI07 executes disclosure, outer wheel, two detached completions, and live return', async () => {
  const { options, calls } = harness();
  const result = await executeActivityScenario(options);
  assert.equal(result.executed, true);
  assert.deepEqual(calls, ['expand disclosure', 'wheel transcript', '[aria-label="Scroll to latest message"]']);
  assert.deepEqual(result.completedWhileDetached, ['one', 'two']);
  assert.deepEqual(result.runningAtReturn, ['final']);
  assert.equal(result.visualVerification, 'NEEDS_AI_REVIEW');
});

test('AI07 waits for measured bottom when the jump control disappears before scrolling settles', async () => {
  const { options } = harness();
  const snapshot = options.cdp.snapshot;
  let returningSamples = 0;
  options.cdp.snapshot = async () => {
    const state = await snapshot();
    if (!state.jumpToLatest && ++returningSamples === 1) state.transcript.scrollTop = 850;
    return state;
  };
  const result = await executeActivityScenario(options);
  assert.equal(result.executed, true);
  assert.equal(returningSamples, 2);
  assert.equal(result.actions.at(-1).after.snapshot.transcript.scrollTop, 900);
  assert.deepEqual(result.runningAtReturn, ['final']);
});

test('AI07 does not count already completed or unrelated tools', async () => {
  const { options } = harness({ stale: true });
  const result = await executeActivityScenario(options);
  assert.equal(result.executed, false);
  assert.equal(result.failurePhase, 'detached-completions');
  assert.deepEqual(result.completedWhileDetached, []);
});

test('AI07 fails rather than retrying around an ended stream or failed detachment', async () => {
  for (const flags of [{ settledEarly: true }, { attached: true }]) {
    const { options, calls } = harness(flags);
    const result = await executeActivityScenario(options);
    assert.equal(result.executed, false);
    assert.ok(!calls.includes('[aria-label="Scroll to latest message"]'));
  }
});

test('AI07 preserves action failure evidence and never proceeds to return', async () => {
  const { options, calls } = harness();
  options.runActions = async () => [{ action: 'expand disclosure', executed: false, reason: 'missing target' }];
  const result = await executeActivityScenario(options);
  assert.equal(result.failurePhase, 'disclosure-and-wheel');
  assert.equal(result.actions[0].reason, 'missing target');
  assert.deepEqual(calls, []);
});

test('AI07 does not count busy reasoning as a running tool at return', async () => {
  const { options } = harness();
  const messages = options.client.messages;
  options.client.messages = async () => (await messages()).map((entry) => ({
    ...entry, parts: entry.parts.filter((part) => part.id !== 'final'),
  }));
  const result = await executeActivityScenario(options);
  assert.equal(result.executed, false);
  assert.equal(result.failurePhase, 'return-while-tool-active');
});

test('AI07 rejects tools completing during the native return action', async () => {
  const { options } = harness();
  const click = options.cdp.click;
  options.cdp.click = async (selector) => {
    options.client.isBusy = async () => false;
    return click(selector);
  };
  const result = await executeActivityScenario(options);
  assert.equal(result.executed, false);
  assert.equal(result.failurePhase, 'return-while-tool-active');
  assert.equal(result.actions.at(-1).executed, false);
});

test('shipped AI07 controller installs telemetry before prompting and records execution separately', async () => {
  const source = await readFile(new URL('./ai-fuzzy-live.mjs', import.meta.url), 'utf8');
  const controller = source.slice(source.indexOf('async function runLive(options)'));
  const observer = controller.indexOf('installObserver.toString()');
  const prompt = controller.indexOf('cdp.sendComposerPrompt(prompt)', observer);
  const execute = controller.indexOf('await executeActivityScenario(', prompt);
  assert.ok(observer > 0 && prompt > observer && execute > prompt);
  assert.match(controller, /preparation: \{ passed: best\?\.missing.length === 0 \}/);
  assert.match(controller, /scenarioVerification: 'NEEDS_AI_REVIEW'/);
  assert.match(controller, /activityObservation = await cdp.evaluate\('globalThis.varroAiStreamingObserver.stop\(\)'\)/);
});
