import assert from 'node:assert/strict';
import { test } from 'node:test';
import vm from 'node:vm';
import { summarizeSamples, installSchedulingProbe } from './ai-performance.mjs';

test('reports unavailable counters separately from zero and computes CPU over the window', () => {
  const summary = summarizeSamples([
    {
      at: 1000,
      metrics: { TaskDuration: 2, JSHeapUsedSize: 100 },
      processes: [{ id: 1, type: 'renderer', cpuTime: 1 }],
    },
    {
      at: 3000,
      metrics: { TaskDuration: 2.5, JSHeapUsedSize: 200 },
      processes: [{ id: 1, type: 'renderer', cpuTime: 2 }],
    },
  ]);
  assert.equal(summary.mainThreadBusyPercent, 25);
  assert.equal(summary.processCpu[0].percentOfOneCore, 50);
  assert.equal(summary.heapBytesPerSecond, 50);
  assert.equal(summary.deltas.LayoutDuration, null);
  assert.equal(
    summarizeSamples([
      { at: 0, metrics: {} },
      { at: 1000, metrics: {} },
    ]).processCpu,
    null
  );
});

test('probe attributes a scheduled callback, preserves its handle, and restores scheduling', () => {
  let callback,
    time = 0;
  const schedule = (fn) => {
    callback = fn;
    return 42;
  };
  const context = vm.createContext({
    setTimeout: schedule,
    performance: { now: () => ++time },
    PerformanceObserver: { supportedEntryTypes: [] },
  });
  vm.runInContext(`(${installSchedulingProbe.toString()})()`, context);
  assert.equal(vm.runInContext('setTimeout(() => 7, 10)', context), 42);
  assert.equal(callback(), 7);
  const report = vm.runInContext('varroSchedulingProbe.stop()', context);
  assert.equal(report.sites[0].calls, 1);
  assert.match(report.sites[0].site, /setTimeout/);
  assert.equal(context.setTimeout, schedule);
});
