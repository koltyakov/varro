export async function writeClipboard(text: string): Promise<boolean> {
  const clipboard = typeof navigator === 'undefined' ? undefined : navigator.clipboard;
  if (clipboard?.writeText) {
    try {
      await clipboard.writeText(text);
      return true;
    } catch {
      // fall through to execCommand fallback
    }
  }

  const body = typeof document === 'undefined' ? undefined : document.body;
  if (body) {
    const textarea = document.createElement('textarea');
    textarea.value = text;
    textarea.setAttribute('readonly', '');
    textarea.style.position = 'fixed';
    textarea.style.opacity = '0';
    textarea.style.pointerEvents = 'none';
    body.appendChild(textarea);
    textarea.select();
    const copied = document.execCommand('copy');
    body.removeChild(textarea);
    if (copied) return true;
  }

  return false;
}
