import assert from 'node:assert/strict';
import test from 'node:test';
import { analyzeBurstProbe } from './ai-streaming-burst-probe.mjs';

const frame = (at, top, markerTop = 300 - top, signature = 'unchanged') => ({
  at,
  top,
  height: 1500,
  client: 800,
  hidden: false,
  mounted: 10,
  textLength: 100,
  markers: [{ id: 1, top: markerTop, signature, painted: true }],
});
const analyze = (frames) =>
  analyzeBurstProbe({
    startedAt: 0,
    stoppedAt: 200,
    frames,
    events: [],
    commits: [],
    longtasks: [],
    longtasksSupported: true,
    droppedSamples: 0,
  });

test('burst probe identifies the same painted block moving backward', () => {
  const result = analyze([frame(0, 100, 200), frame(16, 80, 220)]);
  assert.equal(result.reversals.length, 1);
  assert.equal(result.reversals[0].delta, -20);
});

test('height compensation with a stationary marker is not a visible jump', () => {
  const result = analyze([frame(0, 100, 200), frame(16, 1100, 200)]);
  assert.equal(result.reversals.length, 0);
  assert.equal(result.excessiveSpeed.length, 0);
  assert.equal(result.coordinateOnly.length, 1);
});

test('burst probe distinguishes fast visible following from integer rounding', () => {
  assert.equal(analyze([frame(0, 0), frame(16, 50)]).excessiveSpeed.length, 1);
  assert.equal(analyze([frame(0, 0), frame(16, 36)]).excessiveSpeed.length, 0);
});

test('changed text is not reused as a stable painted reference', () => {
  const result = analyze([frame(0, 100, 200), frame(16, 80, 220, 'changed')]);
  assert.equal(result.reversals.length, 0);
});

test('sustained speed windows retain an excessive movement', () => {
  const result = analyze(Array.from({ length: 9 }, (_, i) => frame(i * 16, i * 48)));
  assert.equal(result.maxSustainedSpeedPxPerSecond, 3000);
  assert.ok(result.excessiveSpeed.length > 0);
});
