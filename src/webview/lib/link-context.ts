export function getLinkContext(text: string, target?: { url: string } | { path: string }): string {
  return JSON.stringify({
    preventDefaultContextMenuItems: true,
    varroLinkText: text,
    ...(target && 'url' in target
      ? { webviewSection: 'varroExternalLink', varroLinkUrl: target.url }
      : target && 'path' in target
        ? { webviewSection: 'varroFileLink', varroFilePath: target.path }
        : { webviewSection: 'varroLink' }),
  });
}
