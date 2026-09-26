import assert from 'node:assert/strict';
import test from 'node:test';
import { V2ReplayProjection } from './ai-streaming-v2.mjs';

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
