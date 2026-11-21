import assert from 'node:assert/strict';
import test from 'node:test';
import { goToLatest, runAi01 } from './ai-fuzzy-navigation.mjs';

function fixture(geometry, route = 'session') {
  let time = 0;
  const inputs = [];
  return {
    inputs,
    cdp: {
      click: async () => {
        inputs.push('click');
        return true;
      },
      key: async () => {
        inputs.push('End');
        return true;
      },
      snapshot: async () => ({ routeSessionId: route }),
      evaluate: async () => {
        const value = geometry(time);
        return value ? { painted: true, ...value } : null;
      },
    },
    options: {
      sessionId: 'session',
      messageId: 'last',
      now: () => time,
      wait: async (ms) => {
        time += ms;
      },
      timeoutMs: 4000,
    },
  };
}

test('waits through a multi-second native animation and subsequent height correction', async () => {
  const f = fixture((time) => ({
    top: time < 2400 ? time : time < 2600 ? 2400 : 2500,
    height: time < 2600 ? 3000 : 3100,
    client: 600,
    visibleIds: time < 2400 ? ['older'] : ['last'],
  }));
  const result = await goToLatest(f.cdp, f.options);
  assert.ok(result.samples.at(-1).at >= 2800);
  assert.deepEqual(f.inputs, ['click']);
});

test('a stalled viewport retains diagnostic evidence and does not pass on button disappearance', async () => {
  const f = fixture(() => ({ top: 100, height: 3000, client: 600, visibleIds: ['older'] }));
  await assert.rejects(goToLatest(f.cdp, f.options), (error) => {
    assert.equal(error.samples.at(-1).geometry.visibleIds[0], 'older');
    return /did not become visible/.test(error.message);
  });
});

test('bottom geometry in another route cannot satisfy navigation', async () => {
  const f = fixture(
    () => ({ top: 2400, height: 3000, client: 600, visibleIds: ['last'] }),
    'other'
  );
  await assert.rejects(goToLatest(f.cdp, f.options), /did not become visible/);
});

test('streaming arrival tracks a growing bottom without requiring stationary height', async () => {
  const f = fixture((time) => ({
    top: 2380 + time,
    height: 3000 + time,
    client: 600,
    visibleIds: ['last'],
  }));
  await assert.rejects(goToLatest(f.cdp, f.options), /did not become visible/);
  const streaming = fixture((time) => ({
    top: 2380 + time,
    height: 3000 + time,
    client: 600,
    visibleIds: ['last'],
  }));
  const result = await goToLatest(streaming.cdp, { ...streaming.options, streaming: true });
  assert.ok(result.samples.at(-1).at >= 150);
  assert.deepEqual(streaming.inputs, []);
});

test('streaming arrival rejects a detached viewport even when the large latest row is visible', async () => {
  const f = fixture((time) => ({
    top: 2000,
    height: 3000 + time,
    client: 600,
    visibleIds: ['last'],
  }));
  await assert.rejects(
    goToLatest(f.cdp, { ...f.options, streaming: true }),
    /did not become visible/
  );
});

test('waits for painted transcript readiness before dispatching one input', async () => {
  const f = fixture((time) =>
    time < 500
      ? null
      : {
          top: time < 900 ? 100 : 2400,
          height: 3000,
          client: 600,
          visibleIds: time < 900 ? ['older'] : ['last'],
          painted: time >= 700,
        }
  );
  f.cdp.click = async () => {
    assert.ok(f.options.now() >= 700);
    f.inputs.push('click');
    return true;
  };
  await goToLatest(f.cdp, f.options);
  assert.deepEqual(f.inputs, ['click']);
});

test('accepts an already settled latest message without targeting hidden navigation controls', async () => {
  const f = fixture(() => ({ top: 2400, height: 3000, client: 600, visibleIds: ['last'] }));
  f.cdp.click = f.cdp.key = async () => {
    throw new Error('No input expected');
  };
  await goToLatest(f.cdp, f.options);
});

test('never dispatches an input into another route or an unpainted transcript', async () => {
  for (const route of ['session', 'other']) {
    const f = fixture(
      () => ({
        top: 100,
        height: 3000,
        client: 600,
        visibleIds: ['older'],
        painted: false,
      }),
      route
    );
    await assert.rejects(goToLatest(f.cdp, f.options), /did not become visible/);
    assert.deepEqual(f.inputs, []);
  }
});

test('AI-01 retains structured drag evidence and rejects a dispatched but unowned grab', async () => {
  const f = fixture(() => ({ top: 2400, height: 3000, client: 600, visibleIds: ['last'] }));
  f.cdp.snapshot = async () => ({ routeSessionId: 'session', transcript: { scrollTop: 100 } });
  f.cdp.wheel = async () => true;
  f.cdp.evaluate = async (expression) =>
    expression.includes('new Promise')
      ? null
      : {
          painted: true,
          top: 2400,
          height: 3000,
          client: 600,
          visibleIds: ['last'],
        };
  const drag = { dispatched: true, held: false, attempts: [{ reached: false }] };
  f.cdp.dragTranscriptScrollbar = async () => drag;
  const result = await runAi01(f.cdp, {
    sessionId: 'session',
    messageId: 'last',
    seed: 'ownership',
  });
  assert.equal(result.result, 'FAIL');
  assert.match(result.error, /pointer ownership/);
  assert.deepEqual(result.actions.at(-1).drag, drag);
});
