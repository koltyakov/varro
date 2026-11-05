type ProviderIdentity = { id: string; name: string };

const PROVIDER_PRIORITY: readonly string[] = [
  'openai',
  'anthropic',
  'github-copilot',
  'groq',
  'google',
];

export function compareProviders(a: ProviderIdentity, b: ProviderIdentity) {
  const aPriority = PROVIDER_PRIORITY.indexOf(a.id);
  const bPriority = PROVIDER_PRIORITY.indexOf(b.id);
  const priorityOrder =
    (aPriority < 0 ? PROVIDER_PRIORITY.length : aPriority) -
    (bPriority < 0 ? PROVIDER_PRIORITY.length : bPriority);
  return priorityOrder || a.name.localeCompare(b.name) || a.id.localeCompare(b.id);
}

export function compareProviderOrder(
  a: ProviderIdentity,
  b: ProviderIdentity,
  order: readonly string[]
) {
  const aIndex = order.indexOf(a.id);
  const bIndex = order.indexOf(b.id);
  if (aIndex < 0 && bIndex < 0) return compareProviders(a, b);
  if (aIndex < 0) return 1;
  if (bIndex < 0) return -1;
  return aIndex - bIndex;
}

export const LARGE_MODEL_CATALOG_THRESHOLD = 50;
