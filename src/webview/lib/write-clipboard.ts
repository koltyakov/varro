type LegacyClipboardDocument = {
  execCommand(commandId: 'copy'): boolean;
};

export async function writeClipboard(text: string): Promise<boolean> {
  const clipboard = globalThis.navigator?.clipboard;
  if (clipboard?.writeText) {
    try {
      await clipboard.writeText(text);
      return true;
    } catch {
      // fall through to execCommand fallback
    }
  }

  const document = globalThis.document;
  const body = document?.body;
  if (body) {
    const activeElement = document.activeElement;
    const modal =
      activeElement instanceof HTMLElement
        ? activeElement.closest<HTMLElement>('[aria-modal="true"]')
        : null;
    const textarea = document.createElement('textarea');
    textarea.value = text;
    textarea.setAttribute('readonly', '');
    textarea.style.position = 'fixed';
    textarea.style.opacity = '0';
    textarea.style.pointerEvents = 'none';
    (modal ?? body).appendChild(textarea);
    textarea.select();
    // SAFETY: Chromium still implements execCommand for the clipboard fallback.
    const legacyDocument = document as LegacyClipboardDocument;
    const copied = legacyDocument.execCommand('copy');
    textarea.remove();
    if (copied) return true;
  }

  return false;
}
