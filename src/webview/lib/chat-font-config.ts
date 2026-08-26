import type { ExtensionConfigSnapshot } from '../../shared/provider-limit-config';

const CHAT_FONT_SIZE_PROPERTY = '--varro-chat-font-size';
const CHAT_EDITOR_FONT_SIZE_PROPERTY = '--varro-chat-editor-font-size';
const CHAT_FONT_FAMILY_PROPERTY = '--varro-chat-font-family';
const beforeChangeListeners = new Set<() => void>();
const afterChangeListeners = new Set<() => void>();

export function onBeforeChatFontConfigChange(listener: () => void): () => void {
  beforeChangeListeners.add(listener);
  return () => beforeChangeListeners.delete(listener);
}

export function onAfterChatFontConfigChange(listener: () => void): () => void {
  afterChangeListeners.add(listener);
  return () => afterChangeListeners.delete(listener);
}

export function applyChatFontConfig(
  config: Pick<ExtensionConfigSnapshot, 'chatFontSize' | 'chatEditorFontSize' | 'chatFontFamily'>
): void {
  const style = document.documentElement.style;
  const nextSize = `${config.chatFontSize}px`;
  const nextEditorSize = `${config.chatEditorFontSize}px`;
  const nextFamily = config.chatFontFamily === 'default' ? '' : config.chatFontFamily;
  if (
    style.getPropertyValue(CHAT_FONT_SIZE_PROPERTY) === nextSize &&
    style.getPropertyValue(CHAT_EDITOR_FONT_SIZE_PROPERTY) === nextEditorSize &&
    style.getPropertyValue(CHAT_FONT_FAMILY_PROPERTY) === nextFamily
  ) {
    return;
  }

  for (const listener of beforeChangeListeners) listener();
  style.setProperty(CHAT_FONT_SIZE_PROPERTY, nextSize);
  style.setProperty(CHAT_EDITOR_FONT_SIZE_PROPERTY, nextEditorSize);
  if (nextFamily) style.setProperty(CHAT_FONT_FAMILY_PROPERTY, nextFamily);
  else style.removeProperty(CHAT_FONT_FAMILY_PROPERTY);
  for (const listener of afterChangeListeners) listener();
}
