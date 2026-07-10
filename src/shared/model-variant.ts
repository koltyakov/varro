export function normalizeModelVariant(
  modelID: string | null | undefined,
  variant: string | null | undefined
) {
  if (modelID === 'gpt-5.5' && variant === 'minimal') return 'low';
  return variant || null;
}
