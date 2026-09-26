import assert from 'node:assert/strict';
import path from 'node:path';
import test from 'node:test';

import { parsePruneArguments, PRUNE_TARGETS, selectPruneCandidates } from './prune-artifacts.mjs';

const HOUR = 60 * 60 * 1000;
const now = 100 * HOUR;

function entry(name, ageHours) {
  return { path: path.join('/repo/artifacts/ai-test-data', name), mtimeMs: now - ageHours * HOUR };
}

test('keeps the newest runs and only removes older ones past the minimum age', () => {
  const entries = [entry('a', 1), entry('b', 30), entry('c', 50), entry('d', 2), entry('e', 70)];
  const candidates = selectPruneCandidates(entries, {
    keep: 2,
    minAgeMs: 24 * HOUR,
    now,
    protectedPaths: [],
  });
  assert.deepEqual(
    candidates.map((candidate) => path.basename(candidate.path)),
    ['b', 'c', 'e']
  );
});

test('skips recent runs even when they exceed the keep count', () => {
  const entries = [entry('a', 1), entry('b', 2), entry('c', 3)];
  assert.deepEqual(
    selectPruneCandidates(entries, { keep: 1, minAgeMs: 24 * HOUR, now, protectedPaths: [] }),
    []
  );
});

test('never selects the active isolated data directory or its ancestors', () => {
  const entries = [entry('active', 90), entry('old', 80)];
  const activeData = path.join('/repo/artifacts/ai-test-data', 'active', 'opencode');
  const candidates = selectPruneCandidates(entries, {
    keep: 0,
    minAgeMs: 0,
    now,
    protectedPaths: [activeData],
  });
  assert.deepEqual(
    candidates.map((candidate) => path.basename(candidate.path)),
    ['old']
  );
});

test('defaults to a dry run and validates numeric options', () => {
  assert.deepEqual(parsePruneArguments([]), { apply: false, keep: 10, minAgeHours: 24 });
  assert.deepEqual(parsePruneArguments(['--dry-run']), parsePruneArguments([]));
  assert.throws(() => parsePruneArguments(['--apply', '--dry-run']), /cannot be combined/);
  assert.throws(() => parsePruneArguments(['--dry-run', '--apply']), /cannot be combined/);
  assert.deepEqual(parsePruneArguments(['--apply', '--keep', '3', '--min-age-hours', '0']), {
    apply: true,
    keep: 3,
    minAgeHours: 0,
  });
  assert.throws(() => parsePruneArguments(['--keep', '-1']), /non-negative integer/);
  assert.throws(() => parsePruneArguments(['--force']), /Unknown argument/);
});

test('only targets regenerable run output', () => {
  assert.ok(PRUNE_TARGETS.every((target) => target.directory.startsWith('artifacts/')));
  assert.ok(!PRUNE_TARGETS.some((target) => target.directory === 'artifacts/ai-fuzzy'));
  const adapters = PRUNE_TARGETS.find(
    (target) => target.directory === 'artifacts/opencode-adapters'
  );
  assert.ok(adapters && !adapters.pattern.test('verified.json'));
});
