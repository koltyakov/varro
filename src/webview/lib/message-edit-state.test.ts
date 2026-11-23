import { flush as flushSolid } from 'solid-js';
import { afterEach, describe, expect, it } from 'vitest';
import {
  editingMessage,
  editingMessageId,
  inlineEditMount,
  registerInlineEditMount,
  resetMessageEditState,
  startEditingMessage,
  stopEditingMessage,
  unregisterInlineEditMount,
} from './message-edit-state';

describe('message-edit-state', () => {
  afterEach(() => {
    resetMessageEditState();
    flushSolid();
  });

  it('tracks the message being edited', () => {
    expect(editingMessage()).toBeNull();
    expect(editingMessageId()).toBeNull();

    startEditingMessage('message-1', 'session-1', 'prompt');
    flushSolid();

    expect(editingMessage()).toEqual({
      messageId: 'message-1',
      sessionId: 'session-1',
      text: 'prompt',
      context: { files: [], images: [], terminalSelection: null },
      model: null,
      agent: null,
    });
    expect(editingMessageId()).toBe('message-1');
  });

  it('replaces the edit target when another message starts editing', () => {
    startEditingMessage('message-1', 'session-1', 'first');
    flushSolid();
    startEditingMessage('message-2', 'session-1', 'second');
    flushSolid();

    expect(editingMessageId()).toBe('message-2');
  });

  it('stops editing only for the matching message', () => {
    startEditingMessage('message-1', 'session-1', 'prompt');
    flushSolid();

    stopEditingMessage('message-2');
    flushSolid();
    expect(editingMessageId()).toBe('message-1');

    stopEditingMessage('message-1');
    flushSolid();
    expect(editingMessage()).toBeNull();
  });

  it('resets unconditionally', () => {
    startEditingMessage('message-1', 'session-1', 'prompt');
    flushSolid();
    resetMessageEditState();
    flushSolid();
    expect(editingMessage()).toBeNull();
  });

  it('tracks the inline composer mount and only unregisters its own element', () => {
    const first = document.createElement('div');
    const second = document.createElement('div');

    registerInlineEditMount(first);
    flushSolid();
    expect(inlineEditMount()).toBe(first);

    // A newer slot can register before the previous slot cleans up.
    registerInlineEditMount(second);
    unregisterInlineEditMount(first);
    flushSolid();
    expect(inlineEditMount()).toBe(second);

    unregisterInlineEditMount(second);
    flushSolid();
    expect(inlineEditMount()).toBeNull();
  });
});
