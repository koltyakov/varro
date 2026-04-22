type ClipboardImageLike = { filename: string };

export function stripClipboardImagePlaceholders(text: string, images: ClipboardImageLike[]) {
  let next = text;
  for (const image of images) {
    next = next.replaceAll(`[${image.filename}]`, '');
  }
  return next.replace(/[^\S\r\n]{2,}/g, ' ');
}

export function getPromptTextForClipboardImages(
  text: string,
  images: ClipboardImageLike[],
  includeImages: boolean
) {
  return includeImages ? text : stripClipboardImagePlaceholders(text, images);
}
