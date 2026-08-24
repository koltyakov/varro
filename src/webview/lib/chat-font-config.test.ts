import { afterEach, describe, expect, it, vi } from 'vitest';
import { applyChatFontConfig, onBeforeChatFontConfigChange } from './chat-font-config';

describe('chat font config', () => {
  afterEach(() => {
    document.documentElement.style.removeProperty('--varro-chat-font-size');
    document.documentElement.style.removeProperty('--varro-chat-font-family');
  });

  it('notifies layout owners before a changed font is applied', () => {
    applyChatFontConfig({ chatFontSize: 13, chatFontFamily: 'default' });
    const listener = vi.fn(() => {
      expect(document.documentElement.style.getPropertyValue('--varro-chat-font-size')).toBe(
        '13px'
      );
    });
    const unsubscribe = onBeforeChatFontConfigChange(listener);

    applyChatFontConfig({ chatFontSize: 13, chatFontFamily: 'default' });
    expect(listener).not.toHaveBeenCalled();

    applyChatFontConfig({ chatFontSize: 17, chatFontFamily: 'monospace' });
    expect(listener).toHaveBeenCalledOnce();
    expect(document.documentElement.style.getPropertyValue('--varro-chat-font-size')).toBe('17px');
    expect(document.documentElement.style.getPropertyValue('--varro-chat-font-family')).toBe(
      'monospace'
    );

    unsubscribe();
    applyChatFontConfig({ chatFontSize: 15, chatFontFamily: 'default' });
    expect(listener).toHaveBeenCalledOnce();
    expect(document.documentElement.style.getPropertyValue('--varro-chat-font-family')).toBe('');
  });
});
