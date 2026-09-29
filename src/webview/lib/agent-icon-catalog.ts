// Loaded only for configured agent icons. Packing raw SVGs into one chunk avoids
// thousands of VSIX entries without adding the catalog to the startup bundle.
const icons = new Map(
  Object.entries(
    import.meta.glob<string>('/node_modules/iconoir/icons/{regular,solid}/*.svg', {
      eager: true,
      exhaustive: true,
      query: '?raw',
      import: 'default',
    })
  ).map(([path, svg]) => {
    const name = path.slice(path.lastIndexOf('/') + 1, -4);
    return [path.includes('/solid/') ? `${name}-solid` : name, svg];
  })
);
const urls = new Map<string, string>();

export function getCatalogIcon(name: string): string | undefined {
  const cached = urls.get(name);
  if (cached) return cached;
  const svg = icons.get(name);
  if (!svg) return undefined;
  const url = `data:image/svg+xml,${encodeURIComponent(svg)}`;
  urls.set(name, url);
  return url;
}
