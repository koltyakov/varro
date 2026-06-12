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
  });

  it('tracks the message being edited', () => {
    expect(editingMessage()).toBeNull();
    expect(editingMessageId()).toBeNull();

    startEditingMessage('message-1', 'session-1', 'prompt');

    expect(editingMessage()).toEqual({
      messageId: 'message-1',
      sessionId: 'session-1',
      text: 'prompt',
      context: { files: [], images: [], terminalSelection: null },
    });
    expect(editingMessageId()).toBe('message-1');
  });

  it('replaces the edit target when another message starts editing', () => {
    startEditingMessage('message-1', 'session-1', 'first');
    startEditingMessage('message-2', 'session-1', 'second');

    expect(editingMessageId()).toBe('message-2');
  });

  it('stops editing only for the matching message', () => {
    startEditingMessage('message-1', 'session-1', 'prompt');

    stopEditingMessage('message-2');
    expect(editingMessageId()).toBe('message-1');

    stopEditingMessage('message-1');
    expect(editingMessage()).toBeNull();
  });

  it('resets unconditionally', () => {
    startEditingMessage('message-1', 'session-1', 'prompt');
    resetMessageEditState();
    expect(editingMessage()).toBeNull();
  });

  it('tracks the inline composer mount and only unregisters its own element', () => {
    const first = document.createElement('div');
    const second = document.createElement('div');

    registerInlineEditMount(first);
    expect(inlineEditMount()).toBe(first);

    // A newer slot can register before the previous slot cleans up.
    registerInlineEditMount(second);
    unregisterInlineEditMount(first);
    expect(inlineEditMount()).toBe(second);

    unregisterInlineEditMount(second);
    expect(inlineEditMount()).toBeNull();
  });
});
