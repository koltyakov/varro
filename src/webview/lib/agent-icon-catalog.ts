import { createSignal } from 'solid-js';

// Vite groups these lazy imports into small alphabetic bundles for VSIX packaging. The
// catalog query keeps statically imported `?raw` icons out of those bundles, which would
// otherwise load a whole bundle at startup for one status icon.
const icons = new Map(
  Object.entries(
    import.meta.glob<string>('/node_modules/iconoir/icons/{regular,solid}/*.svg', {
      exhaustive: true,
      query: '?raw&agent-icon',
      import: 'default',
    })
  ).map(([path, svg]) => {
    const name = path.slice(path.lastIndexOf('/') + 1, -4);
    return [path.includes('/solid/') ? `${name}-solid` : name, svg];
  })
);
const urls = new Map<string, string>();
const requested = new Set<string>();
const [revision, setRevision] = createSignal(0);

export function getCatalogIcon(name: string): string | undefined {
  revision();
  const cached = urls.get(name);
  if (cached) return cached;
  const load = icons.get(name);
  if (!load || requested.has(name)) return undefined;
  requested.add(name);
  void load()
    .then((svg) => {
      urls.set(name, `data:image/svg+xml,${encodeURIComponent(svg)}`);
      setRevision((value) => value + 1);
    })
    .catch((error) => {
      // oxlint-disable-next-line no-console
      console.warn('Failed to load agent icon', name, error);
    });
  return undefined;
}
