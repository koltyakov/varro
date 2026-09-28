import assert from 'node:assert/strict';
import test from 'node:test';
import { goToLatest } from './ai-fuzzy-navigation.mjs';

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
      evaluate: async () => geometry(time),
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
  assert.deepEqual(streaming.inputs, ['click']);
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
