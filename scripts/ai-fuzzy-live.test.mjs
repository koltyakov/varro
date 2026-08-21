import assert from 'node:assert/strict';
import test from 'node:test';

import { buildLivePrompt, missingLiveGates } from './ai-fuzzy-live.mjs';

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
  assert.match(prompt, /ten independent read or search calls/);
  assert.match(prompt, /Do not repeat completed work/);
});

test('the initial task requests the content forms needed by the live gate', () => {
  const prompt = buildLivePrompt({ seed: 'abc', attempt: 1 });

  assert.match(prompt, /eight independent read or search tool calls/);
  assert.match(prompt, /exactly two existing source or test files/);
  assert.match(prompt, /another parallel group/);
});
