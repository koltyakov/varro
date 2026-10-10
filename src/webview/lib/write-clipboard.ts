type LegacyClipboardDocument = {
  execCommand(commandId: 'copy'): boolean;
};

export async function writeClipboardImage(image: HTMLImageElement): Promise<void> {
  const clipboard = globalThis.navigator?.clipboard;
  if (!clipboard?.write || typeof ClipboardItem === 'undefined')
    throw new Error('Copying images is unavailable in this webview');
  if (!image.naturalWidth || !image.naturalHeight)
    throw new Error('Wait for the image to finish loading before copying it');

  const canvas = document.createElement('canvas');
  canvas.width = image.naturalWidth;
  canvas.height = image.naturalHeight;
  try {
    const context = canvas.getContext('2d');
    if (!context) throw new Error('Could not prepare the image for copying');
    context.drawImage(image, 0, 0);
    const blob = new Promise<Blob>((resolve, reject) => {
      canvas.toBlob(
        (value) => (value ? resolve(value) : reject(new Error('Could not copy the image'))),
        'image/png'
      );
    });
    // Start the clipboard write during the click gesture, before PNG encoding finishes.
    await Promise.all([blob, clipboard.write([new ClipboardItem({ 'image/png': blob })])]);
  } finally {
    canvas.width = canvas.height = 0;
  }
}

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
