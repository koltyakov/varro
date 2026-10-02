import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  applyChatFontConfig,
  onAfterChatFontConfigChange,
  onBeforeChatFontConfigChange,
} from './chat-font-config';

describe('chat font config', () => {
  afterEach(() => {
    document.documentElement.style.removeProperty('--varro-chat-font-size');
    document.documentElement.style.removeProperty('--varro-chat-prose-font-size-offset');
    document.documentElement.style.removeProperty('--varro-chat-editor-font-size');
    document.documentElement.style.removeProperty('--varro-chat-font-family');
    vi.restoreAllMocks();
  });

  it.each([
    ['Mozilla/5.0 (X11; Linux x86_64)', '0px'],
    ['Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)', '0.5px'],
    ['Mozilla/5.0 (Windows NT 10.0; Win64; x64)', '0.5px'],
  ])('uses the platform prose offset for %s', (userAgent, offset) => {
    vi.spyOn(navigator, 'userAgent', 'get').mockReturnValue(userAgent);

    for (const chatFontSize of [13, 17, 15.5]) {
      applyChatFontConfig({ chatFontSize, chatEditorFontSize: 12, chatFontFamily: 'default' });
      expect(document.documentElement.style.getPropertyValue('--varro-chat-font-size')).toBe(
        `${chatFontSize}px`
      );
      expect(
        document.documentElement.style.getPropertyValue('--varro-chat-prose-font-size-offset')
      ).toBe(offset);
    }
  });

  it('notifies layout owners around a changed font application', () => {
    applyChatFontConfig({ chatFontSize: 13, chatEditorFontSize: 12, chatFontFamily: 'default' });
    const listener = vi.fn(() => {
      expect(document.documentElement.style.getPropertyValue('--varro-chat-font-size')).toBe(
        '13px'
      );
    });
    const afterListener = vi.fn(() => {
      expect(document.documentElement.style.getPropertyValue('--varro-chat-font-size')).toBe(
        '17px'
      );
    });
    const unsubscribe = onBeforeChatFontConfigChange(listener);
    const unsubscribeAfter = onAfterChatFontConfigChange(afterListener);

    applyChatFontConfig({ chatFontSize: 13, chatEditorFontSize: 12, chatFontFamily: 'default' });
    expect(listener).not.toHaveBeenCalled();
    expect(afterListener).not.toHaveBeenCalled();

    applyChatFontConfig({ chatFontSize: 17, chatEditorFontSize: 16, chatFontFamily: 'monospace' });
    expect(listener).toHaveBeenCalledOnce();
    expect(afterListener).toHaveBeenCalledOnce();
    expect(document.documentElement.style.getPropertyValue('--varro-chat-font-size')).toBe('17px');
    expect(document.documentElement.style.getPropertyValue('--varro-chat-editor-font-size')).toBe(
      '16px'
    );
    expect(document.documentElement.style.getPropertyValue('--varro-chat-font-family')).toBe(
      'monospace'
    );

    unsubscribe();
    unsubscribeAfter();
    applyChatFontConfig({ chatFontSize: 15, chatEditorFontSize: 14, chatFontFamily: 'default' });
    expect(listener).toHaveBeenCalledOnce();
    expect(afterListener).toHaveBeenCalledOnce();
    expect(document.documentElement.style.getPropertyValue('--varro-chat-font-family')).toBe('');
  });
});
