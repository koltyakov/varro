import assert from 'node:assert/strict';
import test from 'node:test';
import { V2ReplayProjection } from './ai-streaming-v2.mjs';
import { ReplayProjection } from './ai-replay-projection.mjs';

test('shared replay projection rejects unsupported native events before delivery', () => {
  const projection = new ReplayProjection([]);
  assert.throws(
    () =>
      projection.apply(
        { session: {}, messages: [] },
        {
          type: 'session.next.unrecognized',
          properties: { sessionID: 's' },
        }
      ),
    /Unsupported capture event/
  );
});

test('shared replay projection preserves legacy history through a native text lifecycle', () => {
  const { answer } = fixture();
  const user = { info: { id: 'u', role: 'user', time: { created: 1 } }, parts: [] };
  const projection = new ReplayProjection([user, answer]);
  const state = { session: {}, messages: [] };
  const legacy = { info: { id: 'old', role: 'user' }, parts: [] };
  projection.apply(state, { type: 'message.updated', properties: { info: legacy.info } });
  projection.apply(state, { type: 'session.next.prompted', properties: { messageID: 'u' } });
  projection.apply(state, {
    type: 'session.next.step.started',
    properties: {
      assistantMessageID: 'a',
      timestamp: 2,
      model: { providerID: 'test', modelID: 'test' },
    },
  });
  assert.deepEqual(state.messages[0], legacy);
  assert.equal(state.messages[2].parts.length, 0);
  assert.equal(state.messages[2].info.time.completed, undefined);
});

function fixture() {
  const user = { info: { id: 'u', role: 'user', time: { created: 1 } }, parts: [] };
  const answer = {
    info: {
      id: 'a',
      role: 'assistant',
      parentID: 'u',
      time: { created: 2, completed: 20 },
      finish: 'stop',
    },
    parts: [
      {
        id: 'r',
        messageID: 'a',
        sessionID: 's',
        type: 'reasoning',
        text: 'Think',
        time: { start: 3, end: 5 },
      },
      { id: 't', messageID: 'a', sessionID: 's', type: 'text', text: 'Hello' },
    ],
  };
  const projection = new V2ReplayProjection([user, answer]);
  const state = { session: {}, messages: [] };
  const emit = (name, props = {}) =>
    projection.apply(state, {
      type: `session.next.${name}`,
      properties: { sessionID: 's', assistantMessageID: 'a', ...props },
    });
  emit('prompted', { messageID: 'u' });
  emit('step.started', { timestamp: 2, model: { id: 'test', providerID: 'test' }, agent: 'build' });
  return { state, emit, answer, projection };
}

test('text and reasoning expose deltas only after delivery and terminal metadata at completion', () => {
  const { state, emit, answer } = fixture();
  emit('reasoning.started', { textID: 'r', timestamp: 3 });
  assert.equal(state.messages[1].parts[0].text, '');
  emit('reasoning.delta', { textID: 'r', delta: 'Think' });
  assert.equal(state.messages[1].parts[0].time.end, undefined);
  emit('reasoning.ended', { textID: 'r', text: 'Think', timestamp: 5 });
  emit('text.started', { textID: 't' });
  emit('text.delta', { textID: 't', delta: 'Hel' });
  assert.equal(state.messages[1].parts[1].text, 'Hel');
  assert.equal(state.messages[1].info.time.completed, undefined);
  emit('text.delta', { textID: 't', delta: 'lo' });
  emit('text.ended', { textID: 't', text: 'Hello' });
  emit('step.ended', { finish: 'stop' });
  assert.deepEqual(state.messages[1], answer);
});

test('invalid ordering and incompatible canonical endings fail rather than silently completing', () => {
  const { emit } = fixture();
  assert.throws(() => emit('text.delta', { textID: 't', delta: 'future' }), /before part start/);
  emit('text.started', { textID: 't' });
  assert.throws(() => emit('text.ended', { textID: 't', text: 'wrong' }), /differs/);
  assert.throws(() => emit('step.ended', { finish: 'stop' }), /before.*completed/);
});

test('synthetic messages without wire IDs require unambiguous timestamp and text matches', () => {
  const { state, projection } = fixture();
  const synthetic = {
    info: { id: 'context', role: 'user', time: { created: 10 } },
    parts: [{ type: 'text', text: 'fixture context' }],
  };
  projection.recorded.set('context', synthetic);
  const event = {
    type: 'session.next.synthetic',
    properties: { timestamp: 10, text: 'fixture context' },
  };
  projection.apply(state, event);
  assert.deepEqual(state.messages.at(-1), synthetic);
  assert.throws(() => projection.apply(state, event), /Duplicate/);
  projection.recorded.set('other', { ...synthetic, info: { ...synthetic.info, id: 'other' } });
  assert.throws(() => projection.apply(state, event), /Ambiguous/);
});

test('failed tools expose the recorded error only after the native failure event', () => {
  const { state, emit, answer } = fixture();
  answer.parts.push({
    id: 'call',
    sessionID: 's',
    messageID: 'a',
    type: 'tool',
    callID: 'call',
    tool: 'read',
    state: { status: 'error', input: {}, error: 'Denied', time: { start: 4, end: 6 } },
  });
  emit('tool.input.started', { callID: 'call', name: 'read' });
  emit('tool.called', { callID: 'call', input: {}, timestamp: 4 });
  assert.equal(state.messages[1].parts.at(-1).state.error, undefined);
  assert.throws(() => emit('tool.failed', { callID: 'call', error: 'different' }), /differs/);
  emit('tool.failed', { callID: 'call', error: { message: 'Denied' } });
  assert.deepEqual(state.messages[1].parts.at(-1), answer.parts.at(-1));
});

test('deferred tool inputs validate their wire summary and expose full input only at completion', () => {
  const { state, emit, answer } = fixture();
  const input = { patchText: 'x'.repeat(800), filePath: '/workspace/example.ts' };
  const summary = { ...input, patchText: input.patchText.slice(0, 512) };
  answer.parts.push({
    id: 'call',
    sessionID: 's',
    messageID: 'a',
    type: 'tool',
    callID: 'call',
    tool: 'patch',
    state: { status: 'completed', input, output: 'Done', time: { start: 4, end: 6 } },
  });
  emit('tool.input.started', { callID: 'call', name: 'patch' });
  emit('tool.called', { callID: 'call', input: summary, deferred: '/part/call', timestamp: 4 });
  assert.deepEqual(state.messages[1].parts.at(-1).state.input, summary);
  state.messages[1].parts.at(-1).state.input = { ...summary, patchText: 'wrong' };
  assert.throws(() => emit('tool.success', { callID: 'call' }), /input differs/);
  state.messages[1].parts.at(-1).state.input = summary;
  emit('tool.success', { callID: 'call' });
  assert.deepEqual(state.messages[1].parts.at(-1), answer.parts.at(-1));
});

test('unmarked truncated tool input still fails canonical validation', () => {
  const { emit, answer } = fixture();
  answer.parts.push({
    id: 'call',
    sessionID: 's',
    messageID: 'a',
    type: 'tool',
    callID: 'call',
    tool: 'patch',
    state: { status: 'completed', input: { patchText: 'x'.repeat(800) }, output: 'Done' },
  });
  emit('tool.input.started', { callID: 'call', name: 'patch' });
  emit('tool.called', { callID: 'call', input: { patchText: 'x'.repeat(512) }, timestamp: 4 });
  assert.throws(() => emit('tool.success', { callID: 'call' }), /input differs/);
});

for (const arrays of [false, true]) {
  test(`deferred input validation respects JSON depth-limit encoding with arrays=${arrays}`, () => {
    const { state, emit, answer } = fixture();
    let input = 'full value';
    let summary = arrays ? null : {};
    for (let depth = 0; depth < 12; depth += 1) {
      input = arrays ? [input] : { child: input };
      if (arrays || depth < 11) summary = arrays ? [summary] : { child: summary };
    }
    const terminal = {
      id: 'call',
      sessionID: 's',
      messageID: 'a',
      type: 'tool',
      callID: 'call',
      tool: 'custom',
      state: { status: 'completed', input: { payload: input }, output: 'Done' },
    };
    answer.parts.push(terminal);
    emit('tool.input.started', { callID: 'call', name: 'custom' });
    // JSON drops undefined object fields and encodes undefined array items as null.
    emit('tool.called', {
      callID: 'call',
      input: { payload: summary },
      deferred: '/part/call',
      timestamp: 4,
    });
    emit('tool.success', { callID: 'call' });
    assert.deepEqual(state.messages[1].parts.at(-1), terminal);
  });
}
