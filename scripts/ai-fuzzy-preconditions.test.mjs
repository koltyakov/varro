import assert from 'node:assert/strict';
import test from 'node:test';

import {
  buildActionPlan,
  buildPreconditionReport,
  inspectGoldenMessages,
} from './ai-fuzzy-preconditions.mjs';

function turn(number, tall = false) {
  const userId = `user-${String(number)}`;
  return [
    {
      info: { id: userId, role: 'user' },
      parts: [{ type: 'text', text: `[VFZ:test:T${String(number).padStart(3, '0')}] prompt` }],
    },
    {
      info: {
        id: `assistant-${String(number)}`,
        role: 'assistant',
        parentID: userId,
        time: { completed: 1 },
      },
      parts: [
        {
          type: 'text',
          text: `${tall ? `${'long line\n'.repeat(60)}` : 'short'}END-${String(number)}`,
        },
      ],
    },
  ];
}

test('validates reusable history against scenario-specific static gates', () => {
  const messages = Array.from({ length: 110 }, (_, index) => turn(index + 1, (index + 1) % 10 === 0)).flat();
  const summary = inspectGoldenMessages(messages);
  const report = buildPreconditionReport(summary);

  assert.equal(summary.completeMarkedTurnCount, 110);
  assert.equal(summary.tallMarkedTurnCount, 11);
  assert.equal(report.staticReady, true);
  assert.equal(report.checks['AI-05'], true);
  assert.equal(report.checks['AI-07'], null);
});

test('reports unmet history gates instead of treating them as passes', () => {
  const messages = Array.from({ length: 32 }, (_, index) => turn(index + 1, index < 3)).flat();
  const report = buildPreconditionReport(inspectGoldenMessages(messages));

  assert.equal(report.staticReady, false);
  assert.equal(report.checks['AI-01'], true);
  assert.equal(report.checks['AI-04'], false);
  assert.equal(report.checks['AI-05'], false);
});

test('creates a stable 50-step mixed-ownership action plan', () => {
  const first = buildActionPlan('seed-1');
  const second = buildActionPlan('seed-1');

  assert.equal(first.length, 50);
  assert.deepEqual(first, second);
  assert.equal(first[0].action, 'wheel verified nested scroller, then outer transcript');
  assert.equal(first[1].action, 'switch session away and back');
  assert.deepEqual(
    first.slice(5, 8).map(({ action }) => action),
    ['PageDown in composer', 'Space in composer', 'Shift+Space in composer']
  );
  assert.equal(first.some(({ action }) => action.includes('inline editor')), false);
});
