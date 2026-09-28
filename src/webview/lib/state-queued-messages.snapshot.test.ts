/* oxlint-disable anti-slop/no-module-mocking -- Capture the VS Code bridge boundary to replay delayed host acknowledgements against real queue state. */
import { beforeEach, expect, it, vi } from 'vitest';
import type { QueuedMessage } from './app-state-types';
import type { WebviewMessage } from '../../shared/protocol';
import { parseExtensionMessage } from '../../shared/extension-message';

const bridge = vi.hoisted(() => ({ postMessage: vi.fn((_message: WebviewMessage) => true) }));
vi.mock('./bridge', () => bridge);

beforeEach(() => {
  vi.resetModules();
  bridge.postMessage.mockClear();
});

it('keeps a newer enqueue when an earlier persistence echo arrives', async () => {
  const queue = await import('./state-queued-messages');
  const { state } = await import('./app-state');
  const item = (id: string): QueuedMessage => ({
    id,
    sessionId: 'session-1',
    text: id,
    droppedFiles: [],
    clipboardImages: [],
    terminalSelection: null,
  });
  const first = item('first');
  const second = item('second');
  queue.enqueueMessage(first);
  const firstCall = bridge.postMessage.mock.calls.at(-1);
  queue.enqueueMessage(second);
  const secondCall = bridge.postMessage.mock.calls.at(-1);
  // Read the actual emitted protocol rather than synthesizing its mutation identities.
  const firstUpdate = firstCall?.[0];
  const secondUpdate = secondCall?.[0];
  expect(firstUpdate?.type).toBe('queued-messages/update');
  expect(secondUpdate?.type).toBe('queued-messages/update');
  if (
    firstUpdate?.type !== 'queued-messages/update' ||
    secondUpdate?.type !== 'queued-messages/update'
  )
    throw new Error('Queue updates missing');
  const deliver = (messages: QueuedMessage[], mutationId: string | undefined) => {
    const parsed = parseExtensionMessage({
      type: 'queued-messages/sync',
      payload: { messages, mutationId },
    });
    if (parsed?.type !== 'queued-messages/sync') throw new Error('Snapshot rejected');
    queue.applyQueuedMessagesSnapshot(parsed.payload.messages, parsed.payload.mutationId);
  };
  deliver([first], firstUpdate.payload.mutationId);
  expect(state.queuedMessages.map((message) => message.id)).toEqual(['first', 'second']);
  deliver([first, second], secondUpdate.payload.mutationId);
  deliver([{ ...second, ownerViewId: 'editor-1' }], secondUpdate.payload.mutationId);
  expect(state.queuedMessages.map((message) => message.ownerViewId)).toEqual(['editor-1']);
});

it('accepts an authoritative lifecycle snapshot without a persistence acknowledgement', async () => {
  const queue = await import('./state-queued-messages');
  const { state } = await import('./app-state');
  queue.enqueueMessage({ id: 'local', sessionId: 'session-1', text: 'pending' });
  queue.applyQueuedMessagesSnapshot([
    { id: 'transferred', sessionId: 'session-1', text: 'paused', paused: true },
  ]);
  expect(state.queuedMessages.map((message) => message.id)).toEqual(['transferred']);
});
