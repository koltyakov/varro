import type { ExtensionConfigSnapshot } from '../../shared/provider-limit-config';

const CHAT_FONT_SIZE_PROPERTY = '--varro-chat-font-size';
const CHAT_FONT_FAMILY_PROPERTY = '--varro-chat-font-family';
const beforeChangeListeners = new Set<() => void>();

export function onBeforeChatFontConfigChange(listener: () => void): () => void {
  beforeChangeListeners.add(listener);
  return () => beforeChangeListeners.delete(listener);
}

export function applyChatFontConfig(
  config: Pick<ExtensionConfigSnapshot, 'chatFontSize' | 'chatFontFamily'>
): void {
  const style = document.documentElement.style;
  const nextSize = `${config.chatFontSize}px`;
  const nextFamily = config.chatFontFamily === 'default' ? '' : config.chatFontFamily;
  if (
    style.getPropertyValue(CHAT_FONT_SIZE_PROPERTY) === nextSize &&
    style.getPropertyValue(CHAT_FONT_FAMILY_PROPERTY) === nextFamily
  ) {
    return;
  }

  for (const listener of beforeChangeListeners) listener();
  style.setProperty(CHAT_FONT_SIZE_PROPERTY, nextSize);
  if (nextFamily) style.setProperty(CHAT_FONT_FAMILY_PROPERTY, nextFamily);
  else style.removeProperty(CHAT_FONT_FAMILY_PROPERTY);
}
